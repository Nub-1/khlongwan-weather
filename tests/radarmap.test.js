const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/sources.js');
require('../js/radarmap.js');
const { util: U, radarMap: RM, sources: SRC } = globalThis.WX;

const NOW = Date.parse('2026-10-12T07:03:00Z'); // 14:03 น.
const lastRadar = Math.floor(NOW / 600000) * 600 - 600; // 13:50
const past = Array.from({ length: 13 }, (_, i) => ({ time: lastRadar - (12 - i) * 600, path: `/v2/radar/h${i}` }));
const hourLabel = h => new Date(Date.parse('2026-10-12T00:00:00Z') + h * 3600000).toISOString().slice(0, 16); // ป้ายเวลาไทย (wall clock)
const gridTimes = Array.from({ length: 24 }, (_, h) => hourLabel(h)); // 00:00–23:00 น.

test('pickRadarPast: ชั่วโมงล่าสุดทุก 10 นาที ก่อนนั้นทุก 20 นาที', () => {
  const p = RM.pickRadarPast(past);
  assert.equal(p.length, 7 + 3);
  assert.equal(p[p.length - 1].time, lastRadar);
  assert.equal(p[0].time, lastRadar - 7200);
});

test('ไทม์ไลน์ −6 ถึง +6 ชม.: แบบจำลอง → เรดาร์ → คาดการณ์จากเรดาร์ → แบบจำลอง', () => {
  const { frames, nowIdx } = RM.buildTimeline({ radarPast: RM.pickRadarPast(past), hasFuture: true, gridTimes, nowMs: NOW });
  const kinds = frames.map(f => f.kind);
  assert.equal(frames[nowIdx].ms, lastRadar * 1000);
  assert.equal(frames[nowIdx].kind, 'radar');
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].ms > frames[i - 1].ms, 'เรียงตามเวลา');
  assert.equal(kinds.filter(k => k === 'extrap').length, 6);
  // แบบจำลองไม่ซ้อนกับช่วงที่มีเรดาร์
  const radarStart = frames.find(f => f.kind === 'radar').ms;
  const extrapEnd = [...frames].reverse().find(f => f.kind === 'extrap').ms;
  for (const f of frames.filter(x => x.kind === 'model')) assert.ok(f.ms < radarStart || f.ms > extrapEnd);
  assert.ok(frames[0].ms >= NOW - 6 * 3600000 - 300000 && frames[0].kind === 'model');
  assert.ok(frames[frames.length - 1].ms <= NOW + 6 * 3600000 + 300000 && frames[frames.length - 1].kind === 'model');
});

test('ไม่มีเรดาร์ → ใช้แบบจำลองทั้งหมด และ "ตอนนี้" อยู่ใกล้เวลาปัจจุบัน', () => {
  const { frames, nowIdx } = RM.buildTimeline({ radarPast: [], hasFuture: false, gridTimes, nowMs: NOW });
  assert.ok(frames.every(f => f.kind === 'model'));
  assert.ok(Math.abs(frames[nowIdx].ms - NOW) <= 3600000);
});

test('rateColor ใช้ระดับเดียวกับเรดาร์', () => {
  assert.equal(RM.rateColor(0.05), null);
  assert.deepEqual(RM.rateColor(1), [0x00, 0x69, 0x9c]);
  assert.deepEqual(RM.rateColor(40), [0xff, 0x81, 0xff]);
});

test('gridPoints / parseGrid', () => {
  const g = SRC.gridPoints(11.75, 99.77);
  assert.equal(g.lats.length, 49);
  assert.ok(g.lats[0] > g.lats[48], 'แถวแรกอยู่เหนือ');
  assert.ok(g.lons[0] < g.lons[6], 'คอลัมน์ซ้ายอยู่ตะวันตก');
  const json = g.lats.map((_, p) => ({ hourly: { time: ['2026-10-12T13:00', '2026-10-12T14:00'], precipitation: [p, null] } }));
  const parsed = SRC.parseGrid(json, g);
  assert.equal(parsed.values.length, 2);
  assert.equal(parsed.values[0][10], 10);
  assert.equal(parsed.values[1][0], null);
  assert.throws(() => SRC.parseGrid(json.slice(1), g));
});
