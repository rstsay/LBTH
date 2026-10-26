**Feature:** 管理工作區 PWA  
**PRD version:** v2.2  
**Source requirement:** 管理員帳號與審計管理 — 2. 角色與權限、10. 管理員需求與審計、13.5 前端與 PWA  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** #11  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)  
**Status:** Complete

# 管理員帳號、角色與稽核紀錄介面

## User story

身為具備相應權限的管理員，我希望管理管理員帳號與角色並查閱稽核紀錄，以維持管理作業的責任分工與可追溯性。

## 範圍

- 管理員帳號及角色管理介面。
- 稽核紀錄查詢介面。
- 操作遵循後端授權與稽核規則。

## 不包含

- 管理員登入、TOTP、角色授權及審計 API 由 #11 追蹤。

## 驗收條件

- [x] 授權管理員可執行產品規格允許的帳號與角色管理。
- [x] 管理員可依權限查閱稽核紀錄。
- [x] 權限不足時拒絕操作，敏感查詢與變更均留有審計紀錄。

## 來源

原始 `issue.md`「前端 PWA 與管理工作區延伸」未完成項目；產品需求依 `product.md` 為準。

## Implementation log

- Date: 2026-10-21
- Tests added: `tests/admin-auth.test.ts`、`tests/admin-access.test.js`；完整測試套件 94 項通過。
- Key decisions: 新增只回傳目前管理員角色的 `/admin/auth/me`；管理員帳號只對 owner 顯示，稽核紀錄對 owner／auditor 顯示，後端授權仍負責拒絕越權請求。
- Architectural friction found: 前端原先沒有目前管理員角色資訊，因此新增受管理員驗證保護的角色端點；auditor 僅可讀取自身角色、異常查閱與稽核紀錄。
- Follow-up work: 無。



