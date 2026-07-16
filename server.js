/**
 * 葉山・一色海岸特化 24時間 気象・海洋データ統合ダッシュボード
 *
 * データソース (すべて公開API/HTTP。ログイン・ブラウザ不要):
 *   1. Yahoo!天気  … 3時間ごとの天気/気温/降水 (cheerioでHTMLパース)
 *   2. 海快晴       … 一色海岸の波/風/潮位/潮回り (api1.namidensetsu.com の公開API直叩き)
 *   3. Open-Meteo  … Marine API(波) + ICON/ECMWF(風) + 降水確率
 */

require('dotenv').config();
// 一部ホスト(marine-api.open-meteo.com等)のIPv6接続がETIMEDOUTになるためIPv4を優先
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = process.env.PORT || 3000;
const HAYAMA_LAT = parseFloat(process.env.HAYAMA_LAT || '35.27');
const HAYAMA_LON = parseFloat(process.env.HAYAMA_LON || '139.58');
const YAHOO_URL = process.env.YAHOO_URL || 'https://weather.yahoo.co.jp/weather/jp/14/4610/14301.html';

const app = express();
app.use(express.static(__dirname));

/* ======================================================================
 * 共通ユーティリティ
 * ====================================================================== */

// 16方位(日本語) → 角度(度)
const JP_DIR_DEG = {
  '北': 0, '北北東': 22.5, '北東': 45, '東北東': 67.5,
  '東': 90, '東南東': 112.5, '南東': 135, '南南東': 157.5,
  '南': 180, '南南西': 202.5, '南西': 225, '西南西': 247.5,
  '西': 270, '西北西': 292.5, '北西': 315, '北北西': 337.5,
  '静穏': null, '無風': null,
};

// 角度 → 矢印絵文字 (8方位に丸める)
function degToArrow(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return '';
  const arrows = ['⬇️', '↙️', '⬅️', '↖️', '⬆️', '↗️', '➡️', '↘️'];
  // 0°=北(風が吹いてくる向き)。矢印は「風が向かう向き」を示す。
  // 北風(0°)＝南へ向かう＝⬇️
  const idx = Math.round(deg / 45) % 8;
  return arrows[idx];
}

// 角度 → 日本語16方位ラベル
function degToJpDir(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return '--';
  const dirs = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
    '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// 一色海岸ローカルアラート (オン/オフショア判定)
//   南半球(東南東〜西南西, 概ね 100〜260°)= オンショア(面荒れ)
//   北半球 = オフショア(沖出し)
function localWindAlert(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return '';
  const d = ((deg % 360) + 360) % 360;
  if (d >= 100 && d <= 260) return '(面荒れ注意・オンショア)';
  if (d <= 80 || d >= 280) return '(沖出しの風・オフショア)';
  return ''; // 真東/真西付近はニュートラル
}

// 文字列から数値を抽出
function num(str) {
  if (str === null || str === undefined) return null;
  const m = String(str).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/* ======================================================================
 * 1) Open-Meteo (Marine=波 / ECMWF=風 / 降水確率)
 * ====================================================================== */
// marine-api.open-meteo.com はIPv6でETIMEDOUTするため、ソケットをIPv4に固定
const https = require('https');
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

// Open-Meteoは無料枠ゆえ間欠的に失敗するためリトライを噛ませる。
// 正常時は約1秒で応答するので、ホスト不通時に長く待たないようタイムアウトは短め(高速失敗)。
async function getWithRetry(url, params, label, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await axios.get(url, {
        params, timeout: 6000, httpsAgent: ipv4Agent,
        headers: { 'User-Agent': 'hayama-marine-dashboard/1.0' },
      });
      if (res.data && res.data.hourly) return res.data;
      throw new Error('hourly欠落');
    } catch (e) {
      const reason = e.response ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown');
      console.warn(`[OpenMeteo] ${label} 試行${i}/${attempts}失敗: ${reason}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

const FORECAST_DAYS = 7; // 取得したい先読み日数(Open-Meteoは最大16日)
// 3つ目の比較列(Windy参照モデル)の風。ECMWF(25km)は葉山から約26km内陸(横浜市旭区)を指し不正確、
// JMA MSMは海快晴の気象庁予報と重複するため、既定はドイツDWDのICON(13km)。
// Windyも参照する独立モデルで、Open-Meteo無料。.envの WINDY_WIND_MODEL で切替可(ecmwf_ifs025 / gfs_seamless / jma_msm 等)。
const WINDY_WIND_MODEL = process.env.WINDY_WIND_MODEL || 'icon_seamless';

async function fetchOpenMeteo() {
  const result = {}; // key: "YYYY-MM-DDTHH:00" -> { wave, windDeg, windSpeed, pop }
  const setH = (data, fields) => {
    if (!data) return;
    const h = data.hourly;
    h.time.forEach((t, i) => {
      const key = t.slice(0, 13) + ':00';
      result[key] = result[key] || {};
      for (const [src, dst] of fields) result[key][dst] = h[src][i];
    });
  };

  // 各ソースを並列取得(各々リトライ付き)
  const windParams = (model) => ({
    latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
    hourly: 'wind_speed_10m,wind_direction_10m',
    models: model,
    forecast_days: FORECAST_DAYS, timezone: 'Asia/Tokyo', wind_speed_unit: 'ms',
  });
  const [marine, wind, ecmwf, pop] = await Promise.all([
    getWithRetry('https://marine-api.open-meteo.com/v1/marine', {
      latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
      hourly: 'wave_height,wave_direction,wave_period',
      forecast_days: FORECAST_DAYS, timezone: 'Asia/Tokyo',
    }, 'Marine(波)'),
    getWithRetry('https://api.open-meteo.com/v1/forecast', windParams(WINDY_WIND_MODEL), `風(${WINDY_WIND_MODEL})`),
    getWithRetry('https://api.open-meteo.com/v1/forecast', windParams('ecmwf_ifs025'), '風(ecmwf_ifs025)'),
    getWithRetry('https://api.open-meteo.com/v1/forecast', {
      latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
      hourly: 'precipitation_probability',
      forecast_days: FORECAST_DAYS, timezone: 'Asia/Tokyo',
    }, '降水確率'),
  ]);

  // 各モデルが実際にスナップした座標をログ(葉山=35.27/139.58 に近いか確認用)
  if (marine) console.log(`[OpenMeteo] Marine座標 ${marine.latitude}/${marine.longitude} (標高${marine.elevation}m)`);
  if (wind) console.log(`[OpenMeteo] 風(${WINDY_WIND_MODEL})座標 ${wind.latitude}/${wind.longitude} (標高${wind.elevation}m)`);
  if (ecmwf) console.log(`[OpenMeteo] 風(ECMWF)座標 ${ecmwf.latitude}/${ecmwf.longitude} (標高${ecmwf.elevation}m)`);

  setH(marine, [['wave_height', 'wave'], ['wave_direction', 'waveDeg'], ['wave_period', 'wavePeriod']]);
  setH(wind, [['wind_speed_10m', 'windSpeed'], ['wind_direction_10m', 'windDeg']]);
  setH(ecmwf, [['wind_speed_10m', 'windSpeedE'], ['wind_direction_10m', 'windDegE']]);
  setH(pop, [['precipitation_probability', 'pop']]);

  return result;
}

/* ======================================================================
 * 2) Yahoo!天気 (3時間ごと: 天気/気温/降水量/風)
 * ====================================================================== */
async function fetchYahoo() {
  // key: "YYYY-MM-DDTHH:00" -> { icon, desc, temp, rainMm, windDir, windDeg, windSpeed }
  const result = {};
  try {
    const res = await axios.get(YAHOO_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      }, timeout: 15000,
    });
    const $ = cheerio.load(res.data);

    // 今日(=最初) / 明日 の2枚の yjw_table2(時間別) を処理
    const now = new Date();
    const tables = $('table.yjw_table2');
    tables.each((tableIdx, table) => {
      const rows = $(table).find('tr');
      // 行の役割を1列目ラベルで判定
      const byLabel = {};
      rows.each((_, tr) => {
        const cells = $(tr).find('td');
        const label = $(cells[0]).text().replace(/\s/g, '');
        byLabel[label] = cells;
      });

      const timeCells = rows.first().find('td');
      const hours = [];
      timeCells.each((i, td) => {
        if (i === 0) return; // ラベル列
        const t = $(td).text().replace(/\s/g, '');
        const m = t.match(/(\d+)時/);
        if (m) hours.push(parseInt(m[1], 10));
      });

      // 各データ行
      const weatherCells = findRow($, rows, ['天気']);
      const tempCells = findRow($, rows, ['気温']);
      const rainCells = findRow($, rows, ['降水', '降水量']);
      const windCells = findRow($, rows, ['風向', '風速']);

      // tableIdx 0=今日, 1=明日 として日付を決める
      const baseDate = new Date(now);
      baseDate.setDate(now.getDate() + tableIdx);

      hours.forEach((hh, colIdx) => {
        const d = new Date(baseDate);
        d.setHours(hh, 0, 0, 0);
        const key = isoLocal(d);

        const entry = {};
        // 天気 (imgのalt or テキスト)
        if (weatherCells) {
          const cell = weatherCells.eq(colIdx + 1);
          const alt = cell.find('img').attr('alt');
          entry.desc = (alt || cell.text().trim()).trim();
          entry.icon = weatherEmoji(entry.desc);
        }
        if (tempCells) entry.temp = num(tempCells.eq(colIdx + 1).text());
        if (rainCells) entry.rainMm = num(rainCells.eq(colIdx + 1).text());
        if (windCells) {
          // セル内は「方位<br>数値」の形
          const cell = windCells.eq(colIdx + 1);
          const raw = cell.text().replace(/\s+/g, ' ').trim();
          const dirMatch = raw.match(/(北北東|北東|東北東|東南東|南東|南南東|南南西|南西|西南西|西北西|北西|北北西|北|東|南|西|静穏|無風)/);
          entry.windDir = dirMatch ? dirMatch[1] : '--';
          entry.windDeg = JP_DIR_DEG[entry.windDir] ?? null;
          entry.windSpeed = num(raw);
        }
        result[key] = entry;
      });
    });
  } catch (e) {
    console.warn('[Yahoo] スクレイピング失敗:', e.message);
  }
  return result;
}

// ラベルに一致する行のtd群を返す
function findRow($, rows, labels) {
  let found = null;
  rows.each((_, tr) => {
    if (found) return;
    const cells = $(tr).find('td');
    const label = $(cells[0]).text().replace(/\s/g, '');
    if (labels.some((l) => label.includes(l))) found = cells;
  });
  return found;
}

function weatherEmoji(desc) {
  if (!desc) return '';
  if (desc.includes('雷')) return '⛈️';
  if (desc.includes('雪')) return '❄️';
  if (desc.includes('雨')) return '🌧️';
  if (desc.includes('曇') && desc.includes('晴')) return '🌤️';
  if (desc.includes('曇')) return '☁️';
  if (desc.includes('晴')) return '☀️';
  return '🌫️';
}

/* ======================================================================
 * 3) 海快晴 (Playwright自動ログイン → 一色海岸の波/風/潮位/潮回り)
 * ====================================================================== */
// 海快晴の公開データAPI (api1.namidensetsu.com)。ログイン/ブラウザ不要。
const UMI_API = 'https://api1.namidensetsu.com/api';
const UMI_POINT_ID = process.env.UMIKAISEI_POINT_ID || '01170052'; // 一色海岸

async function umiGet(path, params, attempts = 3) {
  const qs = new URLSearchParams({ apiver: '1.0', os: 'web', ...params }).toString();
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await axios.get(`${UMI_API}/${path}?${qs}`, {
        timeout: 15000, httpsAgent: ipv4Agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Referer: 'https://www.umikaisei.jp/',
        },
      });
      if (res.data && String(res.data.status) === '0') return res.data;
      throw new Error(`status=${res.data && res.data.status}`);
    } catch (e) {
      console.warn(`[海快晴API] ${path} 試行${i}/${attempts}失敗: ${e.code || e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
  return null;
}

const dirCodeToDeg = (c) => (c == null || c === '' ? null : (((+c % 16) + 16) % 16) * 22.5); // 0=北, 時計回り
const numOr = (v) => { if (v == null) return null; const n = parseFloat(v); return (isNaN(n) || n <= -999) ? null : n; };
const umiDtToKey = (dt) => { const s = String(dt); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:00`; };
const pad2 = (n) => String(n).padStart(2, '0');

// 海快晴の一色海岸データを公開APIから直接取得 (point_comb=風/波/潮位, tide=潮汐, moonphase=月齢)
async function fetchUmikaisei() {
  const out = { tide: {}, hourly: {}, debug: null };
  try {
    const now = new Date();
    const ymd = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
    const [comb, tideRes, moon] = await Promise.all([
      umiGet('point_comb.php', { id: UMI_POINT_ID }),
      umiGet('tide.php', { id: UMI_POINT_ID, date: ymd }),
      umiGet('moonphase.php', { id: UMI_POINT_ID, date: ymd.slice(0, 6) }),
    ]);

    // 毎時の 独自WRF(風) / 独自SWAN(波) / 潮位
    if (comb && Array.isArray(comb.datadates)) {
      const ordered = [];
      for (const d of comb.datadates) {
        const key = umiDtToKey(d.dt);
        const pick = (id) => ((d.foredata || []).find((f) => f.dataid === id) || {}).contents || {};
        const wrf = pick('WRFR01');
        const swan = pick('SWANR01');
        const windDeg = dirCodeToDeg(wrf.wdc);
        const waveDeg = dirCodeToDeg(swan.dir);
        out.hourly[key] = {
          temp: numOr(wrf.tmp),
          rainMm: numOr(wrf.prec),
          windDir: windDeg != null ? degToJpDir(windDeg) : '--',
          windDeg,
          windSpeed: numOr(wrf.ws),
          waveDir: waveDeg != null ? degToJpDir(waveDeg) : '--',
          wave: numOr(swan.ht),
          swellPeriod: numOr(swan.pd),
          tide: numOr(d.tidedata),
        };
        ordered.push(key);
      }
      // 潮位トレンド(上げ/下げ)を前後比較で付与
      for (let i = 0; i < ordered.length; i++) {
        const cur = out.hourly[ordered[i]];
        const next = i < ordered.length - 1 ? out.hourly[ordered[i + 1]] : null;
        const prev = i > 0 ? out.hourly[ordered[i - 1]] : null;
        let trend = null;
        if (cur.tide != null) {
          if (next && next.tide != null) trend = next.tide > cur.tide ? 'up' : (next.tide < cur.tide ? 'down' : null);
          else if (prev && prev.tide != null) trend = cur.tide > prev.tide ? 'up' : (cur.tide < prev.tide ? 'down' : null);
        }
        cur.tideTrend = trend;
      }
    } else {
      out.error = 'point_comb取得失敗';
    }

    out.tide = parseTideApi(tideRes);
    out.tide.moonAge = parseMoonAge(moon, ymd);
    out.debug = { hours: Object.keys(out.hourly).length, tideHighs: (out.tide.highs || []).length };
  } catch (e) {
    console.warn('[海快晴] 失敗:', e.message);
    out.error = e.message;
  }
  return out;
}

// tide.php → { tideName, highs:[{time,level}], lows:[{time,level}] }
function parseTideApi(td) {
  const info = { tideName: null, moonAge: null, highs: [], lows: [], advice: '' };
  const obs = td && Array.isArray(td.obs) ? td.obs[0] : null;
  if (obs && obs.tide) {
    info.tideName = obs.tide.ts || null;
    info.highs = (obs.tide.high || []).map((h) => ({ time: h.time, level: parseInt(h.hgt, 10) }));
    info.lows = (obs.tide.low || []).map((l) => ({ time: l.time, level: parseInt(l.hgt, 10) }));
  }
  return info;
}

// moonphase.php → 今日(ymd:YYYYMMDD)の月齢(整数)
// 海快晴サイトの表示に合わせて切り捨て(例: age 2.72 → 月齢2)
function parseMoonAge(moon, ymd) {
  if (!moon || !Array.isArray(moon.obs)) return null;
  const hit = moon.obs.find((o) => String(o.dt).slice(0, 8) === ymd) || moon.obs[0];
  return hit && hit.age != null ? Math.floor(parseFloat(hit.age)) : null;
}

/* ======================================================================
 * 時刻ユーティリティ & マージ
 * ====================================================================== */
function isoLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

// 3時間ごとデータを各時刻に展開するための「直近の3hスロット」キー
function nearestYahooKey(yahoo, key) {
  if (yahoo[key]) return key;
  // 同日の0,3,6...のうち、その時刻を含むブロックへ寄せる
  const d = new Date(key);
  const block = Math.floor(d.getHours() / 3) * 3;
  d.setHours(block, 0, 0, 0);
  return isoLocal(d);
}

function buildTimeline({ openMeteo, yahoo, umikaisei }) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const nowMs = now.getTime();

  // データが存在する最終時刻まで表示する。
  // 葉山特化の海快晴を優先し、無ければOpen-Meteoの範囲。安全上限168h(7日)。
  const umiKeys = Object.keys(umikaisei.hourly || {});
  const srcKeys = umiKeys.length ? umiKeys : Object.keys(openMeteo || {});
  let maxHours = 24;
  for (const k of srcKeys) {
    const h = Math.floor((new Date(k).getTime() - nowMs) / 3600000);
    if (h > maxHours) maxHours = h;
  }
  maxHours = Math.min(maxHours, 168);

  const timeline = [];
  for (let i = 0; i <= maxHours; i++) {
    const d = new Date(now.getTime() + i * 3600 * 1000);
    const key = isoLocal(d);
    const om = openMeteo[key] || {};
    const yKey = nearestYahooKey(yahoo, key);
    const y = yahoo[yKey] || {};
    const u = umikaisei.hourly[key] || {};

    timeline.push({
      key,
      hour: d.getHours(),
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      dateLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      isNight: d.getHours() >= 0 && d.getHours() <= 4,
      yahoo: {
        icon: y.icon || '', desc: y.desc || '',
        temp: y.temp ?? null,
        rainMm: y.rainMm ?? null, // Yahoo時間別の降水量(mm)
        pop: y.pop ?? om.pop ?? null, // 参考: Open-Meteoの降水確率
        windDir: y.windDir || (y.windDeg != null ? degToJpDir(y.windDeg) : '--'),
        windDeg: y.windDeg ?? null,
        windArrow: degToArrow(y.windDeg),
        windSpeed: y.windSpeed ?? null,
        windAlert: y.windSpeed >= 5 ? localWindAlert(y.windDeg) : '',
      },
      umikaisei: {
        wave: u.wave ?? om.wave ?? null,
        waveFromFallback: u.wave == null && om.wave != null,
        windDir: u.windDir || (u.windDeg != null ? degToJpDir(u.windDeg) : (om.windDeg != null ? degToJpDir(om.windDeg) : '--')),
        windDeg: u.windDeg ?? om.windDeg ?? null,
        windArrow: degToArrow(u.windDeg ?? om.windDeg),
        windSpeed: u.windSpeed ?? om.windSpeed ?? null,
        windAlert: (u.windSpeed ?? om.windSpeed) >= 5 ? localWindAlert(u.windDeg ?? om.windDeg) : '',
        tide: u.tide ?? null,
        tideTrend: u.tideTrend ?? null, // 'up' | 'down'
      },
      windy: {
        wave: om.wave ?? null,
        wavePeriod: om.wavePeriod ?? null,
        windDir: om.windDeg != null ? degToJpDir(om.windDeg) : '--',
        windDeg: om.windDeg ?? null,
        windArrow: degToArrow(om.windDeg),
        windSpeed: om.windSpeed ?? null,
        windAlert: om.windSpeed >= 5 ? localWindAlert(om.windDeg) : '',
      },
      ecmwf: {
        windDir: om.windDegE != null ? degToJpDir(om.windDegE) : '--',
        windDeg: om.windDegE ?? null,
        windArrow: degToArrow(om.windDegE),
        windSpeed: om.windSpeedE ?? null,
        windAlert: om.windSpeedE >= 5 ? localWindAlert(om.windDegE) : '',
      },
    });
  }
  return timeline;
}

// 潮位アドバイス(満干潮の近接で簡易判定) & 各行への満潮/干潮バッジ付与
function annotateTide(timeline, tideInfo) {
  const events = [];
  (tideInfo.highs || []).forEach((h) => events.push({ type: 'high', ...h }));
  (tideInfo.lows || []).forEach((l) => events.push({ type: 'low', ...l }));

  timeline.forEach((row) => {
    let badge = null;
    for (const ev of events) {
      const [hh, mm] = ev.time.split(':').map(Number);
      if (hh === row.hour) {
        badge = ev.type === 'high' ? '🛑 満潮間近' : '🟢 干潮間近';
      }
    }
    row.tideBadge = badge;
  });

  // トップのアドバイス
  let advice = '潮汐データ取得中…';
  if (events.length) {
    advice = `本日は${tideInfo.tideName || ''}。満潮${(tideInfo.highs[0] || {}).time || '--'}・干潮${(tideInfo.lows[0] || {}).time || '--'}を目安に行動を。`;
  }
  tideInfo.advice = advice;
  return timeline;
}

/* ======================================================================
 * キャッシュ & APIエンドポイント
 * ====================================================================== */
let cache = { ts: 0, data: null };
let building = null; // 進行中ビルドのPromise(重複ビルド防止ロック)
const CACHE_MS = 10 * 60 * 1000; // 10分

// 重複を避けつつビルドを1本化。完了時にキャッシュ更新。
function rebuild() {
  if (!building) {
    building = buildPayload()
      .then((data) => { cache = { ts: Date.now(), data }; return data; })
      .finally(() => { building = null; });
  }
  return building;
}

async function buildPayload() {
  const [openMeteo, yahoo, umikaisei] = await Promise.all([
    fetchOpenMeteo(),
    fetchYahoo(),
    fetchUmikaisei(),
  ]);
  let timeline = buildTimeline({ openMeteo, yahoo, umikaisei });
  timeline = annotateTide(timeline, umikaisei.tide || {});
  return {
    generatedAt: new Date().toISOString(),
    tide: umikaisei.tide || {},
    timeline,
    sources: {
      yahoo: Object.keys(yahoo).length > 0,
      umikaisei: !umikaisei.error && Object.keys(umikaisei.hourly || {}).length > 0,
      umikaiseiTide: (umikaisei.tide && (umikaisei.tide.highs || []).length > 0),
      openMeteo: Object.keys(openMeteo).length > 0,
    },
    debug: umikaisei.debug || umikaisei.error || null,
  };
}

app.get('/api/weather', async (req, res) => {
  try {
    const force = req.query.force === '1';
    const age = Date.now() - cache.ts;

    // 有効なキャッシュがあれば即返す
    if (cache.data && !force && age < CACHE_MS) {
      return res.json({ ...cache.data, cached: true });
    }
    // 古いキャッシュがある場合は「即座に古いデータを返しつつ裏で更新」(stale-while-revalidate)
    // → ユーザーは待たされない。裏のビルドは次回に反映。
    if (cache.data && !force) {
      rebuild().catch((e) => console.error('[rebuild] 背面更新失敗:', e.message));
      return res.json({ ...cache.data, cached: true, stale: true });
    }
    // キャッシュ無し(初回) or 手動更新(force): ビルド完了を待つ(重複ビルドはロックで共有)
    const data = await rebuild();
    res.json({ ...data, cached: false });
  } catch (e) {
    console.error('[/api/weather] error:', e);
    // ビルド失敗でも古いキャッシュがあれば返す(取得失敗を出さない)
    if (cache.data) return res.json({ ...cache.data, cached: true, stale: true, buildError: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// このファイルを直接実行(node server.js)した時だけサーバーを起動する。
// generate.js から require された時は起動しない(データ生成だけ行うため)。
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🌊 葉山・一色海岸ダッシュボード起動: http://localhost:${PORT}\n`);
  });
}

// generate.js から呼べるようにデータ生成関数を公開
module.exports = { buildPayload };
