'use strict';

/* global Chart */

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MAX_KEEP = 1000;
const LOG_MAX = 60;

// One card per figure. cssVar picks a categorical slot (--cat-1..8, themed in
// style.css); same physical quantity keeps the same hue in both sections.
const LORA_PARAMS = [
  { key: 't',     label: 'Temperature',  unit: '°C',    cssVar: '--cat-1', decimals: 1 },
  { key: 'pm1',   label: 'PM1',          unit: 'µg/m³', cssVar: '--cat-2', decimals: 1 },
  { key: 'pm2',   label: 'PM2',          unit: 'µg/m³', cssVar: '--cat-3', decimals: 1 },
  { key: 'flame', label: 'Flame sensor', unit: 'raw',   cssVar: '--cat-4', decimals: 0, integer: true },
  { key: 'rssi',  label: 'RSSI',         unit: 'dBm',   cssVar: '--cat-5', decimals: 0, integer: true },
  { key: 'snr',   label: 'SNR',          unit: 'dB',    cssVar: '--cat-6', decimals: 1 },
];

const TEL_PARAMS = [
  { key: 'co2_ppm',        label: 'CO₂',             unit: 'ppm',   cssVar: '--cat-5', decimals: 1 },
  { key: 't_c',            label: 'Temperature',      unit: '°C',    cssVar: '--cat-1', decimals: 2 },
  { key: 'rh_pct',         label: 'Humidity',         unit: '%',     cssVar: '--cat-7', decimals: 2 },
  { key: 'pm1',            label: 'PM1',              unit: 'µg/m³', cssVar: '--cat-2', decimals: 2 },
  { key: 'pm25',           label: 'PM2.5',            unit: 'µg/m³', cssVar: '--cat-3', decimals: 2 },
  { key: 'pm4',            label: 'PM4',              unit: 'µg/m³', cssVar: '--cat-8', decimals: 2 },
  { key: 'pm10',           label: 'PM10',             unit: 'µg/m³', cssVar: '--cat-6', decimals: 2 },
  { key: 'flame_adc',      label: 'Flame ADC',        unit: 'raw',   cssVar: '--cat-4', decimals: 0, integer: true },
  { key: 'flame_digital',  label: 'Flame digital',    unit: '',      cssVar: '--cat-7', decimals: 0, integer: true, stepped: true },
  { key: 'boost_v',        label: 'Boost input V',    unit: 'V',     cssVar: '--cat-1', decimals: 3 },
  { key: 'boost_i',        label: 'Boost input I',    unit: 'A',     cssVar: '--cat-2', decimals: 4 },
  { key: 'boost_p',        label: 'Boost input P',    unit: 'W',     cssVar: '--cat-3', decimals: 4 },
  { key: 'charger_v',      label: 'Charger input V',  unit: 'V',     cssVar: '--cat-5', decimals: 3 },
  { key: 'charger_i',      label: 'Charger input I',  unit: 'A',     cssVar: '--cat-6', decimals: 4 },
  { key: 'charger_p',      label: 'Charger input P',  unit: 'W',     cssVar: '--cat-8', decimals: 4 },
  { key: 'boost_duty_pct', label: 'Boost duty',       unit: '%',     cssVar: '--cat-4', decimals: 2 },
  { key: 'buck_duty_pct',  label: 'Buck duty',        unit: '%',     cssVar: '--cat-7', decimals: 2 },
  { key: 'charge_limit_ma', label: 'Charge current limit', unit: 'mA', cssVar: '--cat-1', decimals: 0, integer: true, stepped: true },
  { key: 'fault_flags',    label: 'Fault flags',      unit: '',      cssVar: '--cat-6', decimals: 0, integer: true, stepped: true, hex: true },
];

function fmtUptime(ms) {
  if (ms == null) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const GROUPS = {
  lora: {
    params: LORA_PARAMS,
    sectionId: 'group-lora',
    gridId: 'grid-lora',
    metaId: 'meta-lora',
    xLabel: (s) => String(s.rx),
    tooltipTitle: (label) => `RX #${label}`,
    metaText: (s) => `last RX #${s.rx}`,
  },
  telemetry: {
    params: TEL_PARAMS,
    sectionId: 'group-telemetry',
    gridId: 'grid-telemetry',
    metaId: 'meta-telemetry',
    xLabel: (s) => fmtUptime(s.uptime_ms),
    tooltipTitle: (label) => `t+${label}`,
    metaText: (s) => `up ${fmtUptime(s.uptime_ms)}`,
  },
};
for (const g of Object.values(GROUPS)) {
  g.samples = [];
  g.built = false;
  g.charts = {};
  g.readouts = {};
}

let packetCount = 0;
let paused = false;
let windowSize = 120;

const $ = (id) => document.getElementById(id);

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readTokens() {
  return {
    surface: cssToken('--surface-1'),
    textPrimary: cssToken('--text-primary'),
    muted: cssToken('--muted'),
    grid: cssToken('--grid'),
    baseline: cssToken('--baseline'),
  };
}

let tokens = readTokens();

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function fmtValue(value, param) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  if (param.hex) return '0x' + Number(value).toString(16);
  return Number(value).toFixed(param.decimals);
}

// Vertical hairline that tracks the hovered X position (crosshair + tooltip).
const crosshairPlugin = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || active.length === 0) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = tokens.baseline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function buildCard(group, param) {
  const card = document.createElement('article');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';

  const name = document.createElement('span');
  name.className = 'param';
  const key = document.createElement('span');
  key.className = 'line-key';
  key.style.background = `var(${param.cssVar})`;
  name.append(key, document.createTextNode(param.label));

  const readout = document.createElement('span');
  readout.className = 'readout';
  const value = document.createElement('span');
  value.textContent = '—';
  readout.append(value);
  if (param.unit) {
    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = param.unit;
    readout.append(unit);
  }
  group.readouts[param.key] = value;

  head.append(name, readout);

  const plot = document.createElement('div');
  plot.className = 'plot';
  const canvas = document.createElement('canvas');
  plot.append(canvas);

  card.append(head, plot);
  $(group.gridId).append(card);
  return canvas;
}

function makeChart(group, param, canvas) {
  const color = cssToken(param.cssVar);
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        backgroundColor: hexToRgba(color, 0.1),
        fill: 'start',
        borderWidth: 2,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        tension: 0,
        stepped: param.stepped ? 'before' : false,
        pointRadius: 0,
        pointHitRadius: 16,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: tokens.surface,
        pointHoverBorderWidth: 2,
      }],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          backgroundColor: tokens.surface,
          borderColor: tokens.baseline,
          borderWidth: 1,
          titleColor: tokens.muted,
          titleFont: { family: FONT, size: 11, weight: 'normal' },
          bodyColor: tokens.textPrimary,
          bodyFont: { family: FONT, size: 13, weight: 'bold' },
          padding: 10,
          caretSize: 0,
          cornerRadius: 6,
          callbacks: {
            title: (items) => group.tooltipTitle(items[0].label),
            label: (item) => {
              const v = fmtValue(item.parsed.y, param);
              return param.unit ? `${v} ${param.unit}` : v;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: tokens.baseline },
          ticks: {
            color: tokens.muted,
            font: { family: FONT, size: 11 },
            maxTicksLimit: 7,
            maxRotation: 0,
            autoSkip: true,
          },
        },
        y: {
          grace: '12%',
          grid: { color: tokens.grid, lineWidth: 1 },
          border: { display: false },
          ticks: {
            color: tokens.muted,
            font: { family: FONT, size: 11 },
            maxTicksLimit: 5,
            precision: param.integer ? 0 : undefined,
          },
        },
      },
    },
    plugins: [crosshairPlugin],
  });
}

function buildGroup(group) {
  for (const p of group.params) {
    group.charts[p.key] = makeChart(group, p, buildCard(group, p));
  }
  group.built = true;
}

function redrawGroup(group) {
  if (!group.built) return;
  const view = windowSize > 0 ? group.samples.slice(-windowSize) : group.samples;
  const labels = view.map(group.xLabel);
  const last = view.length > 0 ? view[view.length - 1] : null;
  for (const p of group.params) {
    const chart = group.charts[p.key];
    chart.data.labels = labels;
    chart.data.datasets[0].data = view.map((s) => (s[p.key] == null ? null : s[p.key]));
    chart.update('none');
    group.readouts[p.key].textContent = last === null ? '—' : fmtValue(last[p.key], p);
  }
  $(group.metaId).textContent = last === null ? '' : `· ${group.metaText(last)}`;
}

function redrawAll() {
  for (const g of Object.values(GROUPS)) redrawGroup(g);
}

function onSample(s) {
  const group = GROUPS[s.type];
  if (!group) return;
  group.samples.push(s);
  if (group.samples.length > MAX_KEEP) group.samples.splice(0, group.samples.length - MAX_KEEP);
  if (!group.built) buildGroup(group);
  $(group.sectionId).hidden = false;
  packetCount += 1;
  updatePkts();
  if (!paused) redrawGroup(group);
}

function applyTheme() {
  tokens = readTokens();
  for (const group of Object.values(GROUPS)) {
    for (const p of group.params) {
      const chart = group.charts[p.key];
      if (!chart) continue;
      const color = cssToken(p.cssVar);
      const ds = chart.data.datasets[0];
      ds.borderColor = color;
      ds.backgroundColor = hexToRgba(color, 0.1);
      ds.pointHoverBackgroundColor = color;
      ds.pointHoverBorderColor = tokens.surface;
      const o = chart.options;
      o.plugins.tooltip.backgroundColor = tokens.surface;
      o.plugins.tooltip.borderColor = tokens.baseline;
      o.plugins.tooltip.titleColor = tokens.muted;
      o.plugins.tooltip.bodyColor = tokens.textPrimary;
      o.scales.x.border.color = tokens.baseline;
      o.scales.x.ticks.color = tokens.muted;
      o.scales.y.grid.color = tokens.grid;
      o.scales.y.ticks.color = tokens.muted;
      chart.update('none');
    }
  }
}

// ---------------------------------------------------------------- UI chrome

function setConn(ok, text) {
  $('conn').classList.toggle('is-off', !ok);
  $('connText').textContent = text;
}

function updatePkts() {
  $('pkts').textContent = `${packetCount} packets`;
}

let flashTimer = null;
function flash(message) {
  $('flash').textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('flash').textContent = ''; }, 4000);
}

function logLine(line, ts) {
  const log = $('log');
  const row = document.createElement('div');
  const stamp = document.createElement('span');
  stamp.className = 'ts';
  stamp.textContent = `[${new Date(ts).toLocaleTimeString('en-GB')}] `;
  row.append(stamp, document.createTextNode(line));
  log.append(row);
  while (log.childElementCount > LOG_MAX) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- data feed

function connect() {
  const es = new EventSource('/events');

  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    packetCount = d.packetCount || 0;
    $('source').textContent = `${d.mode === 'serial' ? 'live' : 'fake'} · ${d.source}`;
    $('log').replaceChildren();
    for (const r of d.rawTail || []) logLine(r.line, r.ts);
    for (const [type, group] of Object.entries(GROUPS)) {
      group.samples = d[type] || [];
      if (!group.built && group.samples.length > 0) buildGroup(group);
      $(group.sectionId).hidden = group.samples.length === 0;
      redrawGroup(group);
    }
    updatePkts();
  });

  es.addEventListener('sample', (e) => {
    const s = JSON.parse(e.data);
    onSample(s);
    if (s.type === 'lora') logLine(s.raw, s.ts); // telemetry lines arrive via 'raw'
  });

  es.addEventListener('raw', (e) => {
    const d = JSON.parse(e.data);
    logLine(d.line, d.ts);
  });

  es.addEventListener('status', (e) => {
    flash(JSON.parse(e.data).message);
  });

  es.onopen = () => setConn(true, 'live');
  es.onerror = () => setConn(false, 'reconnecting…'); // EventSource retries itself
}

// ---------------------------------------------------------------- boot

Chart.defaults.font.family = FONT;

$('windowSel').addEventListener('change', (e) => {
  windowSize = Number(e.target.value);
  redrawAll();
});

$('pauseBtn').addEventListener('click', (e) => {
  paused = !paused;
  e.target.textContent = paused ? 'Resume' : 'Pause';
  if (!paused) redrawAll();
});

const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'light' || savedTheme === 'dark') {
  document.documentElement.dataset.theme = savedTheme;
}

$('themeBtn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  applyTheme();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) applyTheme();
});

connect();
