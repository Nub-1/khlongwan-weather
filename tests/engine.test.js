const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/engine.js');
const { util: U, engine: E } = globalThis.WX;

const START = '2026-10-12';

function label(i, start = START) {
  return new Date(U.bkkToEpoch(start) + i * 3600000 + U.TZ_OFFSET_MS).toISOString().slice(0, 16);
}

// members: array ของฟังก์ชัน i -> mm (หรือ null)
function hourly(members, hours = 48, start = START) {
  const h = { time: Array.from({ length: hours }, (_, i) => label(i, start)) };
  members.forEach((fn, k) => {
    h[k === 0 ? 'precipitation' : `precipitation_member${String(k).padStart(2, '0')}`] =
      Array.from({ length: hours }, (_, i) => fn(i));
  });
  return h;
}

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test('weightedQuantile', () => {
  assert.equal(E.weightedQuantile([1, 2, 3, 4], [1, 1, 1, 1], 0.5), 2);
  assert.equal(E.weightedQuantile([4, 1, 3, 2], [1, 1, 1, 1], 1), 4);
  assert.equal(E.weightedQuantile([0, 10], [9, 1], 0.5), 0);
  assert.equal(E.weightedQuantile([0, 10], [1, 9], 0.5), 10);
});

test('น้ำหนักเท่ากันต่อระบบ ไม่ใช่ต่อสมาชิก', () => {
  const dry = Array.from({ length: 10 }, () => () => 0);
  const wet = Array.from({ length: 2 }, () => () => 5);
  const ens = E.buildEnsemble([
    { id: 'a', hourly: hourly(dry) },
    { id: 'b', hourly: hourly(wet) },
  ]);
  const d = E.hourDist(ens, 5);
  near(d.pWet, 0.5);
  assert.equal(d.nModels, 2);
});

test('precipitation ป้ายเวลา T = ฝนของชั่วโมงก่อนหน้า → 00:00 ของวันถัดไปนับเป็นของวันนี้', () => {
  // ฝน 1 มม. เฉพาะป้าย 2026-10-13T00:00 (index 24) = ชั่วโมง 23:00-24:00 ของวันที่ 12
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly([() => 0, i => (i === 24 ? 1 : 0)].map(f => f), 72) }]);
  assert.equal(ens.dateOf[24], '2026-10-12');
  const d12 = E.dailyDist(ens, '2026-10-12');
  const d13 = E.dailyDist(ens, '2026-10-13');
  near(d12.mean, 0.5);
  near(d13.mean, 0);
  near(d12.probs[1], 0.5);
});

test('ไม่ให้ 0% / 100% ตรง ๆ', () => {
  assert.equal(U.fmtPct(1), '>99%');
  assert.equal(U.fmtPct(0), '<1%');
  assert.equal(U.fmtPct(0.724), '72%');
});

test('ระบบที่ข้อมูลสั้นกว่า (ICON) ถูกปรับน้ำหนักใหม่ ไม่นับเป็น "ไม่ตก"', () => {
  const longWet = Array.from({ length: 5 }, () => () => 4);
  const shortDry = Array.from({ length: 5 }, () => i => (i < 24 ? 0 : null));
  const ens = E.buildEnsemble([
    { id: 'long', hourly: hourly(longWet, 48) },
    { id: 'short', hourly: hourly(shortDry, 48) },
  ]);
  near(E.hourDist(ens, 10).pWet, 0.5);
  const later = E.hourDist(ens, 30);
  near(later.pWet, 1);
  assert.equal(later.nModels, 1);
});

test('วันที่ข้อมูลไม่ครบ → null', () => {
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly([() => 0], 30) }]);
  assert.ok(E.dailyDist(ens, '2026-10-12'));
  assert.equal(E.dailyDist(ens, '2026-10-13'), null);
});

test('nextRainOnset: ช่วงเวลาเริ่มตกเป็นการกระจาย ไม่ใช่เวลาเดียว', () => {
  // 4 สมาชิก เริ่มตกที่ index 6, 8, 10 และไม่ตกเลย
  const starts = [6, 8, 10, null];
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly(starts.map(s => i => (s != null && i === s ? 3 : 0)), 48) }]);
  const now = U.bkkToEpoch(label(2));
  const o = E.nextRainOnset(ens, now);
  near(o.pAny, 0.75);
  assert.equal(o.p50, ens.slotStart[8]);
  assert.equal(o.p10, ens.slotStart[6]);
  assert.equal(o.p90, ens.slotStart[10]);
});

test('nextRainOnset: ฝนกำลังตกในชั่วโมงปัจจุบัน → onset = now', () => {
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly([i => (i === 3 ? 2 : 0)], 24) }]);
  const now = U.bkkToEpoch(label(2)) + 30 * 60000; // ครึ่งชั่วโมงหลังป้าย 02:00 → อยู่ในช่อง 02:00-03:00
  const o = E.nextRainOnset(ens, now);
  assert.equal(o.p50, now);
  near(o.pOngoing, 1);
});

test('findWindows รวมชั่วโมงติดกัน และคำนวณปริมาณรวมจากสมาชิก', () => {
  const m = [0, 1, 2, 3].map(() => i => (i >= 10 && i <= 12 ? 2 : 0));
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly(m, 48) }]);
  const w = E.findWindows(ens, U.bkkToEpoch(label(0)), U.bkkToEpoch(label(40)));
  assert.equal(w.length, 1);
  assert.equal(w[0].hours, 3);
  assert.equal(w[0].startMs, ens.slotStart[10]);
  assert.equal(w[0].endMs, ens.epochs[12]);
  near(w[0].total.p50, 6);
});

test('periodDist: ช่วงบ่ายใช้ชั่วโมงเริ่มต้น 12-18', () => {
  // ตกเฉพาะช่อง 13:00-14:00 (ป้าย 14:00 → index 14)
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly([() => 0, i => (i === 14 ? 1 : 0)], 48) }]);
  const aft = E.CFG.PERIODS.find(p => p.id === 'afternoon');
  const mor = E.CFG.PERIODS.find(p => p.id === 'morning');
  near(E.periodDist(ens, START, aft).pAny, 0.5);
  near(E.periodDist(ens, START, mor).pAny, 0);
});

test('rangeTotal รวมรายสมาชิกก่อนหาควอนไทล์', () => {
  // สมาชิก A ตก 10 มม. วันที่ 1 ; B ตก 10 มม. วันที่ 2 → รวม 2 วันทั้งคู่ 10
  const a = i => (i === 5 ? 10 : 0);
  const b = i => (i === 30 ? 10 : 0);
  const ens = E.buildEnsemble([{ id: 'x', hourly: hourly([a, b], 72) }]);
  const r = E.rangeTotal(ens, ['2026-10-12', '2026-10-13']);
  near(r.p10, 10);
  near(r.p90, 10);
  const one = E.rangeTotal(ens, ['2026-10-12']);
  near(one.p10, 0);
  near(one.p90, 10);
});

test('describeProb / classifyDay / classifyHour', () => {
  assert.equal(E.describeProb(0.05).level, 0);
  assert.equal(E.describeProb(0.1).level, 1);
  assert.equal(E.describeProb(0.69).label, 'มีโอกาสฝนสูง');
  assert.equal(E.describeProb(0.99).label, 'เกือบแน่ว่าฝนตก');
  assert.equal(E.classifyDay(10).label, 'ฝนเล็กน้อย');
  assert.equal(E.classifyDay(10.1).label, 'ฝนปานกลาง');
  assert.equal(E.classifyDay(36).label, 'ฝนหนัก');
  assert.equal(E.classifyHour(0.1).level, 0);
  assert.equal(E.classifyHour(3).label, 'ฝนปานกลาง');
});

test('dailyFromHourly ใช้วันของชั่วโมงเริ่มต้น และตัดวันที่ไม่ครบ', () => {
  const h = hourly([i => (i === 0 ? 5 : 1)], 48);
  const m = E.dailyFromHourly(h.time, h.precipitation);
  // ป้าย index 0 (00:00 ของวันที่ 12) เป็นของวันที่ 11 → ไม่ครบ ถูกตัด ; วันที่ 12 = index 1..24 (24 ช่อง) ; วันที่ 13 = index 25..47 (23 ช่อง)
  assert.equal(m.has('2026-10-11'), false);
  assert.equal(m.get('2026-10-12'), 24);
  assert.equal(m.get('2026-10-13'), 23);
});

test('scoreForecasts', () => {
  const obs = new Map([['d1', 5], ['d2', 0], ['d3', 3], ['d4', 0]]);
  const fc = new Map([['d1', 4], ['d2', 2], ['d3', 0], ['d4', 0]]);
  const s = E.scoreForecasts(obs, fc, 1);
  assert.deepEqual([s.hits, s.falseAlarms, s.misses, s.correctNeg], [1, 1, 1, 1]);
  near(s.pod, 0.5); near(s.far, 0.5); near(s.csi, 1 / 3); near(s.freqBias, 1);
  near(s.mae, (1 + 2 + 3 + 0) / 4);
  assert.equal(E.scoreForecasts(new Map(), new Map()), null);
});

test('capeLevel / capeMaxByDate', () => {
  assert.equal(E.capeLevel(500), 0);
  assert.equal(E.capeLevel(1500), 1);
  assert.equal(E.capeLevel(3000), 2);
  assert.equal(E.capeLevel(null), 0);
  const times = [label(14), label(15), label(38), label(30)];
  const m = E.capeMaxByDate(times, [800, 2000, 500, 9999]);
  assert.equal(m.get('2026-10-12'), 2000);
  assert.equal(m.get('2026-10-13'), 500);
});

test('nowVerdict: เรดาร์ชนะโมเดล และค่าเดียวใช้ทุกแผง', () => {
  const longdoDry = { ok: true, intensity: 0, desc: 'ไม่มีฝน' };
  const v1 = E.nowVerdict({ longdo: longdoDry, radar: { ok: false }, model: { ok: true, isRainy: true } });
  assert.equal(v1.state, 'dry');
  assert.equal(v1.observed, true);

  const v2 = E.nowVerdict({ longdo: { ok: false }, radar: { ok: false }, model: { ok: true, isRainy: true } });
  assert.equal(v2.state, 'model_rain');
  assert.equal(v2.observed, false);

  const v3 = E.nowVerdict({ longdo: { ok: true, intensity: 2, desc: 'ฝนเบา' }, radar: { ok: true, atPointDbz: null }, model: null });
  assert.equal(v3.state, 'raining');
  assert.ok(v3.lines.some(l => l.includes('ไม่ตรงกัน')));

  const v4 = E.nowVerdict({
    longdo: longdoDry,
    radar: { ok: true, atPointDbz: null, arrival: { etaMin: 22, dbz: 35 }, nearest: { distKm: 12, bearingDeg: 270 }, velocity: { ok: true, headingDeg: 90, speedKmh: 28 } },
    model: null,
  });
  assert.equal(v4.state, 'approaching');
  assert.ok(v4.title.includes('20'));
  assert.ok(v4.lines.some(l => l.includes('ตะวันตก')));

  const v5 = E.nowVerdict({ longdo: null, radar: { ok: true, atPointDbz: null, arrival: null, nearest: { distKm: 40, bearingDeg: 0 } }, model: null });
  assert.equal(v5.state, 'dry');

  assert.equal(E.nowVerdict({ longdo: null, radar: null, model: null }).state, 'unknown');
});

test('ช่วงปริมาณ "ถ้าฝนตก" ไม่ถูกลากลงเป็น 0 ด้วยสมาชิกที่แห้ง', () => {
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly([() => 0, i => (i === 5 ? 10 : 0)], 48) }]);
  const d = E.dailyDist(ens, START);
  near(d.probs[1], 0.5);
  assert.equal(d.p50, 0);
  near(d.cond.p50, 10);
  near(d.mean, 5);
});

test('nextRainOnset ให้ช่วงกลาง 50% (p25-p75)', () => {
  const starts = [6, 7, 8, 9, 20];
  const ens = E.buildEnsemble([{ id: 'a', hourly: hourly(starts.map(s => i => (i === s ? 3 : 0)), 48) }]);
  const o = E.nextRainOnset(ens, U.bkkToEpoch(label(2)));
  assert.ok(o.p25 <= o.p50 && o.p50 <= o.p75);
  assert.equal(o.p25, ens.slotStart[7]);
  assert.equal(o.p75, ens.slotStart[9]);
});
