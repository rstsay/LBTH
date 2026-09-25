# LBS 虛擬尋寶 App

這個專案是一個以 Google Maps / GPS 為核心的行動式尋寶 PWA 應用，支援管理員建立遊戲、置放寶藏，以及玩家透過手機實際位置探索並蒐集寶藏。專案整合了前端互動、後端 API、資料持久化與 PWA 安裝需求，適合用於校園、社區活動或企業導覽型遊戲。

本專案的設計與實作規範，主要依據 `agents.md` 與 `ticket.md` 兩份文件，並統整了登入流程、遊戲管理、GPS 計算規則、發布鎖定與狀態持久化等需求。

## 專案定位

- 玩家：使用電話號碼登入，直接進入已發布遊戲並開始實際尋寶。
- 管理員：可建立遊戲、設定寶藏座標、發布遊戲、匯出／匯入資料，並以 Mock GPS 進行測試。
- 系統：採用前後端分離式架構，後端以 Express + SQLite 提供資料與 Session 管理，前端使用 Vite + 瀏覽器端互動邏輯。

## 核心功能

### 1. 登入與角色分流

- 以電話號碼註冊或登入。
- 預設管理員電話號碼為 `0919345737`，可透過 `ADMIN_PHONE_NUMBER` 覆寫。
- 只有符合此電話號碼的使用者視為管理員；其他使用者皆為玩家。
- 登入裝置會記住上次使用的電話號碼，方便下次自動預填。

### 2. 管理員遊戲與寶藏管理

- 管理員可建立新遊戲、重新命名、選擇管理中的遊戲。
- 在 Google 地圖上新增、編輯與刪除未發布遊戲中的寶藏。
- 發布遊戲後，內容會鎖定，不可再修改寶藏或遊戲內容。
- 已發布遊戲只有在沒有人正在遊玩時才可刪除；未發布遊戲可直接刪除。
- 提供 JSON 匯出／匯入、遊戲重置、清空寶藏等管理工具。

### 3. 玩家尋寶與 GPS 判定

- 玩家只能使用 Real GPS；伺服器端拒絕 Mock GPS 狀態。
- 管理員保留 Mock GPS 測試工具，用於驗證寶藏搜集邏輯。
- 使用標準 Haversine 公式計算距離；地球半徑固定為 `6,371,000` 公尺。
- 寶藏蒐集門檻固定為 `20` 公尺：距離小於或等於 `20` 公尺時自動判定為已找到。
- 搜集成功後會更新 HUD、地圖標記、進度條與歷史累計數。

### 4. 狀態保存與進度回復

- 玩家進度、已搜集寶藏 ID、歷史累計數量、遊戲狀態皆會保存。
- 暫停、繼續、退出、重新登入後都可還原遊戲狀態。
- 進度資料以本機 LocalStorage 作為快取，並以後端資料庫為跨使用者／跨裝置的權威來源。

### 5. PWA / 行動裝置支援

- 提供 `manifest.json` 與圖示資源，支援加入主畫面。
- 支援 `standalone` 模式，適合手機安裝為應用程式。
- 專案可在同一 Wi-Fi 網路下以 iPhone / Android 裝置測試。

## 技術棧

- 前端：Vite + JavaScript + HTML + CSS
- 後端：Express + Node.js
- 資料庫：SQLite（使用 `node:sqlite`）
- 地圖：Google Maps JavaScript API
- PWA：Web App Manifest + Apple Touch Icon
- 位置計算：Haversine 距離算法

## 專案結構

```text
.
├── .env.example            # 環境變數範例
├── .gitignore              # Git 忽略設定
├── agents.md               # 專案實作規範總結
├── ticket.md               # 整合後的任務工單
├── index.html              # 應用入口與 UI 結構
├── package.json            # Node 專案設定與腳本
├── pnpm-lock.yaml          # pnpm 鎖定檔
├── public/                 # PWA manifest、圖示、logo
├── scripts/                # 啟動與測試輔助腳本
├── server/                 # Express 伺服器與啟動腳本
├── src/                    # 前端主邏輯與樣式
├── vite.config.js          # Vite 設定
├── task_1.md               # 任務拆解草稿
├── ticket_1.md ...         # 先前工單紀錄
├── 登入與伺服器設定.md      # 補充設定與測試說明
└── README.md               # 專案說明文件
```

## 快速開始

### 1. 安裝依賴

```bash
npm install
# 或
pnpm install
```

### 2. 建立環境變數

將 `.env.example` 複製成 `.env`，並填入所需資訊：

```bash
cp .env.example .env
```

範例內容：

```env
VITE_GOOGLE_MAPS_API_KEY=
SESSION_SECRET=
PORT=8787
ADMIN_PHONE_NUMBER=0919345737
```

說明：

- `VITE_GOOGLE_MAPS_API_KEY`：Google Maps API Key
- `SESSION_SECRET`：後端 Session 使用的秘密金鑰，至少 32 字元
- `PORT`：後端埠號，預設為 `8787`
- `ADMIN_PHONE_NUMBER`：管理員登入電話號碼

### 3. 啟動開發環境

```bash
npm run dev
# 或
pnpm dev
```

此指令會同時啟動：

- Express 後端伺服器
- Vite 前端開發伺服器

### 4. 開啟網站

預設瀏覽器可開啟 Vite 開發頁面（通常為 `http://localhost:5173`），並透過管理員／玩家角色進入遊戲流程。

## 運行腳本

```bash
npm run dev       # 啟動前後端開發伺服器
npm run build     # 建置正式前端資產
npm run preview   # 啟動預覽伺服器
npm run start     # 啟動正式伺服器
```

## 重要業務規則

這個專案明確要求遵守以下規範：

- 寶藏判定距離固定為 `20` 公尺。
- 經緯度距離必須使用標準 Haversine 演算法，地球半徑固定為 `6,371,000` 公尺。
- 玩家僅可使用 Real GPS；管理員可使用 Mock GPS 進行測試。
- Google Maps API Key 不得硬編碼，必須透過 `.env` 載入。
- 已發布遊戲內容不可修改；未發布遊戲可管理。
- 遊戲進度、寶藏蒐集狀態與歷史累計數量需即時保存。

## 開發注意事項

- 本專案使用繁體中文作為程式碼註解、介面文案與文件語言。
- 所有資料屬於 LBS 尋寶活動，需保留玩家進度與管理遊戲資料的一致性。
- 若需進行 iPhone 實機測試，建議使用同一 Wi-Fi 網路，並以區網 IP + Vite 預設埠號進行開啟。
- 若需提供 HTTPS 測試網址，可使用 Cloudflare Quick Tunnel 等臨時方案，但本專案不依賴其作為正式設計。

## 使用說明

### 管理員流程

1. 以 `ADMIN_PHONE_NUMBER` 設定的電話號碼登入。
2. 進入管理介面，建立並命名遊戲。
3. 在地圖上點擊新增寶藏。
4. 發布遊戲供玩家遊玩。
5. 透過 Mock GPS 測試玩家搜集條件，確認 20 公尺門檻符合預期。

### 玩家流程

1. 以非管理員電話號碼登入。
2. 登入後直接進入已發布遊戲。
3. 允許使用 Real GPS 定位，邊走邊蒐集寶藏。
4. 若在距離 `20` 公尺內，系統會自動判定搜集成功並更新進度。
5. 暫停、退出或重新進入後，進度會自動保存與恢復。

## 整體目標

此專案的最終目標，是打造一個可在手機瀏覽器環境中實際運作的 LBS 虛擬尋寶系統，兼顧：

- 真實 GPS 定位
- 管理員內容編輯與發布控制
- 玩家遊戲進度持久化
- 互動式寶藏搜集感受
- PWA 安裝體驗

## 授權

本專案未附帶明確的法務授權條款，請依實際執行單位的內部規範使用與發佈。
