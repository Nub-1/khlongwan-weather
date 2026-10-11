(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;

  // ค่าที่ตั้งใจเลือกเอง ไม่ใช่ค่ามาตรฐาน — โมเดลกริด 11-25 กม. ให้ละอองฝนเล็กน้อยบ่อยเกินจริง
  // การตั้งเกณฑ์ "ฝนตก" สูงกว่าเครื่องวัด (0.1 มม.) ช่วยลดการเตือนฝนที่ไม่ตก
  const CFG = {
    HOUR_WET_MM: 0.3,
    HOUR_HEAVY_MM: 2.5,
    DAY_THRESHOLDS: [1, 10, 35],
    PERIODS: [
      { id: 'night', label: 'ดึก', from: 0, to: 6 },
      { id: 'morning', label: 'เช้า', from: 6, to: 12 },
      { id: 'afternoon', label: 'บ่าย', from: 12, to: 18 },
      { id: 'evening', label: 'ค่ำ', from: 18, to: 24 },
    ],
    DETAILED_DAYS: 7,
    WINDOW_P: 0.4,
  };

  // ============ Ensemble ============
  // Open-Meteo: precipitation ที่ป้ายเวลา T คือฝนรวมของชั่วโมง "ก่อนหน้า" T (T-1h, T]
  // ช่อง (slot) จึงเริ่มที่ T-1h — ถ้าอ่านเป็นเริ่มที่ T เวลาฝนจะเลื่อนไป 1 ชม. และฝนช่วง 23:00-24:00 จะตกผิดวัน
  function memberKeys(h) {
    return Object.keys(h).filter(k => k.startsWith('precipitation') && !/probability|sum|hours/.test(k));
  }

  function buildEnsemble(inputs) {
    const set = new Set();
    for (const inp of inputs) for (const t of inp?.hourly?.time || []) set.add(t);
    const times = [...set].sort();
    if (!times.length) return null;
    const index = new Map(times.map((t, i) => [t, i]));

    const models = [];
    for (const inp of inputs) {
      const h = inp?.hourly;
      if (!h?.time?.length) continue;
      const keys = memberKeys(h);
      if (!keys.length) continue;
      const members = keys.map(k => {
        const arr = new Array(times.length).fill(null);
        const src = h[k];
        for (let j = 0; j < h.time.length; j++) {
          const v = src?.[j];
          if (v != null && Number.isFinite(v)) arr[index.get(h.time[j])] = v;
        }
        return arr;
      });
      models.push({ id: inp.id, label: inp.label || inp.id, weight: inp.weight ?? 1, members });
    }
    if (!models.length) return null;

    const epochs = times.map(U.bkkToEpoch);
    const slotStart = epochs.map(e => e - U.HOUR_MS);
    const dateOf = slotStart.map(s => U.bkkDateStr(s));
    const hourOf = slotStart.map(s => U.bkkHourNum(s));
    const byDate = new Map();
    dateOf.forEach((d, i) => {
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(i);
    });
    return { times, epochs, slotStart, dateOf, hourOf, byDate, models };
  }

  // น้ำหนักเท่ากันต่อ "ระบบ" ไม่ใช่ต่อสมาชิก — ECMWF 51 ชุด ไม่ควรกลบ GEFS 31 ชุด
  // ช่วงที่ระบบไหนไม่มีข้อมูล (ICON สั้นกว่า) น้ำหนักจะถูกปรับสัดส่วนใหม่
  function normalizeSamples(per) {
    const tw = per.reduce((s, p) => s + p.m.weight, 0);
    const v = [], w = [];
    for (const p of per) {
      const each = p.m.weight / tw / p.vals.length;
      for (const x of p.vals) { v.push(x); w.push(each); }
    }
    return { v, w, n: v.length, nModels: per.length };
  }

  const SUM = { init: 0, step: (a, v) => a + v };
  const anyWet = thr => ({ init: 0, step: (a, v) => (v >= thr ? 1 : a) });

  function samples(ens, idxs, minCount, reduce) {
    const per = [];
    for (const m of ens.models) {
      const vals = [];
      for (const mem of m.members) {
        let n = 0, acc = reduce.init;
        for (const i of idxs) {
          const v = mem[i];
          if (v == null) continue;
          n++;
          acc = reduce.step(acc, v);
        }
        if (n >= minCount) vals.push(acc);
      }
      if (vals.length) per.push({ m, vals });
    }
    return normalizeSamples(per);
  }

  function weightedQuantileSorted(sv, sw, q) {
    if (!sv.length) return null;
    const total = sw.reduce((s, x) => s + x, 0);
    const target = q * total;
    let cum = 0;
    for (let i = 0; i < sv.length; i++) {
      cum += sw[i];
      if (cum >= target - 1e-12) return sv[i];
    }
    return sv[sv.length - 1];
  }

  function weightedQuantile(values, weights, q) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    return weightedQuantileSorted(order.map(i => values[i]), order.map(i => weights[i]), q);
  }

  // condThr: คำนวณช่วงปริมาณ "เฉพาะสมาชิกที่ฝนตกถึงเกณฑ์" — ค่ากลางของทั้งหมดจะเป็น 0 ทั้งที่โอกาสฝน 49% ซึ่งอ่านแล้วขัดกัน
  function distribution(s, thresholds, condThr) {
    if (!s || !s.n) return null;
    const order = s.v.map((_, i) => i).sort((a, b) => s.v[a] - s.v[b]);
    const sv = order.map(i => s.v[i]);
    const sw = order.map(i => s.w[i]);
    const probs = {};
    for (const t of thresholds) {
      let p = 0;
      for (let i = 0; i < sv.length; i++) if (sv[i] >= t) p += sw[i];
      probs[t] = U.clamp(p, 0, 1);
    }
    let mean = 0;
    const cs = [], cw = [];
    for (let i = 0; i < sv.length; i++) {
      mean += sv[i] * sw[i];
      if (condThr != null && sv[i] >= condThr) { cs.push(sv[i]); cw.push(sw[i]); }
    }
    const condMass = cw.reduce((a, b) => a + b, 0);
    const cond = condMass >= 0.02
      ? { p10: weightedQuantileSorted(cs, cw, 0.10), p50: weightedQuantileSorted(cs, cw, 0.50), p90: weightedQuantileSorted(cs, cw, 0.90) }
      : null;
    return {
      n: s.n, nModels: s.nModels, probs, mean, cond,
      p10: weightedQuantileSorted(sv, sw, 0.10),
      p25: weightedQuantileSorted(sv, sw, 0.25),
      p50: weightedQuantileSorted(sv, sw, 0.50),
      p75: weightedQuantileSorted(sv, sw, 0.75),
      p90: weightedQuantileSorted(sv, sw, 0.90),
    };
  }

  function hourDist(ens, i) {
    const d = distribution(samples(ens, [i], 1, SUM), [CFG.HOUR_WET_MM, CFG.HOUR_HEAVY_MM]);
    if (!d) return null;
    return { ...d, pWet: d.probs[CFG.HOUR_WET_MM], pHeavy: d.probs[CFG.HOUR_HEAVY_MM] };
  }

  function dailyDist(ens, date) {
    const idxs = ens.byDate.get(date);
    if (!idxs || idxs.length < 23) return null;
    return distribution(samples(ens, idxs, 23, SUM), CFG.DAY_THRESHOLDS, CFG.DAY_THRESHOLDS[0]);
  }

  function periodDist(ens, date, period) {
    const all = ens.byDate.get(date) || [];
    const idxs = all.filter(i => ens.hourOf[i] >= period.from && ens.hourOf[i] < period.to);
    if (idxs.length < period.to - period.from) return null;
    const d = distribution(samples(ens, idxs, Math.ceil(idxs.length * 0.8), anyWet(CFG.HOUR_WET_MM)), [0.5]);
    return d ? { pAny: d.probs[0.5], n: d.n } : null;
  }

  function rangeTotal(ens, dates, thresholds = []) {
    const idxs = [];
    for (const d of dates) idxs.push(...(ens.byDate.get(d) || []));
    if (!idxs.length) return null;
    const dist = distribution(samples(ens, idxs, Math.floor(idxs.length * 0.97), SUM), thresholds);
    return dist ? { ...dist, days: dates.length } : null;
  }

  // ฝนก้อนถัดไปจะ "เริ่ม" เมื่อไหร่ — วัดทีละสมาชิกแล้วดูการกระจายของเวลา
  // ตอบเรื่องเวลาที่ไม่ตรงโดยตรง: บอกเป็นช่วง ไม่ใช่เวลาเดียว
  function nextRainOnset(ens, nowMs, opts = {}) {
    const thr = opts.thr ?? CFG.HOUR_WET_MM;
    const horizon = (opts.horizonH ?? 24) * U.HOUR_MS;
    const idxs = [];
    for (let i = 0; i < ens.epochs.length; i++) {
      if (ens.epochs[i] > nowMs && ens.slotStart[i] < nowMs + horizon) idxs.push(i);
    }
    if (!idxs.length) return null;

    const per = [];
    for (const m of ens.models) {
      const vals = [];
      for (const mem of m.members) {
        let first = null, seen = false;
        for (const i of idxs) {
          const v = mem[i];
          if (v == null) continue;
          seen = true;
          if (v >= thr) { first = Math.max(ens.slotStart[i], nowMs); break; }
        }
        if (seen) vals.push(first);
      }
      if (vals.length) per.push({ m, vals });
    }
    const s = normalizeSamples(per);
    if (!s.n) return null;

    let pAny = 0, pOngoing = 0;
    const ov = [], ow = [];
    s.v.forEach((x, j) => {
      if (x == null) return;
      pAny += s.w[j];
      if (x === nowMs) pOngoing += s.w[j];
      ov.push(x); ow.push(s.w[j]);
    });
    const order = ov.map((_, i) => i).sort((a, b) => ov[a] - ov[b]);
    const sv = order.map(i => ov[i]);
    const sw = order.map(i => ow[i]);
    return {
      pAny: U.clamp(pAny, 0, 1),
      pOngoing: U.clamp(pOngoing, 0, 1),
      p10: weightedQuantileSorted(sv, sw, 0.10),
      p25: weightedQuantileSorted(sv, sw, 0.25),
      p50: weightedQuantileSorted(sv, sw, 0.50),
      p75: weightedQuantileSorted(sv, sw, 0.75),
      p90: weightedQuantileSorted(sv, sw, 0.90),
      nModels: s.nModels,
    };
  }

  function findWindows(ens, fromMs, toMs, opts = {}) {
    const pThr = opts.pThr ?? CFG.WINDOW_P;
    const gap = opts.gap ?? 1;
    const runs = [];
    let cur = null;
    for (let i = 0; i < ens.epochs.length; i++) {
      if (ens.epochs[i] <= fromMs || ens.slotStart[i] >= toMs) continue;
      const d = hourDist(ens, i);
      const wet = d && d.pWet >= pThr;
      if (wet) {
        if (cur && i - cur.last <= gap + 1) { cur.last = i; cur.idxs.push(i); cur.peak = Math.max(cur.peak, d.pWet); }
        else { cur = { first: i, last: i, idxs: [i], peak: d.pWet }; runs.push(cur); }
      }
    }
    return runs.map(r => {
      const span = [];
      for (let i = r.first; i <= r.last; i++) span.push(i);
      const tot = distribution(samples(ens, span, span.length, SUM), [CFG.DAY_THRESHOLDS[0]]);
      return {
        startMs: ens.slotStart[r.first],
        endMs: ens.epochs[r.last],
        hours: span.length,
        peakP: r.peak,
        total: tot ? { p10: tot.p10, p50: tot.p50, p90: tot.p90, mean: tot.mean } : null,
      };
    });
  }

  // ============ Wording ============
  function describeProb(p) {
    if (p == null) return { level: -1, label: 'ไม่มีข้อมูล' };
    if (p < 0.10) return { level: 0, label: 'แทบไม่มีฝน' };
    if (p < 0.30) return { level: 1, label: 'โอกาสฝนน้อย' };
    if (p < 0.50) return { level: 2, label: 'อาจมีฝน' };
    if (p < 0.70) return { level: 3, label: 'มีโอกาสฝนสูง' };
    if (p < 0.90) return { level: 4, label: 'น่าจะมีฝน' };
    return { level: 5, label: 'เกือบแน่ว่าฝนตก' };
  }

  function classifyHour(mm) {
    if (mm == null || mm < CFG.HOUR_WET_MM) return { level: 0, label: 'ไม่มีฝน' };
    if (mm < 2.5) return { level: 1, label: 'ฝนเบา' };
    if (mm < 7.6) return { level: 2, label: 'ฝนปานกลาง' };
    if (mm < 30) return { level: 3, label: 'ฝนหนัก' };
    return { level: 4, label: 'ฝนหนักมาก' };
  }

  // เกณฑ์รายวันของกรมอุตุนิยมวิทยา
  function classifyDay(mm) {
    if (mm == null || mm < 0.1) return { level: 0, label: 'ไม่มีฝน' };
    if (mm <= 10) return { level: 1, label: 'ฝนเล็กน้อย' };
    if (mm <= 35) return { level: 2, label: 'ฝนปานกลาง' };
    if (mm <= 90) return { level: 3, label: 'ฝนหนัก' };
    return { level: 4, label: 'ฝนหนักมาก' };
  }

  // ============ Convective instability ============
  // CAPE สูง = บรรยากาศพร้อมเกิดฝนฟ้าคะนองเฉพาะที่ ซึ่งโมเดลกริดหยาบมักพลาด — เป็นตัวบอกปัจจัยหนุน ไม่ใช่ความน่าจะเป็น
  function capeLevel(cape) {
    if (cape == null || !Number.isFinite(cape) || cape < 1000) return 0;
    return cape < 2500 ? 1 : 2;
  }

  function capeMaxByDate(times, cape, fromHour = 10, toHour = 20) {
    const out = new Map();
    (times || []).forEach((t, j) => {
      const v = cape?.[j];
      if (v == null) return;
      const ms = U.bkkToEpoch(t);
      const h = U.bkkHourNum(ms);
      if (h < fromHour || h > toHour) return;
      const d = U.bkkDateStr(ms);
      out.set(d, Math.max(out.get(d) ?? 0, v));
    });
    return out;
  }

  // ============ Daily sums & verification ============
  function dailyFromHourly(times, values, minSlots = 23) {
    const acc = new Map();
    (times || []).forEach((t, j) => {
      const v = values?.[j];
      if (v == null) return;
      const d = U.bkkDateStr(U.bkkToEpoch(t) - U.HOUR_MS);
      const a = acc.get(d) || { sum: 0, n: 0 };
      a.sum += v; a.n += 1;
      acc.set(d, a);
    });
    const out = new Map();
    for (const [d, a] of acc) if (a.n >= minSlots) out.set(d, a.sum);
    return out;
  }

  function scoreForecasts(obs, fc, thr = 1) {
    let a = 0, b = 0, c = 0, d = 0, absErr = 0, bias = 0, n = 0;
    for (const [date, o] of obs) {
      const f = fc.get(date);
      if (f == null || o == null) continue;
      n++;
      const O = o >= thr, F = f >= thr;
      if (O && F) a++; else if (!O && F) b++; else if (O && !F) c++; else d++;
      absErr += Math.abs(f - o);
      bias += f - o;
    }
    if (!n) return null;
    const ratio = (x, y) => (y > 0 ? x / y : null);
    return {
      n, hits: a, falseAlarms: b, misses: c, correctNeg: d,
      pod: ratio(a, a + c), far: ratio(b, a + b), csi: ratio(a, a + b + c),
      freqBias: ratio(a + b, a + c), baseRate: (a + c) / n,
      mae: absErr / n, meanBias: bias / n,
    };
  }

  // ============ Right-now verdict ============
  // เรดาร์ (สังเกตการณ์) ชนะโมเดลเสมอ และใช้ค่าเดียวนี้ทุกแผง ไม่ให้แผงหนึ่งบอกว่าตก อีกแผงบอกว่าไม่ตก
  function nowVerdict({ longdo, radar, model }) {
    const lOk = !!(longdo && longdo.ok);
    const rOk = !!(radar && radar.ok);
    const longdoRain = lOk && longdo.intensity > 0;
    const radarRain = rOk && radar.atPointDbz != null && radar.atPointDbz >= U.RAIN_DBZ;

    const sources = [];
    if (lOk) sources.push({ id: 'longdo', label: 'เรดาร์ Longdo', rain: longdoRain, text: longdoRain ? `${longdo.desc || 'มีฝน'} (${longdo.intensity}/5)` : 'ไม่มีฝน' });
    if (rOk) {
      const cls = U.dbzClass(radar.atPointDbz);
      sources.push({ id: 'rainviewer', label: 'เรดาร์ RainViewer', rain: radarRain, text: radarRain ? cls.label : 'ไม่เห็นฝนที่จุดนี้' });
    }

    const lines = [];
    const motionText = () => {
      const v = radar.velocity;
      return v && v.ok ? `เมฆฝนเคลื่อนไปทาง${U.compassTh(v.headingDeg)} ~${Math.round(v.speedKmh)} กม./ชม.` : null;
    };
    const nearText = () => {
      const n = radar.nearest;
      return n ? `ฝนที่ใกล้ที่สุดห่าง ~${Math.round(n.distKm)} กม. ทาง${U.compassTh(n.bearingDeg)}` : null;
    };

    let state, icon, title;
    if (longdoRain || radarRain) {
      state = 'raining'; icon = '🌧️'; title = 'กำลังฝนตก';
      if (radarRain) lines.push(`ความแรง: ${U.dbzClass(radar.atPointDbz).label}`);
      else if (longdo.desc) lines.push(`ความแรง: ${longdo.desc}`);
      if (rOk) { const m = motionText(); if (m) lines.push(m); }
      if (lOk && rOk && longdoRain !== radarRain) lines.push('เรดาร์สองแหล่งเห็นไม่ตรงกัน — ถือว่าฝนตกไว้ก่อน');
    } else if (rOk && radar.arrival && radar.arrival.etaMin <= 60) {
      const eta = Math.max(5, Math.round(radar.arrival.etaMin / 5) * 5);
      state = 'approaching'; icon = '⛈️'; title = `ฝนกำลังเข้า — คาดถึงใน ~${eta} นาที`;
      lines.push(`ความแรงสูงสุดที่คาด: ${U.dbzClass(radar.arrival.peakDbz ?? radar.arrival.dbz).label}`);
      const n = nearText(); if (n) lines.push(n);
      const m = motionText(); if (m) lines.push(m);
    } else if (rOk && radar.nearest && radar.nearest.distKm <= 25) {
      state = 'nearby'; icon = '🌦️'; title = 'มีฝนอยู่ใกล้ ๆ แต่ยังไม่ตกที่จุดนี้';
      lines.push(nearText());
      lines.push(radar.velocity && radar.velocity.ok ? `${motionText()} — ยังไม่คาดว่าจะเข้าจุดนี้ภายใน 1 ชม.` : 'ยังประเมินทิศทางเคลื่อนที่ไม่ได้');
    } else if (lOk || rOk) {
      state = 'dry'; icon = '☀️'; title = 'ตอนนี้ไม่มีฝน';
      if (rOk) lines.push('เรดาร์ไม่เห็นฝนในรัศมีประมาณ 25 กม.');
    } else if (model && model.ok) {
      state = model.isRainy ? 'model_rain' : 'model_dry';
      icon = model.isRainy ? '🌧️' : '⛅';
      title = model.isRainy ? 'โมเดลบอกว่ามีฝน' : 'โมเดลไม่เห็นฝนตอนนี้';
      lines.push('ยังไม่มีเรดาร์ยืนยัน — นี่คือค่าจากโมเดล ไม่ใช่การสังเกตการณ์');
    } else {
      state = 'unknown'; icon = '❓'; title = 'ยังไม่มีข้อมูลฝนปัจจุบัน';
    }
    return { state, icon, title, lines: lines.filter(Boolean), sources, observed: lOk || rOk };
  }

  function subEnsemble(ens, ids) {
    const models = ens.models.filter(m => ids.includes(m.id));
    return models.length ? { ...ens, models } : null;
  }

  // ฝนสะสมนับจากตอนนี้ แยกรายสมาชิกแล้วหาควอนไทล์ทุก stepH ชั่วโมง — เห็นว่าความไม่แน่นอนบานออกเร็วแค่ไหน
  function cumulativeFan(ens, fromMs, hours = 168, stepH = 3) {
    const idxs = [];
    for (let i = 0; i < ens.epochs.length && idxs.length < hours; i++) if (ens.epochs[i] > fromMs) idxs.push(i);
    if (!idxs.length) return null;
    const cum = ens.models.map(m => m.members.map(mem => {
      const out = new Array(idxs.length);
      let acc = 0, ok = true;
      idxs.forEach((i, k) => {
        if (mem[i] == null) ok = false; else acc += mem[i];
        out[k] = ok ? acc : null;
      });
      return out;
    }));
    const points = [{ ms: Math.max(fromMs, ens.slotStart[idxs[0]]), p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, n: 0 }];
    for (let k = stepH - 1; k < idxs.length; k += stepH) {
      const per = [];
      ens.models.forEach((m, mi) => {
        const vals = cum[mi].map(a => a[k]).filter(v => v != null);
        if (vals.length) per.push({ m, vals });
      });
      const d = distribution(normalizeSamples(per), []);
      if (!d) break;
      points.push({ ms: ens.epochs[idxs[k]], p10: d.p10, p25: d.p25, p50: d.p50, p75: d.p75, p90: d.p90, n: d.n });
    }
    return points.length > 1 ? points : null;
  }

  WX.engine = {
    CFG, buildEnsemble, weightedQuantile, subEnsemble, cumulativeFan,
    hourDist, dailyDist, periodDist, rangeTotal, nextRainOnset, findWindows,
    describeProb, classifyHour, classifyDay, capeLevel, capeMaxByDate,
    dailyFromHourly, scoreForecasts, nowVerdict,
  };
})(typeof window !== 'undefined' ? window : globalThis);
