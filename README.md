# 🌊 Hayama波風情報

葉山・一色海岸に特化した、数日先までの気象・海洋データを一元表示する自分専用ダッシュボード。
**すべて公開API/HTTPで取得（ログイン・ブラウザ自動操作は不要）** なので、どこにでも軽量にデプロイできます。

## データソース
- **Yahoo!天気（葉山町）** … 天気・気温・降水量（cheerioでHTMLパース）
- **海快晴（一色海岸）** … 波・風・潮位・潮回り（`api1.namidensetsu.com` の公開APIを直接取得）
- **Open-Meteo** … Marine API(波) + ICON/ECMWF(風) + 降水確率

## 機能
- 上部に今日の潮回り（潮名・満潮/干潮の時刻と潮位）とアドバイス
- 24時間先までを毎時で比較する統合タイムラインテーブル
- 固定列（天気・気温・降水量・潮位）＋ タブ切替（風／波／波風の比較）
- 強風5m/s以上のハイライト、一色海岸の地形を考慮したオン/オフショア判定
- 満潮/干潮バッジ、潮位トレンド、深夜帯の視認性調整

## セットアップ（ローカル）
```bash
npm install                 # 軽量な依存のみ（ブラウザ不要）
cp .env.example .env        # ログイン情報は不要
node generate.js            # data.json を生成
npm start                   # http://localhost:3000 を開く
```

## 構成
| ファイル | 役割 |
|---|---|
| `server.js` | データ取得処理＋ローカル用サーバー（`buildPayload`を公開） |
| `generate.js` | `data.json` を生成するスクリプト |
| `index.html` | フロントエンド（`data.json`を読んで表示） |
| `data.json` | 生成された気象データ |
| `.github/workflows/update-data.yml` | 30分ごとに`data.json`を自動更新（GitHub利用時） |
| `.env` | ポイントID・URL・座標（Git除外／秘密情報なし） |

## 外部公開
ログイン情報が不要になったため、どの方法でも簡単に公開できます。
- **GitHub Actions ＋ GitHub Pages**（無料・Mac不要）: Secrets登録は不要。Actionsで`data.json`を定期生成→Pagesで表示。
- **Firebase**（Google）: Hosting で `index.html`＋`data.json` を配信。定期取得はCloud Functions/スケジューラ等で。

以前必要だった海快晴のログインID/パスワードは **不要** になりました（公開APIを利用）。
