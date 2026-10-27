# #13 部署設定檢查表

本表補足只能在部署環境與 Google Cloud 專案確認的驗收項目。請在正式部署使用的專案中操作並記錄結果；不要把 API 金鑰或其他秘密貼入 issue、文件或 Git。

## 環境變數與 HTTPS

- [ ] 伺服器及 `npm run db:restore` 使用專案根目錄 `.env`（或部署平台注入的同名環境變數）；`.env.example` 僅供複製建立設定，不是執行時設定檔。
- [ ] `.env` 不提交至 Git；正式環境 `NODE_ENV=production` 且 `PUBLIC_APP_URL` 使用 HTTPS。
- [ ] 正式環境設定至少 32 位元組的 `AUTH_HANDOFF_ENCRYPTION_KEY`；多個服務實例使用相同值，且不寫入部署紀錄。
- [ ] `DATABASE_PATH` 指向持久化磁碟；`BACKUP_DIRECTORY` 指向持久化且受限存取的目錄，並確認備份有異地副本及可用的還原程序。
- [ ] 若服務位於反向代理後，確認代理會覆寫 `X-Forwarded-For`，再將 `TRUST_PROXY_HOPS` 設為實際可信代理 hop 數；否則維持 `0`。
- [ ] 記錄部署環境變數的來源與更新程序，不在紀錄中保存其值。
- [x] SMTP 連線與認證檢查通過；未傳送測試郵件。
- [ ] 實際寄送玩家 Magic Link，確認收信、登入及地圖載入。

## Google Maps API 金鑰與用量

目前前端使用 `GOOGLE_MAPS_API_KEY` 載入 Maps JavaScript API。此金鑰會提供給瀏覽器，因此必須在 Google Cloud 專案以網站 referrer 限制及 API 限制保護。

- [x] 使用者確認已在 Google Cloud 專案啟用 Maps JavaScript API。
- [x] 本機開發網址 `http://localhost:3000/` 可連線並載入應用程式；本機金鑰 referrer 設定已由使用者確認。
- [ ] 先在 Google Maps Platform 指標中確認現有金鑰實際呼叫的 API 與來源網域，再設定限制，避免直接套用限制而中斷正式地圖。
- [ ] 在 **Google Maps Platform → Credentials** 編輯該金鑰，Application restrictions 選 **Websites**，只加入實際正式網域，例如 `https://<正式網域>/*`；依需要另加明確的測試網域，不要使用廣泛萬用網域。
- [x] 使用者確認在 **API restrictions** 限制此金鑰僅允許 **Maps JavaScript API**。
- [ ] 套用金鑰限制後，從 `http://localhost:3000/` 載入地圖，確認合法 referrer 下地圖仍可用。
- [x] 使用者確認已設定 Maps JavaScript API 配額。
- [ ] 套用限制及配額後，從 `http://localhost:3000/` 登入玩家帳號並載入地圖，確認地圖仍可用。
- [x] 使用者確認已建立 Cloud Billing budget 並設定費用通知。Budget 警示本身不會自動限制支出；若需要自動停止用量，須另外確認服務是否支援 spend cap 並設定。
- [ ] 儲存限制後，以正式網域載入地圖並查看 Cloud 指標／錯誤，確認合法流量可用、未授權網域及非允許 API 受限制。

## 備份與還原演練

- [ ] 確認服務啟動時建立線上備份，且預設排程為每 24 小時；檢查備份檔 SQLite 完整性與外鍵驗證結果。
- [x] 2026-10-21 在隔離暫存目錄以獨立 `DATABASE_PATH` 還原啟動備份 `lbth-2026-10-21T10-11-19-774Z.sqlite`；還原程式驗證成功並建立資料庫檔，演練後已清除暫存檔。
- [x] 2026-10-27 在隔離 `DATABASE_PATH` 還原備份 `lbth-2026-10-22T05-26-07-077Z.sqlite`；SQLite 完整性／外鍵檢查通過，應用程式 loopback 首頁回應 200、未登入身份端點回應 401，資料庫可讀取。
- [ ] 在正式或指定隔離部署環境確認還原後的服務可啟動並讀取資料；記錄環境、備份識別及結果，不記錄玩家精確位置或秘密值。

## 驗收紀錄

- 正式網域：
- Google Cloud 專案識別（非金鑰）：
- 金鑰 referrer／API 限制：
- 配額與 Billing 通知：
- 備份還原演練日期／結果：
- 驗收者／日期：
