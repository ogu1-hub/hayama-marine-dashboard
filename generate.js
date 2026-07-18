/**
 * data.json 生成スクリプト (GitHub Actions が定期実行する)
 *   全対応地点(葉山・逗子)について 海快晴・Yahoo!天気・Open-Meteo を取得し data.json に書き出す。
 *   フロント(index.html)は海快晴/Open-Meteoをブラウザから直接取得し、Yahoo天気だけこの data.json を読む。
 *   出力形式: { generatedAt, locations: { hayama: <payload>, zushi: <payload> } }
 */
process.env.TZ = process.env.TZ || 'Asia/Tokyo'; // 日本時間で計算(GitHubの実行環境はUTCのため)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPayload, LOCATIONS } = require('./server');

(async () => {
  try {
    const out = { generatedAt: new Date().toISOString(), locations: {} };
    for (const key of Object.keys(LOCATIONS)) {
      console.log(`[${key}] データ取得中…`);
      const payload = await buildPayload(LOCATIONS[key]);
      out.locations[key] = payload;
      console.log(`  ✅ ${LOCATIONS[key].name} (${payload.timeline.length}行, sources=${JSON.stringify(payload.sources)})`);
    }
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(out));
    console.log('✅ data.json を書き出しました:', Object.keys(out.locations).join(', '));
    process.exit(0);
  } catch (e) {
    console.error('❌ data.json 生成に失敗:', e);
    process.exit(1);
  }
})();
