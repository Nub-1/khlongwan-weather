(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;
  const $ = id => document.getElementById(id);

  const MAX_PAST = 8;     // ~70 นาทีล่าสุด — พอเห็นทิศทาง โดยไม่โหลดภาพมากเกินบนมือถือ
  const STEP_MS = 700;

  let map = null, marker = null, rings = [], arrow = null;
  let layers = [], frames = [], idx = 0, sig = '', locKey = '';
  let timer = null, playing = true, hold = 0, lastS = null, libFailed = false;

  const textEl = s => { const e = document.createElement('span'); e.textContent = s; return e; };

  function ensureMap(loc) {
    if (!window.L) return false;
    if (!map) {
      map = L.map($('radar-map'), {
        zoomControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false,
      }).setView([loc.lat, loc.lon], 8);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 12, attribution: '© OpenStreetMap · เรดาร์ © RainViewer',
      }).addTo(map);
      $('radar-play').onclick = () => { playing = !playing; syncControls(); };
      $('radar-slider').oninput = e => { playing = false; showFrame(Number(e.target.value)); syncControls(); };
      timer = setInterval(tick, STEP_MS);
    }
    const key = `${loc.lat},${loc.lon}`;
    if (key !== locKey) {
      locKey = key;
      map.setView([loc.lat, loc.lon], 8);
      rings.forEach(r => r.remove());
      if (marker) marker.remove();
      rings = [10, 25].map(km => L.circle([loc.lat, loc.lon], { radius: km * 1000, color: '#52514e', weight: 1, opacity: 0.6, fill: false, interactive: false }).addTo(map));
      marker = L.circleMarker([loc.lat, loc.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#d03b3b', fillOpacity: 1 })
        .addTo(map).bindTooltip(textEl(loc.name));
    }
    return true;
  }

  function setFrames(meta) {
    const list = [
      ...meta.past.slice(-MAX_PAST).map(f => ({ ...f, kind: 'past' })),
      ...meta.nowcast.map(f => ({ ...f, kind: 'nowcast' })),
    ];
    const s = list.map(f => f.path).join('|');
    if (s === sig) return;
    sig = s;
    layers.forEach(l => l.remove());
    frames = list;
    // color 2 = โทนสีมาตรฐานสำหรับดูด้วยตา, 1_1 = เกลี่ยขอบ + แสดงหิมะ (ไม่มีผลในไทย)
    layers = list.map(f => L.tileLayer(`${meta.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0, maxNativeZoom: 7, maxZoom: 12, zIndex: 5,
    }).addTo(map));
    const slider = $('radar-slider');
    slider.max = String(Math.max(0, list.length - 1));
    idx = Math.max(0, list.filter(f => f.kind === 'past').length - 1);
    showFrame(idx);
  }

  function showFrame(i) {
    if (!frames.length) return;
    idx = (i + frames.length) % frames.length;
    layers.forEach((l, k) => l.setOpacity(k === idx ? 0.75 : 0));
    const f = frames[idx];
    const ms = f.time * 1000;
    const rel = f.kind === 'nowcast'
      ? `คาดการณ์ +${Math.max(0, Math.round((ms - Date.now()) / 60000))} นาที`
      : U.fmtAgo(ms);
    $('radar-time').textContent = `${U.bkkHM(ms)} น. · ${rel}`;
    $('radar-slider').value = String(idx);
  }

  function tick() {
    if (!playing || document.hidden || frames.length < 2) return;
    const lastPast = frames.filter(f => f.kind === 'past').length - 1;
    // ค้างภาพล่าสุดไว้นานขึ้น ให้เห็นสถานการณ์ปัจจุบันชัด ๆ ก่อนวนใหม่
    if (idx === lastPast && hold < 3) { hold++; return; }
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
    setFrames(meta);
    drawArrow(S);
    syncControls();
    setTimeout(() => map && map.invalidateSize(), 0);
  }

  function libLoaded() { if (lastS) render(lastS); }
  function libError() { libFailed = true; if (lastS) render(lastS); }

  WX.radarMap = { render, libLoaded, libError };
})(typeof window !== 'undefined' ? window : globalThis);
