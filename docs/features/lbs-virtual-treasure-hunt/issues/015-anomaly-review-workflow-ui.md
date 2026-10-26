**Feature:** 管理工作區 PWA  
**PRD version:** v2.2  
**Source requirement:** 異常覆核介面 — 8.2 異常門檻與處理、10. 管理員需求與審計、13.5 前端與 PWA  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** #10、#11  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)  
**Status:** 已完成；尚無 GitHub issue

# 管理端異常訊號查閱與雙人覆核介面

## User story

身為管理員，我希望查閱異常訊號與相關證據，並由第二位不同管理員完成覆核，以依規格處理疑似異常。

## 範圍

- 查閱異常訊號及相關證據。
- 依產品規格記錄覆核結果。
- 覆核流程要求兩位不同管理員確認。
- 異常訊號不得自動扣分、封鎖或隱藏玩家。

## 不包含

- 異常訊號的產生與伺服器記錄由 #10 追蹤。
- 管理員登入、角色與審計基礎由 #11 追蹤。

## 驗收條件

- [x] 管理員可查閱異常訊號及相關證據。
- [x] 同一管理員不能完成雙人確認的兩個步驟。
- [x] 覆核結果可追溯，且不會自動懲罰玩家。

## 來源

原始 `issue.md`「前端 PWA 與管理工作區延伸」未完成項目；產品需求依 `product.md` 為準。

## Implementation log

- Date: 2026-10-21
- Tests added: 擴充 `tests/anomalies.test.ts` 覆核歷程驗證及 `tests/admin-access.test.js` 角色能力驗證；完整測試套件 94 項通過。
- Key decisions: 異常工作區提供訊號、匿名玩家代碼、遊戲、偵測指標、位置樣本精度與相關搜集事件；管理員可輸入覆核決定及備註。第二階段鎖定第一階段決定，仍由伺服器檢查不同管理員及雙人確認。
- Architectural friction found: 異常清單 API 原先沒有回傳覆核歷程，新增 `reviews` 欄位供介面追溯。介面不呈現證據中的精確座標。
- Follow-up work: #16 玩家進度重置與還原工作流程 UI。

