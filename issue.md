# 開發工作清單索引

本索引導向 [功能工作區](./docs/features/lbs-virtual-treasure-hunt/README.md)。產品需求與驗收標準以 [product.md](./product.md) 為準；已移除的離線遊戲、動態搜集門檻及玩家 Mock GPS 需求不得重新加入。

原有 GitHub issue #1–#13 的編號及連結保留在各 issue 文件。原清單未編號的 PWA／管理工作區延伸待辦已整理為本地 issue #14–#18，尚未建立 GitHub issue。

## Feature 分組

### 玩家身份與會話

- [#1 Email Magic Link 與玩家身份](./docs/features/lbs-virtual-treasure-hunt/issues/001-email-magic-link-player-identity.md)（本次登入聚焦測試 27 項通過；實際收信與瀏覽器流程待驗收）
- [#2 單一有效會話與跨裝置恢復](./docs/features/lbs-virtual-treasure-hunt/issues/002-single-session-cross-device-restore.md)（登出前阻擋其他裝置登入已實作；完整測試通過，背景心跳與實機驗收待完成）

### 遊戲管理與寶藏設定

- [#3 多遊戲管理與生命週期](./docs/features/lbs-virtual-treasure-hunt/issues/003-multi-game-lifecycle.md)（聚焦測試 10 項通過；管理員與玩家介面操作待驗收）
- [#4 寶藏資料模型與草稿地圖編輯](./docs/features/lbs-virtual-treasure-hunt/issues/004-treasure-draft-map-management.md)（程式端已實作；驗收待執行）
- [#5 JSON 匯入、驗證與預覽](./docs/features/lbs-virtual-treasure-hunt/issues/005-treasure-json-import.md)（程式端已實作；驗收待執行）

### 玩家尋寶與進度

- [#6 前景定位與固定 20 公尺搜集驗證](./docs/features/lbs-virtual-treasure-hunt/issues/006-foreground-location-20m-collection.md)（已實作；聚焦測試 34 項通過）
- [#7 冪等搜集與伺服器權威進度](./docs/features/lbs-virtual-treasure-hunt/issues/007-idempotent-server-authoritative-collection.md)（已實作；聚焦測試 26 項通過）
- [#9 全站累計前三名與玩家進度](./docs/features/lbs-virtual-treasure-hunt/issues/009-player-progress-leaderboard.md)（已實作；聚焦測試 25 項通過）

### 管理員安全與覆核

- [#8 管理員草稿 Mock GPS 測試](./docs/features/lbs-virtual-treasure-hunt/issues/008-admin-draft-mock-gps.md)（已實作；聚焦測試 18 項通過）
- [#10 異常訊號與雙人審查](./docs/features/lbs-virtual-treasure-hunt/issues/010-anomaly-review-two-admins.md)（程式端已實作；聚焦測試 7 項通過；整體驗收待完成）
- [#11 管理員登入、角色與審計](./docs/features/lbs-virtual-treasure-hunt/issues/011-admin-totp-roles-audit.md)（本次登入聚焦測試 27 項通過；正式郵件與瀏覽器流程待驗收）

### 隱私與營運可靠性

- [#12 資料保留、刪除與帳號刪除](./docs/features/lbs-virtual-treasure-hunt/issues/012-data-retention-deletion.md)（已實作）
- [#13 API 限流與營運可靠性](./docs/features/lbs-virtual-treasure-hunt/issues/013-api-rate-limits-operations.md)（程式端已實作；部署設定待確認）

### 管理工作區 PWA（本地 issue）

- [#14 管理端玩家進度、搜集事件與營運統計](./docs/features/lbs-virtual-treasure-hunt/issues/014-admin-operations-overview.md)（已完成）
- [#15 管理端異常訊號查閱與雙人覆核介面](./docs/features/lbs-virtual-treasure-hunt/issues/015-anomaly-review-workflow-ui.md)（已完成）
- [#16 玩家進度重置申請、雙人確認與還原介面](./docs/features/lbs-virtual-treasure-hunt/issues/016-progress-reset-workflow-ui.md)（已完成）
- [#17 管理員帳號、角色與稽核紀錄介面](./docs/features/lbs-virtual-treasure-hunt/issues/017-admin-account-audit-ui.md)（已完成）
- [#18 玩家帳號刪除與遊戲封存管理介面](./docs/features/lbs-virtual-treasure-hunt/issues/018-account-and-game-retention-ui.md)（已完成）

## 相依關係

- #2 → #1；#4 → #3；#5 → #4；#7 → #6；#9 → #7。
- #8 → #3、#4、#11；#10 → #6、#7、#11；#12 → #11。
- #14 → #3、#7、#11；#15 → #10、#11；#16 → #11；#17 → #11；#18 → #3、#11、#12。
- #13 無工作區內前置 issue。
