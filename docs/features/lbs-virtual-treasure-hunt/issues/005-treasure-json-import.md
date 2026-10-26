**Feature:** 遊戲管理與寶藏設定  
**PRD version:** v2.2  
**Status:** 程式端已實作；驗收待執行（本次靜態檢視，未執行測試）  
**Source requirement:** 寶藏 JSON 匯入 — 6.2 JSON 匯入契約  
**Iteration:** 1  
**Type:** HITL  
**Depends on:** #4  
**Part of:** [LBS 虛擬尋寶 PWA](../02-prd.md)

## 5. [#5](https://github.com/rstsay/LBTH/issues/5) JSON 匯入、驗證與預覽

**User Story**  
身為管理員，我希望上傳 JSON、預覽寶藏並取得逐列錯誤，以降低發布錯誤座標的風險。

**Scope**
- `schemaVersion: 1` 與 `treasures` 格式；欄位、預設值、座標範圍及重複座標規則依 `product.md`。
- 最多 500 筆；匯入前地圖預覽。
- 全部有效才匯入或跳過錯誤列；有效資料以單一交易匯入。
- 匯入錯誤回報列號、欄位、錯誤碼與原因。

**Acceptance Criteria**
- 缺必填欄位、錯誤型別、非法座標、重複精確座標及超過上限均可辨識。
- 全部有效模式遇錯誤不匯入任何列。
- 跳過錯誤模式只原子化匯入有效列。
- 匯入後仍為草稿，需再次確認才能發布。

**API 端點（初版）**
- `POST /admin/games/:gameId/treasures/import/preview`：輸入 PRD 定義的 JSON，不寫入資料；回傳正規化預覽、有效列數與錯誤清單。
- `POST /admin/games/:gameId/treasures/import/commit`：輸入同一 JSON 及 `mode`（`all_or_nothing` 或 `skip_invalid`），交易成功後回傳伺服器產生的 ID、匯入數、啟用目標數與逐列錯誤。
- 錯誤格式為 `{ row, field, code, reason }`；資料列從 1 開始，全域格式／版本／容量錯誤使用 `row: 0`（實際單場容量超限則標註超限列）。
- 匯入同時檢查該遊戲既有寶藏，重複座標依小數點後 6 位判定；單場含既有資料最多 500 筆。

Labels: HITL, admin, import, validation, P0

## 範圍界線

**不包含：** 本 issue 以外的工作由相依或同功能工作區的其他 issue 追蹤。

## 驗收

- [ ] 完成上方驗收條件；相關 API、權限與錯誤情境符合產品需求文件。

**原始 GitHub issue：** [#5](https://github.com/rstsay/LBTH/issues/5)

## Implementation log

- 日期：2026-10-22
- 測試：依工作區指示，未新增或執行測試。
- 實作：API 驗證格式、各列資料、重複座標及單場容量；預覽不寫入資料，兩種匯入模式都以交易處理。管理介面顯示逐列錯誤，並在草稿地圖以橘色標記及模糊範圍圓預覽有效資料。
- 後續：驗收預覽、全部有效才匯入、跳過錯誤列及容量限制。

