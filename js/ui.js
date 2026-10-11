(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const E = WX.engine;
  const $ = id => document.getElementById(id);

  // ============ Helpers ============
  function dayName(date, today) {
    if (date === today) return 'วันนี้';
    if (date === U.addDays(today, 1)) return 'พรุ่งนี้';
    return U.bkkDayLabel(date, { weekday: 'long' });
  }
  const dayShort = date => U.bkkDayLabel(date, { day: 'numeric', month: 'short' });

  // เวลาเริ่ม/จบ พร้อมคำนำหน้าวันเมื่อไม่ใช่วันนี้
  function whenLabel(ms, nowMs) {
    const t = U.bkkHM(ms);
    const d = U.bkkDateStr(ms), today = U.bkkDateStr(nowMs);
    if (d === today) return t;
    return `${dayName(d, today)} ${t}`;
  }

  function age(r, now) { return r && r.fetchedAt ? U.fmtAgo(r.fetchedAt, now) : ''; }
  const short = s => U.esc(String(s || '').slice(0, 80));

  function modelIsRainy(cur) {
    if (!cur) return false;
    const c = cur.weather_code;
    return (cur.precipitation ?? 0) >= 0.1 || (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
  }

  // ============ 1. Now ============
  function renderNow(S, el) {
    const v = S.verdict;
    const cur = S.fc && S.fc.current;
    const chips = [];
    if (cur && cur.temperature_2m != null) {
      const feels = cur.apparent_temperature != null ? ` <small>รู้สึก ${Math.round(cur.apparent_temperature)}°</small>` : '';
      chips.push(`<span class="chip">🌡️ ${cur.temperature_2m.toFixed(1)}°C${feels}</span>`);
    }
    if (cur && cur.relative_humidity_2m != null) chips.push(`<span class="chip">💧 ${Math.round(cur.relative_humidity_2m)}%</span>`);
    if (cur && cur.wind_speed_10m != null) {
      const dir = cur.wind_direction_10m != null ? ` จาก${U.compassTh(cur.wind_direction_10m)}` : '';
      const gust = cur.wind_gusts_10m != null && cur.wind_gusts_10m > cur.wind_speed_10m + 8 ? ` <small>กระโชก ${Math.round(cur.wind_gusts_10m)}</small>` : '';
      chips.push(`<span class="chip">🍃 ${Math.round(cur.wind_speed_10m)} กม./ชม.${dir}${gust}</span>`);
    }

    const rows = [];
    const lg = S.res.longdo_rain;
    if (lg && lg.ok) rows.push(`<li class="ok"><span class="mk">✓</span> Longdo เรดาร์: ${U.esc(v.sources.find(s => s.id === 'longdo')?.text || '')} <small>${age(lg, S.now)}</small></li>`);
    else rows.push(`<li class="bad"><span class="mk">✗</span> Longdo เรดาร์: ${lg ? short(lg.error) : 'กำลังโหลด...'}</li>`);

    const rv = S.res.radar;
    if (S.radar && S.radar.ok) {
      const t = S.radar.frameTimeMs;
      rows.push(`<li class="ok"><span class="mk">✓</span> RainViewer เรดาร์: ข้อมูล ณ ${U.bkkHM(t)} <small>(${U.fmtAgo(t, S.now)}${S.radar.nearest && !S.radar.velocity?.ok ? ' · ยังประเมินทิศทางฝนไม่ได้' : ''})</small></li>`);
    } else if (rv && !rv.ok) {
      rows.push(`<li class="bad"><span class="mk">✗</span> RainViewer เรดาร์: ${short(rv.error)}</li>`);
    } else if (S.radar && S.radar.reason) {
      const why = { stale: 'ภาพเรดาร์เก่าเกินไป', decode: 'ถอดค่าเรดาร์ไม่ผ่านการตรวจสอบ', noframes: 'ไม่มีภาพ', decode_error: `อ่านค่าเรดาร์ไม่ได้ (${S.radar.message || ''}) — ยังดูภาพบนแผนที่ได้` }[S.radar.reason] || S.radar.reason;
      rows.push(`<li class="bad"><span class="mk">✗</span> RainViewer เรดาร์: ${U.esc(why)}</li>`);
    } else {
      rows.push('<li class="bad"><span class="mk">…</span> RainViewer เรดาร์: กำลังโหลด...</li>');
    }
    if (cur) rows.push(`<li class="ref"><span class="mk">○</span> โมเดล (อ้างอิงเท่านั้น): ${U.fmtMm(cur.precipitation ?? 0)} มม./ชม. <small>${v.observed ? 'ไม่ใช้ตัดสินเมื่อมีเรดาร์' : 'ใช้แทนเพราะไม่มีเรดาร์'}</small></li>`);

    el.className = `card hero state-${v.state}`;
    el.innerHTML = `
      <div class="hero-main">
        <div class="hero-icon" aria-hidden="true">${v.icon}</div>
        <div>
          <p class="eyebrow">ตอนนี้ · ${U.bkkHM(S.now)} น.</p>
          <h2 class="hero-title">${U.esc(v.title)}</h2>
          ${v.lines.length ? `<ul class="hero-lines">${v.lines.map(l => `<li>${U.esc(l)}</li>`).join('')}</ul>` : ''}
        </div>
      </div>
      ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
      <ul class="src-list">${rows.join('')}</ul>`;
  }

  // ============ 2. Next rain ============
  function renderNext(S, el) {
    if (!S.ens) {
      const det = S.fc && S.fc.daily;
      const i = det ? det.time.indexOf(S.today) : -1;
      el.innerHTML = i >= 0
        ? `<p>วันนี้ โมเดลเดี่ยวให้ฝน <b>${U.fmtMm(det.precipitation_sum[i])} มม.</b> (โอกาส ${det.precipitation_probability_max?.[i] ?? '–'}%)</p><p class="note warn-note">⚠️ ไม่มีข้อมูล ensemble — ไม่มีช่วงความไม่แน่นอนและเวลาเริ่มตก</p>`
        : '<p class="muted">ยังไม่มีข้อมูลพยากรณ์</p>';
      return;
    }
    const today = E.dailyDist(S.ens, S.today);
    const parts = [];
    if (today) {
      const p = today.probs[1];
      const d = E.describeProb(p);
      const amt = today.cond && p >= 0.1
        ? `ถ้าฝนตก คาดราว ${U.fmtMm(today.cond.p10)}–${U.fmtMm(today.cond.p90)} มม. (กลาง ${U.fmtMm(today.cond.p50)})`
        : 'ปริมาณฝนที่คาดน้อยมาก';
      parts.push(`<div class="next-head"><span class="big-p">${U.fmtPct(p)}</span><div><b>วันนี้ ${d.label}</b><br><span class="muted">โอกาสที่ฝนรวมทั้งวันจะ ≥ 1 มม. · ${amt}</span></div></div>`);
    }

    const on = E.nextRainOnset(S.ens, S.now, { horizonH: 24 });
    const wins = E.findWindows(S.ens, S.now, S.now + 48 * U.HOUR_MS);
    const inWin = wins.find(w => w.startMs <= S.now && w.endMs > S.now);
    if (S.verdict.state === 'raining' && inWin) {
      parts.push(`<p>🌧️ โมเดลคาดว่าช่วงที่มีโอกาสฝนต่อเนื่องไปถึงราว <b>${whenLabel(inWin.endMs, S.now)}</b></p>`);
    } else if (S.verdict.state === 'raining') {
      let pNow = null;
      for (let i = 0; i < S.ens.epochs.length; i++) {
        if (S.ens.slotStart[i] <= S.now && S.ens.epochs[i] > S.now) { const d = E.hourDist(S.ens, i); pNow = d ? d.pWet : null; break; }
      }
      parts.push(`<p class="note warn-note">ℹ️ เรดาร์เห็นฝนตกอยู่ แต่โมเดลให้โอกาสฝนชั่วโมงนี้เพียง ${U.fmtPct(pNow)} — ให้เชื่อเรดาร์ ส่วนเวลาที่ฝนจะหยุดตอนนี้ยังประเมินไม่ได้</p>`);
    } else if (on) {
      if (on.pAny < 0.15) parts.push(`<p>⏱️ 24 ชม.ข้างหน้า โอกาสที่ฝนจะเริ่มตก <b>${U.fmtPct(on.pAny)}</b> — ต่ำ</p>`);
      else {
        const at = ms => (ms === S.now ? 'ตอนนี้' : whenLabel(ms, S.now));
        parts.push(`<p>⏱️ ฝนก้อนถัดไปน่าจะเริ่มราว <b>${at(on.p50)}</b> <span class="muted">(ครึ่งหนึ่งของผลพยากรณ์ที่ให้ฝนอยู่ในช่วง ${at(on.p25)} – ${at(on.p75)})</span><br><span class="muted">โอกาสที่ฝนจะเริ่มตกภายใน 24 ชม. ${U.fmtPct(on.pAny)}${on.pOngoing >= 0.1 ? ` · โอกาสฝนตกอยู่แล้วชั่วโมงนี้ ${U.fmtPct(on.pOngoing)}` : ''}</span></p>`);
      }
    }

    const future = wins.filter(w => w.endMs > S.now).slice(0, 4);
    if (future.length) {
      parts.push('<ul class="win-list">' + future.map(w => `<li><b>${whenLabel(Math.max(w.startMs, S.now), S.now)} – ${U.bkkHMEnd(w.endMs)}</b> <span class="muted">โอกาสสูงสุด ${U.fmtPct(w.peakP)}${w.total ? ` · ปริมาณ ${U.fmtMm(w.total.p10)}–${U.fmtMm(w.total.p90)} มม.` : ''}</span></li>`).join('') + '</ul>');
    }
    if (S.instability && S.instability.today) {
      parts.push(`<p class="note warn-note">⚡ ${S.instability.today}</p>`);
    }
    el.innerHTML = parts.join('') || '<p class="muted">ยังไม่มีข้อมูลพยากรณ์</p>';
  }

  // ============ 3. 48h timeline ============
  function renderTimeline(S, el) {
    const det = S.fc && S.fc.hourly;
    const cols = [];
    if (S.ens) {
      for (let i = 0; i < S.ens.epochs.length && cols.length < 48; i++) {
        if (S.ens.epochs[i] <= S.now) continue;
        const d = E.hourDist(S.ens, i);
        if (d) cols.push({ endMs: S.ens.epochs[i], pWet: d.pWet, pHeavy: d.pHeavy, p50: d.p50, p90: d.p90, time: S.ens.times[i] });
      }
    } else if (det) {
      for (let i = 0; i < det.time.length && cols.length < 48; i++) {
        const endMs = U.bkkToEpoch(det.time[i]);
        if (endMs <= S.now) continue;
        const pop = (det.precipitation_probability?.[i] ?? 0) / 100;
        cols.push({ endMs, pWet: pop, pHeavy: (det.precipitation?.[i] ?? 0) >= E.CFG.HOUR_HEAVY_MM ? 1 : 0, p50: det.precipitation?.[i] ?? 0, p90: null, time: det.time[i], det: true });
      }
    }
    if (!cols.length) { el.innerHTML = '<p class="muted">ยังไม่มีข้อมูลรายชั่วโมง</p>'; return; }

    const hIdx = det ? new Map(det.time.map((t, i) => [t, i])) : new Map();
    let prevDate = null;
    const html = cols.map((c, k) => {
      const startMs = c.endMs - U.HOUR_MS;
      const date = U.bkkDateStr(startMs);
      const hr = U.bkkHourNum(startMs);
      const j = hIdx.get(c.time);
      const cape = j != null ? det.cape?.[j] : null;
      const lvl = E.capeLevel(cape);
      const temp = j != null ? det.temperature_2m?.[j] : null;
      const newDay = date !== prevDate;
      prevDate = date;
      const heavy = c.pHeavy < 0.05 ? 1 : c.pHeavy < 0.25 ? 2 : c.pHeavy < 0.5 ? 3 : 4;
      const h = c.pWet >= 0.01 ? Math.max(c.pWet * 100, 4) : 0;
      const tip = `${U.bkkHM(startMs)}–${U.bkkHMEnd(c.endMs)} · โอกาสฝน ${U.fmtPct(c.pWet)} · ปริมาณกลาง ${U.fmtMm(c.p50)} มม./ชม.${c.p90 != null ? ` (สูงสุดที่เป็นไปได้ ~${U.fmtMm(c.p90)})` : ''}${temp != null ? ` · ${Math.round(temp)}°C` : ''}${lvl ? ` · ⚡ บรรยากาศไม่เสถียร (CAPE ${Math.round(cape)})` : ''}`;
      return `<button type="button" class="tl-col${k === 0 ? ' now' : ''}${newDay && k > 0 ? ' newday' : ''}" data-tip="${U.esc(tip)}" aria-label="${U.esc(tip)}">
        ${newDay ? `<span class="tl-day">${dayName(date, S.today)} ${dayShort(date)}</span>` : ''}
        <span class="tl-plot"><i class="tl-bar r${heavy}" style="height:${h}%"></i></span>
        <span class="tl-cape c${lvl}"></span>
        <span class="tl-hr">${hr % 3 === 0 ? String(hr).padStart(2, '0') : ''}</span>
      </button>`;
    }).join('');

    el.innerHTML = `
      ${S.ens ? '' : '<p class="note warn-note">⚠️ ไม่มีข้อมูล ensemble — ใช้โอกาสฝนจากโมเดลเดี่ยว</p>'}
      <div class="tl-scroll" id="tl-scroll"><div class="tl-track">${html}</div></div>
      <p class="tl-detail" id="tl-detail" aria-live="polite">แตะที่แท่งเพื่อดูรายละเอียดรายชั่วโมง</p>
      <div class="legend">
        <span><i class="sw r1"></i><i class="sw r2"></i><i class="sw r3"></i><i class="sw r4"></i> ความสูง = โอกาสมีฝน ≥ ${E.CFG.HOUR_WET_MM} มม./ชม. · สีเข้ม = โอกาสฝนหนัก (≥ ${E.CFG.HOUR_HEAVY_MM} มม./ชม.) สูงขึ้น</span>
        <span><i class="sw c1"></i><i class="sw c2"></i> แถบล่าง = บรรยากาศไม่เสถียร (CAPE) — ฝนฟ้าคะนองเฉพาะที่เกิดได้แม้โมเดลไม่ให้ฝน</span>
      </div>`;
  }

  // ============ 4. 7-day ============
  function renderDaily(S, el) {
    const det = S.fc && S.fc.daily;
    const rows = [];
    for (let i = 0; i < E.CFG.DETAILED_DAYS; i++) {
      const date = U.addDays(S.today, i);
      const di = det ? det.time.indexOf(date) : -1;
      const tmax = di >= 0 ? det.temperature_2m_max?.[di] : null;
      const tmin = di >= 0 ? det.temperature_2m_min?.[di] : null;
      const dist = S.ens ? E.dailyDist(S.ens, date) : null;
      let p, amt, extra = '', periods = '';
      if (dist) {
        p = dist.probs[1];
        amt = p < 0.1 || !dist.cond
          ? '<span class="muted">ปริมาณฝนที่คาดน้อยมาก</span>'
          : `ถ้าฝนตก ราว <b>${U.fmtMm(dist.cond.p10)}–${U.fmtMm(dist.cond.p90)} มม.</b> <span class="muted">กลาง ${U.fmtMm(dist.cond.p50)}</span>`;
        if (dist.probs[10] >= 0.15) extra += `<span class="tag">≥10 มม. ${U.fmtPct(dist.probs[10])}</span>`;
        if (dist.probs[35] >= 0.05) extra += `<span class="tag hot">≥35 มม. ${U.fmtPct(dist.probs[35])}</span>`;
        periods = E.CFG.PERIODS.map(pe => {
          const pd = E.periodDist(S.ens, date, pe);
          const v = pd ? pd.pAny : null;
          return `<span class="per" title="${pe.label} ${String(pe.from).padStart(2, '0')}–${String(pe.to).padStart(2, '0')} น. โอกาสมีฝน ${U.fmtPct(v)}"><i style="height:${v == null ? 0 : Math.max(v * 100, v > 0.02 ? 6 : 0)}%"></i><b>${pe.label}</b></span>`;
        }).join('');
      } else if (di >= 0) {
        const pm = det.precipitation_probability_max?.[di];
        p = pm != null ? pm / 100 : null;
        amt = `${U.fmtMm(det.precipitation_sum?.[di])} มม. <span class="muted">โมเดลเดี่ยว</span>`;
      } else continue;
      const note = S.instability && S.instability.byDate.get(date);
      const d = E.describeProb(p);
      rows.push(`<div class="day-row">
        <div class="day-name"><b>${dayName(date, S.today)}</b><span class="muted">${dayShort(date)}</span></div>
        <div class="day-main">
          <div class="pbar" role="img" aria-label="โอกาสมีฝน ≥ 1 มม. ${U.fmtPct(p)}"><i style="width:${p == null ? 0 : p * 100}%"></i></div>
          <div class="day-p"><b>${U.fmtPct(p)}</b> ${d.label}</div>
        </div>
        <div class="day-amt">${amt}${extra}</div>
        ${periods ? `<div class="day-per" aria-label="โอกาสมีฝนแยกช่วงเวลา">${periods}</div>` : '<div class="day-per"></div>'}
        <div class="day-temp">${tmin != null && tmax != null ? `${Math.round(tmin)}–${Math.round(tmax)}°` : ''}</div>
        ${note ? `<div class="day-note">⚡ ${note}</div>` : ''}
      </div>`);
    }
    el.innerHTML = (S.ens ? '' : '<p class="note warn-note">⚠️ ไม่มีข้อมูล ensemble — แสดงจากโมเดลเดี่ยว ไม่มีช่วงความไม่แน่นอน</p>')
      + (rows.join('') || '<p class="muted">ยังไม่มีข้อมูลพยากรณ์</p>')
      + `<p class="note">โอกาส = สัดส่วนสมาชิกพยากรณ์ที่ให้ฝนรวมทั้งวัน ≥ 1 มม. (เกณฑ์ "วันที่ฝนตก" ของ WMO) · แท่งเล็ก 4 แท่ง = โอกาสมีฝนช่วง ดึก/เช้า/บ่าย/ค่ำ</p>`;
  }

  // ============ 5. Outlook 8-14 ============
  function renderOutlook(S, el) {
    if (!S.ens) { el.innerHTML = '<p class="muted">ต้องใช้ข้อมูล ensemble</p>'; return; }
    const dates = Array.from({ length: 14 - E.CFG.DETAILED_DAYS }, (_, i) => U.addDays(S.today, E.CFG.DETAILED_DAYS + i));
    const cells = dates.map(d => {
      const dist = E.dailyDist(S.ens, d);
      const p = dist ? dist.probs[1] : null;
      const lvl = p == null ? 0 : p < 0.2 ? 1 : p < 0.4 ? 2 : p < 0.6 ? 3 : 4;
      return `<div class="out-cell" title="${U.esc(dayName(d, S.today))} ${dayShort(d)} · โอกาสฝน ≥ 1 มม. ${U.fmtPct(p)}"><span>${U.bkkDayLabel(d, { weekday: 'short' })}</span><small>${U.bkkDayLabel(d, { day: 'numeric' })}</small><i class="sw r${lvl || 1}${lvl ? '' : ' none'}"></i><b>${p == null ? '–' : U.fmtPct(p)}</b></div>`;
    }).join('');
    const tot = E.rangeTotal(S.ens, dates);
    el.innerHTML = `<div class="out-strip">${cells}</div>
      ${tot ? `<p>ฝนรวมทั้งช่วงค่ากลาง <b>${U.fmtMm(tot.p50)} มม.</b> <span class="muted">(อาจอยู่ระหว่าง ${U.fmtMm(tot.p10)} – ${U.fmtMm(tot.p90)} มม.)</span></p>` : ''}
      <p class="note warn-note">⚠️ พยากรณ์ฝนรายวันของจุดเดียวในเขตร้อนแทบไม่มีความแม่นเกิน ${E.CFG.DETAILED_DAYS} วัน — ใช้ดู<b>แนวโน้ม</b>เท่านั้น อย่าใช้วางแผนงานรายวัน</p>`;
  }

  // ============ 6. History + forecast bars ============
  function renderHistory(S, el) {
    const days = [];
    for (let i = -14; i <= 6; i++) {
      const date = U.addDays(S.today, i);
      if (i < 0) {
        const mm = S.actual.get(date);
        days.push({ date, kind: 'past', mm: mm ?? null });
      } else {
        const dist = S.ens ? E.dailyDist(S.ens, date) : null;
        if (dist) days.push({ date, kind: 'fc', mm: dist.mean, lo: dist.p10, hi: dist.p90 });
        else {
          const v = S.detDaily.get(date);
          days.push({ date, kind: 'fc', mm: v ?? null });
        }
      }
    }
    if (days.every(d => d.mm == null)) { el.innerHTML = '<p class="muted">ยังไม่มีข้อมูลฝนรายวัน</p>'; return; }
    const maxMm = Math.max(20, ...days.map(d => d.hi ?? d.mm ?? 0));
    const H = 120;
    const px = mm => (mm / maxMm) * H;
    const cols = days.map(d => {
      const bar = d.mm == null ? '' : `<i class="hb ${d.kind}" style="height:${Math.max(px(d.mm), d.mm >= 0.1 ? 2 : 0)}px"></i>`;
      const whisk = d.hi != null ? `<i class="hw" style="bottom:${px(d.lo)}px;height:${Math.max(px(d.hi) - px(d.lo), 1)}px"></i>` : '';
      const tip = d.mm == null ? `${dayShort(d.date)} · ไม่มีข้อมูล`
        : d.kind === 'past' ? `${dayShort(d.date)} · ฝนย้อนหลัง ${U.fmtMm(d.mm)} มม.`
          : `${dayShort(d.date)} · พยากรณ์ค่าเฉลี่ย ${U.fmtMm(d.mm)} มม.${d.hi != null ? ` (สมาชิก 10–90%: ${U.fmtMm(d.lo)}–${U.fmtMm(d.hi)})` : ''}`;
      return `<button type="button" class="h-col${d.date === S.today ? ' today' : ''}" data-tip="${U.esc(tip)}" aria-label="${U.esc(tip)}"><span class="h-plot">${bar}${whisk}</span><span class="h-day">${U.bkkDayLabel(d.date, { day: 'numeric' })}</span></button>`;
    }).join('');

    const sum = (arr) => arr.reduce((s, d) => s + (d.mm ?? 0), 0);
    const past7 = days.slice(7, 14), next7 = days.slice(14, 21);
    const missing = days.slice(0, 14).filter(d => d.mm == null).length;
    el.innerHTML = `
      <div class="h-chart" style="--h:${H}px"><div class="h-scroll"><div class="h-track">${cols}</div></div></div>
      <p class="tl-detail" id="hist-detail" aria-live="polite">แตะที่แท่งเพื่อดูรายละเอียด · สูงสุดของแกน ${U.fmtMm(maxMm)} มม./วัน</p>
      <div class="legend"><span><i class="sw hist"></i> ฝนย้อนหลัง (ข้อมูลวิเคราะห์ ERA5-Land — ไม่ใช่เครื่องวัดฝน)</span><span><i class="sw fcs"></i> พยากรณ์ค่าเฉลี่ยรายวัน + เส้น = ช่วง 10–90% ของสมาชิกพยากรณ์</span></div>
      <p class="note">7 วันที่ผ่านมารวม <b>${U.fmtMm(sum(past7))} มม.</b> · 7 วันข้างหน้าคาดรวม <b>${U.fmtMm(S.week ? S.week.p50 : sum(next7))} มม.</b>${S.week ? ` <span class="muted">(10–90%: ${U.fmtMm(S.week.p10)}–${U.fmtMm(S.week.p90)})</span>` : ''}${missing ? ` · ⏳ ขาดข้อมูลย้อนหลัง ${missing} วัน` : ''}</p>`;
  }

  // ============ 7. Reliability ============
  function backtestRows(res) {
    const r = res.backtest;
    if (!r || !r.ok) return null;
    const d = r.data;
    const obs = new Map();
    (d.obsTimes || []).forEach((t, i) => { const v = d.obsValues?.[i]; if (v != null) obs.set(t, v); });
    return WX.sources.BACKTEST_MODELS.map(m => {
      const pm = d.perModel[m.id];
      if (!pm) return null;
      const sc = E.scoreForecasts(obs, E.dailyFromHourly(pm.times, pm.values), 1);
      return sc ? { m, label: m.label, sc } : null;
    }).filter(Boolean);
  }

  function renderReliability(S, el) {
    const r = S.res.backtest;
    if (!r) { el.innerHTML = '<p class="muted">กำลังโหลด...</p>'; return; }
    if (!r.ok) { el.innerHTML = `<p class="muted">ยังคำนวณไม่ได้: ${short(r.error)}</p>`; return; }
    const rows = S.backtest || [];
    if (!rows.length) { el.innerHTML = '<p class="muted">ข้อมูลย้อนหลังไม่พอสำหรับประเมิน</p>'; return; }
    const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);
    const best = rows.filter(x => x.sc.csi != null).sort((a, b) => b.sc.csi - a.sc.csi)[0];
    const n = rows[0].sc.n;
    el.innerHTML = `
      <p>พยากรณ์ล่วงหน้า 1 วัน เทียบกับฝนจริงย้อนหลัง <b>${n} วัน</b> ที่จุดนี้ (นับวันที่ฝน ≥ 1 มม. · ฝนตกจริง ${Math.round(rows[0].sc.baseRate * 100)}% ของวัน)</p>
      <div class="table-wrap"><table class="rel">
        <thead><tr><th>โมเดล</th><th title="จากวันที่ฝนตกจริง โมเดลเตือนถูกกี่ %">จับฝนได้</th><th title="จากวันที่โมเดลเตือน ไม่มีฝนจริงกี่ %">เตือนผิด</th><th title="คะแนนรวม (ยิ่งสูงยิ่งดี)">คะแนนรวม</th><th title="มากกว่า 1 = เตือนฝนบ่อยเกินจริง">เตือนบ่อยเกิน/ขาด</th><th title="ค่าเฉลี่ยความคลาดเคลื่อนปริมาณรายวัน">คลาดเคลื่อน</th></tr></thead>
        <tbody>${rows.map(x => `<tr${best && x === best ? ' class="best"' : ''}><td>${U.esc(x.m.label)}</td><td>${pct(x.sc.pod)}</td><td>${pct(x.sc.far)}</td><td>${x.sc.csi == null ? '–' : x.sc.csi.toFixed(2)}</td><td>${x.sc.freqBias == null ? '–' : '×' + x.sc.freqBias.toFixed(1)}</td><td>${U.fmtMm(x.sc.mae)} มม.</td></tr>`).join('')}</tbody>
      </table></div>
      ${best ? `<p>ที่จุดนี้ย้อนหลังที่ผ่านมา <b>${U.esc(best.m.label)}</b> ได้คะแนนรวมสูงสุด</p>` : ''}
      <h3>ผลรายวันของแต่ละโมเดล</h3>
      <div class="stack-chart">${rows.map(x => {
        const t = x.sc.hits + x.sc.falseAlarms + x.sc.misses;
        const seg = (v, cls, lab) => v ? `<i class="${cls}" style="flex:${v}" title="${lab} ${v} วัน"></i>` : '';
        return `<div class="stack-row"><span class="stack-lab">${U.esc(x.m.label)}</span><span class="stack-bar">${t ? seg(x.sc.hits, 'k-hit', 'ทายถูกว่าตก') + seg(x.sc.falseAlarms, 'k-fa', 'เตือนแต่ไม่ตก') + seg(x.sc.misses, 'k-miss', 'ตกแต่ไม่เตือน') : ''}</span><span class="stack-n">${x.sc.hits}/${x.sc.falseAlarms}/${x.sc.misses}</span></div>`;
      }).join('')}</div>
      <div class="legend"><span><i class="sw k-hit"></i> ทายถูกว่าตก</span><span><i class="sw k-fa"></i> เตือนแต่ไม่ตก</span><span><i class="sw k-miss"></i> ตกแต่ไม่เตือน</span></div>
      <p class="note warn-note">⚠️ "ฝนจริง" ในที่นี้คือข้อมูลวิเคราะห์ ERA5-Land (ไม่ใช่เครื่องวัดฝนบนแปลง) และ ${n < 20 ? 'ตัวอย่างน้อย ผลอาจแกว่ง ' : ''}ผลย้อนหลังไม่การันตีอนาคต — ใช้ดูแนวโน้มว่าโมเดลไหนเตือนเกิน/ขาดที่จุดนี้เท่านั้น</p>`;
  }

  // ============ 8. Sources + method ============
  function renderSources(S, el) {
    const defs = WX.sources.LIST;
    const rows = defs.map(def => {
      const r = S.res[def.id];
      let st, cls;
      if (!r) { st = 'กำลังโหลด...'; cls = 'ref'; }
      else if (r.ok && !r.stale) { st = `พร้อมใช้ · ${age(r, S.now)}${r.cached ? ' (แคช)' : ''}`; cls = 'ok'; }
      else if (r.ok && r.stale) { st = `ใช้ข้อมูลเดิม (${age(r, S.now)}) · ดึงใหม่ไม่สำเร็จ: ${short(r.error)}`; cls = 'warn'; }
      else { st = `ไม่สำเร็จ: ${short(r.error)}`; cls = 'bad'; }
      return `<li class="${cls}"><span class="mk">${cls === 'ok' ? '✓' : cls === 'bad' ? '✗' : cls === 'warn' ? '!' : '…'}</span> <b>${U.esc(def.label)}</b> <small>${st}</small></li>`;
    }).join('');
    const nm = S.ens ? S.ens.models.map(m => `${U.esc(m.label)} ${m.members.length} ชุด`).join(' · ') : 'ไม่มี';
    el.innerHTML = `
      <ul class="src-list">${rows}</ul>
      <p class="muted">Ensemble ที่ใช้อยู่: ${nm}</p>
      <h3>วิธีคำนวณ</h3>
      <ul class="method">
        <li><b>ตอนนี้</b> — ใช้เรดาร์ (การสังเกตการณ์) ตัดสินก่อนเสมอ โมเดลใช้แทนเฉพาะเมื่อไม่มีเรดาร์ ทิศทางและเวลาที่ฝนจะมาถึงคำนวณจากการเคลื่อนที่ของภาพเรดาร์ 3 ภาพล่าสุด (เชื่อได้ราว 30–60 นาที เพราะไม่รู้ว่าเซลล์ฝนจะโตหรือสลาย)</li>
        <li><b>โอกาสฝน</b> — นับสัดส่วนสมาชิกพยากรณ์ (ensemble ~120 ชุดจาก 3 ระบบ) ที่ให้ฝนถึงเกณฑ์ โดยให้น้ำหนักเท่ากันต่อระบบ ไม่ใช่ต่อสมาชิก</li>
        <li><b>เกณฑ์</b> — ชั่วโมงที่ "ฝนตก" = ≥ ${E.CFG.HOUR_WET_MM} มม. (สูงกว่าเครื่องวัด 0.1 มม. เพราะโมเดลกริดหยาบให้ละอองฝนเกินจริง) · วันที่ "ฝนตก" = ≥ 1 มม.</li>
        <li><b>เวลา</b> — ค่าฝนรายชั่วโมงของ Open-Meteo คือฝนของชั่วโมง "ก่อนหน้า" ป้ายเวลา จึงเลื่อนช่วงเวลาให้ตรงแล้ว · เวลาเริ่มตกแสดงเป็นช่วงที่เป็นไปได้ (10–90%) ไม่ใช่เวลาเดียว</li>
        <li><b>ความจริงที่ต้องรู้</b> — ฝนพาความร้อนบนชายฝั่งเป็นเซลล์กว้าง 1–5 กม. แต่โมเดลละเอียดสุด ~11–25 กม. ไม่มีแหล่งฟรีใดบอกล่วงหน้าหลายชั่วโมงว่า "ตกบนแปลงนี้" ได้แม่นยำ — เรดาร์สำหรับ 1 ชม.แรก และเครื่องวัดฝนบนแปลงคือสิ่งเดียวที่ยืนยันได้จริง</li>
      </ul>
      ${S.debug ? `<h3>Debug</h3><pre class="debug">${U.esc(JSON.stringify(S.debugInfo || {}, null, 1))}</pre>` : ''}`;
  }

  // ============ Status line ============
  function renderStatus(S) {
    const defs = WX.sources.LIST;
    const bad = defs.filter(d => S.res[d.id] && (!S.res[d.id].ok || S.res[d.id].stale)).length;
    const loading = defs.filter(d => !S.res[d.id]).length;
    const latest = Math.max(0, ...defs.map(d => S.res[d.id]?.fetchedAt || 0));
    let text;
    if (loading === defs.length) text = '⏳ กำลังโหลดข้อมูลสด...';
    else text = `${bad ? '🟠' : '🟢'} อัปเดตล่าสุด ${latest ? U.bkkHM(latest) + ' น. (' + U.fmtAgo(latest, S.now) + ')' : ''}${bad ? ` · แหล่งข้อมูลมีปัญหา ${bad} แหล่ง` : ''}${loading ? ` · กำลังโหลด ${loading}` : ''}`;
    $('refresh-status').textContent = text;
  }


  // ============ บทวิเคราะห์อัตโนมัติ ============
  function renderInsights(S, el) {
    const items = WX.analysis.insights({
      ens: S.ens, today: S.today, week: S.week, past7: S.past7, past7Missing: S.past7Missing,
      instabilityByDate: S.instability.byDate, backtest: S.backtest,
      modelLabels: Object.fromEntries(WX.sources.ENSEMBLES.map(e => [e.id, e.short])),
    });
    el.innerHTML = items.length
      ? `<ul class="insights">${items.map(i => `<li class="tone-${i.tone}"><span class="ins-icon" aria-hidden="true">${i.icon}</span><span>${U.esc(i.text)}</span></li>`).join('')}</ul>
         <p class="note">สรุปอัตโนมัติด้วยกฎตายตัวจากตัวเลขในหน้านี้ (ไม่ใช่ AI) — เรียงตามความสำคัญ</p>`
      : '<p class="muted">ต้องใช้ข้อมูล ensemble — ยังไม่พร้อม</p>';
  }

  // ============ สภาพอากาศรายชั่วโมง (meteogram) ============
  function renderMeteogram(S, el) {
    const h = S.fc && S.fc.hourly;
    if (!h) { el.innerHTML = '<p class="muted">ยังไม่มีข้อมูลรายชั่วโมง</p>'; return; }
    const idx = [];
    for (let i = 0; i < h.time.length && idx.length < 49; i++) if (U.bkkToEpoch(h.time[i]) > S.now - U.HOUR_MS) idx.push(i);
    if (idx.length < 2) { el.innerHTML = '<p class="muted">ยังไม่มีข้อมูลรายชั่วโมง</p>'; return; }
    const xs = idx.map(i => U.bkkToEpoch(h.time[i]));
    const col = k => idx.map(i => (h[k] ? h[k][i] : null));
    const when = i => `${dayName(U.bkkDateStr(xs[i]), S.today)} ${U.bkkHM(xs[i])}`;
    const fmt = (v, d = 0) => (v == null ? '–' : v.toFixed(d));
    const charts = [
      { id: 'mg-temp', title: 'อุณหภูมิ (°C)', spec: { series: [{ values: col('temperature_2m'), color: 'var(--s-temp)' }], minSpan: 4, tip: i => `${when(i)} · ${fmt(col('temperature_2m')[i], 1)}°C` } },
      { id: 'mg-rh', title: 'ความชื้นสัมพัทธ์ (%)', spec: { series: [{ values: col('relative_humidity_2m'), color: 'var(--s-rh)' }], yMax: 100, minSpan: 20, tip: i => `${when(i)} · ความชื้น ${fmt(col('relative_humidity_2m')[i])}%` } },
      { id: 'mg-wind', title: 'ลม (กม./ชม.)', legend: '<span><i class="sw" style="background:var(--s-wind)"></i> ลมเฉลี่ย</span><span><i class="sw" style="background:var(--s-gust)"></i> ลมกระโชก</span>', spec: { series: [{ values: col('wind_speed_10m'), color: 'var(--s-wind)' }, { values: col('wind_gusts_10m'), color: 'var(--s-gust)', width: 1.5 }], zero: true, minSpan: 10, tip: i => `${when(i)} · เฉลี่ย ${fmt(col('wind_speed_10m')[i])} · กระโชก ${fmt(col('wind_gusts_10m')[i])} กม./ชม.` } },
    ];
    if (h.cloud_cover) charts.push({ id: 'mg-cloud', title: 'เมฆปกคลุม (%)', spec: { series: [{ values: col('cloud_cover'), color: 'var(--s-cloud)', area: true }], yMin: 0, yMax: 100, tip: i => `${when(i)} · เมฆ ${fmt(col('cloud_cover')[i])}%` } });
    el.innerHTML = charts.map(c => `<div class="mg"><h3>${c.title}</h3><div id="${c.id}"></div>${c.legend ? `<div class="legend row">${c.legend}</div>` : ''}</div>`).join('')
      + '<p class="note">แตะหรือชี้ที่กราฟเพื่อดูค่า · เส้นตั้งสีเข้ม = ตอนนี้ · เส้นตั้งจาง = เที่ยงคืน · ค่าจากโมเดลหลักของ Open-Meteo (ไม่ใช่ ensemble)</p>';
    for (const c of charts) WX.charts.line($(c.id), { xs, nowMs: S.now, height: 110, title: c.title, ...c.spec });
  }

  // ============ ความเห็นของแต่ละระบบพยากรณ์ ============
  function renderModels(S, el) {
    if (!S.ens) { el.innerHTML = '<p class="muted">ต้องใช้ข้อมูล ensemble</p>'; return; }
    const dates = Array.from({ length: E.CFG.DETAILED_DAYS }, (_, i) => U.addDays(S.today, i));
    const short = Object.fromEntries(WX.sources.ENSEMBLES.map(e => [e.id, e.short]));
    const cell = (ens, d, name) => {
      const dist = E.dailyDist(ens, d);
      return { v: dist ? dist.probs[1] : null, title: dist ? `${name} · ${dayName(d, S.today)} ${dayShort(d)}: โอกาสฝน ${U.fmtPct(dist.probs[1])}${dist.cond ? ` · ถ้าตก ~${U.fmtMm(dist.cond.p50)} มม.` : ''} (${dist.n} ชุด)` : '' };
    };
    const rows = S.ens.models.map(m => {
      const sub = E.subEnsemble(S.ens, [m.id]);
      return { label: short[m.id] || m.label, cells: dates.map(d => cell(sub, d, short[m.id] || m.label)) };
    });
    rows.push({ label: 'รวม', total: true, cells: dates.map(d => cell(S.ens, d, 'รวม')) });
    WX.charts.heat(el, {
      cols: dates.map(d => `${d === S.today ? 'วันนี้' : U.bkkDayLabel(d, { weekday: 'short' })}<br><small>${U.bkkDayLabel(d, { day: 'numeric' })}</small>`),
      rows, caption: 'โอกาสฝนรายวันแยกตามระบบพยากรณ์',
    });
    el.insertAdjacentHTML('beforeend', '<p class="note">ตัวเลข = โอกาสฝนรวมทั้งวัน ≥ 1 มม. ของแต่ละระบบ · ถ้าสีในคอลัมน์เดียวกันต่างกันมาก แปลว่าระบบเห็นไม่ตรงกัน ความเชื่อมั่นต่ำ · แถวรวมให้น้ำหนักเท่ากันทุกระบบ</p>');
  }

  // ============ ฝนสะสม (fan chart) ============
  function renderFan(S, el) {
    if (!S.ens) { el.innerHTML = '<p class="muted">ต้องใช้ข้อมูล ensemble</p>'; return; }
    const fan = E.cumulativeFan(S.ens, U.bkkToEpoch(S.today), 168, 3);
    if (!fan) { el.innerHTML = '<p class="muted">ข้อมูลไม่พอ</p>'; return; }
    const xs = fan.map(f => f.ms);
    const q = k => fan.map(f => f[k]);
    const target = S.loc.coconut ? WX.coconut.WEEKLY_TARGET_MM : null;
    el.innerHTML = '<div id="fan-chart"></div><div class="legend row"><span><i class="sw" style="background:var(--r3)"></i> ค่ากลาง</span><span><i class="sw" style="background:var(--r2);opacity:.45"></i> 50% ของผลพยากรณ์</span><span><i class="sw" style="background:var(--r1);opacity:.45"></i> 80% ของผลพยากรณ์</span></div><div id="fan-sum"></div>';
    WX.charts.line($('fan-chart'), {
      xs, height: 180, zero: true, minSpan: 10, xTicks: 'days', nowMs: S.now, title: 'ฝนสะสม 7 วัน',
      bands: [{ lo: q('p10'), hi: q('p90'), color: 'var(--r1)', opacity: 0.35 }, { lo: q('p25'), hi: q('p75'), color: 'var(--r2)', opacity: 0.35 }],
      series: [{ values: q('p50'), color: 'var(--r3)' }],
      refs: target ? [{ y: target, label: `เป้ามะพร้าว ${target} มม.` }] : [],
      tip: i => `ถึง ${dayName(U.bkkDateStr(xs[i] - 1), S.today)} ${U.bkkHMEnd(xs[i])} · สะสมค่ากลาง ${U.fmtMm(fan[i].p50)} มม. · 50%: ${U.fmtMm(fan[i].p25)}–${U.fmtMm(fan[i].p75)} · 80%: ${U.fmtMm(fan[i].p10)}–${U.fmtMm(fan[i].p90)}`,
    });
    const w = S.week;
    if (w) {
      $('fan-sum').innerHTML = `<div class="stat-row">${[10, 25, 50].map(t => `<div class="stat"><b>${U.fmtPct(w.probs[t])}</b><span>โอกาสฝนรวม 7 วัน ≥ ${t} มม.</span></div>`).join('')}</div>
        <p class="note">แตะที่กราฟเพื่อดูค่า · แถบกว้างขึ้นเรื่อย ๆ = ยิ่งไกลยิ่งไม่แน่นอน · นับตั้งแต่ 00:00 วันนี้ ถึงสิ้นวันที่ 7 (ตัวเลขเดียวกับแผงน้ำมะพร้าว)</p>`;
    }
  }

  function renderAll(S) {
    renderStatus(S);
    renderNow(S, $('now'));
    renderNext(S, $('next-rain'));
    renderInsights(S, $('insights'));
    if (WX.radarMap) WX.radarMap.render(S);
    renderTimeline(S, $('timeline'));
    renderMeteogram(S, $('meteogram'));
    renderDaily(S, $('daily'));
    renderModels(S, $('models'));
    renderFan(S, $('fan'));
    renderOutlook(S, $('outlook'));
    if (S.loc.coconut) WX.coconut.render($('coconut'), { week: S.week, actual: S.actual, detDaily: S.detDaily });
    renderHistory(S, $('history'));
    renderReliability(S, $('reliability-body'));
    renderSources(S, $('sources-body'));
  }

  function initInteractions() {
    const bind = (rootId, detailId, sel) => {
      const rootEl = $(rootId);
      const show = e => {
        const b = e.target.closest(sel);
        if (!b) return;
        const d = $(detailId);
        if (d) d.textContent = b.dataset.tip;
      };
      rootEl.addEventListener('click', show);
      rootEl.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') show(e); });
      rootEl.addEventListener('focusin', show);
    };
    bind('timeline', 'tl-detail', '.tl-col');
    bind('history', 'hist-detail', '.h-col');
  }

  WX.ui = { renderAll, renderNow, renderNext, renderStatus, modelIsRainy, initInteractions, backtestRows };
})(typeof window !== 'undefined' ? window : globalThis);
