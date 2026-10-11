(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const NS = 'http://www.w3.org/2000/svg';

  function niceTicks(lo, hi, count = 4) {
    if (!(hi > lo)) hi = lo + 1;
    const raw = (hi - lo) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    const start = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 1e-6; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ============ Line / band chart (แกนเวลา) ============
  // spec: { xs, series:[{values,color,width,label}], bands:[{lo,hi,color,opacity}], refs:[{y,label}],
  //         yMin, yMax, zero, height, xTicks:'hours'|'days', nowMs, tip(i) → string, title }
  function line(host, spec) {
    host.__chart = spec;
    host.classList.add('chart');
    draw(host);
    observe(host);
  }

  function draw(host) {
    const spec = host.__chart;
    if (!spec) return;
    const xs = spec.xs;
    host.innerHTML = '';
    if (!xs || xs.length < 2) { host.innerHTML = '<p class="muted">ไม่มีข้อมูล</p>'; return; }

    const W = Math.max(240, host.clientWidth || 320);
    const H = spec.height || 130;
    const m = { l: 38, r: 10, t: 12, b: 22 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;

    const vals = [];
    for (const s of spec.series || []) for (const v of s.values) if (v != null) vals.push(v);
    for (const b of spec.bands || []) { for (const v of b.lo) if (v != null) vals.push(v); for (const v of b.hi) if (v != null) vals.push(v); }
    for (const r of spec.refs || []) vals.push(r.y);
    let lo = spec.yMin ?? Math.min(...vals), hi = spec.yMax ?? Math.max(...vals);
    if (spec.zero) lo = Math.min(0, lo);
    if (hi - lo < (spec.minSpan || 1)) hi = lo + (spec.minSpan || 1);
    const ticks = niceTicks(lo, hi, spec.ticks || 3);
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    // ขยายแกนให้เส้นบนสุดมีป้ายกำกับเสมอ ไม่ปล่อยข้อมูลลอยเหนือ tick สุดท้าย
    while (ticks[ticks.length - 1] < hi - 1e-9 && spec.yMax == null) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
    lo = Math.min(lo, ticks[0]); hi = spec.yMax != null ? spec.yMax : Math.max(hi, ticks[ticks.length - 1]);

    const x0 = xs[0], x1 = xs[xs.length - 1];
    const X = ms => m.l + ((ms - x0) / (x1 - x0)) * pw;
    const Y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': spec.title || '' }, host);
    const clipId = `clip${Math.random().toString(36).slice(2, 8)}`;
    el('rect', { x: m.l, y: m.t, width: pw, height: ph }, el('clipPath', { id: clipId }, el('defs', {}, svg)));
    const plot = el('g', { 'clip-path': `url(#${clipId})` });

    for (const t of ticks) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), class: 'c-grid' }, svg);
      el('text', { x: m.l - 6, y: Y(t) + 4, class: 'c-ylab', 'text-anchor': 'end' }, svg).textContent = spec.yFmt ? spec.yFmt(t) : String(t);
    }

    // เส้นแบ่งวัน + ป้ายเวลา
    const day0 = U.bkkDateStr(x0);
    for (let ms = U.bkkToEpoch(day0); ms <= x1; ms += 3600000) {
      if (ms < x0) continue;
      const h = U.bkkHourNum(ms);
      if (h === 0) el('line', { x1: X(ms), x2: X(ms), y1: m.t, y2: m.t + ph, class: 'c-day' }, svg);
      const lab = spec.xTicks === 'days' ? (h === 12 ? U.bkkDayLabel(U.bkkDateStr(ms), { weekday: 'short', day: 'numeric' }) : null) : (h % 6 === 0 ? String(h).padStart(2, '0') : null);
      if (lab) el('text', { x: X(ms), y: H - 6, class: 'c-xlab', 'text-anchor': 'middle' }, svg).textContent = lab;
    }

    for (const b of spec.bands || []) {
      const top = [], bot = [];
      xs.forEach((ms, i) => { if (b.lo[i] != null && b.hi[i] != null) { top.push(`${X(ms)},${Y(b.hi[i])}`); bot.unshift(`${X(ms)},${Y(b.lo[i])}`); } });
      if (top.length > 1) el('polygon', { points: top.concat(bot).join(' '), fill: b.color, 'fill-opacity': b.opacity ?? 0.18 }, plot);
    }
    svg.appendChild(plot);
    for (const r of spec.refs || []) {
      el('line', { x1: m.l, x2: W - m.r, y1: Y(r.y), y2: Y(r.y), class: 'c-ref' }, svg);
      el('text', { x: m.l + 4, y: Y(r.y) - 4, class: 'c-reflab', 'text-anchor': 'start' }, svg).textContent = r.label;
    }
    for (const s of spec.series || []) {
      let d = '', pen = false;
      xs.forEach((ms, i) => {
        const v = s.values[i];
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(ms).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      });
      if (s.area) el('path', { d: `${d}L${X(x1)},${Y(lo)}L${X(x0)},${Y(lo)}Z`, fill: s.color, 'fill-opacity': 0.12 }, plot);
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': s.opacity ?? 1 }, plot);
    }
    if (spec.nowMs && spec.nowMs >= x0 && spec.nowMs <= x1) {
      el('line', { x1: X(spec.nowMs), x2: X(spec.nowMs), y1: m.t, y2: m.t + ph, class: 'c-now' }, svg);
    }

    // hover / แตะ: เส้นตั้ง + จุด + ข้อความ
    const cross = el('line', { y1: m.t, y2: m.t + ph, class: 'c-cross', visibility: 'hidden' }, svg);
    const dots = (spec.series || []).map(s => el('circle', { r: 4, fill: s.color, class: 'c-dot', visibility: 'hidden' }, svg));
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.textContent = spec.hint || '\u00a0';
    host.appendChild(tip);
    const hit = el('rect', { x: m.l, y: 0, width: pw, height: H, fill: 'transparent' }, svg);
    const show = e => {
      const r = svg.getBoundingClientRect();
      const ms = x0 + ((e.clientX - r.left - m.l) / pw) * (x1 - x0);
      let i = 0, best = Infinity;
      xs.forEach((t, k) => { const d = Math.abs(t - ms); if (d < best) { best = d; i = k; } });
      cross.setAttribute('x1', X(xs[i])); cross.setAttribute('x2', X(xs[i]));
      cross.setAttribute('visibility', 'visible');
      (spec.series || []).forEach((s, k) => {
        const v = s.values[i];
        if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('cx', X(xs[i])); dots[k].setAttribute('cy', Y(v));
        dots[k].setAttribute('visibility', 'visible');
      });
      tip.textContent = spec.tip ? spec.tip(i) : `${U.bkkHM(xs[i])}`;
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
  }

  let ro = null;
  const widths = new WeakMap();
  function observe(host) {
    if (typeof ResizeObserver === 'undefined') return;
    if (!ro) {
      ro = new ResizeObserver(entries => {
        for (const en of entries) {
          const w = Math.round(en.contentRect.width);
          if (widths.get(en.target) !== w) { widths.set(en.target, w); draw(en.target); }
        }
      });
    }
    widths.set(host, Math.round(host.clientWidth));
    ro.observe(host);
  }

  // ============ Heatmap (ตาราง HTML) ============
  // ระดับสีตามความน่าจะเป็น — ตัวอักษรในช่องเลือกสีตามความเข้มของพื้น ให้อ่านออกเสมอ
  function heatLevel(p) {
    if (p == null) return 0;
    return p < 0.2 ? 1 : p < 0.4 ? 2 : p < 0.6 ? 3 : p < 0.8 ? 4 : 5;
  }

  function heat(host, { cols, rows, caption }) {
    bindHeat(host);
    host.innerHTML = `
      <div class="table-wrap"><table class="heat">
        ${caption ? `<caption class="sr-only">${U.esc(caption)}</caption>` : ''}
        <thead><tr><th></th>${cols.map(c => `<th scope="col">${c}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr${r.total ? ' class="total"' : ''}><th scope="row">${U.esc(r.label)}</th>${r.cells.map(c =>
          `<td class="h${heatLevel(c.v)}" tabindex="0" data-tip="${U.esc(c.title || '')}" title="${U.esc(c.title || '')}">${c.v == null ? '–' : U.fmtPct(c.v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="tl-detail heat-detail" aria-live="polite">แตะช่องเพื่อดูรายละเอียด</p>
      <div class="legend heat-legend"><span>โอกาสฝน ≥ 1 มม.:</span>${[1, 2, 3, 4, 5].map((l, i) => `<span><i class="sw h${l}"></i>${['<20', '20–40', '40–60', '60–80', '≥80'][i]}%</span>`).join('')}</div>`;
  }

  // ใช้ delegation ครั้งเดียวต่อ host — title ไม่แสดงบนมือถือ จึงต้องมีบรรทัดรายละเอียดให้แตะดู
  function bindHeat(host) {
    if (host.__heatBound) return;
    host.__heatBound = true;
    const show = e => {
      const td = e.target.closest('td[data-tip]');
      const out = host.querySelector('.heat-detail');
      if (td && out && td.dataset.tip) out.textContent = td.dataset.tip;
    };
    host.addEventListener('click', show);
    host.addEventListener('focusin', show);
    host.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') show(e); });
  }

  WX.charts = { line, heat, niceTicks, heatLevel };
})(typeof window !== 'undefined' ? window : globalThis);
