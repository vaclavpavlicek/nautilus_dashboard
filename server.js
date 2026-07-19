#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { parseLoraLine, TelemetryAssembler } = require('./lib/parsers');

const USAGE = `
Nautilus LoRa dashboard server

Usage: node server.js [options]

  --mode fake|serial   data source (default: fake)
  --http-port <n>      web UI port (default: 3000)

Fake mode (replay a captured log file):
  --file <path>        log file to replay, relative to this folder
                       (default: data/sample-log.txt)
  --interval <ms>      delay between replayed lines (default: 500)
  --no-loop            stop at end of file instead of looping

Serial mode (live receiver):
  --port <name>        serial port, e.g. COM5 (omit to list available ports)
  --baud <n>           baud rate (default: 115200, matches firmware)

Examples:
  npm run fake
  npm run demo
  npm run serial -- --port COM5
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    mode: 'fake',
    file: path.join(__dirname, 'data', 'sample-log.txt'),
    interval: 500,
    loop: true,
    port: null,
    baud: 115200,
    httpPort: 3300,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      if (++i >= args.length) fail(`missing value after ${a}`);
      return args[i];
    };
    switch (a) {
      case '--mode': opts.mode = next(); break;
      case '--file': opts.file = path.resolve(__dirname, next()); break;
      case '--interval': opts.interval = Number(next()); break;
      case '--no-loop': opts.loop = false; break;
      case '--port': opts.port = next(); break;
      case '--baud': opts.baud = Number(next()); break;
      case '--http-port': opts.httpPort = Number(next()); break;
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default: fail(`unknown argument: ${a}`);
    }
  }
  if (opts.mode !== 'fake' && opts.mode !== 'serial') fail('--mode must be "fake" or "serial"');
  if (!Number.isFinite(opts.interval) || opts.interval < 10) fail('--interval must be a number >= 10');
  if (!Number.isFinite(opts.baud) || opts.baud <= 0) fail('--baud must be a positive number');
  if (!Number.isFinite(opts.httpPort) || opts.httpPort <= 0) fail('--http-port must be a positive number');
  return opts;
}

const opts = parseArgs(process.argv);

// ---------------------------------------------------------------- state

const HISTORY_MAX = 1000; // parsed samples kept per type for late-joining clients
const RAW_TAIL_MAX = 40;  // raw lines kept for the log panel

const historyLora = [];
const historyTel = [];
const rawTail = [];
const clients = new Set();
const assembler = new TelemetryAssembler();
let packetCount = 0;
let sourceLabel = '';

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function ingestLine(rawLine) {
  const line = String(rawLine).replace(/\r/g, '').trim();
  if (!line) return;
  const ts = Date.now();

  rawTail.push({ line, ts });
  if (rawTail.length > RAW_TAIL_MAX) rawTail.shift();

  const lora = parseLoraLine(line);
  if (lora) {
    lora.type = 'lora';
    lora.ts = ts;
    lora.raw = line;
    historyLora.push(lora);
    if (historyLora.length > HISTORY_MAX) historyLora.shift();
    packetCount += 1;
    broadcast('sample', lora);
  } else {
    // telemetry block lines, boot noise, debug prints — all shown in the raw feed
    broadcast('raw', { line, ts });
  }

  const tel = assembler.feed(line);
  if (tel) {
    tel.type = 'telemetry';
    tel.ts = ts;
    historyTel.push(tel);
    if (historyTel.length > HISTORY_MAX) historyTel.shift();
    packetCount += 1;
    broadcast('sample', tel);
  }
}

// ---------------------------------------------------------------- sources

function startFake() {
  let text;
  try {
    text = fs.readFileSync(opts.file, 'utf8');
  } catch (err) {
    fail(`cannot read replay file ${opts.file}: ${err.message}`);
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) fail(`replay file ${opts.file} is empty`);

  sourceLabel = `replay · ${path.basename(opts.file)} · ${opts.interval} ms/line`;
  console.log(`[fake] replaying ${lines.length} lines from ${opts.file} every ${opts.interval} ms${opts.loop ? ' (looping)' : ''}`);

  let idx = 0;
  const timer = setInterval(() => {
    ingestLine(lines[idx]);
    idx += 1;
    if (idx >= lines.length) {
      if (opts.loop) {
        idx = 0;
        broadcast('status', { state: 'loop', message: 'replay looped back to start' });
      } else {
        clearInterval(timer);
        console.log('[fake] replay finished');
        broadcast('status', { state: 'done', message: 'replay finished' });
      }
    }
  }, opts.interval);
}

async function startSerial() {
  let SerialPort;
  let ReadlineParser;
  try {
    ({ SerialPort, ReadlineParser } = require('serialport'));
  } catch (err) {
    fail(`the "serialport" package failed to load — run "npm install" in ${__dirname} first\n${err.message}`);
  }

  if (!opts.port) {
    const ports = await SerialPort.list();
    console.error('--port is required in serial mode. Available ports:');
    if (ports.length === 0) console.error('  (no serial ports found)');
    for (const p of ports) {
      console.error(`  ${p.path}  ${p.friendlyName || p.manufacturer || ''}`.trimEnd());
    }
    console.error('\nExample: npm run serial -- --port COM5');
    process.exit(1);
  }

  sourceLabel = `serial · ${opts.port} @ ${opts.baud} baud`;
  let retryTimer = null;
  const scheduleRetry = () => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, 3000);
  };

  const open = () => {
    const sp = new SerialPort({ path: opts.port, baudRate: opts.baud, autoOpen: false });
    const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', ingestLine);

    sp.open((err) => {
      if (err) {
        console.error(`[serial] open ${opts.port} failed: ${err.message} — retrying in 3 s`);
        broadcast('status', { state: 'serial-retry', message: `open failed: ${err.message}` });
        scheduleRetry();
        return;
      }
      console.log(`[serial] connected to ${opts.port} @ ${opts.baud} baud`);
      broadcast('status', { state: 'serial-open', message: `connected to ${opts.port}` });
    });
    sp.on('close', () => {
      console.error('[serial] port closed — retrying in 3 s');
      broadcast('status', { state: 'serial-retry', message: 'port closed, retrying' });
      scheduleRetry();
    });
    sp.on('error', (err) => {
      console.error(`[serial] ${err.message}`);
    });
  };

  open();
}

// ---------------------------------------------------------------- web app

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const hello = {
    mode: opts.mode,
    source: sourceLabel,
    packetCount,
    lora: historyLora,
    telemetry: historyTel,
    rawTail,
  };
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// keep intermediaries from timing out idle SSE connections
setInterval(() => {
  for (const res of clients) res.write(':hb\n\n');
}, 15000).unref();

const server = app.listen(opts.httpPort, () => {
  console.log(`Dashboard: http://localhost:${opts.httpPort}  (mode: ${opts.mode})`);
  if (opts.mode === 'fake') startFake();
  else startSerial();
});

process.on('SIGINT', () => {
  console.log('\nshutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
