"use strict";

function exportItems(scope = current) {
  return entries.filter(entry => entry.level === 4 &&
    (!scope || ancestors(entry).some(parent => parent.id === scope.id)))
    .map(entry => ({ ...entry, location: ancestors(entry).slice(0, -1).map(parent => parent.name).join(" / ") }))
    .sort((a, b) => a.location.localeCompare(b.location, "zh-Hant", { numeric: true }) ||
      a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
}

function exportEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function exportPdf() {
  const items = exportItems();
  if (!items.length) {
    $("mutation-status").textContent = "目前位置及其下層沒有可匯出的物品。";
    return;
  }
  const popup = window.open("", "_blank");
  if (!popup) {
    $("mutation-status").textContent = "請允許開啟新視窗後再匯出。";
    return;
  }
  const title = "收納管家物品清單－" + (current ? ancestors(current).map(entry => entry.name).join("／") : "所有空間");
  popup.document.write("<!doctype html><html lang='zh-Hant'><meta charset='utf-8'><title>" + exportEscape(title) + "</title><body><p>正在準備物品清單與照片…</p></body></html>");
  popup.document.close();
  const urls = [];
  $("export-pdf").disabled = true;
  try {
    // Limit concurrent photo requests while retaining the selected scope as a snapshot.
    for (let offset = 0; offset < items.length; offset += 4) {
      await Promise.all(items.slice(offset, offset + 4).map(async item => {
        if (!item.hasPhoto) return;
        try {
          const blob = item.photo || await drive.photo(item.id);
          item.exportPhoto = URL.createObjectURL(blob);
          urls.push(item.exportPhoto);
        } catch { item.photoFailed = true; }
      }));
      if (popup.closed) return;
    }
    const rows = items.map((item, index) => "<tr><td>" + (index + 1) + "</td><td>" +
      (item.exportPhoto ? "<img alt='' src='" + exportEscape(item.exportPhoto) + "'>" : item.photoFailed ? "照片載入失敗" : "無照片") +
      "</td><td>" + exportEscape(item.name) + "</td><td>" + exportEscape(item.location) +
      "</td><td>" + exportEscape(changeDescription(item)) +
      (photoUploads.has(item.id) ? "<br>尚未完成雲端上傳" : "") + "</td></tr>").join("");
    popup.document.open();
    popup.document.write("<!doctype html><html lang='zh-Hant'><head><meta charset='utf-8'><title>" + exportEscape(title) +
      "</title><style>@page{size:A4 portrait;margin:14mm}body{font-family:system-ui,'Microsoft JhengHei',sans-serif;color:#172c21;font-size:11px}h1{font-size:20px}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #bbb;padding:7px;text-align:left;overflow-wrap:anywhere}th{background:#eef1e9}th:first-child{width:24px}th:nth-child(2){width:72px}img{width:72px;height:72px;object-fit:contain}tr{break-inside:avoid}thead{display:table-header-group}.instructions{padding:12px;background:#eef1e9}button{padding:10px;cursor:pointer}@media print{.instructions{display:none}}</style></head><body><div class='instructions'>請在列印視窗選擇「另存為 PDF」，再選擇儲存路徑。<button id='print'>列印／儲存 PDF</button></div><h1>" +
      exportEscape(title) + "</h1><p>匯出時間：" + exportEscape(formatTime(new Date().toISOString())) + "　共 " + items.length +
      " 件物品</p><table><thead><tr><th>序號</th><th>照片</th><th>物品名稱</th><th>存放位置</th><th>更動時間／帳號</th></tr></thead><tbody>" +
      rows + "</tbody></table></body></html>");
    popup.document.close();
    popup.document.getElementById("print").onclick = () => popup.print();
    await Promise.allSettled(Array.from(popup.document.images, image => image.decode()));
    await popup.document.fonts.ready;
    if (!popup.closed) { popup.focus(); popup.print(); }
  } catch (error) {
    $("mutation-status").textContent = "匯出失敗：" + error.message + "，請重試。";
  } finally {
    $("export-pdf").disabled = false;
    if (popup.closed) urls.forEach(url => URL.revokeObjectURL(url));
    else popup.addEventListener("unload", () => urls.forEach(url => URL.revokeObjectURL(url)), { once: true });
  }
}
