**Feature:** 玩家尋寶與進度  
**PRD version:** v2.2  
**Source requirement:** 冪等搜集與權威進度 — 7.2 定位與伺服器驗證、9. 進度與排行榜  
**Iteration:** 1  
**Type:** AFK  
**Depends on:** #6  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 7. [#7](https://github.com/rstsay/LBTH/issues/7) 冪等搜集與伺服器權威進度

**Status:** 已實作；聚焦測試 26 項通過

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

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [x] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#7](https://github.com/rstsay/LBTH/issues/7)

## Implementation log

- Date: 2026-10-26
- Tests added: 無；驗收既有搜集服務、API、跨裝置重試及排行榜測試。
- Key decisions: 維持 SQLite 唯一鍵與 `BEGIN IMMEDIATE` 交易；搜集紀錄、該場進度及伺服器累計由資料庫計算與回傳。
- Architectural friction found: 無
- Follow-up work: #9 全站累計前三名與玩家進度

