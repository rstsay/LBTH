**Feature:** 隱私與營運可靠性  
**PRD version:** v2.2  
**Status:** 程式端已實作；部署環境與 Google Cloud 設定待驗收  
**Source requirement:** API 限流與營運可靠性 — 11.1 安全與 API 保護、11.3 可用性與維運、11.4 Google Maps 金鑰  
**Iteration:** 1  
**Type:** AFK  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 13. [#13](https://github.com/rstsay/LBTH/issues/13) API 限流與營運可靠性

**部署驗收指引：** [#13 部署設定檢查表](./013-deployment-checklist.md)

**User Story**  
身為營運者，我希望控制 API 濫用並能在資料庫故障時可靠恢復。

**Scope**
- 初始限流：Magic Link 每 Email／IP 各 5 次／15 分鐘；位置每玩家 1 次／5 秒；搜集每玩家 10 次／分鐘；排行榜每玩家 30 次／分鐘。
- 超限 HTTP 429；伺服器端限制為權威。
- SQLite WAL、連線逾時、寫入重試、定期備份及備份還原。
- HTTPS 與 Google Maps 金鑰環境變數管理、referrer 限制、用量上限及費用警示。

**Acceptance Criteria**
- 超限請求收到 429 與可理解提示。
- 前端節流不被視為安全限制。
- 備份可依程序還原；金鑰不硬編碼且不提交至 Git。
- Magic Link 每 Email 及來源 IP 各 15 分鐘 5 次；位置每玩家 5 秒 1 次；搜集每玩家每分鐘 10 次；排行榜每玩家每分鐘 30 次。限流狀態由 SQLite 原子更新，回傳 `Retry-After` 與繁體中文提示。
- SQLite 啟用 WAL、`busy_timeout` 與有界寫入交易重試；不得重試非鎖定錯誤或整筆非冪等交易。
- 啟動時及預設每 24 小時建立線上一致性備份；備份須通過 SQLite 完整性與外鍵檢查。還原前驗證備份，應用程式停止時以暫存檔驗證後取代資料庫，失敗不得覆蓋現有資料。

**營運設定與還原**
- `BACKUP_DIRECTORY` 預設 `./backups`；`BACKUP_INTERVAL_MS` 預設 `86400000` 毫秒。
- `TRUST_PROXY_HOPS` 預設 `0`；僅於部署於會覆寫 `X-Forwarded-For` 的可信 Proxy 後，依實際 Proxy hop 數設定。
- 停止伺服器後執行 `npm run db:restore -- <backup-file>`；路徑由 `DATABASE_PATH` 指定，拒絕還原損毀備份或資料庫仍有 WAL/SHM 活動檔。
- Production 的 `PUBLIC_APP_URL` 必須是 HTTPS；TLS 由部署平台的 HTTPS reverse proxy 終止。Google Maps API Key 從 `GOOGLE_MAPS_API_KEY` 環境變數提供；referrer 限制、用量上限及費用警示由 Google Cloud 專案設定，不得把 Key 寫入程式碼或版本控制。

Labels: AFK, backend, security, operations, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [x] 程式端限流、SQLite WAL／重試、定期備份／安全還原及 `.env` 金鑰載入已實作（部署前仍須依檢查表驗證設定）。
- [ ] 確認正式環境使用 `.env`／部署環境變數，`PUBLIC_APP_URL` 為 HTTPS，備份目錄及可信 Proxy hop 設定正確。
- [ ] Google Cloud 金鑰完成網站 referrer 與必要 API 限制，Maps API 用量配額與 Billing 費用警示已設定並驗證。
- [ ] 依檢查表完成備份檔完整性確認與停機還原演練。

**原始 GitHub issue：** [#13](https://github.com/rstsay/LBTH/issues/13)

