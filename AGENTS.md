# JasonBox 發布規則

- 每次對話中完成 JasonBox 的網站修改後，將 `app.js` 的 `PAGE_BUILD` 加一，並以台北日期更新 `PAGE_DATE`。
- 同步 `version.json` 的 `build`、`date` 和 `index.html` 內本專案靜態資源的 `?v=` 版次。
- 驗證後提交本次變更並推送至 `origin/main`。確認 GitHub Pages 的 [正式網址](https://schmidtaiwan.github.io/JasonBox/) 已提供同一版次，再回報。若發布失敗，說明原因和目前狀態。
- GitHub 僅發布靜態網站。Google 登入讀取 JasonHome 已上線的共用設定，物品與照片存於 Google Drive 的 JasonBox 資料夾。保留本機設定檔於 Git 忽略清單。
