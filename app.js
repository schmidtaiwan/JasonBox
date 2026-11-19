"use strict";

const labels = ["樓層", "空間", "櫃子", "分類箱", "物品"];
const PAGE_BUILD = 28;
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
let signedIn = false;
let navigationHistory = [];
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
  entries = (await drive.readEntries()).filter(entry => !photoUploads.has(entry.id));
  entries.push(...Array.from(photoUploads.values(), job => job.local));
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

function navigate(entry, remember = true) {
  if (adjustingSave) return;
  planAdjustment = null;
  if (remember && current?.id !== entry?.id) navigationHistory.push({ id: current?.id ?? null, x: window.scrollX, y: window.scrollY, query: $("search").value });
  current = entry;
  $("search").value = "";
  render();
  window.scrollTo(0, 0);
}

const photoUploads = new Map();
let uploadSequence = 0;

function uploadStatus(entry) {
  const job = photoUploads.get(entry.id);
  return job ? job.failed ? "上傳失敗，按此重試" : "背景上傳中…" : "";
}

function openItem(entry) {
  const job = photoUploads.get(entry.id);
  if (job) {
    if (job.failed) void sendPhotoUpload(job);
    return;
  }
  edit(entry);
}

function displayThumbnail(placeholder, entry) {
  if (entry.photo) {
    const img = element("img", "", "thumb");
    img.alt = "";
    img.src = URL.createObjectURL(entry.photo);
    objectUrls.push(img.src);
    placeholder.replaceWith(img);
  } else if (entry.hasPhoto) {
    placeholder.dataset.id = entry.photoId || entry.id;
    thumbnails.observe(placeholder);
  }
}

function queueSelectedPhotos(record, name) {
  const photos = record.photos || [{ photo: record.photo }];
  for (const [index, item] of photos.entries()) {
    const { photos: unused, ...single } = record;
    single.photo = item.photo;
    single.name = photos.length === 1 ? record.name : name ? name + " " + (index + 1) : item.name || record.name + " " + (index + 1);
    queuePhotoUpload(single);
  }
}

function queuePhotoUpload(record) {
  const id = record.id || "pending-photo-" + ++uploadSequence;
  const local = { ...record, id, hasPhoto: true, updatedAt: new Date().toISOString(),
    createdAt: record.createdAt || new Date().toISOString() };
  const job = { id, record, local, failed: false, running: false };
  photoUploads.set(id, job);
  entries = entries.filter(entry => entry.id !== id).concat(local);
  if (current?.id === id) current = local;
  closeEditor();
  render();
  void sendPhotoUpload(job);
}

async function sendPhotoUpload(job) {
  if (job.running) return;
  job.running = true;
  job.failed = false;
  render();
  try {
    const saved = await drive.save(job.record);
    entries = entries.filter(entry => entry.id !== job.id).concat(saved);
    photoUploads.delete(job.id);
    if (current?.id === job.id) current = saved;
    await touchParent(saved.parent);
  } catch (error) {
    job.failed = true;
    $("mutation-status").textContent = "照片尚未上傳：" + error.message + "。點選失敗的物品可重試。";
  } finally {
    job.running = false;
    render();
  }
}

window.addEventListener("beforeunload", event => {
  if (photoUploads.size) { event.preventDefault(); event.returnValue = ""; }
});

function photoListCard(entry) {
  const section = element("section", "", "photo-list-section");
  const heading = element("div", "", "photo-list-heading");
  heading.append(button(entry.name, "quiet", () => entry.level === 4 ? openItem(entry) : navigate(entry)));
  if (entry.level !== 4 && entry.level !== 0) heading.append(button("編輯", "quiet", () => edit(entry)));
  section.append(heading);
  for (const child of entries.filter(item => item.parent === entry.id && item.level !== 4)) {
    section.append(button((child.positionType || "位置") + "：" + child.name, "quiet", () => navigate(child)));
  }
  const items = entry.level === 4 ? [entry] : entries.filter(item =>
    item.level === 4 && ancestors(item).some(parent => parent.id === entry.id));
  const gallery = element("div", "", "photo-list-gallery");
  for (const item of items) {
    const tile = button("", "photo-list-item", () => openItem(item));
    tile.setAttribute("aria-label", "編輯物品：" + item.name);
    const photo = element("span", "尚無照片", "thumb");
    // The local thumbnail is inserted after the tile is attached.

    tile.append(photo, element("span", item.name, "photo-list-name"));
    gallery.append(tile);
    displayThumbnail(photo, item);
    if (uploadStatus(item)) tile.append(element("small", uploadStatus(item), "upload-status"));
  }
  if (!items.length) gallery.append(element("p", "這個空間還沒有物品。", "muted"));
  section.append(gallery);
  return section;
}

function card(entry, searching) {
  if (displayMode === "list") return photoListCard(entry);
  const row = element("div", "", "card");
  const isItem = entry.level === 4;
  const open = button("", "card-main", () => isItem ? openItem(entry) : navigate(entry));
  const children = entries.filter(child => child.parent === entry.id);
  const path = ancestors(entry).slice(0, -1).map(parent => parent.name).join(" / ");
  const description = element("span", "");
  description.append(element("strong", entry.name));
  if (searching && path) description.append(element("small", path));
  else if (!isItem) description.append(element("small",
    children.filter(child => child.level === 4).length + " 件物品 · " + children.filter(child => child.level !== 4).length + " 個空間"));
  const thumb = element("span", entry.positionType || labels[entry.level], "thumb");
  const arrow = element("span", "›");
  arrow.setAttribute("aria-hidden", "true");
  open.append(thumb, description, arrow);
  if (entry.hasPhoto && displayMode === "details") displayThumbnail(thumb, entry);
  if (uploadStatus(entry)) description.append(element("small", uploadStatus(entry), "upload-status"));
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
  renderSpaceLayout(query);
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
    ? (current.level === 0 ? "按下方「加入」新增空間或物品" : "更動：" + formatTime(current.updatedAt))
    : "固定四層樓　·　" +
      entries.filter(entry => entry.level === 4).length + " 件物品";
  $("list-title").textContent = query ? "搜尋結果" : !current || current.level === 0 ? "存放空間" : "內部位置與物品";
  $("count").textContent = visible.length + (depth === 4 && !query ? " 件" : " 筆");
  $("add").textContent = "加入";
  $("add").hidden = false;
  $("add").disabled = !signedIn || !current;
  $("add").title = current ? "加入到「" + ancestors(current).map(entry => entry.name).join(" / ") + "」" : "請先選擇樓層、櫃子或內部位置";
  $("back").disabled = !signedIn || (!current && !navigationHistory.length && !query);
  document.querySelector("footer").hidden = !signedIn;
  $("edit-space").hidden = !current || current.level === 0;
  $("edit-space").onclick = () => edit(current);
  $("list").replaceChildren(...visible.map(entry => card(entry, Boolean(query))));
  if (!visible.length) {
    const message = query ? "找不到符合的空間或物品。" : !current || current.level === 0
      ? "按下方「加入」，建立存放空間或物品。"
      : "這裡還沒有物品，可新增照片或填寫物品名稱。";
    $("list").append(element("p", message, "empty"));
  }
}

function edit(entry, placement) {
  if (entry?.level === 0 || (!entry && !current && !placement)) return;
  draft = entry ? { ...entry } : placement ? { ...placement } : { level: 4, parent: current.id };
  const isPosition = draft.level > 1 && draft.level < 4;
  $("position-type-field").hidden = !isPosition;
  const label = draft.level === 4 ? "物品" : isPosition ? "內部位置" : "存放空間";
  $("form").reset();
  $("add-kind-field").hidden = Boolean(draft.id);
  $("add-kind").replaceChildren(...availableAddKinds().map(([value, text]) => {
    const option = element("option", text);
    option.value = value;
    return option;
  }));
  $("add-kind").value = draft.level === 4 ? "item" : draft.level === 1 ? "space" : draft.positionType || "區";
  $("gallery").multiple = !draft.id && draft.level === 4;
  $("batch-preview").replaceChildren();
  $("position-type").value = draft.positionType || "區";
  $("form-status").textContent = "";
  $("editor-title").textContent = (entry ? "編輯" : "新增") + label;
  $("location").textContent = "存放位置：所有空間 / " + ancestors(entries.find(parent => parent.id === draft.parent))
    .map(parent => parent.name).join(" / ");
  $("name").value = draft.name ?? "";
  $("name").required = draft.level !== 4;
  $("name").placeholder = draft.level === 4 ? "例如 羊毛圍巾（有照片時可不填）" : isPosition ? "例如 左區、第 2 格、上層" : "例如 櫃子、床底下";
  $("entry-time").textContent = entry ? "建立：" + formatTime(entry.createdAt) + "；更動：" + formatTime(entry.updatedAt) : "儲存時自動記錄建立與更動時間（台北）";
  $("remove").hidden = !entry;
  $("photos").hidden = draft.level === 0;
  busy(false);
  showPhoto();
  editor.showModal();
  if (entry?.hasPhoto) {
    const version = ++photoVersion;
    $("form-status").textContent = "正在載入照片…";
    drive.photo(entry.photoId || entry.id).then(blob => {
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
  const files = Array.from(event.target.files);
  const file = files[0];
  event.target.value = "";
  if (!file) return;
  const version = ++photoVersion;
  busy(true);
  $("form-status").textContent = "正在處理照片…";
  try {
    const photos = [];
    for (const selected of (draft.id || draft.level !== 4 ? files.slice(0, 1) : files)) {
      photos.push({ photo: await compress(selected), name: selected.name.replace(/\.[^.]+$/, "") });
      if (version !== photoVersion) return;
    }
    draft.photo = photos[0].photo;
    draft.photos = photos;
    draft.photoRemoved = false;
    showPhoto();
    $("batch-preview").replaceChildren(...photos.slice(1).map(item => {
      const image = element("img", "", "thumb");
      image.alt = item.name;
      image.src = URL.createObjectURL(item.photo);
      objectUrls.push(image.src);
      return image;
    }));
    $("form-status").textContent = photos.length > 1 ? "已選擇 " + photos.length + " 張照片，每張將新增為一筆物品。" : "";
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
  delete draft.photos;
  $("batch-preview").replaceChildren();
  draft.photoRemoved = true;
  $("form-status").textContent = "";
  busy(false);
  showPhoto();
};
$("search").oninput = render;
function availableAddKinds() {
  if (!current) return [];
  return current.level === 0 ? [["item", "物品"], ["space", "空間／櫃子"]]
    : current.level < 3 ? [["item", "物品"], ["區", "區"], ["格", "格"], ["層", "層"]]
    : [["item", "物品"]];
}
function newEntryAtCurrent(kind) {
  if (!current) return;
  const record = { level: 4, parent: current.id };
  if (kind === "space" && current.level === 0) {
    const floor = floorNumber(current.name);
    const [left, top, right, bottom] = planBounds[(floor || 1) - 1];
    Object.assign(record, { level: 1, x: (left + right) / 2 / 1672, y: (top + bottom) / 2 / 941 });
  } else if (["區", "格", "層"].includes(kind) && current.level > 0 && current.level < 3) {
    Object.assign(record, { level: current.level + 1, positionType: kind, photoX: .5, photoY: .5 });
  }
  edit(null, record);
}
$("add").onclick = () => newEntryAtCurrent("item");
$("add-kind").onchange = () => {
  const name = $("name").value;
  const kind = $("add-kind").value;
  newEntryAtCurrent(kind);
  $("name").value = name;
};
$("back").onclick = () => {
  if (adjustingSave) return;
  const previous = navigationHistory.length ? navigationHistory.pop() : { id: current?.parent, x: 0, y: 0, query: "" };
  navigate(entries.find(entry => entry.id === previous.id) || null, false);
  $("search").value = previous.query || "";
  render();
  window.scrollTo(previous.x, previous.y);
};
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
  if (record.level > 1 && record.level < 4) record.positionType = $("position-type").value;
  if (record.photo) {
    queueSelectedPhotos(record, $("name").value.trim());
    return;
  }
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
  return (value / 1024 ** index).toLocaleString("zh-TW", { maximumFractionDigits: 1 }) + units[index];
}

async function refreshQuota() {
  const generation = ++quotaGeneration;
  $("drive-quota").textContent = "雲端硬碟容量：讀取中…";
  $("retry-quota").hidden = true;
  try {
    const quota = await drive.quota();
    if (generation !== quotaGeneration) return;
    const limit = Number(quota.limit);
    $("drive-quota").textContent = formatStorage(quota.usage) +
      (Number.isFinite(limit) && limit > 0 ? "/" + formatStorage(limit) : "/未知");
    $("drive-quota").title = "目前登入帳號的 Google 儲存空間，包含雲端硬碟、Gmail 與 Google 相簿。";
  } catch {
    if (generation !== quotaGeneration) return;
    $("drive-quota").textContent = "雲端硬碟容量：讀取失敗";
    $("retry-quota").hidden = false;
  }
}

function setSignedIn(value) {
  signedIn = value;
  document.querySelector("main").hidden = !signedIn;
  document.querySelector("footer").hidden = !signedIn;
  $("gate").hidden = signedIn;
  $("logout").hidden = !signedIn;
  $("add").disabled = !signedIn || !current;
  $("back").disabled = !signedIn || (!current && !navigationHistory.length);
  $("header-storage").hidden = !signedIn;
  $("account-menu").hidden = !signedIn;
  $("account-menu").open = false;
  quotaGeneration++;
  $("drive-quota").textContent = "";
  $("retry-quota").hidden = true;
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
  navigate(null, false);
  navigationHistory = [];
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
$("logout").onclick = () => {
  if (photoUploads.size) {
    $("mutation-status").textContent = "照片尚未上傳完成，請等待完成或點選失敗物品重試後再登出。";
    return;
  }
  signOut();
};

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
