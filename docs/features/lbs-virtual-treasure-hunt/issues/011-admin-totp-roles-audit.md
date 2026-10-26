**Feature:** 管理員安全與覆核  
**PRD version:** v2.2  
**Source requirement:** 管理員 TOTP、角色與審計 — 2. 角色與權限、10. 管理員需求與審計、11.1 安全與 API 保護  
**Iteration:** 1  
**Status:** 已改為每台裝置首次 Email 確認及信任裝置登入；暫停 TOTP；驗收待執行  
**Type:** HITL  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 11. [#11](https://github.com/rstsay/LBTH/issues/11) 管理員 TOTP、角色與審計

**User Story**  
身為系統管理者，我希望保護管理功能並能追查敏感操作。

**Scope**
- 管理員每台裝置首次使用 Magic Link 確認，之後由信任裝置登入；現階段暫停 TOTP。保留 TOTP 資料及程式，供日後重新啟用時使用。
- 管理員建立、停用及撤銷。
- 管理員寫入操作及敏感資料查詢審計。
- 一般變更可復原；永久刪除明確確認且不可復原。

**Acceptance Criteria**
- 未信任裝置未完成 Email 確認不得登入；完成一次確認後該裝置可直接登入，不要求 TOTP。
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
- `web/` 已提供管理員 Magic Link 確認、信任裝置登入與遊戲草稿工作區；TOTP 設定及驗證 API 保留但目前登入流程不要求 TOTP。異常審查、雙人確認、稽核紀錄及管理員帳號管理 UI 尚待完成，見「前端 PWA 與管理工作區延伸」。

Labels: HITL, admin, auth, security, audit, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#11](https://github.com/rstsay/LBTH/issues/11)

## Implementation log

- 日期：2026-10-22
- 修正：管理員首次在每台裝置以 Email Magic Link 確認並建立信任；信任裝置可直接登入。暫停登入時的 TOTP 要求並保留 TOTP 資料；TOTP 加密金鑰不再是伺服器啟動必填設定。
- 測試：依工作區指示，未新增或執行測試。
- 後續：以新裝置首次確認及已信任裝置回訪實際驗收。

