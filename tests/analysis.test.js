const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/engine.js');
require('../js/analysis.js');
const { util: U, engine: E, analysis: A } = globalThis.WX;

const START = '2026-10-12';
const label = i => new Date(U.bkkToEpoch(START) + i * 3600000 + U.TZ_OFFSET_MS).toISOString().slice(0, 16);

// แต่ละสมาชิก: ฟังก์ชัน (วัน, ชั่วโมงของป้ายเวลา) -> มม.
function model(id, n, fn, hours = 8 * 24) {
  const h = { time: Array.from({ length: hours }, (_, i) => label(i)) };
  for (let k = 0; k < n; k++) {
    h[k ? `precipitation_member${String(k).padStart(2, '0')}` : 'precipitation'] =
      Array.from({ length: hours }, (_, i) => fn(Math.floor(i / 24), i % 24, k));
  }
  return { id, hourly: h };
}

test('cumulativeFan เพิ่มขึ้นเสมอ และค่าสุดท้ายเท่ากับฝนรวม', () => {
  const ens = E.buildEnsemble([model('a', 4, (d, h, k) => (h === 15 ? k + 1 : 0))]);
  const fan = E.cumulativeFan(ens, U.bkkToEpoch(label(0)), 72, 6);
  assert.ok(fan.length > 5);
  for (let i = 1; i < fan.length; i++) {
    for (const q of ['p10', 'p50', 'p90']) assert.ok(fan[i][q] >= fan[i - 1][q] - 1e-9);
    assert.ok(fan[i].p10 <= fan[i].p50 && fan[i].p50 <= fan[i].p90);
  }
  // 3 วัน × (1..4 มม.) → สมาชิกรวม 3,6,9,12 ; ค่ากลาง (ถ่วงเท่ากัน) = 6
  assert.equal(fan[fan.length - 1].p50, 6);
});

test('subEnsemble เลือกเฉพาะระบบ', () => {
  const ens = E.buildEnsemble([model('a', 2, () => 0), model('b', 2, () => 1)]);
  assert.equal(E.subEnsemble(ens, ['b']).models.length, 1);
  assert.equal(E.subEnsemble(ens, ['x']), null);
});

test('insights: พบช่วงแล้งติดต่อกัน และฝนมักตกช่วงบ่าย', () => {
  // ฝนเฉพาะวันที่ 0-1 ช่วงบ่าย (ป้าย 15:00 = ช่อง 14:00-15:00) ที่เหลือแห้ง
  const fn = (d, h) => (d <= 1 && h === 15 ? 6 : 0);
  const ens = E.buildEnsemble([model('a', 5, fn), model('b', 5, fn)]);
  const out = A.insights({ ens, today: START, modelLabels: { a: 'A', b: 'B' } });
  const texts = out.map(o => o.text).join('\n');
  assert.match(texts, /แนวโน้มแห้ง 5 วันติดต่อกัน/);
  assert.match(texts, /ฝนมักตกช่วงบ่าย/);
  assert.match(texts, /เห็นตรงกัน/);
  // เรียงตามความสำคัญ
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].w >= out[i].w);
});

test('insights: ระบบเห็นต่างกันมาก → เตือนความเชื่อมั่นต่ำ', () => {
  const ens = E.buildEnsemble([
    model('ecmwf', 5, (d, h) => (d === 1 && h === 15 ? 12 : 0)),
    model('gefs', 5, () => 0),
  ]);
  const out = A.insights({ ens, today: START, modelLabels: { ecmwf: 'ECMWF', gefs: 'GEFS' } });
  const w = out.find(o => o.icon === '⚖️');
  assert.ok(w, 'ควรมีคำเตือนเรื่องระบบเห็นต่าง');
  assert.match(w.text, /พรุ่งนี้/);
  assert.match(w.text, /ECMWF/);
});

test('insights: เทียบสัปดาห์ก่อน และ bias ย้อนหลัง', () => {
  const ens = E.buildEnsemble([model('a', 4, (d, h) => (h === 15 ? 5 : 0))]);
  const week = E.rangeTotal(ens, Array.from({ length: 7 }, (_, i) => U.addDays(START, i)));
  const out = A.insights({
    ens, today: START, week, past7: 5, past7Missing: 0,
    backtest: [{ label: 'X', sc: { freqBias: 1.8, csi: 0.4 } }, { label: 'Y', sc: { freqBias: 1.6, csi: 0.5 } }],
  });
  const texts = out.map(o => o.text).join('\n');
  assert.match(texts, /มากกว่า 7 วันที่ผ่านมา/);
  assert.match(texts, /บ่อยเกินจริง/);
  assert.match(texts, /แม่นสุด: Y/);
});

test('insights: ไม่มี ensemble → ว่าง', () => {
  assert.deepEqual(A.insights({ ens: null, today: START }), []);
});
