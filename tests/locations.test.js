const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/util.js');
require('../js/locations.js');
const { parseCoordPair, formatCoord } = globalThis.WX.locations;

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} !≈ ${b}`);

test('อ่านพิกัดได้ทุกรูปแบบที่ README ระบุ', () => {
  for (const s of ['12.2211831, 99.8770225', '12.2211831:99.8770225', '12.2211831 99.8770225', '12.2211831N, 99.8770225E']) {
    const p = parseCoordPair(s);
    assert.ok(p, s);
    near(p.lat, 12.2211831); near(p.lon, 99.8770225);
  }
  const dms = parseCoordPair('12°13\'16.3"N 99°52\'37.3"E');
  near(dms.lat, 12.221194); near(dms.lon, 99.876972);
});

test('วางสลับ lon,lat → สลับกลับให้ ; ค่าที่เป็นไปไม่ได้ → null', () => {
  const p = parseCoordPair('99.8770225, 12.2211831');
  near(p.lat, 12.2211831); near(p.lon, 99.8770225);
  assert.equal(parseCoordPair('abc'), null);
  assert.equal(parseCoordPair('200, 300'), null);
  assert.equal(parseCoordPair(''), null);
});

test('formatCoord', () => {
  assert.equal(formatCoord(11.756334, 99.7684976), '11.756334°N, 99.7684976°E');
  assert.equal(formatCoord(-1.5, -70), '1.5°S, 70°W');
});
