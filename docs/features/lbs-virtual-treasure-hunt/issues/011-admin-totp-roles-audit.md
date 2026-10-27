**Feature:** 管理員安全與覆核  
**PRD version:** v2.2  
**Source requirement:** 管理員 TOTP、角色與審計 — 2. 角色與權限、10. 管理員需求與審計、11.1 安全與 API 保護  
**Iteration:** 1  
**Status:** 跨裝置核准與登入交付已實作；本次登入聚焦測試 27 項通過；實際收信流程待驗收<br>
**Type:** HITL  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 11. [#11](https://github.com/rstsay/LBTH/issues/11) 管理員 TOTP、角色與審計

**User Story**  
身為系統管理者，我希望保護管理功能並能追查敏感操作。

**Scope**
- 管理員新裝置以 Magic Link 核准原申請裝置，會話只交付給申請裝置；登入頁提供預設勾選的「之後信任此裝置繼續」，取消時只建立目前工作階段。現階段暫停 TOTP，保留資料及程式供日後重新啟用。
- 管理員建立、停用及撤銷。
- 管理員寫入操作及敏感資料查詢審計。
- 一般變更可復原；永久刪除明確確認且不可復原。

**Acceptance Criteria**
- 未信任裝置未獲 Email 核准不得登入；信件裝置不取得管理 Cookie，原申請裝置核准後登入。完成一次確認後該裝置可直接登入，不要求 TOTP。
- 管理員登入頁顯示預設勾選的「之後信任此裝置繼續」；取消時登出後需再次以 Email 核准。
- 每筆敏感操作記錄操作者、時間、對象、結果與必要變更摘要。
- 審計紀錄不含不必要的 Email 或精確座標，至少保留 90 天。
- 管理員每台裝置首次登入必須完成 Email Magic Link 確認；該裝置後續可免 Email 確認登入。現階段暫停 TOTP，不刪除既有加密設定。停用管理員後，既有管理員工作階段立即失效。
- 管理員可建立、調整角色、停用及撤銷其他管理員；資料庫角色限制管理功能，且不可停用或降級最後一位系統管理員。
- `DELETE` 遊戲或草稿寶藏時必須送出 `confirmPermanentDeletion: true`；管理員帳號撤銷採停用並保留稽核紀錄。

**API 與部署設定**
- `POST /admin/auth/magic-links`、`POST /admin/auth/verify`、`POST /admin/auth/device-login` 與 `POST /admin/auth/logout`；TOTP 設定／驗證端點保留供日後恢復使用。
- `GET/POST /admin/administrators`、`PATCH/DELETE /admin/administrators/:adminId`；角色為 `owner`、`admin` 或唯讀 `auditor`，只有 `owner` 可管理帳號。
- `GET /admin/audit-logs` 查詢最近 90 天內的不可變更稽核紀錄；稽核摘要只保留安全欄位及變更欄位名稱，不保存請求 Email 或座標值。
- 伺服器須設定 `ADMIN_BOOTSTRAP_EMAIL`。只有日後恢復 TOTP 時才須設定至少 32 位元組的 `ADMIN_TOTP_ENCRYPTION_KEY`；既有 TOTP 秘密仍以 AES-256-GCM 加密儲存。
- `web/` 已提供管理員 Magic Link 確認、信任裝置登入與遊戲草稿工作區；TOTP 設定及驗證 API 保留但目前登入流程不要求 TOTP。異常審查及雙人確認介面見已完成的本地 issue [#15](./015-anomaly-review-workflow-ui.md)，進度重置介面見 [#16](./016-progress-reset-workflow-ui.md)，管理員帳號與稽核介面見 [#17](./017-admin-account-audit-ui.md)。

Labels: HITL, admin, auth, security, audit, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#11](https://github.com/rstsay/LBTH/issues/11)

## Implementation log

- 2026-10-27：管理員 Magic Link 改為只核准原申請裝置；信件端不取得管理員工作階段，原申請頁核准後自動進入管理模式。

- 日期：2026-10-22
- 修正：管理員首次在每台裝置以 Email Magic Link 確認並建立信任；信任裝置可直接登入。暫停登入時的 TOTP 要求並保留 TOTP 資料；TOTP 加密金鑰不再是伺服器啟動必填設定。
- 測試：依工作區指示，未新增或執行測試。
- 後續：以新裝置首次確認及已信任裝置回訪實際驗收。
- 2026-10-26：移除與目前需求衝突的 TOTP 登入測試，改驗證首次 Magic Link 建立工作階段及信任憑證、信任裝置免收信登入，以及既有角色與稽核控制。`npm test -- tests/admin-auth.test.ts tests/admin-access.test.js` 共 6 項通過；未修改正式登入程式。
- 2026-10-27：管理員 Email 確認成功後導回管理工作區，並通知同瀏覽器的原登入頁切換至管理模式；登入相關回歸測試共 22 項通過，正式瀏覽器流程仍待驗收。

## 修訂紀錄

| 日期 | PRD 版本 | 修訂內容 | 原因 |
|---|---|---|---|
| 2026-10-26 | v2.2 | 將過時的介面待辦敘述改為已完成 issue 連結 | 使本 issue 與已完成的本地 issue #15–#17 一致 |
| 2026-10-26 | v2.2 | 將舊 TOTP 測試改為逐裝置信任登入測試 | 符合已確認的暫停 TOTP 決策 |
| 2026-10-27 | v2.2 | 確認成功後導回管理工作區並通知原登入頁 | 修正管理員 Magic Link 確認後不接續登入的問題 |

