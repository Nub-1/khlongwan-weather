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
        const e = new Error(r.status === 429 ? 'ถูกจำกัดจำนวนคำขอ (HTTP 429)' : `HTTP ${r.status}`);
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

  async function radar(loc) {
    const meta = await fetchJSON(WX.radar.HOST_META, 10000);
    const loaded = await WX.radar.loadFrames(meta, loc.lat, loc.lon);
    return { ...loaded, generated: meta.generated ? meta.generated * 1000 : null };
  }

  function forecast(loc) {
    const base = `${OM.forecast}?latitude=${loc.lat}&longitude=${loc.lon}&${TZ_Q}&forecast_days=14&past_days=7`;
    const full = `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover`
      + `&hourly=temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,cape,wind_speed_10m,wind_gusts_10m`
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

  // ชื่อตัวแปรเมื่อขอหลายโมเดล = precipitation_previous_day1_<model> ; โมเดลเดียวไม่มี suffix
  function parsePrevRuns(json, models) {
    const h = json && json.hourly;
    if (!h || !h.time) return {};
    const out = {};
    for (const m of models) {
      const key = h[`precipitation_previous_day1_${m}`] ? `precipitation_previous_day1_${m}`
        : models.length === 1 && h.precipitation_previous_day1 ? 'precipitation_previous_day1' : null;
      if (key) out[m] = { times: h.time, values: h[key] };
    }
    return out;
  }

  async function backtest(loc) {
    const today = U.bkkDateStr();
    const start = U.addDays(today, -35), end = U.addDays(today, -6);
    const ids = BACKTEST_MODELS.map(m => m.id);
    const prevBase = `${OM.prev}?latitude=${loc.lat}&longitude=${loc.lon}&hourly=precipitation_previous_day1&past_days=36&forecast_days=1&${TZ_Q}&models=${ids.join(',')}`;
    const archBase = `${OM.archive}?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${start}&end_date=${end}&daily=precipitation_sum&${TZ_Q}`;
    const [prev, arch] = await Promise.all([
      firstOk('Previous runs', [`${prevBase}&cell_selection=${CELL}`, prevBase]),
      firstOk('Archive', [`${archBase}&models=era5_land&cell_selection=${CELL}`, `${archBase}&models=era5_land`, archBase]),
    ]);
    const perModel = parsePrevRuns(prev, ids);
    if (!Object.keys(perModel).length) throw new Error('รูปแบบข้อมูล previous runs ไม่ตรงที่คาด');
    return { start, end, perModel, obsTimes: arch.daily && arch.daily.time, obsValues: arch.daily && arch.daily.precipitation_sum };
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

  WX.sources = { LIST, ENSEMBLES, BACKTEST_MODELS, run, geocode, parsePrevRuns, fetchJSON };
})(typeof window !== 'undefined' ? window : globalThis);
