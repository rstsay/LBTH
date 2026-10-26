**Feature:** 玩家尋寶與進度  
**PRD version:** v2.2  
**Source requirement:** 前景定位與搜集驗證 — 7.1 固定距離規則、7.2 定位與伺服器驗證、13.3 位置與搜集  
**Iteration:** 1  
**Type:** AFK  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

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
- `web/` 尋寶地圖已接入前景 Geolocation API、位置揭露及搜集 API；前端 Haversine 位於 `web/geo.js`，並以測試確認距離結果與伺服器一致。

Labels: AFK, geolocation, backend, frontend, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#6](https://github.com/rstsay/LBTH/issues/6)

