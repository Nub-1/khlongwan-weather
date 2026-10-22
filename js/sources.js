(function (root) {
  'use strict';
  const WX = (root.WX = root.WX || {});
  const U = WX.util;

  const LONGDO_KEY = 'fc3a538036000942bff242cb17c1ec99';
  const CELL = 'land'; // แปลงอยู่ติดทะเล — กันโมเดลหยิบ grid cell ที่เป็นทะเลมาให้
  const OM = {
    forecast: 'https://api.open-meteo.com/v1/forecast',
    ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
    archive: 'https://archive-api.open-meteo.com/v1/archive',
    prev: 'https://previous-runs-api.open-meteo.com/v1/forecast',
    geo: 'https://geocoding-api.open-meteo.com/v1/search',
  };
  const TZ_Q = 'timezone=Asia%2FBangkok';

  async function fetchJSON(url, timeoutMs = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) {
        // Open-Meteo ตอบ 400 พร้อม {"error":true,"reason":"..."} — เอาเหตุผลจริงมาแสดง จะได้รู้ว่าพารามิเตอร์ตัวไหนใช้ไม่ได้
        let reason = '';
        try { const j = await r.json(); if (j && j.reason) reason = `: ${String(j.reason).slice(0, 140)}`; } catch (_) { /* ไม่ใช่ JSON */ }
        const e = new Error((r.status === 429 ? 'ถูกจำกัดจำนวนคำขอ (HTTP 429)' : `HTTP ${r.status}`) + reason);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('หมดเวลารอการตอบกลับ');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Open-Meteo ตอบ 400 ถ้าพารามิเตอร์ขั้นสูงตัวใดไม่รองรับ จึงไล่ลองจากชุดที่ดีที่สุดไปชุดพื้นฐาน
  async function firstOk(label, urls) {
    let last = null;
    for (const url of urls) {
      try {
        return await fetchJSON(url);
      } catch (e) {
        last = e;
        if (e.status === 429) break;
      }
    }
    throw new Error(`${label}: ${last ? last.message : 'ขอข้อมูลไม่สำเร็จ'}`);
  }

  const cacheKey = (id, loc) => `wx:${id}:${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
  function cacheGet(id, loc, ttl) {
    return U.safeLS(() => {
      const raw = sessionStorage.getItem(cacheKey(id, loc));
      if (!raw) return null;
      const o = JSON.parse(raw);
      return Date.now() - o.t <= ttl ? o : null;
    });
  }
  function cacheSet(id, loc, data) {
    U.safeLS(() => sessionStorage.setItem(cacheKey(id, loc), JSON.stringify({ t: Date.now(), data })));
  }

  // ============ Individual sources ============
  async function longdoRain(loc) {
    const j = await fetchJSON(`https://weather.longdo.com/rain/api/v1/location?key=${LONGDO_KEY}&lat=${loc.lat}&lon=${loc.lon}`, 10000);
    const r = j && j.rain;
    if (!r || !Number.isFinite(Number(r.intensity))) throw new Error('รูปแบบข้อมูลไม่ตรงที่คาด');
    return { intensity: Number(r.intensity), desc: r.description || '' };
  }

  // รายการเฟรมเก็บไว้เสมอสำหรับแผนที่ (แสดงภาพได้แม้เบราว์เซอร์ไม่ยอมให้อ่านค่าพิกเซล)
  async function radar(loc) {
    const meta = await fetchJSON(WX.radar.HOST_META, 10000);
    const pick = arr => (arr || []).filter(f => f && f.path && f.time).map(f => ({ time: f.time, path: f.path }));
    const frameMeta = { host: meta.host || 'https://tilecache.rainviewer.com', past: pick(meta.radar && meta.radar.past), nowcast: pick(meta.radar && meta.radar.nowcast) };
    let loaded = null, decodeError = null;
    try { loaded = await WX.radar.loadFrames(meta, loc.lat, loc.lon); } catch (e) { decodeError = (e && e.message) || String(e); }
    return { meta: frameMeta, ...(loaded || {}), decodeError, generated: meta.generated ? meta.generated * 1000 : null };
  }

  function forecast(loc) {
    const base = `${OM.forecast}?latitude=${loc.lat}&longitude=${loc.lon}&${TZ_Q}&forecast_days=14&past_days=7`;
    const full = `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover`
      + `&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,cape,wind_speed_10m,wind_gusts_10m,cloud_cover`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`;
    const min = `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m`
      + `&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m`
      + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max`;
    return firstOk('Open-Meteo forecast', [
      `${base}${full}&cell_selection=${CELL}`, `${base}${full}`, `${base}${min}&cell_selection=${CELL}`, `${base}${min}`,
    ]);
  }

  // ensemble แต่ละระบบขอแยกกัน — ระบบใดล่มก็ไม่ทำให้ระบบอื่นเสียไปด้วย
  const ENSEMBLES = [
    { id: 'ens_ecmwf', label: 'ECMWF ENS (51 ชุด)', short: 'ECMWF', models: ['ecmwf_ifs025'] },
    { id: 'ens_gefs', label: 'NOAA GEFS (31 ชุด)', short: 'GEFS', models: ['gfs_seamless', 'gfs025'] },
    { id: 'ens_icon', label: 'DWD ICON-EPS (40 ชุด)', short: 'ICON', models: ['icon_seamless'] },
  ];

  function ensemble(loc, def) {
    const base = `${OM.ensemble}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=precipitation&${TZ_Q}&forecast_days=14`;
    const urls = [];
    for (const m of def.models) urls.push(`${base}&cell_selection=${CELL}&models=${m}`, `${base}&models=${m}`);
    return firstOk(def.short + ' ensemble', urls);
  }

  function archive(loc) {
    const today = U.bkkDateStr();
    const base = `${OM.archive}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${U.addDays(today, -14)}&end_date=${U.addDays(today, -1)}&daily=precipitation_sum&${TZ_Q}`;
    return firstOk('Open-Meteo archive', [`${base}&models=era5_land&cell_selection=${CELL}`, `${base}&models=era5_land`, base]);
  }

  const BACKTEST_MODELS = [
    { id: 'ecmwf_ifs025', label: 'ECMWF IFS' },
    { id: 'gfs_seamless', label: 'NOAA GFS' },
    { id: 'icon_seamless', label: 'DWD ICON' },
    { id: 'jma_seamless', label: 'JMA' },
  ];

  // ชื่อตัวแปรอาจมี suffix ชื่อโมเดลต่อท้ายหรือไม่ก็ได้ — รับทั้งสองแบบ
  function parsePrevRuns(json, modelId) {
    const h = json && json.hourly;
    if (!h || !h.time) return null;
    const key = h[`precipitation_previous_day1_${modelId}`] ? `precipitation_previous_day1_${modelId}`
      : Object.keys(h).find(k => k.startsWith('precipitation_previous_day1'));
    return key ? { times: h.time, values: h[key] } : null;
  }

  // แผนสำรอง: ค่าฝนรายวันของแต่ละโมเดลจาก forecast API (ช่วงใกล้เวลาจริง ไม่ใช่พยากรณ์ล่วงหน้า 1 วัน)
  function parseDailyModels(json) {
    const d = json && json.daily;
    if (!d || !d.time) return {};
    const out = {};
    for (const m of BACKTEST_MODELS) {
      const arr = d[`precipitation_sum_${m.id}`];
      if (arr) out[m.id] = { times: d.time, values: arr };
    }
    return out;
  }

  // ขอทีละโมเดล: โมเดลไหนไม่รองรับก็ล้มเฉพาะตัวนั้น ไม่ลากตัวอื่นไปด้วย
  async function backtest(loc) {
    const today = U.bkkDateStr();
    const start = U.addDays(today, -35), end = U.addDays(today, -6);
    const archBase = `${OM.archive}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${start}&end_date=${end}&daily=precipitation_sum&${TZ_Q}`;
    const arch = await firstOk('ERA5-Land', [`${archBase}&models=era5_land&cell_selection=${CELL}`, `${archBase}&models=era5_land`, archBase]);
    const obs = { times: (arch.daily && arch.daily.time) || [], values: (arch.daily && arch.daily.precipitation_sum) || [] };

    const models = {};
    await Promise.all(BACKTEST_MODELS.map(async m => {
      const base = `${OM.prev}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=precipitation_previous_day1&past_days=36&forecast_days=1&${TZ_Q}&models=${m.id}`;
      try {
        const j = await firstOk(m.label, [`${base}&cell_selection=${CELL}`, base]);
        const pm = parsePrevRuns(j, m.id);
        if (!pm) throw new Error('ไม่พบตัวแปรพยากรณ์ล่วงหน้า 1 วันในคำตอบ');
        const daily = WX.engine.dailyFromHourly(pm.times, pm.values);
        if (!daily.size) throw new Error('ไม่มีข้อมูลรายวันที่ครบ');
        models[m.id] = { mode: 'day1', times: [...daily.keys()], values: [...daily.values()] };
      } catch (e) {
        models[m.id] = { error: (e && e.message) || String(e) };
      }
    }));

    // ทุกโมเดลดึงแบบล่วงหน้า 1 วันไม่ได้ → ใช้ค่าใกล้เวลาจริงแทน และบอกผู้ใช้ชัดเจน
    if (!Object.values(models).some(m => !m.error)) {
      const ids = BACKTEST_MODELS.map(m => m.id);
      const fBase = `${OM.forecast}?latitude=${loc.lat}&longitude=${loc.lon}&daily=precipitation_sum&${TZ_Q}&past_days=36&forecast_days=1`;
      try {
        const j = await firstOk('forecast', [`${fBase}&cell_selection=${CELL}&models=${ids.join(',')}`, `${fBase}&models=${ids.join(',')}`, `${fBase}&models=ecmwf_ifs025,gfs_seamless`]);
        const got = parseDailyModels(j);
        for (const id of Object.keys(got)) models[id] = { mode: 'near', times: got[id].times, values: got[id].values };
      } catch (e) {
        models._fallbackError = (e && e.message) || String(e);
      }
    }
    return { start, end, obs, models };
  }

  // กริดจุดรอบพื้นที่สำหรับวาดแผนที่ฝนจากแบบจำลอง (ช่วงที่ไม่มีภาพเรดาร์) — แถว 0 = เหนือสุด
  const GRID_N = 7, GRID_STEP = 0.3;
  function gridPoints(lat, lon, n = GRID_N, step = GRID_STEP) {
    const h = (n - 1) / 2, lats = [], lons = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        lats.push(+(lat + (h - i) * step).toFixed(4));
        lons.push(+(lon + (j - h) * step).toFixed(4));
      }
    }
    return { lat, lon, n, step, lats, lons };
  }

  function parseGrid(json, g) {
    const arr = Array.isArray(json) ? json : [json];
    if (arr.length !== g.lats.length) throw new Error(`จุดกริดไม่ครบ (${arr.length}/${g.lats.length})`);
    const times = arr[0] && arr[0].hourly && arr[0].hourly.time;
    if (!times || !times.length) throw new Error('ไม่มีข้อมูลรายชั่วโมง');
    const values = times.map((_, t) => arr.map(p => {
      const v = p && p.hourly && p.hourly.precipitation ? p.hourly.precipitation[t] : null;
      return v == null ? null : v;
    }));
    return { lat: g.lat, lon: g.lon, n: g.n, step: g.step, times, values };
  }

  // cell_selection=nearest: บนแผนที่ต้องการค่าของจุดนั้นจริง ๆ ไม่ใช่ดึงจุดในทะเลไปหาแผ่นดิน
  async function modelGrid(loc) {
    const g = gridPoints(loc.lat, loc.lon);
    const base = `${OM.forecast}?latitude=${g.lats.join(',')}&longitude=${g.lons.join(',')}&hourly=precipitation&${TZ_Q}&cell_selection=nearest`;
    const j = await firstOk('Open-Meteo grid', [`${base}&past_hours=7&forecast_hours=8`, `${base}&past_days=1&forecast_days=2`]);
    return parseGrid(j, g);
  }

  async function geocode(query) {
    const j = await fetchJSON(`${OM.geo}?name=${encodeURIComponent(query)}&count=8&language=th&format=json`, 10000);
    return Array.isArray(j.results) ? j.results : [];
  }

  // ============ Registry ============
  const MIN = 60000;
  const LIST = [
    { id: 'longdo_rain', label: 'Longdo เรดาร์ฝน', group: 'now', every: 5 * MIN, run: longdoRain },
    { id: 'radar', label: 'RainViewer เรดาร์', group: 'now', every: 5 * MIN, run: radar },
    { id: 'forecast', label: 'Open-Meteo พยากรณ์', group: 'fc', every: 30 * MIN, cache: 15 * MIN, run: forecast },
    ...ENSEMBLES.map(e => ({ id: e.id, label: e.label, group: 'fc', every: 60 * MIN, cache: 40 * MIN, run: loc => ensemble(loc, e), ens: e })),
    { id: 'model_grid', label: 'Open-Meteo แผนที่ฝนแบบจำลอง', group: 'map', every: 60 * MIN, cache: 50 * MIN, run: modelGrid },
    { id: 'archive', label: 'ERA5-Land ย้อนหลัง', group: 'hist', every: 3 * 60 * MIN, cache: 2 * 60 * MIN, run: archive },
    { id: 'backtest', label: 'ผลย้อนทดสอบโมเดล', group: 'hist', every: 12 * 60 * MIN, cache: 6 * 60 * MIN, run: backtest },
  ];

  async function run(def, loc, force = false) {
    if (def.cache && !force) {
      const c = cacheGet(def.id, loc, def.cache);
      if (c) return { id: def.id, label: def.label, ok: true, data: c.data, fetchedAt: c.t, cached: true };
    }
    const t0 = Date.now();
    try {
      const data = await def.run(loc);
      if (def.cache) cacheSet(def.id, loc, data);
      return { id: def.id, label: def.label, ok: true, data, fetchedAt: Date.now(), ms: Date.now() - t0 };
    } catch (e) {
      return { id: def.id, label: def.label, ok: false, error: (e && e.message) || String(e), fetchedAt: Date.now() };
    }
  }

  WX.sources = { LIST, ENSEMBLES, BACKTEST_MODELS, run, geocode, parsePrevRuns, parseDailyModels, fetchJSON, gridPoints, parseGrid };
})(typeof window !== 'undefined' ? window : globalThis);
