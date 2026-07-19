'use strict';

// ---- LoRa receiver report (one line) ----------------------------------
// LoRa RX #56: T=36.5 C, PM1=12.3, PM2=25.7 ug/m3, flame=512, RSSI=-107 dBm, SNR=7.7 dB
const LORA_RE = new RegExp(
  'LoRa\\s+RX\\s*#(\\d+):\\s*' +
    'T=(-?\\d+(?:\\.\\d+)?)\\s*C,\\s*' +
    'PM1=(-?\\d+(?:\\.\\d+)?),\\s*' +
    'PM2=(-?\\d+(?:\\.\\d+)?)\\s*ug/m3,\\s*' +
    'flame=(-?\\d+),\\s*' +
    'RSSI=(-?\\d+(?:\\.\\d+)?)\\s*dBm,\\s*' +
    'SNR=(-?\\d+(?:\\.\\d+)?)\\s*dB'
);

function parseLoraLine(line) {
  const m = LORA_RE.exec(line);
  if (!m) return null;
  return {
    rx: Number(m[1]),
    t: Number(m[2]),
    pm1: Number(m[3]),
    pm2: Number(m[4]),
    flame: Number(m[5]),
    rssi: Number(m[6]),
    snr: Number(m[7]),
  };
}

// ---- TX telemetry block (multi-line) ----------------------------------
// Telemetry sample:
//   uptime_ms=151207
//   SCD30 ok=1 CO2=0.0 ppm T=27.21 C RH=35.31 %
//   SPS30 ok=0 PM1=nan PM2.5=nan PM4=nan PM10=nan
//   flame_adc=23 flame_digital=1
//   boost_input: V=0.556 I=0.0001 P=0.0000
//   charger_input: V=3.565 I=0.0000 P=0.0001
//   boost_duty=0.00% buck_duty=0.00% charge_current_limit_mA=10
//   fault_flags=0x0
//
// Values may be "nan" while a sensor is warming up or failed — those become
// null so they plot as gaps.

const num = (s) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const FIELD_MATCHERS = [
  {
    re: /^uptime_ms=(\d+)/,
    apply: (m, out) => { out.uptime_ms = Number(m[1]); },
  },
  {
    re: /^SCD30 ok=(\d+) CO2=(\S+) ppm T=(\S+) C RH=(\S+) %/,
    apply: (m, out) => {
      out.scd30_ok = Number(m[1]);
      out.co2_ppm = num(m[2]);
      out.t_c = num(m[3]);
      out.rh_pct = num(m[4]);
    },
  },
  {
    re: /^SPS30 ok=(\d+) PM1=(\S+) PM2\.5=(\S+) PM4=(\S+) PM10=(\S+)/,
    apply: (m, out) => {
      out.sps30_ok = Number(m[1]);
      out.pm1 = num(m[2]);
      out.pm25 = num(m[3]);
      out.pm4 = num(m[4]);
      out.pm10 = num(m[5]);
    },
  },
  {
    re: /^flame_adc=(-?\d+) flame_digital=(\d+)/,
    apply: (m, out) => {
      out.flame_adc = Number(m[1]);
      out.flame_digital = Number(m[2]);
    },
  },
  {
    re: /^boost_input: V=(\S+) I=(\S+) P=(\S+)/,
    apply: (m, out) => {
      out.boost_v = num(m[1]);
      out.boost_i = num(m[2]);
      out.boost_p = num(m[3]);
    },
  },
  {
    re: /^charger_input: V=(\S+) I=(\S+) P=(\S+)/,
    apply: (m, out) => {
      out.charger_v = num(m[1]);
      out.charger_i = num(m[2]);
      out.charger_p = num(m[3]);
    },
  },
  {
    re: /^boost_duty=(\S+)% buck_duty=(\S+)% charge_current_limit_mA=(\d+)/,
    apply: (m, out) => {
      out.boost_duty_pct = num(m[1]);
      out.buck_duty_pct = num(m[2]);
      out.charge_limit_ma = Number(m[3]);
    },
  },
  {
    re: /^fault_flags=0x([0-9a-fA-F]+)/,
    apply: (m, out) => { out.fault_flags = parseInt(m[1], 16); },
    last: true, // known final line of the block — emit immediately
  },
];

// Feed serial lines one at a time (already trimmed); returns a completed
// telemetry sample, or null. A block finishes on its fault_flags line, on the
// start of the next block, or on the first line that isn't a telemetry field.
class TelemetryAssembler {
  constructor() {
    this.partial = null;
  }

  feed(line) {
    if (/^Telemetry sample:/.test(line)) {
      const done = this._finalize();
      this.partial = {};
      return done;
    }
    if (this.partial === null) return null;

    for (const f of FIELD_MATCHERS) {
      const m = f.re.exec(line);
      if (m) {
        f.apply(m, this.partial);
        return f.last ? this._finalize() : null;
      }
    }
    return this._finalize(); // stray line ends the block early
  }

  _finalize() {
    const out = this.partial;
    this.partial = null;
    // a block that never carried its uptime is garbage — drop it
    if (!out || out.uptime_ms === undefined) return null;
    return out;
  }
}

module.exports = { parseLoraLine, TelemetryAssembler };
