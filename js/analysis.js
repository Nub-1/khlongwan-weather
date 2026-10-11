(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const E = WX.engine;

  // บทวิเคราะห์อัตโนมัติจากกฎตายตัว (ไม่ใช่ AI) — ทุกประโยคมาจากตัวเลขที่แสดงอยู่ในหน้าเดียวกัน
  function dayShort(date, today) {
    if (date === today) return 'วันนี้';
    if (date === U.addDays(today, 1)) return 'พรุ่งนี้';
    return U.bkkDayLabel(date, { weekday: 'short', day: 'numeric' });
  }

  function insights(inp) {
    const { ens, today } = inp;
    const out = [];
    if (!ens) return out;
    const dates = Array.from({ length: E.CFG.DETAILED_DAYS }, (_, i) => U.addDays(today, i));
    const dists = dates.map(d => E.dailyDist(ens, d));
    const p = dists.map(d => (d ? d.probs[1] : null));

    // 1) แนวโน้มทั้งสัปดาห์: ช่วงแล้งติดต่อกัน / ช่วงฝนชุก
    let best = { len: 0, start: -1 }, cur = { len: 0, start: -1 };
    p.forEach((v, i) => {
      if (v != null && v <= 0.25) { cur = cur.len ? { len: cur.len + 1, start: cur.start } : { len: 1, start: i }; }
      else cur = { len: 0, start: -1 };
      if (cur.len > best.len) best = { ...cur };
    });
    const wet = dates.filter((d, i) => p[i] != null && p[i] >= 0.6);
    if (best.len >= 3) {
      const a = dates[best.start], b = dates[best.start + best.len - 1];
      out.push({ w: 8, tone: 'dry', icon: '☀️', text: `แนวโน้มแห้ง ${best.len} วันติดต่อกัน (${dayShort(a, today)} – ${dayShort(b, today)}) โอกาสฝนแต่ละวันไม่เกิน 25%` });
    } else if (wet.length >= 4) {
      out.push({ w: 7, tone: 'wet', icon: '🌧️', text: `ช่วงฝนชุก: ${wet.length} ใน 7 วันมีโอกาสฝน ≥ 60%` });
    } else if (wet.length) {
      out.push({ w: 5, tone: 'wet', icon: '🌦️', text: `ฝนมาเป็นช่วง ๆ — วันที่น่าจะมีฝน: ${wet.map(d => dayShort(d, today)).join(', ')}` });
    } else {
      out.push({ w: 3, tone: 'info', icon: '⛅', text: 'สัปดาห์นี้ไม่มีวันไหนที่โอกาสฝนเด่นชัด (ทุกวันต่ำกว่า 60%)' });
    }

    // 2) วันที่ฝนน่าจะหนักที่สุด
    let hi = -1;
    dists.forEach((d, i) => { if (d && (hi < 0 || d.probs[10] > dists[hi].probs[10])) hi = i; });
    if (hi >= 0 && dists[hi].probs[10] >= 0.2) {
      const d = dists[hi];
      const heavy = d.probs[35] >= 0.05 ? ` · ≥ 35 มม. ${U.fmtPct(d.probs[35])}` : '';
      out.push({ w: 6, tone: d.probs[35] >= 0.2 ? 'warn' : 'wet', icon: '🌧️', text: `วันที่ฝนน่าจะหนักที่สุด: ${dayShort(dates[hi], today)} — โอกาสฝน ≥ 10 มม. ${U.fmtPct(d.probs[10])}${heavy}` });
    }

    // 3) ฝนมักตกช่วงไหนของวัน
    const per = E.CFG.PERIODS.map(pe => {
      const vals = dates.map(d => E.periodDist(ens, d, pe)).filter(Boolean).map(x => x.pAny);
      return { pe, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    }).filter(x => x.avg != null);
    if (per.length >= 2) {
      const sorted = [...per].sort((a, b) => b.avg - a.avg);
      const top = sorted[0], low = sorted[sorted.length - 1];
      if (top.avg >= 0.25 && top.avg - low.avg >= 0.15) {
        const hh = n => String(n).padStart(2, '0');
        out.push({ w: 5, tone: 'info', icon: '🕒', text: `ฝนมักตกช่วง${top.pe.label} (${hh(top.pe.from)}–${hh(top.pe.to)} น.) โอกาสเฉลี่ย ${U.fmtPct(top.avg)} เทียบกับช่วง${low.pe.label} ${U.fmtPct(low.avg)} → งานกลางแจ้งเหมาะกับช่วง${low.pe.label}` });
      }
    }

    // 4) ระบบพยากรณ์เห็นตรงกันไหม (4 วันแรก ซึ่งยังพอมีความแม่น)
    const labels = inp.modelLabels || {};
    if (ens.models.length >= 2) {
      let worst = null, allClose = true, compared = 0;
      for (let i = 0; i < Math.min(4, dates.length); i++) {
        const byModel = ens.models.map(m => {
          const sub = E.subEnsemble(ens, [m.id]);
          const d = sub && E.dailyDist(sub, dates[i]);
          return d ? { id: m.id, p: d.probs[1] } : null;
        }).filter(Boolean);
        if (byModel.length < 2) continue;
        compared++;
        byModel.sort((a, b) => b.p - a.p);
        const spread = byModel[0].p - byModel[byModel.length - 1].p;
        if (spread > 0.2) allClose = false;
        if (!worst || spread > worst.spread) worst = { spread, i, hi: byModel[0], lo: byModel[byModel.length - 1] };
      }
      if (worst && worst.spread >= 0.4) {
        const name = x => labels[x.id] || x.id;
        out.push({ w: 7, tone: 'warn', icon: '⚖️', text: `${dayShort(dates[worst.i], today)}: ระบบพยากรณ์เห็นต่างกันมาก (${name(worst.hi)} ${U.fmtPct(worst.hi.p)} vs ${name(worst.lo)} ${U.fmtPct(worst.lo.p)}) — ความเชื่อมั่นต่ำ ให้ดูเรดาร์ใกล้เวลา` });
      } else if (compared >= 2 && allClose) {
        out.push({ w: 4, tone: 'info', icon: '🤝', text: `ทั้ง ${ens.models.length} ระบบเห็นตรงกันในช่วง ${compared} วันแรก (ต่างกันไม่เกิน 20 จุด) — ความเชื่อมั่นค่อนข้างสูง` });
      }
    }

    // 5) ฝนรวมทั้งสัปดาห์ เทียบสัปดาห์ที่ผ่านมา
    if (inp.week) {
      const w = inp.week;
      let text = `ฝนรวม 7 วันข้างหน้า ค่ากลาง ${U.fmtMm(w.p50)} มม. (10–90%: ${U.fmtMm(w.p10)}–${U.fmtMm(w.p90)})`;
      if (inp.past7 != null && !inp.past7Missing) {
        const r = inp.past7 > 0.5 ? w.p50 / inp.past7 : null;
        const cmp = r == null ? (w.p50 > 2 ? 'มากกว่า' : 'ใกล้เคียง') : r >= 1.3 ? 'มากกว่า' : r <= 0.7 ? 'น้อยกว่า' : 'ใกล้เคียง';
        text += ` — ${cmp} 7 วันที่ผ่านมา (${U.fmtMm(inp.past7)} มม.)`;
      }
      if (w.p90 - w.p10 > Math.max(10, 2 * w.p50)) text += ' · ช่วงกว้างมาก ความไม่แน่นอนสูง';
      out.push({ w: 5, tone: 'info', icon: '📊', text });
    }

    // 6) บรรยากาศไม่เสถียร
    const unstable = dates.filter(d => inp.instabilityByDate && inp.instabilityByDate.has(d));
    if (unstable.length) {
      out.push({ w: 6, tone: 'warn', icon: '⚡', text: `บรรยากาศไม่เสถียร ${unstable.length} วัน (${unstable.map(d => dayShort(d, today)).join(', ')}) แม้โอกาสฝนต่ำ — ระวังฝนฟ้าคะนองเฉพาะที่ช่วงบ่าย` });
    }

    // 7) ผลย้อนทดสอบ: โมเดลที่จุดนี้เตือนเกินหรือขาด
    const bt = (inp.backtest || []).filter(x => x.sc && x.sc.freqBias != null);
    if (bt.length) {
      const bias = bt.reduce((a, x) => a + x.sc.freqBias, 0) / bt.length;
      const top = [...bt].filter(x => x.sc.csi != null).sort((a, b) => b.sc.csi - a.sc.csi)[0];
      let text = null;
      if (bias > 1.3) text = `ย้อนหลัง 30 วันที่จุดนี้ โมเดลเตือนวันฝนบ่อยเกินจริง (×${bias.toFixed(1)}) — ตัวเลขโอกาสฝนอาจสูงเกินไป`;
      else if (bias < 0.75) text = `ย้อนหลัง 30 วันที่จุดนี้ โมเดลให้วันฝนน้อยกว่าจริง (×${bias.toFixed(1)}) — ฝนอาจมาบ่อยกว่าที่พยากรณ์`;
      if (text) out.push({ w: 4, tone: 'warn', icon: '🎯', text: text + (top ? ` · แม่นสุด: ${top.label}` : '') });
      else if (top) out.push({ w: 3, tone: 'info', icon: '🎯', text: `ย้อนหลัง 30 วัน โมเดลที่จุดนี้เตือนฝนได้สมดุล · แม่นสุด: ${top.label}` });
    }

    return out.sort((a, b) => b.w - a.w);
  }

  WX.analysis = { insights };
})(typeof window !== 'undefined' ? window : globalThis);
