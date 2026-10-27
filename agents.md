# Project guidance

- Before implementing an ambiguous feature, change, or migration, use the `grill-me` skill to clarify requirements.
- Do not begin implementation until the requirements have been confirmed with the user.
- Follow all applicable skills when their workflow matches the task.
- 程式碼註解、介面文案、文件及對話回應使用繁體中文。
- for implementation phase, security related concerns always require my approval, otherwise just go ahead

# LBS 虛擬尋寶 PWA 專案指引

## 規格優先順序
- `product.md` 是產品需求與驗收標準的權威文件；`proposal.md` 說明已確認的方案與系統邊界；`issue.md` 是實作工作清單。
- 文件衝突時，以 `product.md` 中最新確認的需求為準，並同步修正其他文件；不得恢復已移除的舊需求。

## 不可違反的技術規則
- 搜集門檻固定為 20 公尺，使用共用常量 `COLLECTION_THRESHOLD_METERS = 20`；不得依 GPS accuracy 擴大門檻。
- 所有經緯度距離一律使用標準 Haversine 演算法，地球半徑為 6,371,000 公尺；禁止平面勾股近似。
- 前端、後端、管理員測試與測試案例使用相同距離公式、半徑及比較精度；距離以未捨入值與 20 公尺比較，捨入僅供顯示。
- accuracy 大於 50 公尺時不得搜集，須提示玩家改善定位；accuracy 不得改變 20 公尺距離門檻。
- Google Maps API Key 透過 `.env` 環境變數管理，不得硬編碼或提交至 Git；設定 referrer 限制、用量上限及費用警示。

## 定位、搜集與權威資料
- 玩家一律使用前景 Real GPS；玩家端不得提供 Real／Mock 切換。背景時停止定位及回報，不自動暫停遊戲。
- 正式玩家 API 拒絕明確標記為 Mock 的請求。管理員只可在未發布草稿遊戲的隔離測試介面使用 Mock GPS；不得建立正式搜集紀錄或影響排行榜。
- 伺服器是位置驗證、遊戲狀態、寶藏狀態、搜集結果、進度及排行榜的唯一權威來源。前端可顯示「可搜集」，伺服器仍可拒絕。
- 每次成功搜集即時寫入伺服器；以玩家、遊戲及寶藏的唯一性／冪等控制防止重複計分。LocalStorage 僅供即時本機狀態快取及還原，不得作為權威來源。不得支援離線遊戲或離線搜集佇列。
- 同一 Email 只允許一個有效會話；新登入立即使舊會話失效。跨裝置恢復只使用伺服器進度，不恢復舊定位快照。

## 多場遊戲與資料聯動
- 管理員可建立並發布多場遊戲；玩家從已發布清單選擇，但同一時間只能進行一場遊戲。切換前須暫停目前遊戲；各遊戲進度分開保存。
- 已發布遊戲的內容鎖定；允許緊急停用寶藏、暫停或提前結束，不允許修改已發布寶藏座標及半徑。
- 草稿寶藏新增、修改、刪除須同步更新地圖 Marker／InfoWindow、目標數、伺服器資料及本機快取。
- HUD 顯示目前遊戲名稱、該場目標數及已搜集數；主選單顯示跨遊戲歷史累計與前三名排行榜。
- 全站排行榜依跨遊戲有效搜集數排序，只顯示前三名；隱藏榜單設定只影響公開榜單，不影響個人資料。
- 遊戲、玩家進度、累計數與完成場數的更新必須一致；進度重置、遊戲永久刪除及帳號刪除須按產品規格同步調整排行統計。

## 安全、審計與資料保留
- 管理員使用 Email Magic Link 與 TOTP；重置玩家進度及異常審查須兩位不同管理員確認。
- 異常訊號只供記錄與人工覆核，不自動扣分、封鎖或隱藏玩家；門檻依 `product.md`。
- 管理員操作與敏感資料查詢均須審計；日常變更可透過軟刪除或更正紀錄復原。永久刪除及期限屆滿的清除不可復原。
- 位置軌跡於玩家暫停或退出後保留 24 小時；搜集／異常事件於遊戲停止接受遊玩後保留 30 天；遊戲資料結束後封存 7 天；審計紀錄至少保留 90 天。
- 搜集事件不得保存玩家精確座標；事件保留期與遊戲內容刪除期分開執行，必要留存資料須去識別化。
