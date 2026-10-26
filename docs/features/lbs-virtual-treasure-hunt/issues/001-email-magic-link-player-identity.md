**Feature:** 玩家身份與會話  
**PRD version:** v2.2  
**Source requirement:** 玩家身份與會話 — 5. 玩家帳號與會話需求、13.1 帳號與會話  
**Iteration:** 1  
**Type:** AFK  
**Depends on:** 無  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 1. [#1](https://github.com/rstsay/LBTH/issues/1) Email Magic Link 與玩家身份

**User Story**  
身為玩家，我希望以 Email Magic Link 驗證並登入匿名帳號，避免設定密碼也不會僅憑已知 Email 登入他人帳號。

**Scope**
- Email 正規化與唯一性；未信任裝置的 Magic Link 15 分鐘有效、只能使用一次。
- 每個瀏覽器／裝置首次驗證建立玩家 ID（若為新帳號）及匿名代號，並建立持久裝置信任。
- 信任裝置回訪自動登入，不再寄送 Email；登出保留信任，忘記此裝置或清除瀏覽器資料才撤銷。
- 驗證連結在同一瀏覽器完成後，通知原始頁面登入並繼續；驗證頁可關閉時關閉，否則提示返回原頁。
- 不同 Email 建立不同玩家；Email 更換不轉移舊進度。
- 管理員同樣每台裝置首次須完成 Email 確認；信任裝置可直接登入。現階段暫停 TOTP，詳見 #11。

**Acceptance Criteria**
- 未信任裝置未完成 Email 驗證不能登入；信任裝置可自動登入。
- 已使用或過期的 Magic Link 不能再次使用。
- Email 不區分大小寫且去除首尾空白後唯一。
- 原始頁面在同一瀏覽器完成 Email 確認後自動登入；不同裝置的頁面不互相切換登入狀態。

Labels: AFK, auth, backend, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#1](https://github.com/rstsay/LBTH/issues/1)

