"use strict";

const labels = ["樓層", "空間", "櫃子", "分類箱", "物品"];
const PAGE_BUILD = 13;
const PAGE_DATE = "2026-11-19";
const $ = id => document.getElementById(id);
const editor = $("editor");
const updateDialog = $("update-dialog");
let displayMode = "details";
try { if (localStorage.getItem("jasonbox-display-mode") === "list") displayMode = "list"; } catch {}
function setDisplayMode(mode) {
  displayMode = mode;
  try { localStorage.setItem("jasonbox-display-mode", mode); } catch {}
  render();
}
$("view-list").onclick = () => setDisplayMode("list");
$("view-details").onclick = () => setDisplayMode("details");
let entries = [];
let current = null;
let draft;
let objectUrls = [];
let previewUrl;
let photoVersion = 0;
let saving = false;
let pendingUpdate;
let checkingUpdate = false;

function showUpdatePrompt() {
  if (!pendingUpdate || editor.open || updateDialog.open) return;
  const { build, date } = pendingUpdate;
  $("update-version").textContent = "目前版次 " + PAGE_BUILD + " → 線上版次 " + build +
    (date ? " (" + date + ")" : "");
  updateDialog.showModal();
}

async function checkForUpdate() {
  if (checkingUpdate || window.location.protocol === "file:") return;
  checkingUpdate = true;
  try {
    const response = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    if (!response.ok) return;
    const version = await response.json();
    if (Number.isSafeInteger(version.build) && version.build > (pendingUpdate?.build ?? PAGE_BUILD)) {
      pendingUpdate = version;
      showUpdatePrompt();
    }
  } catch {
    // A failed check leaves the current page available.
  } finally {
    checkingUpdate = false;
  }
}

const thumbnails = new IntersectionObserver(changes => {
  for (const change of changes) {
    if (!change.isIntersecting) continue;
    const placeholder = change.target;
    thumbnails.unobserve(placeholder);
    drive.photo(placeholder.dataset.id).then(blob => {
      if (!placeholder.isConnected) return;
      const img = element("img", "", "thumb");
      img.alt = "";
      img.src = URL.createObjectURL(blob);
      placeholder.replaceWith(img);
      objectUrls.push(img.src);
    }).catch(() => {});
  }
});

async function refresh() {
  entries = await drive.readEntries();
  for (let floor = 1; floor <= 4; floor++) {
    const existing = entries.find(entry => entry.level === 0 && floorNumber(entry.name) === floor);
    if (!existing) entries.push(await drive.save({ name: floor + "F", level: 0, parent: null }));
  }
  if (current) current = entries.find(entry => entry.id === current.id) ?? null;
  render();
}

function floorNumber(name) {
  const match = name.trim().match(/^(?:([1-4])\s*(?:f|樓|層)|([一二三四])樓)$/i);
  return match ? Number(match[1] || "一二三四".indexOf(match[2]) + 1) : null;
}

function ancestors(entry) {
  const path = [];
  while (entry) {
    path.unshift(entry);
    entry = entries.find(parent => parent.id === entry.parent);
  }
  return path;
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function button(content, className, action) {
  const node = element("button", content, className);
  node.type = "button";
  node.onclick = action;
  return node;
}

function navigate(entry) {
  if (adjustingSave) return;
  planAdjustment = null;
  current = entry;
  $("search").value = "";
  render();
  window.scrollTo(0, 0);
}

function photoListCard(entry) {
  const section = element("section", "", "photo-list-section");
  const heading = element("div", "", "photo-list-heading");
  heading.append(button(entry.name, "quiet", () => entry.level === 4 ? edit(entry) : navigate(entry)));
  if (entry.level !== 4 && entry.level !== 0) heading.append(button("編輯", "quiet", () => edit(entry)));
  section.append(heading);
  const items = entry.level === 4 ? [entry] : entries.filter(item =>
    item.level === 4 && ancestors(item).some(parent => parent.id === entry.id));
  const gallery = element("div", "", "photo-list-gallery");
  for (const item of items) {
    const tile = button("", "photo-list-item", () => edit(item));
    tile.setAttribute("aria-label", "編輯物品：" + item.name);
    const photo = element("span", "尚無照片", "thumb");
    if (item.hasPhoto) {
      photo.dataset.id = item.id;
      thumbnails.observe(photo);
    }
    tile.append(photo, element("span", item.name, "photo-list-name"));
    gallery.append(tile);
  }
  if (!items.length) gallery.append(element("p", "這個空間還沒有物品。", "muted"));
  section.append(gallery);
  return section;
}

function card(entry, searching) {
  if (displayMode === "list") return photoListCard(entry);
  const row = element("div", "", "card");
  const isItem = entry.level === 4;
  const open = button("", "card-main", () => isItem ? edit(entry) : navigate(entry));
  const children = entries.filter(child => child.parent === entry.id);
  const path = ancestors(entry).slice(0, -1).map(parent => parent.name).join(" / ");
  const description = element("span", "");
  description.append(element("strong", entry.name));
  if (searching && path) description.append(element("small", path));
  else if (!isItem) description.append(element("small",
    children.filter(child => child.level === 4).length + " 件物品 · " + children.filter(child => child.level !== 4).length + " 個空間"));
  const thumb = element("span", labels[entry.level], "thumb");
  const arrow = element("span", "›");
  arrow.setAttribute("aria-hidden", "true");
  open.append(thumb, description, arrow);
  if (entry.hasPhoto && displayMode === "details") {
    thumb.dataset.id = entry.id;
    thumbnails.observe(thumb);
  }
  description.append(element("small", "更動：" + formatTime(entry.updatedAt), "changed-time"));
  row.append(open);
  if (!isItem && entry.level !== 0) {
    const editButton = button("編輯", "quiet", () => edit(entry));
    editButton.setAttribute("aria-label", "編輯 " + entry.name);
    row.append(editButton);
  }
  return row;
}

function render() {
  $("list").className = displayMode === "list" ? "compact-list" : "";
  $("view-list").setAttribute("aria-pressed", String(displayMode === "list"));
  $("view-details").setAttribute("aria-pressed", String(displayMode === "details"));
  thumbnails.disconnect();
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = [];
  const depth = current ? current.level + 1 : 0;
  const query = $("search").value.trim().toLocaleLowerCase();
  const visible = query
    ? entries.filter(entry => entry.level >= 1 && entry.name.toLocaleLowerCase().includes(query))
    : current ? entries.filter(entry => entry.parent === current.id)
    : entries.filter(entry => entry.level !== 0 && entry.level !== 4 && entries.find(parent => parent.id === entry.parent)?.level === 0);
  renderFloorPlans(query);
  const path = $("path");
  path.replaceChildren();
  for (const entry of [null, ...ancestors(current)]) {
    if (path.childElementCount) {
      const divider = element("span", "/");
      divider.setAttribute("aria-hidden", "true");
      path.append(divider);
    }
    const link = button(entry?.name ?? "所有空間", "", () => navigate(entry));
    if (entry === current) link.setAttribute("aria-current", "location");
    path.append(link);
  }
  $("page-title").textContent = current?.name ?? "我的收納";
  $("summary").textContent = current
    ? (current.level === 0 ? "點平面圖新增存放空間" : "更動：" + formatTime(current.updatedAt))
    : "固定四層樓　·　" +
      entries.filter(entry => entry.level === 4).length + " 件物品";
  $("list-title").textContent = query ? "搜尋結果" : !current || current.level === 0 ? "存放空間" : "存放物品";
  $("count").textContent = visible.length + (depth === 4 && !query ? " 件" : " 筆");
  $("add").textContent = "＋ 新增存放物品";
  $("add").hidden = !current || current.level === 0 || Boolean(query);
  document.querySelector("footer").hidden = $("add").hidden;
  $("edit-space").hidden = !current || current.level === 0;
  $("edit-space").onclick = () => edit(current);
  $("list").replaceChildren(...visible.map(entry => card(entry, Boolean(query))));
  if (!visible.length) {
    const message = query ? "找不到符合的空間或物品。" : !current || current.level === 0
      ? "直接點平面圖上的位置，建立櫃子、床底下等存放空間。"
      : "這裡還沒有物品，可新增照片或填寫物品名稱。";
    $("list").append(element("p", message, "empty"));
  }
}

function edit(entry, placement) {
  if (entry?.level === 0 || (!entry && !current && !placement)) return;
  if (!entry && !placement && current?.level === 0) return;
  draft = entry ? { ...entry } : placement ? { ...placement } : { level: 4, parent: current.id };
  const label = draft.level === 4 ? "物品" : "存放空間";
  $("form").reset();
  $("form-status").textContent = "";
  $("editor-title").textContent = (entry ? "編輯" : "新增") + label;
  $("location").textContent = ancestors(entries.find(parent => parent.id === draft.parent))
    .map(parent => parent.name).join(" / ");
  $("name").value = draft.name ?? "";
  $("name").required = draft.level !== 4;
  $("name").placeholder = draft.level === 4 ? "例如 羊毛圍巾（有照片時可不填）" : "例如 櫃子、床底下";
  $("entry-time").textContent = entry ? "建立：" + formatTime(entry.createdAt) + "；更動：" + formatTime(entry.updatedAt) : "儲存時自動記錄建立與更動時間（台北）";
  $("remove").hidden = !entry;
  $("photos").hidden = draft.level !== 4;
  busy(false);
  showPhoto();
  editor.showModal();
  if (entry?.hasPhoto) {
    const version = ++photoVersion;
    $("form-status").textContent = "正在載入照片…";
    drive.photo(entry.id).then(blob => {
      if (version !== photoVersion || !editor.open) return;
      showPhoto(blob);
      $("form-status").textContent = "";
    }).catch(error => {
      if (version === photoVersion && editor.open) showError(error);
    });
  }
}

function busy(value) {
  $("save").disabled = value;
  $("remove").disabled = value;
}

async function compress(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1440 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Image encoding failed")), "image/jpeg", .83);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pickPhoto(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const version = ++photoVersion;
  busy(true);
  $("form-status").textContent = "正在處理照片…";
  try {
    const photo = await compress(file);
    if (version !== photoVersion) return;
    draft.photo = photo;
    showPhoto();
    $("form-status").textContent = "";
  } catch {
    if (version === photoVersion) $("form-status").textContent = "無法讀取這張照片，請試用 JPG 或 PNG。";
  } finally {
    if (version === photoVersion) busy(false);
  }
}

$("camera").onchange = pickPhoto;
$("gallery").onchange = pickPhoto;
$("remove-photo").onclick = () => {
  photoVersion++;
  delete draft.photo;
  draft.photoRemoved = true;
  $("form-status").textContent = "";
  busy(false);
  showPhoto();
};
$("search").oninput = render;
$("add").onclick = () => edit();
$("close").onclick = () => { if (!saving) closeEditor(); };
editor.oncancel = event => {
  event.preventDefault();
  if (!saving) closeEditor();
};
function closeEditor() {
  editor.close();
  photoVersion++;
  draft = undefined;
  showPhoto();
  showUpdatePrompt();
}
$("form").onsubmit = async event => {
  event.preventDefault();
  if ($("save").disabled || !draft || draft.level === 0) return;
  let name = $("name").value.trim();
  if (!name && draft.level === 4 && (draft.photo || (draft.hasPhoto && !draft.photoRemoved))) name = "物品照片 " + formatTime(new Date().toISOString());
  if (!name) {
    $("form-status").textContent = "請輸入名稱。";
    $("name").focus();
    return;
  }
  const record = { ...draft, name };
  saving = true;
  busy(true);
  $("form-status").textContent = "正在儲存到 Google Drive…";
  try {
    const saved = await drive.save(record);
    entries = [...entries.filter(entry => entry.id !== saved.id), saved];
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
    if (current?.id === saved.id) current = saved;
    await touchParent(saved.parent);
    closeEditor();
    render();
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    busy(false);
  }
};
$("remove").onclick = async () => {
  if (!draft || draft.level === 0) return;
  if (entries.some(entry => entry.parent === draft.id)) {
    $("form-status").textContent = "請先清空這個位置的清單，再刪除。";
    return;
  }
  if (!window.confirm("確定要刪除「" + draft.name + "」？")) return;
  const entry = draft;
  saving = true;
  busy(true);
  try {
    await drive.remove(entry);
    entries = entries.filter(item => item.id !== entry.id);
    if (current?.id === entry.id) current = entries.find(item => item.id === entry.parent) ?? null;
    await touchParent(entry.parent);
    closeEditor();
    render();
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    busy(false);
  }
};

async function touchParent(id) {
  const parent = entries.find(entry => entry.id === id);
  if (!parent || parent.level === 0) return;
  try {
    const updated = await drive.touch(parent);
    entries = entries.map(entry => entry.id === id ? updated : entry);
    if (current?.id === id) current = updated;
  } catch {
    $("mutation-status").textContent = "物品變更已儲存，但存放空間的更動時間更新失敗，請重新整理確認。";
  }
}

function showPhoto(blob = draft?.photo) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : undefined;
  $("preview").hidden = !previewUrl;
  $("remove-photo").hidden = !blob && !(draft?.hasPhoto && !draft.photoRemoved);
  if (previewUrl) $("preview").src = previewUrl;
  else $("preview").removeAttribute("src");
}

let quotaGeneration = 0;

function formatStorage(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = value ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return (value / 1024 ** index).toLocaleString("zh-TW", { maximumFractionDigits: 2 }) + " " + units[index];
}

async function refreshQuota() {
  const generation = ++quotaGeneration;
  $("drive-quota").textContent = "雲端硬碟容量：讀取中…";
  $("retry-quota").hidden = true;
  try {
    const quota = await drive.quota();
    if (generation !== quotaGeneration) return;
    const limit = Number(quota.limit);
    $("drive-quota").textContent = "雲端容量：已用 " + formatStorage(quota.usage) +
      (Number.isFinite(limit) && limit > 0 ? "／" + formatStorage(limit) + "，剩餘 " + formatStorage(Math.max(0, limit - Number(quota.usage))) : "（未提供容量上限）");
    $("drive-quota").title = "目前登入帳號的 Google 儲存空間，包含雲端硬碟、Gmail 與 Google 相簿。";
  } catch {
    if (generation !== quotaGeneration) return;
    $("drive-quota").textContent = "雲端硬碟容量：讀取失敗";
    $("retry-quota").hidden = false;
  }
}

function setSignedIn(signedIn) {
  document.querySelector("main").hidden = !signedIn;
  document.querySelector("footer").hidden = !signedIn || $("add").hidden;
  $("gate").hidden = signedIn;
  $("logout").hidden = !signedIn;
  $("add").disabled = !signedIn;
  $("header-storage").hidden = !signedIn;
  $("account-menu").hidden = !signedIn;
  $("account-menu").open = false;
  quotaGeneration++;
  $("drive-quota").textContent = "";
  $("account-email").textContent = "";
  const avatar = $("account-avatar");
  avatar.hidden = true;
  avatar.removeAttribute("src");
  $("avatar-fallback").hidden = false;
  if (signedIn) {
    const account = drive.account();
    $("account-email").textContent = account.email;
    $("account-toggle").setAttribute("aria-label", "登入帳號：" + account.email);
    $("account-toggle").title = account.email;
    $("avatar-fallback").textContent = Array.from(account.name || account.email || "G")[0].toUpperCase();
    if (account.picture && /^https:\/\//i.test(account.picture)) {
      avatar.src = account.picture;
      avatar.hidden = false;
      $("avatar-fallback").hidden = true;
    }
    void refreshQuota();
  }
}

$("retry-quota").onclick = refreshQuota;
$("account-avatar").onerror = () => {
  $("account-avatar").hidden = true;
  $("avatar-fallback").hidden = false;
};

function signOut(message = "") {
  if (editor.open) closeEditor();
  drive.logout();
  entries = [];
  navigate(null);
  setSignedIn(false);
  $("login-status").textContent = message;
}

function showError(error) {
  if (error instanceof drive.SessionExpired) signOut(error.message);
  else $("form-status").textContent = error.message;
}

$("login").onclick = async () => {
  const sharedConfig = window.GOOGLE_CONFIG;
  const clientId = sharedConfig?.clientId?.trim();
  const owner = sharedConfig?.preferredEmail?.trim().toLowerCase();
  if (!clientId || !owner) {
    $("login-status").textContent = "無法載入 JasonHome 的 Google 登入設定，請重新整理後再試。";
    return;
  }
  $("login").disabled = true;
  $("login-status").textContent = "正在連接 Google Drive…";
  try {
    await drive.login({ clientId, owner });
    await refresh();
    setSignedIn(true);
  } catch (error) {
    signOut(error.message);
  } finally {
    $("login").disabled = false;
  }
};
$("logout").onclick = () => signOut();

$("page-version").textContent = "版次 " + PAGE_BUILD + " (" + PAGE_DATE + ")";
updateDialog.oncancel = event => event.preventDefault();
$("update-reload").onclick = () => {
  const url = new URL(window.location.href);
  url.searchParams.set("_v", String(Date.now()));
  window.location.replace(url.href);
};
window.addEventListener("focus", checkForUpdate);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkForUpdate();
});
setInterval(checkForUpdate, 60000);
void checkForUpdate();

if (window.location.protocol === "file:") {
  $("login").disabled = true;
  const link = element("a", "http://localhost:8000/");
  link.href = "http://localhost:8000/";
  $("login-status").append("請先執行 preview.cmd，再開啟 ", link, " 以登入 Google。");
}
