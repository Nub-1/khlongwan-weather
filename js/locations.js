(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;

  // พื้นที่ที่ติดมากับโปรแกรม — มีทุกเครื่อง ไม่พึ่ง localStorage และลบไม่ได้
  const PRESETS = [
    { id: 'khlongwan', name: 'แปลงมะพร้าวคลองวาฬ', detail: 'อ.สามร้อยยอด จ.ประจวบคีรีขันธ์', lat: 11.7563340, lon: 99.7684976, coconut: true, builtin: true },
    { id: 'raikao', name: 'ต.ไร่เก่า', detail: 'อ.สามร้อยยอด จ.ประจวบคีรีขันธ์', lat: 12.2211831, lon: 99.8770225, coconut: true, builtin: true },
  ];
  const DEFAULT = PRESETS[0];
  // key เดิมของเวอร์ชันก่อน — คงไว้ให้พื้นที่ที่ผู้ใช้เพิ่มไว้ไม่หาย
  const LS_LOCATIONS = 'khlongwan-weather.locations.v1';
  const LS_ACTIVE = 'khlongwan-weather.active.v1';

  const coordKey = l => `${Number(l.lat).toFixed(4)},${Number(l.lon).toFixed(4)}`;

  function isValid(l) {
    return !!l && typeof l.name === 'string' && l.name.trim().length > 0
      && Number.isFinite(l.lat) && Math.abs(l.lat) <= 90
      && Number.isFinite(l.lon) && Math.abs(l.lon) <= 180;
  }

  function normalize(l) {
    return {
      id: String(l.id || `${l.lat},${l.lon}`),
      name: String(l.name).trim().slice(0, 60),
      detail: l.detail ? String(l.detail).slice(0, 120) : '',
      lat: Number(l.lat), lon: Number(l.lon),
      coconut: l.coconut !== false,
      builtin: l.builtin === true,
    };
  }

  function load() {
    const saved = U.safeLS(() => JSON.parse(localStorage.getItem(LS_LOCATIONS) || '[]'), []);
    const ids = new Set(PRESETS.map(l => l.id));
    const coords = new Set(PRESETS.map(coordKey));
    const custom = (Array.isArray(saved) ? saved : [])
      .filter(isValid).map(normalize)
      .filter(l => !ids.has(l.id) && !coords.has(coordKey(l)));
    return [...PRESETS, ...custom];
  }

  function persist(list) {
    U.safeLS(() => localStorage.setItem(LS_LOCATIONS, JSON.stringify(list.filter(l => !l.builtin))));
  }

  function fromUrl() {
    const p = new URLSearchParams(window.location.search);
    const lat = parseFloat(p.get('lat')), lon = parseFloat(p.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const loc = {
      id: `${lat.toFixed(4)},${lon.toFixed(4)}`,
      name: p.get('name') || `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
      lat, lon, coconut: p.get('coconut') !== '0',
    };
    return isValid(loc) ? normalize(loc) : null;
  }

  // ============ Coordinate parsing ============
  function dmsToDecimal(deg, min, sec, hemi) {
    let v = Math.abs(deg) + (min || 0) / 60 + (sec || 0) / 3600;
    if (/[SW]/i.test(hemi || '') || deg < 0) v = -v;
    return v;
  }

  function parseCoordPair(input) {
    const s = String(input || '').trim().replace(/\s+/g, ' ');
    if (!s) return null;
    let lat = null, lon = null;

    const dmsRe = /(-?\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′’])?\s*(?:(\d+(?:\.\d+)?)\s*["″”])?\s*([NSEW])?/gi;
    const dms = [...s.matchAll(dmsRe)].filter(m => m[0].includes('°'));
    if (dms.length === 2) {
      const vals = dms.map(m => ({
        value: dmsToDecimal(parseFloat(m[1]), parseFloat(m[2] || 0), parseFloat(m[3] || 0), m[4]),
        hemi: (m[4] || '').toUpperCase(),
      }));
      const latPart = vals.find(v => v.hemi === 'N' || v.hemi === 'S');
      const lonPart = vals.find(v => v.hemi === 'E' || v.hemi === 'W');
      if (latPart && lonPart) { lat = latPart.value; lon = lonPart.value; }
      else { lat = vals[0].value; lon = vals[1].value; }
    } else {
      const dec = /^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*(?:[,;:]|\s)\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/i.exec(s);
      if (!dec) return null;
      lat = parseFloat(dec[1]);
      lon = parseFloat(dec[3]);
      if (/S/i.test(dec[2] || '')) lat = -Math.abs(lat);
      if (/W/i.test(dec[4] || '')) lon = -Math.abs(lon);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // ละติจูดเกิน 90 เป็นไปไม่ได้ → ผู้ใช้วางสลับ lon,lat มา
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function formatCoord(lat, lon) {
    const f = v => String(Number(Math.abs(v).toFixed(7)));
    return `${f(lat)}°${lat >= 0 ? 'N' : 'S'}, ${f(lon)}°${lon >= 0 ? 'E' : 'W'}`;
  }

  // ============ State + UI ============
  let list = load();
  let active = null;
  let onChange = () => {};
  const $ = id => document.getElementById(id);

  function pickInitial() {
    const u = fromUrl();
    if (u) {
      const existing = list.find(l => l.id === u.id || coordKey(l) === coordKey(u));
      if (existing) return existing;
      list = [...list, { ...u, detail: u.detail || 'เพิ่มจากลิงก์ที่แชร์' }];
      persist(list);
      return list[list.length - 1];
    }
    const savedId = U.safeLS(() => localStorage.getItem(LS_ACTIVE));
    return list.find(l => l.id === savedId) || DEFAULT;
  }

  function renderSelect() {
    $('location-select').innerHTML = list.map(l =>
      `<option value="${U.esc(l.id)}"${l.id === active.id ? ' selected' : ''}>${U.esc(l.name)}${l.detail ? ' — ' + U.esc(l.detail) : ''}</option>`).join('');
    $('location-del').disabled = !!active.builtin;
  }

  function renderHeader() {
    $('place-icon').textContent = active.coconut ? '🌴' : '📍';
    $('place-name').textContent = active.name;
    $('place-sub').textContent = `${formatCoord(active.lat, active.lon)}${active.detail ? ' · ' + active.detail : ''}`;
    document.title = `${active.name} — พยากรณ์อากาศเจาะจงพื้นที่`;
    const c = $('coconut-card');
    if (c) c.hidden = !active.coconut;
  }

  function syncUrl() {
    const p = new URLSearchParams();
    p.set('lat', String(active.lat));
    p.set('lon', String(active.lon));
    p.set('name', active.name);
    if (!active.coconut) p.set('coconut', '0');
    if (new URLSearchParams(window.location.search).get('debug')) p.set('debug', '1');
    try { history.replaceState(null, '', `${window.location.pathname}?${p}`); } catch (e) { /* file:// */ }
  }

  function setActive(loc) {
    active = loc;
    U.safeLS(() => localStorage.setItem(LS_ACTIVE, loc.id));
    renderSelect();
    renderHeader();
    syncUrl();
    onChange(loc);
  }

  const err = msg => { $('loc-error').textContent = msg || ''; };

  function openForm() {
    $('location-form').hidden = false;
    $('loc-results').innerHTML = '';
    err('');
    for (const id of ['loc-search', 'loc-name', 'loc-coord']) $(id).value = '';
    $('loc-coord-preview').textContent = '';
    $('loc-coconut').checked = true;
    $('loc-search').focus();
  }

  function closeForm() { $('location-form').hidden = true; err(''); }

  function updatePreview() {
    const raw = $('loc-coord').value.trim();
    const el = $('loc-coord-preview');
    if (!raw) { el.textContent = ''; el.className = 'loc-preview'; return; }
    const p = parseCoordPair(raw);
    el.textContent = p ? `✓ อ่านได้: ${formatCoord(p.lat, p.lon)}` : '✗ อ่านพิกัดไม่ออก — ตรวจรูปแบบตามตัวอย่างด้านบน';
    el.className = 'loc-preview ' + (p ? 'ok' : 'bad');
  }

  function add(loc) {
    const n = normalize(loc);
    const existing = list.find(l => l.id === n.id || coordKey(l) === coordKey(n));
    if (existing) { closeForm(); setActive(existing); return; }
    list = [...list, n];
    persist(list);
    closeForm();
    setActive(n);
  }

  async function doSearch() {
    const q = $('loc-search').value.trim();
    if (!q) { err('พิมพ์ชื่อสถานที่ก่อน'); return; }
    const btn = $('loc-search-btn');
    btn.disabled = true; btn.textContent = 'กำลังค้นหา...';
    err(''); $('loc-results').innerHTML = '';
    try {
      const results = await WX.sources.geocode(q);
      if (!results.length) { err('ไม่พบสถานที่นี้ — ลองคำอื่น หรือกรอกพิกัดเองด้านล่าง'); return; }
      $('loc-results').innerHTML = results.map((r, i) => {
        const detail = [r.admin2, r.admin1, r.country].filter(Boolean).join(', ');
        return `<button type="button" class="loc-result" data-idx="${i}"><b>${U.esc(r.name)}</b><small>${U.esc(detail)} · ${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}</small></button>`;
      }).join('');
      $('loc-results').querySelectorAll('.loc-result').forEach(el => {
        el.onclick = () => {
          const r = results[Number(el.dataset.idx)];
          add({
            id: `${r.latitude.toFixed(4)},${r.longitude.toFixed(4)}`, name: r.name,
            detail: [r.admin2, r.admin1].filter(Boolean).join(', '),
            lat: r.latitude, lon: r.longitude, coconut: $('loc-coconut').checked,
          });
        };
      });
    } catch (e) {
      err(`ค้นหาไม่สำเร็จ: ${e.message} — กรอกพิกัดเองด้านล่างได้`);
    } finally {
      btn.disabled = false; btn.textContent = 'ค้นหา';
    }
  }

  function saveManual() {
    const raw = $('loc-coord').value.trim();
    if (!raw) { err('วางพิกัดก่อน เช่น 12.2211831, 99.8770225'); return; }
    const p = parseCoordPair(raw);
    if (!p) { err('อ่านพิกัดไม่ออก — ต้องเป็นละติจูด แล้วตามด้วยลองจิจูด เช่น 12.2211831, 99.8770225'); return; }
    add({
      id: `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`,
      name: $('loc-name').value.trim() || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
      lat: p.lat, lon: p.lon, coconut: $('loc-coconut').checked,
    });
  }

  function removeActive() {
    if (active.builtin) return;
    if (!window.confirm(`ลบพื้นที่ "${active.name}" ออกจากรายการ?`)) return;
    list = list.filter(l => l.id !== active.id);
    persist(list);
    setActive(list[0] || DEFAULT);
  }

  async function share() {
    syncUrl();
    const btn = $('location-share');
    const original = btn.textContent;
    try { await navigator.clipboard.writeText(window.location.href); btn.textContent = '✅ คัดลอกแล้ว'; }
    catch (e) { btn.textContent = '⚠️ คัดลอกไม่ได้ — ใช้ URL บนแถบที่อยู่'; }
    setTimeout(() => { btn.textContent = original; }, 2500);
  }

  function init(changeCb) {
    onChange = changeCb;
    active = pickInitial();
    renderSelect(); renderHeader(); syncUrl();
    $('location-select').onchange = e => { const l = list.find(x => x.id === e.target.value); if (l) setActive(l); };
    $('location-add').onclick = openForm;
    $('location-del').onclick = removeActive;
    $('location-share').onclick = share;
    $('loc-search-btn').onclick = doSearch;
    $('loc-save').onclick = saveManual;
    $('loc-cancel').onclick = closeForm;
    $('loc-search').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
    for (const id of ['loc-name', 'loc-coord']) $(id).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); saveManual(); } };
    $('loc-coord').oninput = updatePreview;
    $('loc-coord').onpaste = () => setTimeout(updatePreview, 0);
    return active;
  }

  WX.locations = { init, parseCoordPair, formatCoord, get active() { return active; } };
})(typeof window !== 'undefined' ? window : globalThis);
