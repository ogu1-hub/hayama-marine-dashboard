/**
 * 葉山・一色海岸特化 24時間 気象・海洋データ統合ダッシュボード
 * ローカルサーバー (Express + Playwright)
 *
 * データソース:
 *   1. Yahoo!天気  … 3時間ごとの天気/気温/風 (cheerioでHTMLパース)
 *   2. 海快晴       … 一色海岸の波/風/潮位 + 今日の潮回り (Playwrightで自動ログイン)
 *   3. Open-Meteo  … Marine API(波) + ECMWF(風) + 降水確率   (CORS回避済みの公式API)
 */

require('dotenv').config();
// 一部ホスト(marine-api.open-meteo.com等)のIPv6接続がETIMEDOUTになるためIPv4を優先
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;
const HAYAMA_LAT = parseFloat(process.env.HAYAMA_LAT || '35.27');
const HAYAMA_LON = parseFloat(process.env.HAYAMA_LON || '139.58');
const YAHOO_URL = process.env.YAHOO_URL;
const UMIKAISEI_URL = process.env.UMIKAISEI_URL;
const UMIKAISEI_EMAIL = process.env.UMIKAISEI_EMAIL;
const UMIKAISEI_PASSWORD = process.env.UMIKAISEI_PASSWORD;

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

// Open-Meteoは無料枠ゆえ間欠的に失敗するためリトライを噛ませる
async function getWithRetry(url, params, label, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await axios.get(url, {
        params, timeout: 20000, httpsAgent: ipv4Agent,
        headers: { 'User-Agent': 'hayama-marine-dashboard/1.0' },
      });
      if (res.data && res.data.hourly) return res.data;
      throw new Error('hourly欠落');
    } catch (e) {
      const reason = e.response ? `HTTP ${e.response.status}` : (e.code || e.message || 'unknown');
      console.warn(`[OpenMeteo] ${label} 試行${i}/${attempts}失敗: ${reason}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 700 * i));
    }
  }
  return null;
}

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

  // 3ソースを並列取得(各々リトライ付き)
  const [marine, wind, pop] = await Promise.all([
    getWithRetry('https://marine-api.open-meteo.com/v1/marine', {
      latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
      hourly: 'wave_height,wave_direction,wave_period',
      forecast_days: 2, timezone: 'Asia/Tokyo',
    }, 'Marine(波)'),
    getWithRetry('https://api.open-meteo.com/v1/forecast', {
      latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
      hourly: 'wind_speed_10m,wind_direction_10m',
      models: 'ecmwf_ifs025',
      forecast_days: 2, timezone: 'Asia/Tokyo', wind_speed_unit: 'ms',
    }, 'ECMWF(風)'),
    getWithRetry('https://api.open-meteo.com/v1/forecast', {
      latitude: HAYAMA_LAT, longitude: HAYAMA_LON,
      hourly: 'precipitation_probability',
      forecast_days: 2, timezone: 'Asia/Tokyo',
    }, '降水確率'),
  ]);

  setH(marine, [['wave_height', 'wave'], ['wave_direction', 'waveDeg'], ['wave_period', 'wavePeriod']]);
  setH(wind, [['wind_speed_10m', 'windSpeed'], ['wind_direction_10m', 'windDeg']]);
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
async function fetchUmikaisei() {
  const out = { tide: {}, hourly: {}, debug: null };
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'ja-JP',
    });
    const page = await ctx.newPage();

    // --- 会員ログイン (login.php: id / password / login) ---
    await login(page);

    // --- 一色海岸 詳細ページへ ---
    await page.goto(UMIKAISEI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#forecast_all', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    const html = await page.content();
    const bodyText = await page.evaluate(() => document.body.innerText);
    const $ = cheerio.load(html);

    out.hourly = parseForecastAll($);
    out.tide = parseTideTable($, bodyText);
    out.debug = { hours: Object.keys(out.hourly).length, tideHighs: (out.tide.highs || []).length };
  } catch (e) {
    console.warn('[海快晴] 失敗:', e.message);
    out.error = e.message;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}

async function login(page) {
  await page.goto('https://www.umikaisei.jp/login.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[name="id"]', UMIKAISEI_EMAIL);
  await page.fill('input[name="password"]', UMIKAISEI_PASSWORD);
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {}),
    page.locator('input[name="login"], input[type="submit"]').first().click({ timeout: 8000 }).catch(() => {}),
  ]);
  await page.waitForTimeout(1200);
}

// #forecast_all (天気/気温/降水/風(WRF)/波(SWAN)/潮位) を毎時パース
// 列: [時, 天気icon, 気温, 降水mm, 風向, 風向icon, 風速, 波向, 波向icon, 波高, うねり周期, 潮位cm]
function parseForecastAll($) {
  const result = {};
  const table = $('#forecast_all');
  if (!table.length) return result;

  const now = new Date();
  let curYear = now.getFullYear();
  let curMonth = null, curDay = null, lastHour = -1;
  const ordered = [];

  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('td, th');
    const texts = cells.map((i, c) => $(c).text().replace(/\s+/g, '').trim()).get();

    // 日付ヘッダ行 (例: "6月30日(火)")
    if (texts.length <= 2) {
      const dm = (texts.join('')).match(/(\d{1,2})月(\d{1,2})日/);
      if (dm) {
        const m = parseInt(dm[1], 10), d = parseInt(dm[2], 10);
        // 年跨ぎ (12月→1月) 補正
        if (curMonth !== null && m < curMonth) curYear += 1;
        curMonth = m; curDay = d; lastHour = -1;
      }
      return;
    }
    // データ行 (12列, 先頭が時刻の数値)
    if (texts.length >= 12 && /^\d{1,2}$/.test(texts[0]) && curMonth !== null) {
      const hh = parseInt(texts[0], 10);
      if (hh < lastHour) curDay += 1; // 念のための日跨ぎ補正
      lastHour = hh;
      const date = new Date(curYear, curMonth - 1, curDay, hh, 0, 0, 0);
      const key = isoLocal(date);

      const windDir = texts[4] || '--';
      const waveDir = texts[7] || '--';
      const entry = {
        weatherIcon: weatherEmoji(texts[1]) || iconFromImg($(cells[1]).find('img').attr('src')),
        temp: num(texts[2]),
        rainMm: num(texts[3]),
        windDir,
        windDeg: JP_DIR_DEG[windDir] ?? null,
        windSpeed: num(texts[6]),
        waveDir,
        wave: num(texts[9]),
        swellPeriod: num(texts[10]),
        tide: num(texts[11]),
      };
      result[key] = entry;
      ordered.push(key);
    }
  });

  // 潮位トレンド(上げ/下げ)を前後比較で付与
  for (let i = 0; i < ordered.length; i++) {
    const cur = result[ordered[i]];
    const prev = i > 0 ? result[ordered[i - 1]] : null;
    const next = i < ordered.length - 1 ? result[ordered[i + 1]] : null;
    let ref = next ?? prev;
    let trend = null;
    if (cur.tide != null && ref && ref.tide != null) {
      if (next && next.tide != null) trend = next.tide > cur.tide ? 'up' : (next.tide < cur.tide ? 'down' : null);
      else if (prev && prev.tide != null) trend = cur.tide > prev.tide ? 'up' : (cur.tide < prev.tide ? 'down' : null);
    }
    cur.tideTrend = trend;
  }
  return result;
}

function iconFromImg(src) {
  if (!src) return '';
  const map = { '01': '☀️', '02': '🌤️', '03': '⛅', '04': '☁️', '10': '🌧️', '22': '☁️' };
  const m = src.match(/weather_icon_(\d+)/);
  return m ? (map[m[1]] || '🌫️') : '';
}

// #tide_time から満潮/干潮、本文から潮名・月齢を抽出
function parseTideTable($, bodyText) {
  const info = { tideName: null, moonAge: null, highs: [], lows: [], advice: '' };

  const nm = (bodyText || '').match(/(\d{1,2})月(\d{1,2})日\s*(大潮|中潮|小潮|長潮|若潮)\s*月齢\s*(\d+)/);
  if (nm) { info.tideName = nm[3]; info.moonAge = parseInt(nm[4], 10); }
  else {
    const n2 = (bodyText || '').match(/(大潮|中潮|小潮|長潮|若潮)/);
    if (n2) info.tideName = n2[1];
  }

  const parsePair = (s) => {
    const m = (s || '').match(/(\d{1,2}:\d{2})\s*(-?\d+)\s*cm/);
    return m ? { time: m[1], level: parseInt(m[2], 10) } : null;
  };
  $('#tide_time tr').each((idx, tr) => {
    if (idx === 0) return; // ヘッダ
    const cells = $(tr).find('td, th');
    const high = parsePair($(cells[0]).text());
    const low = parsePair($(cells[1]).text());
    if (high) info.highs.push(high);
    if (low) info.lows.push(low);
  });
  return info;
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
  const timeline = [];
  for (let i = 0; i <= 24; i++) {
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
const CACHE_MS = 10 * 60 * 1000; // 10分

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
    if (!force && cache.data && Date.now() - cache.ts < CACHE_MS) {
      return res.json({ ...cache.data, cached: true });
    }
    const data = await buildPayload();
    cache = { ts: Date.now(), data };
    res.json({ ...data, cached: false });
  } catch (e) {
    console.error('[/api/weather] error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🌊 葉山・一色海岸ダッシュボード起動: http://localhost:${PORT}\n`);
});
