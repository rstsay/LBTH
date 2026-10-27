**Feature:** 玩家尋寶與進度  
**PRD version:** v2.2  
**Source requirement:** 個人進度與全站排行榜 — 9. 進度與排行榜、13.4 排行榜、13.5 前端與 PWA  
**Iteration:** 1  
**Type:** AFK  
**Depends on:** #7  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 9. [#9](https://github.com/rstsay/LBTH/issues/9) 全站累計前三名與玩家進度

**Status:** 已實作；聚焦測試 25 項通過

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
- `web/` 已提供玩家遊戲卡片、個人暱稱／公開設定與前三名排行榜介面，資料由上述伺服器 API 載入。

Labels: AFK, leaderboard, progress, frontend, backend, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [x] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#9](https://github.com/rstsay/LBTH/issues/9)

## Implementation log

- Date: 2026-10-26
- Tests added: 無；驗收既有排行榜、進度、重置／還原、遊戲刪除及帳號刪除測試。
- Key decisions: 排行榜、玩家累計及完成場數由伺服器搜集事件與啟用寶藏計算；保留排序規則及個人總數與公開榜單隱藏設定的分離。
- Architectural friction found: 無
- Follow-up work: 無；依賴 issue #6、#7 已完成

