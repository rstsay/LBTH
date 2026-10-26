**Feature:** 遊戲管理與寶藏設定  
**PRD version:** v2.2  
**Status:** 程式端已實作；驗收待執行（本次僅靜態檢視，未執行測試）  
**Source requirement:** 遊戲管理與生命週期 — 4.1 遊戲建立與發布、13.2 遊戲與多場活動  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

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

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#3](https://github.com/rstsay/LBTH/issues/3)

