const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/radar.js');
const R = globalThis.WX.radar;

const SIZE = 96;
const C = { x: 48.3, y: 48.7 };

function blobField(cx, cy, { peak = 45, sigma = 5 } = {}) {
  const f = new Float32Array(SIZE * SIZE).fill(R.NOECHO);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const v = peak * Math.exp(-d2 / (2 * sigma * sigma));
      if (v > 6) f[y * SIZE + x] = v;
    }
  }
  return f;
}

function frames(path, stepMin = 10, t0 = Date.parse('2026-10-12T05:00:00Z')) {
  return path.map(([x, y], i) => ({ t: t0 + i * stepMin * 60000, field: blobField(x, y) }));
}

const geo = { lat: 11.75, z: 7, size: SIZE, center: C };

test('geometry', () => {
  const w = R.worldPx(0, 0, 0);
  assert.ok(Math.abs(w.x - 128) < 1e-6 && Math.abs(w.y - 128) < 1e-6);
  const k = R.kmPerPx(11.75, 7);
  assert.ok(k > 1.18 && k < 1.21, `km/px ${k}`);
});

test('ประเมินความเร็วเมฆฝนที่เคลื่อนที่สม่ำเสมอ', () => {
  const fr = frames([[20, 60], [23, 58], [26, 56], [29, 54]]);
  const v = R.estimateVelocity(fr, SIZE, R.kmPerPx(11.75, 7));
  assert.equal(v.ok, true);
  assert.ok(Math.abs(v.vx - 0.3) < 0.04, `vx ${v.vx}`);
  assert.ok(Math.abs(v.vy + 0.2) < 0.04, `vy ${v.vy}`);
  // ไปทางตะวันออกเฉียงเหนือ (x+ = ตะวันออก, y- = เหนือ)
  assert.ok(v.headingDeg > 40 && v.headingDeg < 70, `heading ${v.headingDeg}`);
  assert.ok(v.speedKmh > 20 && v.speedKmh < 26, `speed ${v.speedKmh}`);
});

test('ฝนที่กำลังเคลื่อนเข้าหาจุด → ได้ ETA', () => {
  // เมฆฝนอยู่ทางตะวันตก ขยับ +3 px / 10 นาที มุ่งหน้าเข้าหาจุดศูนย์กลาง
  const fr = frames([[22, 48.7], [25, 48.7], [28, 48.7], [31, 48.7]]);
  const a = R.analyze(fr, geo, fr[3].t + 2 * 60000);
  assert.equal(a.ok, true);
  assert.equal(a.atPointDbz, null);
  assert.ok(a.arrival, 'ควรมี arrival');
  assert.ok(a.arrival.etaMin >= 25 && a.arrival.etaMin <= 50, `eta ${a.arrival.etaMin}`);
  assert.ok(a.nearest.bearingDeg > 250 && a.nearest.bearingDeg < 290, `bearing ${a.nearest.bearingDeg}`);
});

test('ฝนที่เคลื่อนออกห่าง → ไม่มี arrival', () => {
  const fr = frames([[40, 48.7], [37, 48.7], [34, 48.7], [31, 48.7]]);
  const a = R.analyze(fr, geo, fr[3].t);
  assert.equal(a.ok, true);
  assert.equal(a.arrival, null);
  assert.ok(a.nearest && a.nearest.distKm < 30);
});

test('ฝนตกทับจุดอยู่แล้ว', () => {
  const fr = frames([[45, 48.7], [46, 48.7], [47, 48.7], [48, 48.7]]);
  const a = R.analyze(fr, geo, fr[3].t);
  assert.ok(a.atPointDbz >= 40);
  assert.equal(a.arrival, null);
});

test('ไม่มีสัญญาณเรดาร์เลย → ok แต่ไม่มีฝน ไม่มีทิศทาง', () => {
  const empty = () => new Float32Array(SIZE * SIZE).fill(R.NOECHO);
  const t0 = Date.parse('2026-10-12T05:00:00Z');
  const fr = [0, 1, 2].map(i => ({ t: t0 + i * 600000, field: empty() }));
  const a = R.analyze(fr, geo, fr[2].t);
  assert.equal(a.ok, true);
  assert.equal(a.atPointDbz, null);
  assert.equal(a.nearest, null);
  assert.equal(a.velocity.ok, false);
  assert.equal(a.arrival, null);
});

test('เฟรมเก่าเกินไป / ถอดรหัสผิดปกติ → ไม่ใช้', () => {
  const fr = frames([[20, 48], [23, 48], [26, 48]]);
  assert.equal(R.analyze(fr, geo, fr[2].t + 60 * 60000).reason, 'stale');
  const solid = fr.map(f => ({ t: f.t, field: new Float32Array(SIZE * SIZE).fill(30) }));
  assert.equal(R.analyze(solid, geo, solid[2].t).reason, 'decode');
});

test('ฝนนิ่งอยู่กับที่ → stationary ไม่คาดว่าจะเข้า', () => {
  const fr = frames([[30, 48.7], [30, 48.7], [30, 48.7]]);
  const a = R.analyze(fr, geo, fr[2].t);
  assert.equal(a.velocity.ok, true);
  assert.equal(a.velocity.stationary, true);
  assert.equal(a.arrival, null);
});

test('arrival รายงานความแรงสูงสุดที่ตามมา ไม่ใช่แค่ขอบเมฆฝน', () => {
  const fr = frames([[22, 48.7], [25, 48.7], [28, 48.7], [31, 48.7]]);
  const a = R.analyze(fr, geo, fr[3].t);
  assert.ok(a.arrival.peakDbz >= a.arrival.dbz);
  assert.ok(a.arrival.peakDbz > 30, `peak ${a.arrival.peakDbz}`);
});
