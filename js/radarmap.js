(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const $ = id => document.getElementById(id);

  const MAX_PAST = 7;      // ย้อนหลัง 1 ชม. (ภาพทุก 10 นาที) — RainViewer จำกัด ~100 คำขอ/นาที/IP
  const FUTURE_STEPS = 6;  // ล่วงหน้า 1 ชม. — RainViewer ฟรีเลิกให้ภาพคาดการณ์แล้ว จึงเลื่อนภาพล่าสุดตามทิศทางที่คำนวณเอง
  const STEP_MS = 700;

  let map = null, marker = null, rings = [], arrow = null;
  let layers = [], frames = [], idx = 0, sig = '', locKey = '';
  let pastFrames = [], futureLayer = null, futureSig = '', futurePane = null;
  let timer = null, playing = true, hold = 0, lastS = null, libFailed = false;
  let tileOk = [], tileErr = [];

  const textEl = s => { const e = document.createElement('span'); e.textContent = s; return e; };

  function ensureMap(loc) {
    if (!window.L) return false;
    if (!map) {
      map = L.map($('radar-map'), {
        zoomControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false,
      }).setView([loc.lat, loc.lon], 7);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 12, attribution: '© OpenStreetMap · เรดาร์ © RainViewer',
      }).addTo(map);
      futurePane = map.createPane('radarFuture');
      futurePane.style.zIndex = 250;
      futurePane.style.pointerEvents = 'none';
      map.on('zoomend', () => showFrame(idx));
      $('radar-play').onclick = () => { playing = !playing; syncControls(); };
      $('radar-slider').oninput = e => { playing = false; showFrame(Number(e.target.value)); syncControls(); };
      timer = setInterval(tick, STEP_MS);
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

  function setPast(meta) {
    const list = meta.past.slice(-MAX_PAST).map(f => ({ ...f, kind: 'past' }));
    const s2 = list.map(f => f.path).join('|');
    if (s2 === sig) return false;
    sig = s2;
    layers.forEach(l => l.remove());
    pastFrames = list;
    // color 2 (Universal Blue) เป็นโทนเดียวที่เหลือ ; zoom ของภาพเรดาร์สูงสุด 7 ที่เกินจากนั้นขยายภาพเอา
    tileOk = list.map(() => 0);
    tileErr = list.map(() => 0);
    layers = list.map((f, k) => L.tileLayer(`${meta.host}${f.path}/256/{z}/{x}/{y}/2/1_0.png`, {
      opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 5,
    }).on('tileload', () => { tileOk[k]++; if (k === Math.min(idx, layers.length - 1)) updateInfo(); })
      .on('tileerror', () => { tileErr[k]++; if (k === Math.min(idx, layers.length - 1)) updateInfo(); })
      .addTo(map));
    return true;
  }

  // ภาพล่วงหน้า = ภาพล่าสุดชุดเดียวกัน (โหลดซ้ำจากแคช ไม่เพิ่มคำขอ) วางใน pane แยกแล้วเลื่อนตามความเร็วเมฆฝน
  function setFuture(meta, vel) {
    const last = pastFrames[pastFrames.length - 1];
    const s2 = vel && vel.ok && last ? last.path : '';
    if (s2 === futureSig) return false;
    futureSig = s2;
    if (futureLayer) { futureLayer.remove(); futureLayer = null; }
    if (s2) {
      futureLayer = L.tileLayer(`${meta.host}${last.path}/256/{z}/{x}/{y}/2/1_0.png`, {
        opacity: 0, maxNativeZoom: 7, maxZoom: 12, pane: 'radarFuture',
      }).addTo(map);
    }
    return true;
  }

  function setFrames(meta, vel) {
    const changed = setPast(meta) | setFuture(meta, vel);
    if (!changed) return;
    const last = pastFrames[pastFrames.length - 1];
    const future = futureLayer
      ? Array.from({ length: FUTURE_STEPS }, (_, k) => ({ time: last.time + (k + 1) * 600, kind: 'forecast', offsetMin: (k + 1) * 10 }))
      : [];
    frames = [...pastFrames, ...future];
    const slider = $('radar-slider');
    slider.max = String(Math.max(0, frames.length - 1));
    const nowPos = frames.length > 1 ? ((pastFrames.length - 1) / (frames.length - 1)) * 100 : 100;
    const scale = $('radar-scale');
    if (scale) {
      scale.innerHTML = `<span>−1 ชม.</span><span class="now" style="left:${nowPos}%">ตอนนี้</span>${future.length ? '<span>+1 ชม.</span>' : ''}`;
    }
    idx = Math.max(0, pastFrames.length - 1);
    showFrame(idx);
  }

  function showFrame(i) {
    if (!frames.length) return;
    idx = (i + frames.length) % frames.length;
    const f = frames[idx];
    const forecast = f.kind === 'forecast';
    layers.forEach((l, k) => l.setOpacity(!forecast && k === idx ? 0.75 : 0));
    if (futureLayer) futureLayer.setOpacity(forecast ? 0.6 : 0);
    if (futurePane) {
      const v = lastS && lastS.radar && lastS.radar.velocity;
      if (forecast && v && v.ok) {
        // ความเร็วคิดเป็นพิกเซลที่ zoom 7 ต่อนาที → แปลงเป็นพิกเซลบนจอที่ zoom ปัจจุบัน
        const k = Math.pow(2, map.getZoom() - 7) * f.offsetMin;
        futurePane.style.transform = `translate(${(v.vx * k).toFixed(1)}px, ${(v.vy * k).toFixed(1)}px)`;
      } else {
        futurePane.style.transform = '';
      }
    }
    const ms = f.time * 1000;
    let rel;
    if (forecast) {
      const ahead = Math.round((ms - Date.now()) / 60000);
      rel = ahead > 0 ? `คาดการณ์ +${ahead} นาที` : 'คาดการณ์ (ตอนนี้)';
    } else {
      rel = U.fmtAgo(ms);
    }
    const t = $('radar-time');
    t.textContent = `${forecast ? '🔮 ' : ''}${U.bkkHM(ms)} น. · ${rel}`;
    t.classList.toggle('is-forecast', forecast);
    $('radar-slider').value = String(idx);
    updateInfo();
  }

  // บอกให้ชัดว่า "ไม่เห็นฝน" เพราะไม่มีฝนจริง หรือเพราะโหลดภาพไม่สำเร็จ
  function updateInfo() {
    const out = $('radar-info');
    if (!out || !lastS) return;
    const f = frames[idx];
    const li = f && f.kind === 'forecast' ? pastFrames.length - 1 : idx;
    const ok = tileOk[li] || 0, err = tileErr[li] || 0;
    const parts = [];
    if (err && !ok) parts.push(`⚠️ โหลดภาพเรดาร์ช่วงเวลานี้ไม่สำเร็จ (${err} ภาพ) — RainViewer อาจจำกัดจำนวนคำขอ ลองใหม่ในอีกสักครู่`);
    const a = lastS.radar;
    if (a && a.ok) {
      if (a.atPointDbz != null && a.atPointDbz >= U.RAIN_DBZ) parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: มีฝนตกที่จุดนี้ (${U.dbzClass(a.atPointDbz).label})`);
      else if (a.nearest) parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: ฝนใกล้สุดห่าง ~${Math.round(a.nearest.distKm)} กม. ทาง${U.compassTh(a.nearest.bearingDeg)}`);
      else parts.push(`📡 ภาพล่าสุด ${U.bkkHM(a.frameTimeMs)} น.: ไม่พบฝนในรัศมี ~${Math.round(a.windowKm / 2)} กม. รอบจุดนี้ — ถ้าบนแผนที่ไม่มีสี แปลว่าตอนนี้ไม่มีฝนจริง`);
    } else if (a && a.reason) {
      parts.push(`ℹ️ ประเมินฝนรอบจุดจากภาพเรดาร์ไม่ได้ (${a.message || a.reason}) แต่ภาพบนแผนที่ยังดูได้`);
    }
    const v = a && a.ok && a.velocity;
    if (f && f.kind === 'forecast' && v && v.ok) {
      parts.push(`🔮 ภาพคาดการณ์: เลื่อนภาพล่าสุดตามทิศที่ฝนเคลื่อน${v.stationary ? ' (แทบไม่เคลื่อนที่)' : ` (ไปทาง${U.compassTh(v.headingDeg)} ~${Math.round(v.speedKmh)} กม./ชม.)`} — ไม่คิดการเกิด/สลายตัวของฝน ยิ่งไกลยิ่งคลาดเคลื่อน`);
    } else if (!futureLayer && a) {
      parts.push(a.ok
        ? 'ℹ️ ยังไม่มีภาพคาดการณ์ 1 ชม. ข้างหน้า — ต้องมีฝนในรัศมี ~57 กม. ให้ระบบหาทิศทางการเคลื่อนที่ได้'
        : 'ℹ️ ไม่มีภาพคาดการณ์ 1 ชม. ข้างหน้า — ต้องอ่านค่าเรดาร์ได้ก่อนจึงจะคำนวณทิศทางได้');
    }
    out.textContent = parts.join('\n');
  }

  function tick() {
    if (!playing || document.hidden || frames.length < 2) return;
    const lastPast = pastFrames.length - 1;
    // ค้างภาพล่าสุด (ตอนนี้) และภาพสุดท้ายไว้นานขึ้น ก่อนเดินต่อ/วนใหม่
    if ((idx === lastPast || idx === frames.length - 1) && hold < 3) { hold++; return; }
    hold = 0;
    showFrame(idx + 1);
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
    const r = S.res.radar;
    const meta = r && r.ok && r.data && r.data.meta;
    if (!meta || !meta.past.length) {
      status.textContent = !r ? 'กำลังโหลดภาพเรดาร์...' : r.ok ? 'ไม่มีภาพเรดาร์' : `⚠️ โหลดภาพเรดาร์ไม่สำเร็จ: ${r.error}`;
      return;
    }
    status.textContent = '';
    setFrames(meta, S.radar && S.radar.ok ? S.radar.velocity : null);
    drawArrow(S);
    syncControls();
    setTimeout(() => map && map.invalidateSize(), 0);
  }

  function libLoaded() { if (lastS) render(lastS); }
  function libError() { libFailed = true; if (lastS) render(lastS); }

  WX.radarMap = { render, libLoaded, libError };
})(typeof window !== 'undefined' ? window : globalThis);
