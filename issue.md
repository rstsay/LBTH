# 開發工作清單

本清單對應已確認的 [產品需求文件](./product.md)。需求或驗收細節以產品文件為準；已移除離線遊戲、動態搜集門檻及玩家 Mock GPS 等舊需求不應重新加入。

## 1. [#1](https://github.com/rstsay/LBTH/issues/1) Email Magic Link 與玩家身份

**User Story**  
身為玩家，我希望以 Email Magic Link 驗證並登入匿名帳號，避免設定密碼也不會僅憑已知 Email 登入他人帳號。

**Scope**
- Email 正規化與唯一性；Magic Link 15 分鐘有效、只能使用一次。
- 首次驗證建立玩家 ID 及匿名代號。
- 不同 Email 建立不同玩家；Email 更換不轉移舊進度。
- 管理員登入另須 TOTP。

**Acceptance Criteria**
- 未完成 Email 驗證不能登入。
- 已使用或過期的 Magic Link 不能再次使用。
- Email 不區分大小寫且去除首尾空白後唯一。

Labels: AFK, auth, backend, P0

## 2. [#2](https://github.com/rstsay/LBTH/issues/2) 單一有效會話與跨裝置恢復

**User Story**  
身為玩家，我希望在新裝置登入後安全恢復伺服器進度，並確保舊裝置會話失效。

**Scope**
- 同一 Email 同時只有一個有效會話。
- 新登入撤銷既有會話。
- 從伺服器恢復各場遊戲進度，不恢復位置快照。

**Acceptance Criteria**
- 新裝置成功登入後，舊會話立即無效。
- 玩家可恢復已保存進度；舊裝置位置不會被當作新裝置位置使用。

Labels: AFK, auth, session, backend, P0

## 3. [#3](https://github.com/rstsay/LBTH/issues/3) 多遊戲管理與生命週期

**User Story**  
身為管理員，我希望建立並發布多場遊戲；玩家可從已發布清單選擇遊玩。

**Scope**
- 多場草稿、發布、暫停、恢復、提前結束、封存及刪除。
- 活動時區設定與 UTC 儲存。
- 玩家一次只能進行一場，暫停後可切換；各場進度獨立。
- 發布後鎖定寶藏位置及半徑。

**Acceptance Criteria**
- 多場遊戲可同時發布並顯示正確狀態。
- 玩家不能同時進行兩場；暫停後可選另一場，且可恢復前場進度。
- 暫停不可搜集；結束後不可恢復遊玩。
- 草稿可刪除；結束遊戲封存 7 天，還原資料不恢復遊玩。

**API 端點（初版）**
- 管理員：`GET/POST /admin/games`、`PATCH/DELETE /admin/games/:gameId`、`POST /admin/games/:gameId/{publish,pause,resume,end,restore}`。
- 玩家：`GET /games`、`GET /games/:gameId`、`POST /games/:gameId/{join,pause,exit}`。
- 遊戲時段以含時區偏移的 ISO 8601 時間輸入，資料庫以 UTC 儲存，回應附活動 IANA 時區。
- 管理員路由預設拒絕所有請求，須由管理員角色授權中介軟體提供授權；角色與 TOTP 登入由 Issue #11 接續整合。
- 玩家每場參與紀錄獨立保存；藏寶搜集及進度寫入由 Issue #7 接續整合。

Labels: HITL, admin, games, lifecycle, P0

## 4. [#4](https://github.com/rstsay/LBTH/issues/4) 寶藏資料模型與草稿地圖編輯

**User Story**  
身為管理員，我希望在草稿遊戲管理寶藏與熱區，並在地圖上檢查結果。

**Scope**
- 遊戲及寶藏資料模型，單場上限 500 個寶藏。
- 精確座標與模糊熱區中心分開保存。
- 草稿新增、修改、刪除同步地圖 Marker／InfoWindow、目標數、伺服器資料與本機快取。
- 發布後鎖定內容；可停用寶藏。

**Acceptance Criteria**
- 第 501 個寶藏不能加入。
- 草稿資料在地圖與伺服器一致。
- 玩家在熱區外無法從 API 取得精確座標。
- 停用寶藏不刪除既有搜集，且從完成條件排除。

**API 端點（初版）**
- 管理員：`GET/POST /admin/games/:gameId/treasures`、`PATCH/DELETE /admin/games/:gameId/treasures/:treasureId`。
- 管理員寶藏清單回傳精確座標與模糊熱區資料，供草稿地圖 Marker／InfoWindow 呈現；遊戲回應的 `totalTreasuresCount` 與寶藏異動回應的數量均即時由伺服器資料計算。
- 發布後禁止新增、修改座標／半徑或刪除寶藏；僅允許將 `enabled` 設為 `false`，啟用目標數同步扣除。
- 玩家遊戲 API 不回傳寶藏清單或精確座標；進入熱區後的精確 Marker API 由 Issue #6 接續整合。
- 前端地圖與 LocalStorage 快取須以管理員 API 回傳的完整清單作為更新依據；本次工作區尚無前端地圖實作。

Labels: HITL, admin, maps, data-model, P0

## 5. [#5](https://github.com/rstsay/LBTH/issues/5) JSON 匯入、驗證與預覽

**User Story**  
身為管理員，我希望上傳 JSON、預覽寶藏並取得逐列錯誤，以降低發布錯誤座標的風險。

**Scope**
- `schemaVersion: 1` 與 `treasures` 格式；欄位、預設值、座標範圍及重複座標規則依 `product.md`。
- 最多 500 筆；匯入前地圖預覽。
- 全部有效才匯入或跳過錯誤列；有效資料以單一交易匯入。
- 匯入錯誤回報列號、欄位、錯誤碼與原因。

**Acceptance Criteria**
- 缺必填欄位、錯誤型別、非法座標、重複精確座標及超過上限均可辨識。
- 全部有效模式遇錯誤不匯入任何列。
- 跳過錯誤模式只原子化匯入有效列。
- 匯入後仍為草稿，需再次確認才能發布。

**API 端點（初版）**
- `POST /admin/games/:gameId/treasures/import/preview`：輸入 PRD 定義的 JSON，不寫入資料；回傳正規化預覽、有效列數與錯誤清單。
- `POST /admin/games/:gameId/treasures/import/commit`：輸入同一 JSON 及 `mode`（`all_or_nothing` 或 `skip_invalid`），交易成功後回傳伺服器產生的 ID、匯入數、啟用目標數與逐列錯誤。
- 錯誤格式為 `{ row, field, code, reason }`；資料列從 1 開始，全域格式／版本／容量錯誤使用 `row: 0`（實際單場容量超限則標註超限列）。
- 匯入同時檢查該遊戲既有寶藏，重複座標依小數點後 6 位判定；單場含既有資料最多 500 筆。

Labels: HITL, admin, import, validation, P0

## 6. [#6](https://github.com/rstsay/LBTH/issues/6) 前景定位與固定 20 公尺搜集驗證

**User Story**  
身為玩家，我希望在真實位置接近寶藏時完成搜集，並在定位不可靠時得到明確提示。

**Scope**
- 前景 Real GPS；背景立即停止定位與回報。
- 共用 `COLLECTION_THRESHOLD_METERS = 20`，標準 Haversine，半徑 6,371,000 公尺。
- accuracy >50 公尺拒絕搜集；不得動態擴大距離門檻。
- 伺服器驗證最新定位、遊戲及寶藏狀態。

**Acceptance Criteria**
- 距離 ≤20 公尺且 accuracy ≤50 公尺始可通過位置條件。
- 距離 >20 公尺或 accuracy >50 公尺均拒絕，並顯示適當訊息。
- 前後端、管理測試與單元測試使用相同 Haversine 計算及比較精度。
- App 背景時不回報定位，回前景重新定位。

**API 端點（初版）**
- `POST /games/:gameId/location`：已登入且正在遊玩的玩家回報前景 Real GPS；回傳模糊熱區及熱區內的精確 Marker，不保存原始定位。
- `POST /games/:gameId/treasures/:treasureId/collect`：攜帶最新 GPS 座標、accuracy 與 timestamp，由伺服器按固定門檻判定並記錄成功搜集。
- 明確標示 `isMock: true`、`mode: "mock"`、`gpsMode: "mock"` 或 `source: "mock"` 的定位請求一律拒絕。
- 共用 Haversine helper 位於 `src/geo.ts`；前景追蹤器位於 `src/location.ts`，頁面隱藏時停止 watch，回前景後重新取得定位，回報間隔至少 5 秒。

Labels: AFK, geolocation, backend, frontend, P0

## 7. [#7](https://github.com/rstsay/LBTH/issues/7) 冪等搜集與伺服器權威進度

**User Story**  
身為玩家，我希望搜集結果即時保存且不因重複請求重複計分。

**Scope**
- 每位玩家、每場遊戲、每個寶藏唯一搜集紀錄。
- 搜集事件、該場伺服器進度及完成狀態在同一資料庫交易內更新；跨遊戲累計由已確認搜集事件計算，不維護可漂移的重複計數器。
- 停用寶藏時，在同一交易中重算受影響玩家的目標數與完成狀態。
- 暫停或結束不回滾已確認結果。

**Acceptance Criteria**
- 重送相同搜集請求回傳一致結果但不重複計分。
- 跨裝置或網路重試不會建立重複事件。
- 回應包含該場搜集 ID 清單、已搜集數、啟用目標數、完成狀態及玩家跨遊戲已確認累計數。
- 搜集紀錄、該場進度及跨遊戲累計皆以伺服器資料庫為權威；LocalStorage 不得覆寫伺服器紀錄。
- 前端快取不作為搜集或進度權威來源。

Labels: AFK, backend, persistence, idempotency, P0

## 8. [#8](https://github.com/rstsay/LBTH/issues/8) 管理員草稿 Mock GPS 測試

**User Story**  
身為管理員，我希望能在發布前測試位置搜集邏輯，但不污染正式玩家成績。

**Scope**
- Mock GPS 僅限管理員未發布草稿的隔離測試介面。
- 使用相同 Haversine 與 20 公尺門檻。
- 正式玩家 API 拒絕明確 Mock 狀態。

**Acceptance Criteria**
- 玩家端沒有 Mock GPS 開關或控制列。
- 管理員測試不產生正式搜集、進度、異常或排行紀錄。
- 管理員可使用 `POST /admin/games/:gameId/mock-gps/test`，只測試未發布草稿內啟用寶藏的模擬座標、定位精度與搜集距離。
- 測試採用正式 Haversine、20 公尺門檻及 50 公尺 accuracy 上限；未授權、非草稿、無效或停用寶藏請求均拒絕。

Labels: HITL, admin, testing, security, P0

## 9. [#9](https://github.com/rstsay/LBTH/issues/9) 全站累計前三名與玩家進度

**User Story**  
身為玩家，我希望查看目前遊戲進度及跨遊戲累計排行榜。

**Scope**
- HUD、剩餘寶藏及完成率。
- 全站跨遊戲排行榜只顯示前三名、累計數及完成遊戲數。
- 排序及隱藏設定依 `product.md`。
- 管理員重置進度、刪除遊戲及帳號時正確調整統計。

**Acceptance Criteria**
- 成功搜集即更新該場進度及歷史累計。
- 隱藏玩家不在榜單，個人累計保留。
- 重置被搜集數及完成場數同步扣除／重算。
- 遊戲永久刪除扣除該場排行貢獻。
- 玩家可透過 `PATCH /auth/me` 更新暱稱及排行榜顯示設定；`GET /auth/me` 回傳個人跨遊戲已確認累計。
- `GET /games/:gameId/progress` 回傳伺服器權威該場進度、剩餘數、完成率、完成狀態及歷史累計。
- `GET /leaderboard` 只回傳可顯示玩家的前三名，依累計搜集數、完成遊戲數及達到目前累計數的時間排序；同分時以玩家 ID 穩定排序。
- 遊戲進度及排行榜統計從伺服器搜集紀錄與啟用寶藏計算，不採信客戶端或過期進度快取；遊戲刪除以資料庫級聯移除其統計貢獻。

Labels: AFK, leaderboard, progress, frontend, backend, P0

## 10. [#10](https://github.com/rstsay/LBTH/issues/10) 異常訊號與雙人審查

**User Story**  
身為管理員，我希望檢視可解釋的異常訊號並經人工確認後處理，不讓單一定位誤差自動懲罰玩家。

**Scope**
- 單筆跳點記錄；連續速度 >45 公里／小時、2 分鐘內移動 >1 公里、同寶藏 5 分鐘內嘗試 ≥10 次時標記覆核。
- 異常不自動扣分、封鎖或隱藏排行。
- 異常審查及玩家進度重置須兩位不同管理員確認。
- 審查結果、操作者與更正紀錄寫入審計。

**Acceptance Criteria**
- 門檻產生符合規格的紀錄，異常玩家仍保留榜單資格。
- 無雙人確認不得完成進度重置或異常審查。
- 可查閱相關軌跡與搜集事件，精確位置依期限清除。
- `POST /games/:gameId/location` 保存有效位置樣本；速度以 `max(0, Haversine 距離 - 前後 accuracy)` 除以時間差計算，超過 45 公里／小時建立訊號；距離超過 1 公里且間隔不超過 2 分鐘另建立跳點訊號。
- 同一玩家對同一寶藏 5 分鐘內第 10 次有效遊戲搜集 API 請求建立重複嘗試訊號；冪等重試仍只計分一次。
- 管理員可查詢異常及關聯位置／搜集證據；審查需兩位不同管理員提交相同決定，並逐次寫入審計紀錄。
- 玩家進度重置申請由一位管理員建立，另一位不同管理員確認後才移除該場計分紀錄並重設進度；缺少可信管理員識別時拒絕執行。
- 重置確認時保存原進度及搜集紀錄快照；管理員可用 `POST /admin/games/progress-resets/:resetId/restore` 復原一次，若玩家已產生新搜集則拒絕覆寫。

Labels: HITL, admin, audit, anti-abuse, P1

## 11. [#11](https://github.com/rstsay/LBTH/issues/11) 管理員 TOTP、角色與審計

**User Story**  
身為系統管理者，我希望保護管理功能並能追查敏感操作。

**Scope**
- 管理員 Magic Link、TOTP、多管理員及資料庫角色控制。
- 管理員建立、停用及撤銷。
- 管理員寫入操作及敏感資料查詢審計。
- 一般變更可復原；永久刪除明確確認且不可復原。

**Acceptance Criteria**
- 未通過 TOTP 不得進入管理後台。
- 每筆敏感操作記錄操作者、時間、對象、結果與必要變更摘要。
- 審計紀錄不含不必要的 Email 或精確座標，至少保留 90 天。
- 管理員使用 Email Magic Link 後必須完成 TOTP；首次登入須完成 TOTP 註冊。停用管理員後，既有管理員工作階段立即失效。
- 管理員可建立、調整角色、停用及撤銷其他管理員；資料庫角色限制管理功能，且不可停用或降級最後一位系統管理員。
- `DELETE` 遊戲或草稿寶藏時必須送出 `confirmPermanentDeletion: true`；管理員帳號撤銷採停用並保留稽核紀錄。

**API 與部署設定**
- `POST /admin/auth/magic-links`、`POST /admin/auth/verify`、`POST /admin/auth/totp/enroll`、`POST /admin/auth/totp/confirm`、`POST /admin/auth/totp/verify` 與 `POST /admin/auth/logout`。
- `GET/POST /admin/administrators`、`PATCH/DELETE /admin/administrators/:adminId`；角色為 `owner`、`admin` 或唯讀 `auditor`，只有 `owner` 可管理帳號。
- `GET /admin/audit-logs` 查詢最近 90 天內的不可變更稽核紀錄；稽核摘要只保留安全欄位及變更欄位名稱，不保存請求 Email 或座標值。
- 伺服器必須設定 `ADMIN_BOOTSTRAP_EMAIL` 與至少 32 位元組的 `ADMIN_TOTP_ENCRYPTION_KEY`；TOTP 秘密以 AES-256-GCM 加密後儲存，金鑰只能放在環境變數。

Labels: HITL, admin, auth, security, audit, P0

## 12. [#12](https://github.com/rstsay/LBTH/issues/12) 資料保留、刪除與帳號刪除

**User Story**  
身為玩家或管理員，我希望資料依保留政策清除，又能在允許期間復原誤操作。

**Scope**
- 暫停／退出後位置軌跡保留 24 小時。
- 遊戲停止接受遊玩後，搜集與異常事件保留 30 天。
- 遊戲結束封存 7 天；結束 7 天後可清除遊戲內容，事件保留期限獨立計算。
- 審計紀錄至少保留 90 天。
- 玩家刪除帳號後撤銷憑證、移除直接識別資料並從排行移除；仍須保留資料去識別化。

**Acceptance Criteria**
- 清理作業按規定起算時間刪除到期資料。
- 搜集事件不包含玩家精確座標；留存事件不包含 Email。
- 遊戲刪除後排行榜扣除該場貢獻，但到期前去識別化事件仍留存。
- 自動到期清除及永久刪除不可復原，留下不含敏感資料的審計記錄。
- 暫停／退出的位置樣本於 24 小時到期即刪除；遊戲停止接受遊玩後 30 天清除搜集及異常事件。
- 遊戲結束後 7 天內不得永久刪除遊戲；草稿可由管理員明確確認後立即刪除。遊戲超過封存期的自動清除每分鐘執行，且不影響 30 天事件保留期限。
- 帳號可由已登入玩家以 `DELETE /auth/me` 並帶 `confirmPermanentDeletion: true` 永久刪除。刪除會撤銷所有登入憑證、移除玩家及 Email 資料、清除排行榜貢獻，並將未到期事件轉成不含玩家 ID、Email 或精確位置的留存事件。
- `retained_game_events` 僅保存匿名事件類型、時間、到期時間及最小化摘要；期限屆滿即清除。`data_retention_audit` 僅保存動作、主體雜湊及時間，不含直接識別資料。
- 管理員稽核事件不可修改；清理工作於建立滿 90 天後才自動刪除，不足 90 天的紀錄不得清除。

Labels: AFK, privacy, retention, backend, P0

## 13. [#13](https://github.com/rstsay/LBTH/issues/13) API 限流與營運可靠性

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
