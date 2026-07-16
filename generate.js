/**
 * data.json 生成スクリプト (GitHub Actions が定期実行する)
 *   海快晴・Yahoo!天気・Open-Meteo からデータを取得し、data.json に書き出す。
 *   フロント(index.html)はサーバーではなく、この data.json を読んで表示する。
 */
process.env.TZ = process.env.TZ || 'Asia/Tokyo'; // 日本時間で計算(GitHubの実行環境はUTCのため)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { buildPayload } = require('./server');

(async () => {
  try {
    console.log('データ取得を開始します…');
    const data = await buildPayload();
    const outPath = path.join(__dirname, 'data.json');
    fs.writeFileSync(outPath, JSON.stringify(data));
    console.log(`✅ data.json を書き出しました (${data.timeline.length}行, sources=${JSON.stringify(data.sources)})`);
    process.exit(0);
  } catch (e) {
    console.error('❌ data.json 生成に失敗:', e);
    process.exit(1);
  }
})();
