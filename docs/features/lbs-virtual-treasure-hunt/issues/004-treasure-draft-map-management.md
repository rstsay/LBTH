**Feature:** 遊戲管理與寶藏設定  
**PRD version:** v2.2  
**Status:** 程式端已實作；驗收待執行（本次僅靜態檢視，未執行測試）  
**Source requirement:** 寶藏資料與草稿地圖 — 6.1 寶藏資料、13.2 遊戲與多場活動  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** #3  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 4. [#4](https://github.com/rstsay/LBTH/issues/4) 寶藏資料模型與草稿地圖編輯

**User Story**  
身為管理員，我希望在草稿遊戲管理寶藏與熱區，並在地圖上檢查結果。

**Scope**
- 遊戲及寶藏資料模型，單場上限 500 個寶藏。
- 精確座標與模糊熱區中心分開保存。
- 草稿新增、修改、刪除同步地圖 Marker／InfoWindow、目標數、伺服器資料與本機快取。
- 發布後鎖定內容；可停用寶藏。
- 草稿地圖前端及伺服器同步已於 `web/` 實作；其他管理工作區範圍追蹤於「前端 PWA 與管理工作區延伸」。

**Acceptance Criteria**
- 第 501 個寶藏不能加入。
- 草稿資料在地圖與伺服器一致。
- 玩家在熱區外無法從 API 取得精確座標。
- 停用寶藏不刪除既有搜集，且從完成條件排除。

**API 端點（初版）**
- 管理員：`GET/POST /admin/games/:gameId/treasures`、`PATCH/DELETE /admin/games/:gameId/treasures/:treasureId`。
- 管理員寶藏清單回傳精確座標與模糊熱區資料，供草稿地圖 Marker／InfoWindow 呈現；遊戲回應的 `totalTreasuresCount` 與寶藏異動回應的數量均即時由伺服器資料計算。
- 發布後禁止新增、修改座標／半徑或刪除寶藏；僅允許將 `enabled` 設為 `false`，啟用目標數同步扣除。
- 玩家遊戲 API 不回傳寶藏清單或精確座標；進入熱區後的精確 Marker API 已由 `web/` 前端接入位置 API。
- 前端地圖位於 `web/`，須以管理員 API 回傳的完整清單作為更新依據；LocalStorage 僅可作非權威快取。

Labels: HITL, admin, maps, data-model, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#4](https://github.com/rstsay/LBTH/issues/4)

