(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const $ = id => document.getElementById(id);

  const MIN = 60000, HOUR = 3600000;
  const SPAN_H = 6;        // ไทม์ไลน์ −6 ถึง +6 ชม.
  const FUTURE_STEPS = 6;  // คาดการณ์จากเรดาร์ +10…+60 นาที (เกินนั้นใช้แบบจำลอง)
  const STEP_MS = 700;

  // ============ ไทม์ไลน์ (logic ล้วน มี unit test) ============
  // เรดาร์ RainViewer ฟรีเก็บย้อนหลังได้ ~2 ชม. — ชั่วโมงล่าสุดใช้ทุกภาพ (10 นาที) ชั่วโมงก่อนนั้นใช้ทุก 20 นาที
  // เพื่อไม่ให้ชนเพดาน ~100 คำขอ/นาที/IP ; ช่วงที่ไม่มีเรดาร์เติมด้วยแบบจำลองรายชั่วโมง
  function pickRadarPast(past) {
    if (!past || !past.length) return [];
    const last = past[past.length - 1].time;
    return past.filter(f => last - f.time <= 3600 || ((last - f.time) / 600) % 2 === 0);
  }

  function buildTimeline({ radarPast, hasFuture, gridTimes, nowMs }) {
    const frames = radarPast.map(f => ({ kind: 'radar', ms: f.time * 1000, path: f.path }));
    const last = frames.length ? frames[frames.length - 1] : null;
    if (last && hasFuture) {
      for (let k = 1; k <= FUTURE_STEPS; k++) frames.push({ kind: 'extrap', ms: last.ms + k * 10 * MIN, offsetMin: k * 10 });
    }
    const covStart = frames.length ? frames[0].ms - 5 * MIN : Infinity;
    const covEnd = frames.length ? frames[frames.length - 1].ms + 5 * MIN : -Infinity;
    (gridTimes || []).forEach((t, i) => {
      const ms = U.bkkToEpoch(t);
      if (ms < nowMs - SPAN_H * HOUR - 5 * MIN || ms > nowMs + SPAN_H * HOUR + 5 * MIN) return;
      if (ms >= covStart && ms <= covEnd) return;
      frames.push({ kind: 'model', ms, t: i });
    });
    frames.sort((a, b) => a.ms - b.ms);
    let nowIdx = 0;
    if (last) nowIdx = frames.indexOf(last);
    else frames.forEach((f, i) => { if (Math.abs(f.ms - nowMs) < Math.abs(frames[nowIdx].ms - nowMs)) nowIdx = i; });
    return { frames, nowIdx: Math.max(0, nowIdx) };
  }

  // สีตามปริมาณฝนรายชั่วโมงของแบบจำลอง — ใช้สีระดับเดียวกับเรดาร์ (Universal Blue)
  function rateColor(mm) {
    if (mm == null || mm < 0.1) return null;
    if (mm < 0.5) return [0x51, 0xc5, 0xe8];
    if (mm < 2.5) return [0x00, 0x69, 0x9c];
    if (mm < 7.6) return [0xff, 0xd2, 0x00];
    if (mm < 15) return [0xff, 0x95, 0x00];
    if (mm < 30) return [0xcd, 0x0d, 0x00];
    return [0xff, 0x81, 0xff];
  }

  // ช่องกริดที่ครอบคลุมพิกัดนี้ (แถว 0 = เหนือสุด) — คืน null ถ้าอยู่นอกกรอบ
  function cellAt(grid, lat, lon) {
    const h = ((grid.n - 1) / 2 + 0.5) * grid.step;
    const row = Math.floor((grid.lat + h - lat) / grid.step);
    const col = Math.floor((lon - (grid.lon - h)) / grid.step);
    if (row < 0 || col < 0 || row >= grid.n || col >= grid.n) return null;
    return { row, col, p: row * grid.n + col };
  }

  function rateLabel(mm) {
    if (mm == null) return 'ไม่มีข้อมูล';
    if (mm < 0.1) return 'ไม่มีฝน';
    if (mm < 0.5) return 'ฝนเบามาก';
    if (mm < 2.5) return 'ฝนเบา';
    if (mm < 7.6) return 'ฝนปานกลาง';
    if (mm < 15) return 'ฝนหนัก';
    if (mm < 30) return 'ฝนหนักมาก';
    return 'ฝนรุนแรง';
  }

  // ============ แผนที่ ============
  let map = null, marker = null, rings = [], arrow = null, futurePane = null, futureLayer = null, futurePath = '';
  let modelOverlay = null, modelBox = null, modelKey = '', modelImgs = new Map();
  const radarLayers = new Map(), tiles = new Map();
  let frames = [], nowIdx = 0, idx = 0, sig = '', locKey = '', host = '';
  let playing = true, hold = 0, lastS = null, libFailed = false;
  let expanded = false;

  const textEl = s => { const e = document.createElement('span'); e.textContent = s; return e; };

  function ensureMap(loc) {
    if (!window.L) return false;
    if (!map) {
      map = L.map($('radar-map'), { zoomControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false })
        .setView([loc.lat, loc.lon], 7);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 12, attribution: '© OpenStreetMap · เรดาร์ © RainViewer · แบบจำลอง © Open-Meteo',
      }).addTo(map);
      futurePane = map.createPane('radarFuture');
      futurePane.style.zIndex = 250;
      futurePane.style.pointerEvents = 'none';
      map.on('zoomend', () => showFrame(idx));
      map.on('click', onMapClick);
      $('radar-expand').onclick = () => setExpanded(!expanded);
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && expanded) setExpanded(false); });
      // ปุ่มย้อนกลับของเครื่อง (Android) ปิดแผนที่เต็มจอแทนที่จะออกจากหน้าเว็บ
      window.addEventListener('popstate', () => { if (expanded) setExpanded(false, true); });
      $('radar-play').onclick = () => { playing = !playing; syncControls(); };
      $('radar-slider').oninput = e => { playing = false; showFrame(Number(e.target.value)); syncControls(); };
      setInterval(tick, STEP_MS);
    }
    const key = `${loc.lat},${loc.lon}`;
    if (key !== locKey) {
      locKey = key;
      map.setView([loc.lat, loc.lon], 7);
      rings.forEach(r => r.remove());
      if (marker) marker.remove();
      rings = [10, 25].map(km => L.circle([loc.lat, loc.lon], { radius: km * 1000, color: '#52514e', weight: 1, opacity: 0.6, fill: false, interactive: false }).addTo(map));
      marker = L.circleMarker([loc.lat, loc.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#d03b3b', fillOpacity: 1 })
        .addTo(map).bindTooltip(textEl(loc.name));
    }
    return true;
  }

  // สร้าง layer เรดาร์เมื่อจะใช้จริงเท่านั้น — กระจายคำขอไปตามเวลาที่ภาพเล่น ไม่ยิงทีเดียวทั้งหมด
  function radarLayer(path) {
    if (!radarLayers.has(path)) {
      const t = { ok: 0, err: 0 };
      tiles.set(path, t);
      radarLayers.set(path, L.tileLayer(`${host}${path}/256/{z}/{x}/{y}/2/1_0.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 5 })
        .on('tileload', () => { t.ok++; updateInfo(); })
        .on('tileerror', () => { t.err++; updateInfo(); })
        .addTo(map));
    }
    return radarLayers.get(path);
  }

  // วาดเป็นช่องสี่เหลี่ยมคมชัด (ไม่เบลอ) ให้เห็นว่าข้อมูลจริงหยาบแค่ช่องละ ~30 กม. ;
  // ขอบเข้มรอบช่องที่มีฝน กันสีฟ้าอ่อนกลืนกับสีทะเลบนแผนที่
  const CELL_PX = 32;
  function modelImage(grid, t) {
    const key = `${grid.lat},${grid.lon},${grid.times[t]}`;
    if (modelImgs.has(key)) return modelImgs.get(key);
    const n = grid.n;
    const cv = document.createElement('canvas');
    cv.width = cv.height = n * CELL_PX;
    const c2 = cv.getContext('2d');
    grid.values[t].forEach((v, p) => {
      const c = rateColor(v);
      if (!c) return;
      const x = (p % n) * CELL_PX, y = Math.floor(p / n) * CELL_PX;
      c2.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},0.8)`;
      c2.fillRect(x, y, CELL_PX, CELL_PX);
      c2.strokeStyle = 'rgba(20,30,50,0.55)';
      c2.lineWidth = 2;
      c2.strokeRect(x + 1, y + 1, CELL_PX - 2, CELL_PX - 2);
    });
    const url = cv.toDataURL();
    modelImgs.set(key, url);
    return url;
  }

  function ensureModelOverlay(grid) {
    const key = `${grid.lat},${grid.lon},${grid.n},${grid.step}`;
    if (modelOverlay && key === modelKey) return;
    if (modelOverlay) modelOverlay.remove();
    if (modelBox) modelBox.remove();
    modelKey = key;
    modelImgs = new Map();
    const h = ((grid.n - 1) / 2 + 0.5) * grid.step;
    const bounds = [[grid.lat - h, grid.lon - h], [grid.lat + h, grid.lon + h]];
    modelOverlay = L.imageOverlay(modelImage(grid, 0), bounds, { opacity: 0, interactive: false, zIndex: 4, className: 'model-overlay' }).addTo(map);
    // นอกกรอบนี้ไม่มีข้อมูลแบบจำลอง — ไม่ได้แปลว่าไม่มีฝน
    modelBox = L.rectangle(bounds, { color: '#52514e', weight: 1, opacity: 0, fill: false, interactive: false }).addTo(map);
  }

  function setFrames(S) {
    const r = S.res.radar;
    const meta = r && r.ok && r.data && r.data.meta;
    const g = S.res.model_grid;
    const grid = g && g.ok ? g.data : null;
    if (meta) host = meta.host;
    const vel = S.radar && S.radar.ok ? S.radar.velocity : null;
    const radarPast = meta ? pickRadarPast(meta.past) : [];
    const built = buildTimeline({ radarPast, hasFuture: !!(vel && vel.ok), gridTimes: grid ? grid.times : [], nowMs: S.now });
    if (grid) ensureModelOverlay(grid);
    const lastRadar = radarPast[radarPast.length - 1];
    const fp = vel && vel.ok && lastRadar ? lastRadar.path : '';
    if (fp !== futurePath) {
      futurePath = fp;
      if (futureLayer) { futureLayer.remove(); futureLayer = null; }
      if (fp) futureLayer = L.tileLayer(`${host}${fp}/256/{z}/{x}/{y}/2/1_0.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 12, pane: 'radarFuture' }).addTo(map);
    }
    const s2 = built.frames.map(f => `${f.kind}:${f.ms}`).join('|') + (grid ? `@${grid.lat},${grid.lon}` : '');
    if (s2 === sig) return;
    sig = s2;
    frames = built.frames;
    nowIdx = built.nowIdx;
    // layer เรดาร์ที่หลุดจากไทม์ไลน์แล้ว (เวลาเลื่อนไป) ทิ้งได้
    const keep = new Set(frames.filter(f => f.kind === 'radar').map(f => f.path));
    for (const [p, l] of radarLayers) if (!keep.has(p)) { l.remove(); radarLayers.delete(p); tiles.delete(p); }
    $('radar-slider').max = String(Math.max(0, frames.length - 1));
    renderScale(S.now);
    showFrame(nowIdx);
  }

  function renderScale(nowMs) {
    const el = $('radar-scale');
    if (!el || !frames.length) return;
    const lab = ms => {
      const h = Math.round((ms - nowMs) / HOUR);
      return h === 0 ? '' : `${h > 0 ? '+' : '−'}${Math.abs(h)} ชม.`;
    };
    const pos = frames.length > 1 ? (nowIdx / (frames.length - 1)) * 100 : 100;
    el.innerHTML = `<span>${lab(frames[0].ms)}</span><span class="now" style="left:${pos}%">ตอนนี้</span><span>${lab(frames[frames.length - 1].ms)}</span>`;
  }

  // แตะที่แผนที่ตอนดูภาพแบบจำลอง → บอกปริมาณฝนของช่องที่แตะ
  function onMapClick(e) {
    const f = frames[idx];
    const g = lastS && lastS.res.model_grid;
    if (!f || f.kind !== 'model' || !g || !g.ok) return;
    const cell = cellAt(g.data, e.latlng.lat, e.latlng.lng);
    if (!cell) return;
    const v = g.data.values[f.t][cell.p];
    L.popup({ closeButton: false, offset: [0, -2] }).setLatLng(e.latlng)
      .setContent(textEl(`แบบจำลอง ${U.bkkHM(f.ms)} น.: ${v == null ? 'ไม่มีข้อมูล' : `${v < 0.05 ? '0' : v.toFixed(1)} มม./ชม. (${rateLabel(v)})`}`))
      .openOn(map);
  }

  function showFrame(i) {
    if (!frames.length || !map) return;
    idx = (i + frames.length) % frames.length;
    const f = frames[idx];
    for (const [p, l] of radarLayers) l.setOpacity(f.kind === 'radar' && f.path === p ? 0.75 : 0);
    if (f.kind === 'radar') {
      radarLayer(f.path).setOpacity(0.75);
      const next = frames.slice(idx + 1).find(x => x.kind === 'radar');
      if (next) radarLayer(next.path); // โหลดภาพถัดไปรอไว้ ภาพจะได้ไม่กะพริบ
    }
    if (futureLayer) futureLayer.setOpacity(f.kind === 'extrap' ? 0.6 : 0);
    const v = lastS && lastS.radar && lastS.radar.velocity;
    if (futurePane) {
      let tr = '';
      if (f.kind === 'extrap' && v && v.ok) {
        // ความเร็วคิดเป็นพิกเซลที่ zoom 7 ต่อนาที → แปลงเป็นพิกเซลบนจอที่ zoom ปัจจุบัน
        const k = Math.pow(2, map.getZoom() - 7) * f.offsetMin;
        tr = `translate(${(v.vx * k).toFixed(1)}px, ${(v.vy * k).toFixed(1)}px)`;
      }
      futurePane.style.transform = tr;
    }
    const g = lastS && lastS.res.model_grid;
    const grid = g && g.ok ? g.data : null;
    if (modelOverlay) {
      const on = f.kind === 'model' && grid;
      if (on) { modelOverlay.setUrl(modelImage(grid, f.t)); modelOverlay.setOpacity(1); }
      else modelOverlay.setOpacity(0);
      if (modelBox) modelBox.setStyle({ opacity: on ? 0.7 : 0 });
    }

    const now = Date.now();
    const hrs = Math.max(1, Math.round(Math.abs(f.ms - now) / HOUR));
    let text, cls = '';
    if (f.kind === 'radar') text = `📡 ${U.bkkHM(f.ms)} น. · เรดาร์ · ${U.fmtAgo(f.ms, now)}`;
    else if (f.kind === 'extrap') {
      const ahead = Math.round((f.ms - now) / MIN);
      text = `🔮 ${U.bkkHM(f.ms)} น. · คาดการณ์จากเรดาร์ ${ahead > 0 ? `+${ahead} นาที` : '(ตอนนี้)'}`;
      cls = 'is-forecast';
    } else {
      text = `🧮 ${U.bkkHM(f.ms)} น. · แบบจำลอง · ${f.ms < now ? `ย้อนหลัง ${hrs} ชม.` : `ล่วงหน้า +${hrs} ชม.`}`;
      cls = 'is-model';
    }
    const t = $('radar-time');
    t.textContent = text;
    t.className = `radar-time ${cls}`;
    $('radar-slider').value = String(idx);
    updateInfo();
  }

  // บอกให้ชัดว่าภาพที่เห็นมาจากไหน และ "ไม่เห็นฝน" เพราะไม่มีฝนจริงหรือเพราะโหลดไม่สำเร็จ
  function updateInfo() {
    const out = $('radar-info');
    if (!out || !lastS || !frames.length) return;
    const f = frames[idx];
    const parts = [];
    if (f.kind === 'radar') {
      const t = tiles.get(f.path) || { ok: 0, err: 0 };
      if (t.err && !t.ok) parts.push(`⚠️ โหลดภาพเรดาร์ช่วงเวลานี้ไม่สำเร็จ (${t.err} ภาพ) — RainViewer อาจจำกัดจำนวนคำขอ ลองใหม่ในอีกสักครู่`);
    }
    const a = lastS.radar;
    if (f.kind !== 'model') {
      if (a && a.ok) {
        if (a.atPointDbz != null && a.atPointDbz >= U.RAIN_DBZ) parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: มีฝนตกที่จุดนี้ (${U.dbzClass(a.atPointDbz).label})`);
        else if (a.nearest) parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: ฝนใกล้สุดห่าง ~${Math.round(a.nearest.distKm)} กม. ทาง${U.compassTh(a.nearest.bearingDeg)}`);
        else parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: ไม่พบฝนในรัศมี ~${Math.round(a.windowKm / 2)} กม. รอบจุดนี้ — ถ้าบนแผนที่ไม่มีสี แปลว่าตอนนี้ไม่มีฝนจริง`);
      } else if (a && a.reason) {
        parts.push(`ℹ️ ประเมินฝนรอบจุดจากภาพเรดาร์ไม่ได้ (${a.message || a.reason}) แต่ภาพบนแผนที่ยังดูได้`);
      }
    }
    const v = a && a.ok && a.velocity;
    if (f.kind === 'extrap' && v && v.ok) {
      parts.push(`🔮 เลื่อนภาพเรดาร์ล่าสุดตามทิศที่ฝนเคลื่อน${v.stationary ? ' (แทบไม่เคลื่อนที่)' : ` (ไปทาง${U.compassTh(v.headingDeg)} ~${Math.round(v.speedKmh)} กม./ชม.)`} — ไม่คิดการเกิด/สลายตัวของฝน ยิ่งไกลยิ่งคลาดเคลื่อน`);
    }
    if (f.kind === 'model') {
      const g = lastS.res.model_grid;
      const grid = g && g.ok ? g.data : null;
      if (grid) {
        const here = cellAt(grid, lastS.loc.lat, lastS.loc.lon);
        const v = here ? grid.values[f.t][here.p] : null;
        const mx = grid.values[f.t].reduce((m, x) => (x != null && x > m ? x : m), 0);
        parts.push(`🧮 ที่จุดของคุณ (ช่องกริดตรงกลาง): ${v == null ? 'ไม่มีข้อมูล' : `${v < 0.05 ? '0' : v.toFixed(1)} มม./ชม. — ${rateLabel(v)}`} · มากสุดในกรอบ ${mx < 0.05 ? '0' : mx.toFixed(1)} มม./ชม.`);
      }
      parts.push('ช่วงนี้ไม่มีภาพเรดาร์ (RainViewer ฟรีเก็บย้อนหลัง ~2 ชม. และไม่มีภาพล่วงหน้า) จึงแสดงฝนรายชั่วโมงจากแบบจำลอง — แต่ละช่องสี่เหลี่ยม ≈ 30 กม. ขอบเข้ม = ช่องที่มีฝน แตะช่องเพื่อดูค่า · นอกกรอบเส้นประไม่มีข้อมูล · ไม่ใช่การวัดจริง ฝนก้อนเล็กเฉพาะจุดอาจไม่ปรากฏ');
    }
    if (idx === nowIdx && f.kind === 'radar' && !frames.some(x => x.kind === 'extrap') && a) {
      parts.push(a.ok
        ? 'ℹ️ ไม่มีภาพคาดการณ์จากเรดาร์ 1 ชม. ข้างหน้า — ต้องมีฝนในรัศมี ~57 กม. ให้หาทิศทางการเคลื่อนที่ได้ (ช่วงถัดไปใช้แบบจำลอง)'
        : 'ℹ️ ไม่มีภาพคาดการณ์จากเรดาร์ — อ่านค่าเรดาร์ไม่ได้ จึงคำนวณทิศทางไม่ได้ (ช่วงถัดไปใช้แบบจำลอง)');
    }
    out.textContent = parts.join('\n');
  }

  function tick() {
    if (!playing || document.hidden || frames.length < 2) return;
    // ค้างที่ "ตอนนี้" และภาพสุดท้ายไว้นานขึ้นก่อนเดินต่อ/วนใหม่
    if ((idx === nowIdx || idx === frames.length - 1) && hold < 3) { hold++; return; }
    hold = 0;
    showFrame(idx + 1);
  }

  // เต็มจอด้วย CSS (ไม่ใช้ Fullscreen API ซึ่งบน iOS ใช้กับ <div> ไม่ได้) ; เต็มจอแล้วลาก/ซูมแผนที่ได้เต็มที่
  function setExpanded(on, fromPop) {
    if (!map || on === expanded) return;
    expanded = on;
    const sec = $('sec-radar');
    sec.classList.toggle('radar-full', on);
    document.body.classList.toggle('no-scroll', on);
    const b = $('radar-expand');
    b.textContent = on ? '✕ ปิด' : '⤢ ขยาย';
    b.setAttribute('aria-label', on ? 'ปิดแผนที่เต็มจอ' : 'ขยายแผนที่เต็มจอ');
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      map.dragging.enable();
      map.scrollWheelZoom.enable();
      try { history.pushState({ radarFull: 1 }, ''); } catch (e) { /* file:// */ }
    } else {
      if (L.Browser.mobile) map.dragging.disable();
      map.scrollWheelZoom.disable();
      if (!fromPop && history.state && history.state.radarFull) { try { history.back(); } catch (e) { /* ไม่เป็นไร */ } }
    }
    setTimeout(() => { map.invalidateSize(); if (on) sec.scrollTop = 0; }, 60);
  }

  function syncControls() {
    const b = $('radar-play');
    b.textContent = playing ? '⏸' : '▶';
    b.setAttribute('aria-label', playing ? 'หยุดภาพเคลื่อนไหว' : 'เล่นภาพเคลื่อนไหว');
  }

  // ลูกศรทิศทางที่เมฆฝนเคลื่อน: จากตำแหน่ง 30 นาทีก่อนหน้า (ต้นทาง) มายังจุดนี้
  function drawArrow(S) {
    if (arrow) { arrow.remove(); arrow = null; }
    const v = S.radar && S.radar.ok && S.radar.velocity;
    if (!v || !v.ok || v.stationary) return;
    const km = S.radar.kmPerPx * 30;
    const dLat = (v.vy * km) / 111.32;
    const dLon = (-v.vx * km) / (111.32 * Math.cos((S.loc.lat * Math.PI) / 180));
    const from = [S.loc.lat + dLat, S.loc.lon + dLon];
    arrow = L.layerGroup([
      L.polyline([from, [S.loc.lat, S.loc.lon]], { color: '#ec835a', weight: 4, opacity: 0.9 }),
      L.circleMarker(from, { radius: 4, color: '#ec835a', fillColor: '#ec835a', fillOpacity: 1 })
        .bindTooltip(textEl(`เมฆฝนเคลื่อนไปทาง${U.compassTh(v.headingDeg)} ~${Math.round(v.speedKmh)} กม./ชม.`)),
    ]).addTo(map);
  }

  function render(S) {
    lastS = S;
    const status = $('radar-map-status');
    if (!status) return;
    if (!window.L) {
      status.textContent = libFailed ? '⚠️ โหลดไลบรารีแผนที่ไม่สำเร็จ — ตรวจการเชื่อมต่อแล้วกดรีเฟรช' : 'กำลังโหลดแผนที่...';
      return;
    }
    ensureMap(S.loc);
    const r = S.res.radar, g = S.res.model_grid;
    const hasRadar = r && r.ok && r.data && r.data.meta && r.data.meta.past.length;
    const hasGrid = g && g.ok;
    const radarErr = `⚠️ โหลดภาพเรดาร์ไม่สำเร็จ${r && r.error ? `: ${r.error}` : ''}`;
    if (!hasRadar && !hasGrid) {
      status.textContent = !r && !g ? 'กำลังโหลดภาพเรดาร์...' : radarErr;
      return;
    }
    status.textContent = hasRadar ? '' : `${radarErr} — แสดงแบบจำลองแทน`;
    setFrames(S);
    drawArrow(S);
    syncControls();
    setTimeout(() => map && map.invalidateSize(), 0);
  }

  function libLoaded() { if (lastS) render(lastS); }
  function libError() { libFailed = true; if (lastS) render(lastS); }

  WX.radarMap = { render, libLoaded, libError, buildTimeline, pickRadarPast, rateColor, cellAt, rateLabel };
})(typeof window !== 'undefined' ? window : globalThis);
