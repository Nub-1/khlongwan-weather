(function () {
  'use strict';
  const WX = window.WX;
  const U = WX.util;
  const E = WX.engine;
  const $ = id => document.getElementById(id);
  const DEBUG = new URLSearchParams(window.location.search).get('debug') === '1';

  let loc = null;
  let token = 0;
  let res = {};
  let lastRun = {};
  const inflight = new Set();
  let ensCache = { sig: '', ens: null };
  let renderTimer = null;
  let pendingFull = false;
  let firstFullDone = false;

  // เรดาร์ที่เก่าเกิน 20 นาทีไม่ใช่ "ตอนนี้" แล้ว
  const fresh = (r, maxAgeMs, now) => r && r.ok && now - r.fetchedAt <= maxAgeMs;

  function buildEnsemble() {
    const sig = WX.sources.ENSEMBLES.map(e => `${e.id}:${res[e.id] && res[e.id].ok ? res[e.id].fetchedAt : 0}`).join('|');
    if (sig === ensCache.sig) return ensCache.ens;
    const inputs = [];
    for (const e of WX.sources.ENSEMBLES) {
      const r = res[e.id];
      if (r && r.ok && r.data && r.data.hourly) inputs.push({ id: e.id, label: e.short, hourly: r.data.hourly, weight: 1 });
    }
    ensCache = { sig, ens: inputs.length ? E.buildEnsemble(inputs) : null };
    return ensCache.ens;
  }

  function buildState() {
    const now = Date.now();
    const today = U.bkkDateStr(now);
    const fc = res.forecast && res.forecast.ok ? res.forecast.data : null;
    const ens = buildEnsemble();

    const rd = res.radar && res.radar.ok ? res.radar.data : null;
    const radar = rd && rd.frames ? WX.radar.analyze(rd.frames, rd.geo, now)
      : rd && rd.decodeError ? { ok: false, reason: 'decode_error', message: rd.decodeError } : { ok: false };
    const lg = res.longdo_rain;
    const cur = fc && fc.current;
    const verdict = E.nowVerdict({
      longdo: fresh(lg, 20 * 60000, now) ? { ok: true, ...lg.data } : { ok: false },
      radar,
      model: cur ? { ok: true, isRainy: WX.ui.modelIsRainy(cur) } : null,
    });

    const actual = new Map();
    const a = res.archive && res.archive.ok ? res.archive.data.daily : null;
    ((a && a.time) || []).forEach((d, i) => {
      const v = a.precipitation_sum && a.precipitation_sum[i];
      if (v != null && d < today) actual.set(d, v);
    });
    const detDaily = new Map();
    const fd = fc && fc.daily;
    ((fd && fd.time) || []).forEach((d, i) => {
      const v = fd.precipitation_sum && fd.precipitation_sum[i];
      if (v == null) return;
      detDaily.set(d, v);
      if (d < today && !actual.has(d)) actual.set(d, v);
    });

    const instability = { byDate: new Map(), today: null };
    if (fc && fc.hourly && fc.hourly.cape) {
      const capeMax = E.capeMaxByDate(fc.hourly.time, fc.hourly.cape);
      for (let i = 0; i < E.CFG.DETAILED_DAYS; i++) {
        const d = U.addDays(today, i);
        const c = capeMax.get(d);
        if (c == null || c < 1500) continue;
        const dist = ens ? E.dailyDist(ens, d) : null;
        const p = dist ? dist.probs[1] : null;
        if (p == null || p >= 0.5) continue;
        const note = `โอกาสฝนต่ำ (${U.fmtPct(p)}) แต่บรรยากาศช่วงบ่ายไม่เสถียร (CAPE ~${Math.round(c)}) — ฝนฟ้าคะนองเฉพาะที่เกิดได้`;
        instability.byDate.set(d, note);
        if (i === 0) instability.today = note;
      }
    }

    const week = ens ? E.rangeTotal(ens, Array.from({ length: 7 }, (_, i) => U.addDays(today, i)), [10, 25, 50]) : null;
    const pastDates = Array.from({ length: 7 }, (_, i) => U.addDays(today, i - 7));
    const past7Missing = pastDates.filter(d => !actual.has(d)).length;
    const past7 = pastDates.reduce((a, d) => a + (actual.get(d) ?? 0), 0);
    const backtest = WX.ui.backtestRows(res);
    const S = { now, today, loc, res, fc, ens, radar, verdict, actual, detDaily, instability, week, past7, past7Missing, backtest, debug: DEBUG };
    if (DEBUG) {
      S.debugInfo = {
        radar: { ...radar, stats: radar.stats },
        ensemble: ens ? ens.models.map(m => ({ id: m.id, members: m.members.length })) : null,
        forecastHourlyKeys: fc && fc.hourly ? Object.keys(fc.hourly) : null,
        results: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { ok: v.ok, error: v.error, stale: v.stale, age: Math.round((now - v.fetchedAt) / 1000) + 's' }])),
      };
    }
    return S;
  }

  function fullRender() {
    const keep = ['tl-scroll', 'hist-scroll'].map(id => {
      const el = document.querySelector(id === 'tl-scroll' ? '#tl-scroll' : '#history .h-scroll');
      return [id, el ? el.scrollLeft : null];
    });
    WX.ui.renderAll(buildState());
    const tl = $('tl-scroll');
    const hs = document.querySelector('#history .h-scroll');
    const [, tlLeft] = keep[0];
    const [, hLeft] = keep[1];
    if (tl && tlLeft != null) tl.scrollLeft = tlLeft;
    if (hs) hs.scrollLeft = hLeft != null && firstFullDone ? hLeft : hs.scrollWidth;
    firstFullDone = true;
  }

  function lightRender() {
    const S = buildState();
    WX.ui.renderStatus(S);
    WX.ui.renderNow(S, $('now'));
    WX.ui.renderNext(S, $('next-rain'));
    if (WX.radarMap) WX.radarMap.render(S);
  }

  function scheduleRender(full) {
    pendingFull = pendingFull || full;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      const f = pendingFull;
      pendingFull = false;
      if (f) fullRender(); else lightRender();
    }, 50);
  }

  async function runSources(defs, force) {
    const my = token;
    await Promise.all(defs.map(async def => {
      const key = `${my}:${def.id}`;
      if (inflight.has(key)) return;
      inflight.add(key);
      lastRun[def.id] = Date.now();
      let r;
      try { r = await WX.sources.run(def, loc, force); } finally { inflight.delete(key); }
      if (my !== token) return;
      const prev = res[def.id];
      res[def.id] = !r.ok && prev && prev.ok ? { ...prev, stale: true, error: r.error, lastTry: r.fetchedAt } : r;
      scheduleRender(def.group !== 'now');
    }));
  }

  function tick(force) {
    if (document.hidden) return;
    const now = Date.now();
    const due = WX.sources.LIST.filter(d => force || !lastRun[d.id] || now - lastRun[d.id] >= d.every);
    if (due.length) runSources(due, false);
  }

  function onLocation(newLoc) {
    loc = newLoc;
    token++;
    res = {};
    lastRun = {};
    ensCache = { sig: '', ens: null };
    firstFullDone = false;
    const c = $('coconut-card');
    if (c) c.hidden = !loc.coconut;
    fullRender();
    runSources(WX.sources.LIST, false);
  }

  function boot() {
    const v = $('app-version');
    if (v) v.textContent = `เวอร์ชัน ${WX.VERSION} (${WX.RELEASED})`;
    loc = WX.locations.init(onLocation);
    WX.ui.initInteractions();
    fullRender();
    runSources(WX.sources.LIST, false);

    $('refresh-now').onclick = async () => {
      const b = $('refresh-now');
      b.disabled = true;
      await runSources(WX.sources.LIST, true);
      b.disabled = false;
    };
    setInterval(() => tick(false), 15000);
    // อายุข้อมูล ("2 นาทีที่แล้ว") ต้องเดินต่อแม้ไม่มีข้อมูลใหม่ — อัปเดตเฉพาะส่วนบนสุด ไม่รีเซ็ตกราฟที่ผู้ใช้เลื่อนอยู่
    setInterval(() => { if (!document.hidden) lightRender(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(false); lightRender(); } });
    window.addEventListener('online', () => tick(true));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
