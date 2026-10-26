**Feature:** 管理員安全與覆核  
**PRD version:** v2.2  
**Source requirement:** 草稿 Mock GPS 測試 — 8.1 GPS 使用規則、10. 管理員需求與審計  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** #3、#4、#11  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

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
- `web/` 草稿管理面板已提供隔離 Mock GPS 測試表單，呼叫上述 API，不建立正式玩家搜集紀錄。
- 測試採用正式 Haversine、20 公尺門檻及 50 公尺 accuracy 上限；未授權、非草稿、無效或停用寶藏請求均拒絕。

Labels: HITL, admin, testing, security, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#8](https://github.com/rstsay/LBTH/issues/8)

