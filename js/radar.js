(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;

  const TILE = 256;
  const NOECHO = -32;
  const HOST_META = 'https://api.rainviewer.com/public/weather-maps.json';

  // ============ Geometry ============
  function worldPx(lat, lon, z) {
    const n = TILE * Math.pow(2, z);
    const s = Math.sin((lat * Math.PI) / 180);
    return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }

  function kmPerPx(lat, z) {
    return (40075.016686 * Math.cos((lat * Math.PI) / 180)) / (TILE * Math.pow(2, z));
  }

  // ============ Field helpers ============
  const zlin = dbz => (dbz > 10 ? dbz - 10 : 0);

  function maxInDisc(field, size, cx, cy, r) {
    let m = NOECHO - 1;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(size - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return null;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = field[y * size + x];
        if (v > NOECHO && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) m = Math.max(m, v);
      }
    }
    return m < NOECHO ? null : m;
  }

  function frameStats(field) {
    let echo = 0, max = NOECHO;
    for (let i = 0; i < field.length; i++) {
      if (field[i] > NOECHO) { echo++; if (field[i] > max) max = field[i]; }
    }
    return { echo, fraction: echo / field.length, maxDbz: max };
  }

  // ============ Motion ============
  // หา shift ที่ทำให้ g1(x) ≈ g0(x - shift) มี error ต่ำสุด (normalized SSD) แล้วเกลี่ยเป็น sub-pixel
  function bestShift(g0, g1, size, S) {
    const lo = S, hi = size - S;
    let echo = 0;
    for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) if (g1[y * size + x] > 0) echo++;
    if (echo < 12) return null;

    const W = 2 * S + 1;
    const errs = new Float64Array(W * W);
    let best = Infinity, bx = 0, by = 0, err0 = 1;
    for (let sy = -S; sy <= S; sy++) {
      for (let sx = -S; sx <= S; sx++) {
        let num = 0, den = 0;
        for (let y = lo; y < hi; y++) {
          const r1 = y * size, r0 = (y - sy) * size;
          for (let x = lo; x < hi; x++) {
            const a = g1[r1 + x], b = g0[r0 + x - sx];
            const d = a - b;
            num += d * d;
            den += a * a + b * b;
          }
        }
        const e = den > 0 ? num / den : 1;
        errs[(sy + S) * W + (sx + S)] = e;
        if (sx === 0 && sy === 0) err0 = e;
        if (e < best) { best = e; bx = sx; by = sy; }
      }
    }
    const at = (sx, sy) => errs[(sy + S) * W + (sx + S)];
    const sub = (em, e0, ep) => {
      const den = em - 2 * e0 + ep;
      if (den < 1e-9) return 0;
      return U.clamp(0.5 * (em - ep) / den, -1, 1);
    };
    let ox = 0, oy = 0;
    if (bx > -S && bx < S) ox = sub(at(bx - 1, by), best, at(bx + 1, by));
    if (by > -S && by < S) oy = sub(at(bx, by - 1), best, at(bx, by + 1));
    return { dx: bx + ox, dy: by + oy, err: best, err0, echo };
  }

  // frames: [{t(ms), field}] เรียงเก่า→ใหม่ ; คืนความเร็วเป็น px/นาที (x=ตะวันออก, y=ใต้)
  function estimateVelocity(frames, size, kmpp) {
    const n = frames.length;
    if (n < 2) return { ok: false, reason: 'frames' };
    const g1 = Float32Array.from(frames[n - 1].field, zlin);
    const cands = [];
    for (let k = 1; k <= Math.min(3, n - 1); k++) {
      const prev = frames[n - 1 - k];
      const dtMin = (frames[n - 1].t - prev.t) / 60000;
      if (dtMin <= 0) continue;
      const S = Math.min(Math.floor((size - 24) / 2), 8 * k + 2);
      const sh = bestShift(Float32Array.from(prev.field, zlin), g1, size, S);
      if (!sh || sh.err > 0.6) continue;
      cands.push({ vx: sh.dx / dtMin, vy: sh.dy / dtMin, err: sh.err });
    }
    if (!cands.length) return { ok: false, reason: 'nomatch' };
    let sw = 0, vx = 0, vy = 0;
    for (const c of cands) { const w = Math.pow(1 - c.err, 2); sw += w; vx += c.vx * w; vy += c.vy * w; }
    vx /= sw; vy /= sw;
    const speedKmh = Math.hypot(vx, vy) * kmpp * 60;
    const headingDeg = (Math.atan2(vx, -vy) * 180 / Math.PI + 360) % 360;
    return {
      ok: true, vx, vy, speedKmh, headingDeg,
      fromDeg: (headingDeg + 180) % 360,
      quality: 1 - Math.min(...cands.map(c => c.err)),
      stationary: speedKmh < 3,
    };
  }

  // ============ Nowcast ============
  function nearestEcho(field, size, c, thr, kmpp) {
    let best = Infinity, bx = 0, by = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (field[y * size + x] < thr) continue;
        const d = (x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2;
        if (d < best) { best = d; bx = x + 0.5; by = y + 0.5; }
      }
    }
    if (!Number.isFinite(best)) return null;
    return {
      distKm: Math.sqrt(best) * kmpp,
      bearingDeg: (Math.atan2(bx - c.x, c.y - by) * 180 / Math.PI + 360) % 360,
    };
  }

  // ย้อนตามลมกลับไปหาต้นทางของเมฆฝนที่จะมาถึงจุดนี้ ; รัศมีค้นหาขยายตามเวลาล่วงหน้า (ความไม่แน่นอนโตขึ้น)
  // ไม่คิดการเกิด/สลายตัวของเซลล์ฝน จึงเชื่อได้แค่ราว 30-60 นาที
  function projectArrival(field, size, c, vel, opts = {}) {
    const thr = opts.thr ?? U.RAIN_DBZ;
    const maxMin = opts.maxMin ?? 90;
    const step = opts.step ?? 5;
    let hit = null;
    for (let t = 0; t <= maxMin; t += step) {
      const r = 1.5 + 0.04 * t;
      const m = maxInDisc(field, size, c.x - vel.vx * t, c.y - vel.vy * t, r);
      if (m == null || m < thr) { if (hit && t > hit.etaMin + 30) break; continue; }
      if (!hit) hit = { etaMin: t, dbz: m, peakDbz: m };
      else if (t <= hit.etaMin + 30) hit.peakDbz = Math.max(hit.peakDbz, m);
    }
    return hit;
  }

  function analyze(frames, geo, nowMs = Date.now()) {
    if (!frames || !frames.length) return { ok: false, reason: 'noframes' };
    const { lat, z, size, center } = geo;
    const kmpp = kmPerPx(lat, z);
    const latest = frames[frames.length - 1];
    const ageMin = (nowMs - latest.t) / 60000;
    const st = frameStats(latest.field);
    if (st.fraction > 0.9 || st.maxDbz > 95) return { ok: false, reason: 'decode', stats: st };
    if (ageMin > 35) return { ok: false, reason: 'stale', ageMin };

    const atPoint = maxInDisc(latest.field, size, center.x, center.y, 1.5);
    const nearest = nearestEcho(latest.field, size, center, U.RAIN_DBZ, kmpp);
    const velocity = estimateVelocity(frames, size, kmpp);

    let arrival = null;
    if (velocity.ok && !(atPoint != null && atPoint >= U.RAIN_DBZ)) {
      arrival = projectArrival(latest.field, size, center, velocity);
    }
    return {
      ok: true, frameTimeMs: latest.t, ageMin, atPointDbz: atPoint, nearest, velocity, arrival,
      kmPerPx: kmpp, windowKm: size * kmpp, stats: st, frameCount: frames.length,
    };
  }

  // ============ Browser: ดึง tile แล้วถอดเป็น dBZ ============
  // color scheme 0 = ขาวดำ ค่าพิกเซล = dBZ + 32 ; alpha 0 = ไม่มีสัญญาณ
  function loadImage(url, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const timer = setTimeout(() => reject(new Error('tile timeout')), timeoutMs);
      img.onload = () => { clearTimeout(timer); resolve(img); };
      img.onerror = () => { clearTimeout(timer); reject(new Error('tile load failed')); };
      img.src = url;
    });
  }

  async function loadWindow(host, framePath, lat, lon, opts = {}) {
    const z = opts.z ?? 7, size = opts.size ?? 96;
    const w = worldPx(lat, lon, z);
    const x0 = Math.floor(w.x - size / 2), y0 = Math.floor(w.y - size / 2);
    const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x0 + size - 1) / TILE);
    const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y0 + size - 1) / TILE);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = `${host}${framePath}/${TILE}/${z}/${tx}/${ty}/0/0_0.png`;
        jobs.push(loadImage(url).then(img => ctx.drawImage(img, tx * TILE - x0, ty * TILE - y0)));
      }
    }
    await Promise.all(jobs);

    let data;
    try {
      data = ctx.getImageData(0, 0, size, size).data;
    } catch (e) {
      throw new Error('เบราว์เซอร์บล็อกการอ่านพิกเซลเรดาร์ (CORS)');
    }
    const field = new Float32Array(size * size);
    for (let i = 0; i < field.length; i++) {
      field[i] = data[4 * i + 3] < 10 ? NOECHO : data[4 * i] - 32;
    }
    return { field, center: { x: w.x - x0, y: w.y - y0 } };
  }

  async function loadFrames(meta, lat, lon, opts = {}) {
    const n = opts.frames ?? 4;
    const past = (meta?.radar?.past || []).slice(-n);
    if (!past.length) throw new Error('RainViewer ไม่มีเฟรมเรดาร์');
    const host = meta.host || 'https://tilecache.rainviewer.com';
    const loaded = await Promise.all(past.map(f => loadWindow(host, f.path, lat, lon, opts)));
    return {
      frames: past.map((f, i) => ({ t: f.time * 1000, field: loaded[i].field })),
      geo: { lat, lon, z: opts.z ?? 7, size: opts.size ?? 96, center: loaded[0].center },
    };
  }

  WX.radar = {
    NOECHO, HOST_META,
    worldPx, kmPerPx, maxInDisc, frameStats, bestShift, estimateVelocity,
    nearestEcho, projectArrival, analyze, loadFrames,
  };
})(typeof window !== 'undefined' ? window : globalThis);
