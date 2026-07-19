#!/usr/bin/env node
'use strict';

// Regenerates the synthetic captures in data/:
//   demo-long.txt      — LoRa receiver report lines
//   demo-telemetry.txt — TX-board telemetry blocks (with interleaved noise)
// Usage: node tools/gen-demo-data.js [lineCount]

const fs = require('fs');
const path = require('path');

const count = Number(process.argv[2]) || 400;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const dataDir = path.join(__dirname, '..', 'data');

// ---- LoRa RX capture --------------------------------------------------

const rxLines = [];
for (let i = 0; i < count; i++) {
  const rx = i + 1;
  const t = 34 + 3.5 * Math.sin(i / 18) + rand(-0.4, 0.4);
  const pm1 = Math.max(0, 11 + 3 * Math.sin(i / 45 + 1.2) + rand(-0.5, 0.5));
  const pm2 = Math.max(pm1, pm1 * (1.9 + 0.15 * Math.sin(i / 33)) + rand(-0.8, 0.8));
  const flameEvent = i >= 220 && i <= 235 ? -250 : 0; // simulated flame detection dip
  const flame = Math.round(505 + 30 * Math.sin(i / 24) + rand(-6, 6) + flameEvent);
  const rssi = Math.round(-104 + 5 * Math.sin(i / 60) + rand(-1.5, 1.5));
  const snr = 7.5 + 1.8 * Math.sin(i / 40 + 0.7) + rand(-0.3, 0.3);
  rxLines.push(
    `LoRa RX #${rx}: T=${t.toFixed(1)} C, PM1=${pm1.toFixed(1)}, ` +
    `PM2=${pm2.toFixed(1)} ug/m3, flame=${flame}, RSSI=${rssi} dBm, SNR=${snr.toFixed(1)} dB`
  );
}
fs.writeFileSync(path.join(dataDir, 'demo-long.txt'), rxLines.join('\n') + '\n');
console.log(`wrote ${count} LoRa RX lines to data/demo-long.txt`);

// ---- TX telemetry capture ---------------------------------------------

const blocks = Math.min(count, 300);
const telLines = [];
for (let i = 0; i < blocks; i++) {
  const uptime = 10000 + i * 10007;
  const scdOk = i >= 4;   // SCD30 warms up first
  const spsOk = i >= 10;  // SPS30 takes longer

  const co2 = 420 + 90 * Math.sin(i / 22) + 25 * Math.sin(i / 7) + rand(-8, 8);
  const t = 24.5 + 2.8 * Math.sin(i / 30) + rand(-0.15, 0.15);
  const rh = 36 + 7 * Math.sin(i / 26 + 1) + rand(-0.4, 0.4);
  const pm1 = Math.max(0, 8 + 3 * Math.sin(i / 35) + rand(-0.5, 0.5));
  const pm25 = pm1 * 1.8 + rand(-0.4, 0.4);
  const pm4 = pm25 * 1.12 + rand(-0.3, 0.3);
  const pm10 = pm25 * 1.28 + rand(-0.4, 0.4);

  const flameDip = i >= 200 && i <= 212; // simulated flame event
  const flameAdc = Math.round(24 + 6 * Math.sin(i / 9) + rand(-2, 2) + (flameDip ? 320 : 0));
  const flameDig = flameDip ? 0 : 1;

  const p = Math.min(1, i / 260); // supercap charge progress
  const boostV = 0.5 + 4.6 * p + rand(-0.03, 0.03);
  const boostDuty = p < 1 ? Math.max(0, 2 + 58 * p + rand(-1.5, 1.5)) : rand(0, 0.5);
  const boostI = p < 1 ? 0.08 + 0.04 * Math.sin(i / 12) + rand(-0.005, 0.005) : rand(-0.0003, 0.0005);
  const boostP = Math.max(0, boostV * boostI + rand(-0.001, 0.001));
  const chgV = 3.5 + 0.35 * Math.sin(i / 40) + rand(-0.02, 0.02);
  const chgI = Math.max(0, 0.09 + 0.05 * Math.sin(i / 18 + 2) + rand(-0.004, 0.004));
  const chgP = chgV * chgI;
  const buckDuty = Math.max(0, 3 + 2.5 * Math.sin(i / 16) + rand(-0.4, 0.4));
  const chgLimit = i < 100 ? 10 : 250;
  const fault = i >= 150 && i <= 154 ? '0x2' : '0x0';

  const co2S = scdOk ? co2.toFixed(1) : 'nan';
  const tS = scdOk ? t.toFixed(2) : 'nan';
  const rhS = scdOk ? rh.toFixed(2) : 'nan';
  const pmS = (v) => (spsOk ? v.toFixed(2) : 'nan');

  telLines.push(
    `SCD30 read: ${scdOk ? 'OK' : 'FAILED'}`,
    `SPS30 read: ${spsOk ? 'OK' : 'FAILED'}`,
    'LoRa init placeholder: radio implementation intentionally not filled in yet',
    `LoRa transmit placeholder: uptime_ms=${uptime} co2_ppm=${co2S} pm2p5_ug_m3=${pmS(pm25)} ` +
      `boost_v=${boostV.toFixed(3)} charger_v=${chgV.toFixed(3)}`,
    'Telemetry sample:',
    `  uptime_ms=${uptime}`,
    `  SCD30 ok=${scdOk ? 1 : 0} CO2=${co2S} ppm T=${tS} C RH=${rhS} %`,
    `  SPS30 ok=${spsOk ? 1 : 0} PM1=${pmS(pm1)} PM2.5=${pmS(pm25)} PM4=${pmS(pm4)} PM10=${pmS(pm10)}`,
    `  flame_adc=${flameAdc} flame_digital=${flameDig}`,
    `  boost_input: V=${boostV.toFixed(3)} I=${boostI.toFixed(4)} P=${boostP.toFixed(4)}`,
    `  charger_input: V=${chgV.toFixed(3)} I=${chgI.toFixed(4)} P=${chgP.toFixed(4)}`,
    `  boost_duty=${boostDuty.toFixed(2)}% buck_duty=${buckDuty.toFixed(2)}% charge_current_limit_mA=${chgLimit}`,
    `  fault_flags=${fault}`
  );
}
fs.writeFileSync(path.join(dataDir, 'demo-telemetry.txt'), telLines.join('\n') + '\n');
console.log(`wrote ${blocks} telemetry blocks to data/demo-telemetry.txt`);
