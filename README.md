# LBS 虛擬尋寶 App

這個專案是一個以 Google Maps / GPS 為核心的行動互動式尋寶系統，目的在於讓管理員可設計遊戲、擺放寶藏，並讓玩家透過實際手機位置前往目標點並完成蒐集任務。整體涵蓋了手機登入、遊戲管理、寶藏發布、GPS 判定、進度持久化，以及 PWA 安裝體驗。

本專案的需求來源以 `agents.md`、`ticket.md` 及後續修正事項為準，重點包括：

- 使用電話號碼登入，管理員／玩家角色分流
- 僅允許 Real GPS 供玩家使用，管理員保留 Mock GPS 測試
- 寶藏蒐集依據 Haversine 計算，固定 20 公尺門檻
- 管理員遊戲與寶藏資料持久化，以及發布鎖定機制
- 單一遊戲設定與歷史累計收藏數的維護
- PWA manifest 及行動裝置安裝需求

## 專案特點

- 玩家登入後直接進入已發布遊戲，不需額外確認步驟
- 管理員可在地圖上新增寶藏、建立遊戲、發布遊戲及匯出／匯入 JSON
- 已發布遊戲內容被鎖定，未發布遊戲可修改與刪除
- 遊戲狀態（PLAYING / PAUSED / EXITED）會被保存與還原
- 歷史累計寶藏數會依唯一搜集紀錄計算，避免重複加總
- 所有 API 及資料處理均以伺服器資料庫為權威來源

## 技術架構

### 前端

- Vite
- HTML / CSS / JavaScript
- Google Maps JavaScript API
- PWA Manifest

### 後端

- Node.js
- Express
- SQLite（`node:sqlite`）
- Session / Cookie 驗證

### 核心規則

- 寶藏收集距離固定為 `COLLECTION_THRESHOLD_METERS = 20`
- Haversine 計算公式使用地球半徑 `6,371,000` 公尺
- 玩家只能使用 Real GPS；在瀏覽器端不提供切換 Mock GPS 的入口
- Google Maps API Key 只能從 `.env` 讀取，不可硬編碼
- 語言與文件文案全部使用繁體中文

## 專案結構

```text
.
├── .env.example             # 環境變數範例
├── .gitignore               # Git 忽略設定
├── agents.md                # 專案實作/設計規範
├── ticket.md                # 整合工單與需求條目
├── index.html               # 前端入口和 layout
├── package.json             # 專案腳本與依賴
├── pnpm-lock.yaml           # pnpm 鎖定檔
├── public/                  # PWA manifest、logo、icons
├── scripts/                 # 啟動與測試腳本
├── server/                  # Express server / API / 啟動流程
├── src/                     # 前端地圖互動與遊戲邏輯
├── vite.config.js           # Vite 設定
├── task_1.md                # 任務拆解草稿
├── ticket_*.md              # 歷史工單紀錄
├── 登入與伺服器設定.md       # 補充設定與操作說明
├── README.md                # 本說明文件
└── dist/                    # 建置後輸出（若已執行 build）
```

## 環境變數

建立 `.env` 檔時，請參考 `.env.example`：

```env
VITE_GOOGLE_MAPS_API_KEY=
SESSION_SECRET=
PORT=8787
ADMIN_PHONE_NUMBER=0919345737
```

參數說明：

- `VITE_GOOGLE_MAPS_API_KEY`：Google Maps API Key
- `SESSION_SECRET`：後端 Session 密鑰，建議至少 32 字元
- `PORT`：伺服器埠號，預設為 `8787`
- `ADMIN_PHONE_NUMBER`：管理員登入電話號碼，預設為 `0919345737`

## 安裝與啟動

### 1. 安裝依賴

```bash
npm install
# 或
pnpm install
```

### 2. 啟動開發環境

```bash
npm run dev
# 或
pnpm dev
```

此命令會同時啟動：

- Express 後端伺服器
- Vite 前端開發伺服器

### 3. 建置正式版本

```bash
npm run build
```

### 4. 啟動預覽或正式伺服器

```bash
npm run preview
npm run start
```

## 使用流程

### 管理員操作

1. 以 `ADMIN_PHONE_NUMBER` 設定的電話號碼登入。
2. 進入管理介面，建立或選擇遊戲。
3. 在 Google 地圖上點擊位置新增寶藏。
4. 設定寶藏名稱與座標，確認標記正常顯示。
5. 發布遊戲後，讓玩家可開始進行尋寶。
6. 如需調整或測試，可使用 Mock GPS 觸發距離判定。
7. 對未發布遊戲可做重置、清空、匯出 JSON、匯入 JSON 取代資料等管理操作。

### 玩家操作

1. 使用非管理員電話號碼登入。
2. 登入後自動進入已發布遊戲。
3. 請允許 Real GPS 定位權限。
4. 依據地圖或導覽內容前往寶藏位置。
5. 當距離小於或等於 20 公尺時，自動判定為已搜集。
6. 系統會更新 HUD、地圖標記與歷史累計數。
7. 若想暫停，可選擇暫停遊戲，稍後可繼續；若退出則保留進度。

## 重要業務規則

這個專案的核心限制與確保品質的規範如下：

- 寶藏判定距離固定為 `20` 公尺
- 所有距離計算使用標準 Haversine 演算法
- 玩家不會看到 Mock GPS 設定，且伺服器拒絕 Mock GPS 提交
- 管理員是唯一允許使用 Mock GPS 測試的角色
- 發布後的遊戲內容不可修改、不可重命名、不可增刪寶藏
- 已發布遊戲只有在無人遊玩時才能刪除；未發布遊戲可直接刪除
- 至少保留一場遊戲，避免系統沒有可用遊戲
- 所有玩家進度、寶藏狀態與累計數都會保存並還原

## 進度與狀態管理

本系統提供下列狀態：

- `PLAYING`：正在遊戲中，啟用定位監聽與搜集判定
- `PAUSED`：暫停狀態，中止距離判定與位置監聽
- `EXITED`：退出登入，保留主遊戲進度

除了遊戲狀態外，系統也會保存：

- 已搜集寶藏 ID 清單
- 遊戲中的 Mock GPS 座標
- 目前遊戲與角色資訊
- 歷史總累計搜集數

## PWA 需求

專案已包含：

- `manifest.json`
- `icons/icon-192.png`
- `icons/icon-512.png`
- `apple-touch-icon`
- `standalone` 安裝模式設定

這使得裝置可以將網站加入主畫面，以類似 App 的方式使用。

## 測試與驗收重點

### 基本驗收

- 管理員可新增寶藏並在地圖顯示標記
- 玩家登入後直接進入已發布遊戲
- 20 公尺門檻可正確觸發收集
- 20 公尺外不會誤觸發
- 暫停、繼續、退出、重新登入後保持進度
- 歷史總累計數不重複計算

### iPhone / 行動裝置驗收

建議在同一 Wi-Fi 網路下測試：

1. 啟動 `pnpm dev`
2. 取得電腦的 Wi-Fi IPv4 位址
3. 在 iPhone Chrome 或 Safari 中輸入 `http://<電腦IP>:5173`
4. 若需真實 GPS，建議使用 HTTPS 測試環境，必要時可透過臨時公開方案
5. 確認定位權限、地圖載入、Mock GPS 測試，以及寶藏蒐集流程正常

## 風險與注意事項

- 若未設定有效的 Google Maps API Key，地圖功能會失效
- 若 `SESSION_SECRET` 過短，後端啟動會失敗
- 若管理員未在正確電話號碼登入，將被視為一般玩家
- 若發布後嘗試繞過前端修改遊戲或寶藏資料，伺服器端會拒絕請求

## 授權與使用

本專案無明確外部授權條款，請依實際業務單位與內部規範進行使用、部署與分發。

## 關聯文件

- [agents.md](./agents.md)
- [ticket.md](./ticket.md)
- [登入與伺服器設定.md](./登入與伺服器設定.md)
