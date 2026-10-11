(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;

  // มะพร้าวเพิ่งปลูก 1-3 ปี รากตื้น — ต้องการน้ำสม่ำเสมอ
  const WEEKLY_TARGET_MM = 50;
  const DAILY_TARGET_MM = 8;

  function classifyWeek(totalMm) {
    if (totalMm >= WEEKLY_TARGET_MM) return { cls: 'good', icon: '✅', status: 'ดีมาก', desc: 'ฝนเพียงพอ ไม่ต้องรดน้ำ' };
    if (totalMm >= 30) return { cls: 'ok', icon: '🟡', status: 'พอใช้', desc: 'พอรอดได้ แต่ควรติดตาม' };
    if (totalMm >= 15) return { cls: 'warn', icon: '⚠️', status: 'ขาด', desc: 'ควรรดน้ำเสริม 1-2 ครั้งต่อสัปดาห์' };
    return { cls: 'crit', icon: '❌', status: 'วิกฤต', desc: 'ขาดน้ำมาก ต้องรดน้ำทุกวัน' };
  }

  // 1 มม. ที่ขาด ≈ 3 ลิตร/ต้น/สัปดาห์ (ค่าอนุรักษ์นิยมสำหรับทรงพุ่มเล็ก ~1-2 ม.²)
  function irrigationAdvice(weeklyDeficitMm) {
    if (weeklyDeficitMm <= 0) return null;
    const litersPerWeek = Math.max(10, Math.ceil(weeklyDeficitMm * 3 / 10) * 10);
    const litersPerDay = Math.ceil(litersPerWeek / 7);
    let freq = 'สัปดาห์ละ 2-3 ครั้ง';
    if (litersPerDay >= 20) freq = 'รดทุกวัน';
    else if (litersPerDay >= 8) freq = 'วันเว้นวัน';
    return { litersPerWeek, litersPerDay, freq };
  }

  function meter(totalMm, cls) {
    const pct = U.clamp(totalMm / WEEKLY_TARGET_MM, 0, 1) * 100;
    return `<div class="meter" role="img" aria-label="ฝนรวม ${U.fmtMm(totalMm)} จากเป้า ${WEEKLY_TARGET_MM} มม."><i class="meter-fill st-${cls}" style="width:${pct}%"></i></div>`;
  }

  // ctx: { ens, actual: Map(date→mm), detDaily: Map(date→mm) }
  function render(container, ctx) {
    const today = U.bkkDateStr();
    const nextDates = Array.from({ length: 7 }, (_, i) => U.addDays(today, i));
    const pastDates = Array.from({ length: 7 }, (_, i) => U.addDays(today, i - 7));

    const range = ctx.week || null;
    let nextTotal, nextNote;
    if (range) {
      nextTotal = range.p50;
      nextNote = `อาจอยู่ระหว่าง ${U.fmtMm(range.p10)} – ${U.fmtMm(range.p90)} มม. (จาก ${range.n} ชุดพยากรณ์)`;
    } else {
      nextTotal = nextDates.reduce((s, d) => s + (ctx.detDaily.get(d) ?? 0), 0);
      nextNote = 'จากโมเดลเดี่ยว — ไม่มีช่วงความไม่แน่นอน';
    }
    const nStatus = classifyWeek(nextTotal);
    const nDeficit = Math.max(0, WEEKLY_TARGET_MM - nextTotal);
    const nAdvice = irrigationAdvice(nDeficit);

    let dryBlock = '';
    if (range) {
      const dryAdvice = irrigationAdvice(Math.max(0, WEEKLY_TARGET_MM - range.p25));
      if (dryAdvice && (!nAdvice || dryAdvice.litersPerWeek > nAdvice.litersPerWeek)) {
        dryBlock = `<p class="note warn-note">🌤️ <b>ถ้าฝนมาน้อยกว่าคาด</b> (โอกาส 25%: ได้ฝนแค่ ${U.fmtMm(range.p25)} มม.) เตรียมรดเพิ่มเป็น <b>${dryAdvice.litersPerWeek} ลิตร/ต้น/สัปดาห์</b></p>`;
      }
    }

    const missing = pastDates.filter(d => !ctx.actual.has(d)).length;
    const pastTotal = pastDates.reduce((s, d) => s + (ctx.actual.get(d) ?? 0), 0);
    const pStatus = classifyWeek(pastTotal);
    const pDeficit = Math.max(0, WEEKLY_TARGET_MM - pastTotal);

    container.innerHTML = `
      <div class="coconut-grid">
        <div class="coconut-week">
          <div class="coconut-title">7 วันข้างหน้า (พยากรณ์)</div>
          <div class="coconut-status st-text-${nStatus.cls}"><span aria-hidden="true">${nStatus.icon}</span> ${nStatus.status}</div>
          ${meter(nextTotal, nStatus.cls)}
          <p class="coconut-total">ฝนรวมค่ากลาง <b>${U.fmtMm(nextTotal)} มม.</b> / เป้า ${WEEKLY_TARGET_MM} มม.<br><span class="muted">${nextNote}</span></p>
          <p class="muted">${nStatus.desc}${range && range.probs && range.probs[WEEKLY_TARGET_MM] != null ? ` · โอกาสได้ฝนครบเป้า ${U.fmtPct(range.probs[WEEKLY_TARGET_MM])}` : ''}</p>
          ${nAdvice
            ? `<p class="advice">💧 รดน้ำ <b>${nAdvice.litersPerWeek} ลิตร/ต้น/สัปดาห์</b><br><span class="muted">≈ ${nAdvice.litersPerDay} ลิตร/ต้น/วัน · ${nAdvice.freq}</span></p>`
            : '<p class="advice good-note">✅ ฝนเพียงพอ ไม่ต้องรดน้ำเสริม</p>'}
          ${dryBlock}
        </div>
        <div class="coconut-week">
          <div class="coconut-title">7 วันที่ผ่านมา (ฝนจริงจากข้อมูลวิเคราะห์)</div>
          <div class="coconut-status st-text-${pStatus.cls}"><span aria-hidden="true">${pStatus.icon}</span> ${pStatus.status}</div>
          ${meter(pastTotal, pStatus.cls)}
          <p class="coconut-total">ฝนรวม <b>${U.fmtMm(pastTotal)} มม.</b> / เป้า ${WEEKLY_TARGET_MM} มม.</p>
          <p class="muted">${pStatus.desc}</p>
          ${pDeficit > 0
            ? `<p class="advice muted">📊 ขาดจากเป้า ${U.fmtMm(pDeficit)} มม. — ถ้ามะพร้าวยังไม่ฟื้นตัวให้รดเสริม${missing ? `<br>⏳ ขาดข้อมูล ${missing} วัน — ยอดจริงอาจสูงกว่านี้` : ''}</p>`
            : '<p class="advice good-note">✅ ฝนเพียงพอตลอดสัปดาห์</p>'}
        </div>
      </div>
      <p class="note">🥥 เป้าหมาย <b>${WEEKLY_TARGET_MM} มม./สัปดาห์</b> (≈ ${DAILY_TARGET_MM} มม./วัน) · 1 มม. ที่ขาด ≈ 3 ลิตร/ต้น (ค่าอนุรักษ์นิยม) · ห้ามขาดน้ำเกิน 3 วัน · รดช่วงเช้าหรือเย็น</p>`;
  }

  WX.coconut = { WEEKLY_TARGET_MM, classifyWeek, irrigationAdvice, render };
})(typeof window !== 'undefined' ? window : globalThis);
