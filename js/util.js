(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  // เปลี่ยนทุกครั้งที่ออกเวอร์ชันใหม่ พร้อมกับ ?v= ใน index.html เพื่อบังคับให้เบราว์เซอร์โหลดไฟล์ใหม่
  WX.VERSION = '2.1.2';
  WX.RELEASED = '11 ต.ค. 2569';

  const TZ = 'Asia/Bangkok';
  const TZ_OFFSET_MS = 7 * 3600000; // UTC+7 คงที่ ไม่มี DST
  const HOUR_MS = 3600000;

  // Open-Meteo ถูกเรียกด้วย timezone=Asia/Bangkok → เวลาเป็น wall clock ไทยไม่มี offset
  // ต้องแปลงเอง ไม่งั้น new Date() จะตีความเป็นเวลาของเครื่องผู้ใช้
  function bkkToEpoch(s) {
    const [datePart, timePart = '00:00'] = String(s).split('T');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    return Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET_MS;
  }

  function bkkDateStr(epochMs = Date.now()) {
    return new Date(epochMs + TZ_OFFSET_MS).toISOString().slice(0, 10);
  }

  function bkkHourNum(epochMs) {
    return new Date(epochMs + TZ_OFFSET_MS).getUTCHours();
  }

  function bkkHM(epochMs) {
    const d = new Date(epochMs + TZ_OFFSET_MS);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }

  // เวลา "สิ้นสุด" ที่ตกเที่ยงคืนพอดีเขียนเป็น 24:00 — ถ้าเป็น 00:00 ช่วง 00:00-00:00 จะอ่านเหมือนยาวศูนย์ชั่วโมง
  function bkkHMEnd(epochMs) {
    const t = bkkHM(epochMs);
    return t === '00:00' ? '24:00' : t;
  }

  function addDays(dateStr, n) {
    return bkkDateStr(bkkToEpoch(dateStr) + n * 86400000);
  }

  function bkkDayLabel(dateStr, opts) {
    return new Date(bkkToEpoch(dateStr)).toLocaleDateString('th-TH', { timeZone: TZ, ...opts });
  }

  function bkkWeekday(dateStr) {
    return new Date(bkkToEpoch(dateStr) + TZ_OFFSET_MS).getUTCDay();
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function safeLS(fn, fallback = null) {
    try { return fn(); } catch (e) { return fallback; }
  }

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  // ensemble มีจำนวนสมาชิกจำกัด จึงไม่ควรโชว์ 0% หรือ 100% ตรง ๆ — ไม่มีใครรู้ว่าเป็นศูนย์จริง
  function fmtPct(p) {
    if (p == null || !Number.isFinite(p)) return '–';
    if (p >= 0.99) return '>99%';
    if (p < 0.01) return '<1%';
    return `${Math.round(p * 100)}%`;
  }

  function fmtMm(mm) {
    if (mm == null || !Number.isFinite(mm)) return '–';
    if (mm < 0.05) return '0';
    return mm < 10 ? mm.toFixed(1) : String(Math.round(mm));
  }

  function fmtAgo(ms, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 45) return 'เมื่อสักครู่';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} นาทีที่แล้ว`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ชม. ${m % 60} นาทีที่แล้ว`;
    return `${Math.floor(h / 24)} วันที่แล้ว`;
  }

  const COMPASS_TH = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
  function compassTh(deg) {
    return COMPASS_TH[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  // 18 dBZ ≈ 0.5 มม./ชม. (Marshall-Palmer) — ต่ำกว่านี้เรดาร์มักเป็นละอองหรือสัญญาณรบกวน
  const RAIN_DBZ = 18;
  function dbzClass(dbz) {
    if (dbz == null || dbz < RAIN_DBZ) return { level: 0, label: 'ไม่มีฝน' };
    if (dbz < 30) return { level: 1, label: 'ฝนเบา' };
    if (dbz < 40) return { level: 2, label: 'ฝนปานกลาง' };
    if (dbz < 50) return { level: 3, label: 'ฝนหนัก' };
    return { level: 4, label: 'ฝนหนักมาก/พายุ' };
  }

  WX.util = {
    TZ, TZ_OFFSET_MS, HOUR_MS, RAIN_DBZ,
    bkkToEpoch, bkkDateStr, bkkHourNum, bkkHM, bkkHMEnd, addDays, bkkDayLabel, bkkWeekday,
    esc, safeLS, clamp, fmtPct, fmtMm, fmtAgo, compassTh, dbzClass,
  };
})(typeof window !== 'undefined' ? window : globalThis);
