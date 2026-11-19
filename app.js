"use strict";

const labels = ["樓層", "空間", "櫃子", "分類箱", "物品"];
const PAGE_BUILD = 51;
const PAGE_DATE = "2026-11-19";
const markerSizes = { small: .8, normal: 1, large: 1.25, xlarge: 1.5 };
const markerSettingsKey = "jasonbox-marker-settings";
let markerSettings = { iconsOnly: false, transparent: false, size: "normal", position: "below", color: "#183d2a" };
try {
  const preferences = JSON.parse(localStorage.getItem(markerSettingsKey));
  if (preferences && Object.hasOwn(markerSizes, preferences.size) && /^#[0-9a-f]{6}$/i.test(preferences.color)) {
    markerSettings = { ...markerSettings, ...preferences };
  }
} catch {}
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
let editorCover;
let savedAlbum = [];
let editorPhotoUrls = [];
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

async function refresh({ initial = false } = {}) {
  entries = (await drive.readEntries()).filter(entry => !photoUploads.has(entry.id));
  entries.push(...Array.from(photoUploads.values(), job => job.local));
  for (let floor = 1; floor <= 4; floor++) {
    const existing = entries.find(entry => entry.level === 0 && floorNumber(entry.name) === floor);
    if (!existing) entries.push(await drive.save({ name: floor + "F", level: 0, parent: null }));
  }
  if (initial) current = entries.find(entry => entry.level === 0 && floorNumber(entry.name) === 1) ?? null;
  else if (current) current = entries.find(entry => entry.id === current.id) ?? null;
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
  setSearchOpen(false);
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
    if (job.failed) job.completion = sendPhotoUpload(job);
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

function queueSelectedPhotos(record, name, names = []) {
  const photos = record.photos || [{ photo: record.photo }];
  for (const [index, item] of photos.entries()) {
    const { photos: unused, ...single } = record;
    single.photo = item.photo;
    single.name = names[index] || (photos.length === 1 ? record.name : name ? name + " " + (index + 1) : item.name || record.name + " " + (index + 1));
    queuePhotoUpload(single);
  }
}

function queuePhotoUpload(record) {
  const id = record.id || "pending-photo-" + ++uploadSequence;
  const local = { ...record, id, hasPhoto: Boolean(record.photo || (record.hasPhoto && !record.photoRemoved)), updatedAt: new Date().toISOString(), updatedBy: drive.account()?.email,
    createdAt: record.createdAt || new Date().toISOString() };
  const job = { id, record, local, failed: false, running: false };
  photoUploads.set(id, job);
  entries = entries.filter(entry => entry.id !== id).concat(local);
  if (current?.id === id) current = local;
  closeEditor();
  render();
  job.completion = sendPhotoUpload(job);
}

async function sendPhotoUpload(job) {
  if (job.running) return;
  job.running = true;
  job.failed = false;
  render();
  try {
    const parentJob = photoUploads.get(job.record.parent);
    if (parentJob) {
      await parentJob.completion;
      if (photoUploads.has(parentJob.id)) throw new Error("上層空間尚未儲存，請先重試上層空間");
    }
    if (job.record.compressPhoto && job.record.photo) {
      job.record.photo = await compress(job.record.photo);
      job.record.compressPhoto = false;
    }
    for (const extra of job.record.extraPhotos || []) {
      if (!extra.prepared) {
        extra.photo = await compress(extra.photo);
        extra.prepared = true;
      }
    }
    const saved = await drive.save(job.record);
    entries = entries.filter(entry => entry.id !== job.id).map(entry =>
      entry.parent === job.id ? { ...entry, parent: saved.id } : entry).concat(saved);
    for (const pending of photoUploads.values()) {
      if (pending.record.parent === job.id) {
        pending.record.parent = saved.id;
        pending.local.parent = saved.id;
      }
    }
    navigationHistory = navigationHistory.map(previous => previous.id === job.id ? { ...previous, id: saved.id } : previous);
    photoUploads.delete(job.id);
    if (current?.id === job.id) current = saved;
    if (signedIn && (job.record.photo || job.record.extraPhotos?.length)) void refreshQuota();
    await touchParent(saved.parent);
  } catch (error) {
    job.failed = true;
    $("mutation-status").textContent = "背景儲存失敗：" + error.message + "。點選失敗項目可重試。";
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

function changeDescription(entry) {
  const account = entry.updatedBy ? entry.updatedBy.split("@")[0].toUpperCase() : "未記錄";
  return formatTime(entry.updatedAt) + " · " + account;
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
  description.append(element("small", "更動：" + changeDescription(entry), "changed-time"));
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
  renderCurrentSpaceIcon();
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
    ? (current.level === 0 ? "按下方「加入」新增空間或物品" : "更動：" + changeDescription(current))
    : "固定四層樓　·　" +
      entries.filter(entry => entry.level === 4).length + " 件物品";
  $("list-title").textContent = query ? "搜尋結果" : !current || current.level === 0 ? "存放空間" : "內部位置與物品";
  $("count").textContent = visible.length + (depth === 4 && !query ? " 件" : " 筆");
  $("add").hidden = false;
  $("add").disabled = !signedIn || !current;
  $("add").title = current ? "加入到「" + ancestors(current).map(entry => entry.name).join(" / ") + "」" : "請先選擇樓層、櫃子或內部位置";
  $("back").disabled = !signedIn || (!current && !navigationHistory.length && !query);
  document.querySelector("footer").hidden = !signedIn;
  $("edit-space").hidden = !current || current.level === 0;
  $("delete-items").hidden = !signedIn || Boolean(query) || !movableItems(current).length;
  $("move-items").hidden = $("delete-items").hidden || !moveTargets(current).length;
  $("edit-space").onclick = () => edit(current);
  $("list").replaceChildren(...visible.map(entry => card(entry, Boolean(query))));
  if (!visible.length) {
    const message = query ? "找不到符合的空間或物品。" : !current || current.level === 0
      ? "按下方「加入」，建立存放空間或物品。"
      : "這裡還沒有物品，可新增照片或填寫物品名稱。";
    $("list").append(element("p", message, "empty"));
  }
}

function movableItems(source) {
  return source?.level > 0 ? entries.filter(item => item.level === 4 && item.parent === source.id && !photoUploads.has(item.id)) : [];
}

function moveTargets(source) {
  if (!source || source.level === 0) return [];
  return entries.filter(space => space.level > 0 && space.level < 4 && space.id !== source.id &&
    !photoUploads.has(space.id) && (space.id === source.parent || space.parent === source.id ||
      (space.level === source.level && space.parent === source.parent)))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
}

const moveDialog = $("move-dialog");
let moveSelection;
let movingItems = false;

function updateMoveControls() {
  const deleting = moveSelection?.deleting;
  $("move-confirm").disabled = movingItems || !moveSelection?.selected.size || (!deleting && !$("move-target").value);
  $("move-close").disabled = movingItems;
  $("move-options").disabled = movingItems;
  $("move-target").disabled = movingItems || Boolean(deleting);
}

function renderMoveOptions() {
  const { source, selected } = moveSelection;
  $("move-list").replaceChildren(...movableItems(source).map(item => {
    const label = element("label", "");
    const checkbox = element("input", "");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(item.id);
    checkbox.onchange = () => {
      if (checkbox.checked) selected.add(item.id);
      else selected.delete(item.id);
      updateMoveControls();
    };
    label.append(checkbox, element("span", item.name));
    return label;
  }));
  updateMoveControls();
}

function openItemSelection(deleting) {
  const targets = deleting ? [] : moveTargets(current);
  if ((!deleting && !targets.length) || !movableItems(current).length) return;
  moveSelection = { source: current, selected: new Set(), deleting };
  $("move-title").textContent = deleting ? "多選刪除物品" : "移動物品";
  $("move-confirm").textContent = deleting ? "刪除所選物品" : "移動";
  $("move-confirm").className = deleting ? "danger" : "primary";
  $("move-target-field").hidden = deleting;
  $("move-source").textContent = "來源：" + ancestors(current).map(space => space.name).join(" / ");
  $("move-status").textContent = "";
  const placeholder = element("option", "選擇目的地");
  placeholder.value = "";
  $("move-target").replaceChildren(placeholder, ...targets.map(space => {
    const relation = space.id === current.parent ? "上一層" : space.parent === current.id ? "下一層" : "同層";
    const option = element("option", relation + " · " + space.name);
    option.value = space.id;
    return option;
  }));
  $("move-target").value = "";
  renderMoveOptions();
  moveDialog.showModal();
}
$("move-items").onclick = () => openItemSelection(false);
$("delete-items").onclick = () => openItemSelection(true);
$("move-target").onchange = updateMoveControls;
$("move-close").onclick = () => { if (!movingItems) moveDialog.close(); };
moveDialog.oncancel = event => { if (movingItems) event.preventDefault(); };
$("move-form").onsubmit = async event => {
  event.preventDefault();
  if (movingItems || !moveSelection) return;
  const { source, selected, deleting } = moveSelection;
  const target = deleting ? null : moveTargets(source).find(space => space.id === $("move-target").value);
  const batch = movableItems(source).filter(item => selected.has(item.id));
  if ((!deleting && !target) || !batch.length) return;
  if (deleting && !window.confirm("確定將 " + batch.length + " 件物品移到 Google Drive 垃圾桶？")) return;
  movingItems = true;
  updateMoveControls();
  const action = deleting ? "刪除" : "移動";
  $("move-status").textContent = "正在" + action + " " + batch.length + " 件物品…";
  const errors = [];
  let completed = 0;
  try {
    for (const item of batch) {
      try {
        if (deleting) {
          await drive.remove(item);
          entries = entries.filter(entry => entry.id !== item.id);
        } else {
          const saved = await drive.moveItem(item, target);
          entries = entries.map(entry => entry.id === item.id ? saved : entry);
        }
        selected.delete(item.id);
        completed++;
      } catch (error) {
        errors.push(error.message);
        if (error instanceof drive.SessionExpired) break;
      }
    }
    if (completed) await Promise.all([touchParent(source.id), target && touchParent(target.id)]);
    render();
    if (errors.length) {
      $("move-status").textContent = "已" + action + " " + completed + " 件，尚有 " + (batch.length - completed) + " 件未確認：" + errors[0];
      renderMoveOptions();
    } else {
      moveDialog.close();
      $("mutation-status").textContent = deleting ? "已將 " + completed + " 件物品移到 Google Drive 垃圾桶。"
        : "已將 " + completed + " 件物品移到「" + target.name + "」。";
    }
  } finally {
    movingItems = false;
    updateMoveControls();
  }
};

function edit(entry, placement) {
  if (entry && photoUploads.has(entry.id)) {
    openItem(entry);
    return;
  }
  if (entry?.level === 0 || (!entry && !current && !placement)) return;
  draft = entry ? { ...entry } : placement ? { ...placement } : { level: 4, parent: current.id };
  const isPosition = draft.level > 1 && draft.level < 4;
  $("position-type-field").hidden = true;
  const label = draft.level === 4 ? "物品" : isPosition ? "空間（區格層）" : "存放空間";
  $("form").reset();
  $("add-kind-field").hidden = Boolean(draft.id);
  $("add-kind").replaceChildren(...availableAddKinds().map(([value, text]) => {
    const option = element("option", text);
    option.value = value;
    return option;
  }));
  $("add-kind").value = draft.level === 4 ? "item" : draft.level === 1 ? "space" : "position";
  $("gallery").multiple = draft.level < 4 || !draft.id;
  editorCover = undefined;
  savedAlbum = [];
  $("position-type").value = draft.positionType || "區";
  $("form-status").textContent = "";
  $("editor-title").textContent = (entry ? "編輯" : "新增") + label;
  $("location").textContent = "存放位置：所有空間 / " + ancestors(entries.find(parent => parent.id === draft.parent))
    .map(parent => parent.name).join(" / ");
  $("name").value = draft.name ?? "";
  $("name").required = draft.level !== 4;
  $("name").maxLength = draft.id ? 80 : 1000;
  $("name").placeholder = draft.level === 4
    ? (draft.id ? "例如 羊毛圍巾" : "例如 圍巾、帽子（以空格或逗號分隔）")
    : draft.id ? "例如 櫃子" : isPosition ? "例如 左區 右區 上層（空格分隔）" : "例如 櫃子 床底下（空格分隔）";
  $("entry-time").textContent = entry ? "建立：" + formatTime(entry.createdAt) + "；更動：" + changeDescription(entry) : "儲存時自動記錄建立與更動時間（台北）";
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
      editorCover = blob;
      showPhoto();
      $("form-status").textContent = "";
    }).catch(error => {
      if (version === photoVersion && editor.open) showError(error);
    });
  }
  if (entry?.spaceAlbum) {
    const activeDraft = draft;
    drive.spacePhotos(entry.id).then(files => {
      if (draft !== activeDraft || draft.photoRemoved) return;
      savedAlbum = files;
      showPhoto();
    }).catch(error => {
      if (draft === activeDraft) showError(error);
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
  if (!draft) return;
  if (draft.level === 4) photoVersion++;
  if (draft.level < 4 && (draft.hasPhoto || draft.spaceAlbum) && !draft.photoRemoved) clearSelectedPhotos();
  const multiple = draft.level < 4 || !draft.id;
  const photos = (multiple ? files : files.slice(0, 1))
    .map(selected => ({ photo: selected, name: selected.name.replace(/\.[^.]+$/, "") }));
  draft.photos = multiple ? [...(draft.photos || []), ...photos] : photos;
  if (draft.level === 4) draft.photoRemoved = false;
  showPhoto();
  $("form-status").textContent = "已選擇 " + draft.photos.length + " 張照片，儲存後" +
    (draft.level < 4 && draft.photoRemoved && (draft.hasPhoto || draft.spaceAlbum) ? "將取代舊照片。" : "於背景上傳。");
  busy(false);
}

$("camera").onchange = pickPhoto;
$("gallery").onchange = pickPhoto;
function clearSelectedPhotos() {
  photoVersion++;
  delete draft.photos;
  delete draft.editedCover;
  delete draft.coverTransform;
  savedAlbum = [];
  editorCover = undefined;
  draft.photoRemoved = true;
}
$("remove-photo").onclick = () => {
  clearSelectedPhotos();
  $("form-status").textContent = "";
  busy(false);
  showPhoto();
};
function setSearchOpen(open) {
  $("search-panel").hidden = !open;
  $("toggle-search").setAttribute("aria-expanded", String(open));
  document.querySelector("main").style.paddingBottom = open ? "calc(170px + env(safe-area-inset-bottom))" : "";
}
$("toggle-search").onclick = () => {
  const open = $("search-panel").hidden;
  setSearchOpen(open);
  if (open) $("search").focus();
  else { $("search").value = ""; render(); }
};
$("search").oninput = () => { render(); window.scrollTo(0, 0); };
$("search").onkeydown = event => {
  if (event.key === "Escape") {
    $("search").value = "";
    setSearchOpen(false);
    render();
    $("toggle-search").focus();
  }
};
function availableAddKinds() {
  if (!current) return [];
  return current.level === 0 ? [["space", "空間"]]
    : current.level < 3 ? [["item", "物品"], ["position", "空間（區格層）"]]
    : [["item", "物品"]];
}
function newEntryAtCurrent(kind) {
  if (!current) return;
  if (!availableAddKinds().some(([value]) => value === kind)) kind = availableAddKinds()[0][0];
  const record = { level: 4, parent: current.id };
  if (kind === "space" && current.level === 0) {
    const floor = floorNumber(current.name);
    const [left, top, right, bottom] = planBounds[(floor || 1) - 1];
    Object.assign(record, { level: 1, x: (left + right) / 2 / 1672, y: (top + bottom) / 2 / 941 });
  } else if (kind === "position" && current.level > 0 && current.level < 3) {
    Object.assign(record, { level: current.level + 1, positionType: "區", photoX: .5, photoY: .5 });
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
  setSearchOpen(Boolean(previous.query));
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
  editorCover = undefined;
  savedAlbum = [];
  showPhoto();
  showUpdatePrompt();
}
function batchSpacePosition(record, parent, index, total) {
  const columns = Math.min(3, total);
  const rows = Math.ceil(total / columns);
  const x = .5 + (index % columns - (columns - 1) / 2) * .24;
  const y = .5 + (Math.floor(index / columns) - (rows - 1) / 2) * Math.min(.18, .8 / rows);
  if (record.level === 1) {
    const [left, top, right, bottom] = planBounds[(floorNumber(parent?.name || "") || 1) - 1];
    return { x: (left + (right - left) * x) / 1672, y: (top + (bottom - top) * y) / 941 };
  }
  const [photoX, photoY] = parent?.coverTransform ? inversePhotoPoint(parent.coverTransform, x, y) : [x, y];
  return { photoX, photoY };
}

$("form").onsubmit = async event => {
  event.preventDefault();
  if ($("save").disabled || !draft || draft.level === 0) return;
  let name = $("name").value.trim();
  const enteredName = name;
  const names = draft.id ? [] : name.split(draft.level === 4 ? /[\s,，、]+/u : /\s+/u).filter(Boolean);
  if (!draft.id) name = names[0] || "";
  const photos = draft.photos || [];
  if (!name && draft.level === 4 && (photos.length || draft.editedCover || (draft.hasPhoto && !draft.photoRemoved))) name = "物品照片 " + formatTime(new Date().toISOString());
  if (!name) {
    $("form-status").textContent = "請輸入名稱。";
    $("name").focus();
    return;
  }
  const record = { ...draft, name };
  delete record.editedCover;
  const parent = entries.find(entry => entry.id === record.parent);
  if (!record.id && record.level === 4 && parent?.level === 0) {
    $("form-status").textContent = "樓層只能新增空間，請先進入空間再加入物品。";
    return;
  }
  if (record.level > 1 && record.level < 4) record.positionType = $("position-type").value;
  if (names.some(value => value.length > 80) || (names.length > 1 && photos.length && names.length !== photos.length)) {
    $("form-status").textContent = names.some(value => value.length > 80)
      ? "每個名稱最多 80 個字。" : "請讓名稱數量和照片張數相同，以便依序配對。";
    return;
  }
  if (record.level === 4 && photos.length) {
    record.photo = photos[0].photo;
    record.compressPhoto = true;
    queueSelectedPhotos(record, enteredName, names.length > 1 ? names : []);
    return;
  }
  delete record.photos;
  if (names.length > 1) {
    for (const [index, entryName] of names.entries()) {
      const position = record.level < 4 ? batchSpacePosition(record, parent, index, names.length) : {};
      const photo = photos[index]?.photo;
      queuePhotoUpload({ ...record, ...position, name: entryName, photo, compressPhoto: Boolean(photo) });
    }
    return;
  }
  if (record.level < 4) {
    const hasCover = record.photoId && !record.photoRemoved;
    record.photo = draft.editedCover || (!hasCover ? photos[0]?.photo : undefined);
    record.replaceCover = Boolean(draft.editedCover);
    record.extraPhotos = [
      ...photos.slice(!hasCover && !draft.editedCover ? 1 : 0),
      ...savedAlbum.filter(file => file.editedPhoto).map(file => ({
        name: file.name.replace(/\.jpg$/i, ""), targetId: file.id, photo: file.editedPhoto, prepared: true
      }))
    ];
  } else {
    record.photo = draft.editedCover;
  }
  record.compressPhoto = Boolean(record.photo && !draft.editedCover);
  queuePhotoUpload(record);
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

function showPhoto() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  for (const url of editorPhotoUrls) URL.revokeObjectURL(url);
  editorPhotoUrls = [];
  const photos = draft?.photos || [];
  const cover = draft?.editedCover || (draft?.level === 4 && photos.length ? undefined : editorCover);
  const blob = cover || photos[0]?.photo;
  previewUrl = blob ? URL.createObjectURL(blob) : undefined;
  $("preview").hidden = !previewUrl;
  $("edit-photo").hidden = !blob;
  $("remove-photo").hidden = !blob && !(draft?.hasPhoto && !draft.photoRemoved);
  if (previewUrl) $("preview").src = previewUrl;
  else $("preview").removeAttribute("src");
  const tiles = photos.slice(cover ? 0 : 1).map(item => {
    const tile = button("", "", () => openPhotoTools(item.photo, result => { item.photo = result; }));
    const image = element("img", "", "thumb");
    image.alt = "旋轉或裁切 " + (item.name || "照片");
    image.src = URL.createObjectURL(item.photo);
    editorPhotoUrls.push(image.src);
    tile.append(image);
    return tile;
  });
  for (const file of savedAlbum) {
    const tile = button(file.name.replace(/\.jpg$/i, ""), "quiet", () => {
      const activeDraft = draft;
      (file.editedPhoto ? Promise.resolve(file.editedPhoto) : drive.photo(file.id)).then(blob => {
        if (draft !== activeDraft) return;
        return openPhotoTools(blob, result => {
          file.editedPhoto = result;
        });
      }).catch(error => { if (draft === activeDraft) showError(error); });
    });
    tiles.push(tile);
  }
  $("batch-preview").replaceChildren(...tiles);
  $("edit-photo").onclick = () => openPhotoTools(blob, (result, transform) => {
    if (cover) {
      draft.editedCover = result;
      if (draft.level < 4) draft.coverTransform = combinePhotoTransforms(transform, draft.coverTransform);
    } else photos[0].photo = result;
  });
}

function openPhotoTools(blob, apply) {
  const activeDraft = draft;
  if (!blob || !activeDraft) return;
  return editPhotoImage(blob, (result, transform) => {
    if (draft !== activeDraft) return;
    apply(result, transform);
    showPhoto();
  }).catch(error => { if (draft === activeDraft) showError(error); });
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
  $("marker-settings").hidden = !signedIn;
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

$("marker-settings").onclick = () => {
  $("markers-only").checked = markerSettings.iconsOnly;
  $("markers-transparent").checked = markerSettings.transparent;
  $("marker-label-size").value = markerSettings.size;
  $("marker-label-position").value = markerSettings.position;
  $("marker-label-color").value = markerSettings.color;
  $("marker-label-options").disabled = markerSettings.iconsOnly;
  $("marker-settings-dialog").showModal();
};
$("markers-only").onchange = () => { $("marker-label-options").disabled = $("markers-only").checked; };
$("marker-settings-close").onclick = () => $("marker-settings-dialog").close();
$("marker-settings-form").onsubmit = event => {
  event.preventDefault();
  const size = $("marker-label-size").value;
  const position = $("marker-label-position").value;
  const color = $("marker-label-color").value;
  if (!Object.hasOwn(markerSizes, size) || !/^#[0-9a-f]{6}$/i.test(color)) return;
  markerSettings = {
    iconsOnly: $("markers-only").checked, transparent: $("markers-transparent").checked,
    size, position: position === "above" ? "above" : "below", color
  };
  try { localStorage.setItem(markerSettingsKey, JSON.stringify(markerSettings)); } catch {}
  $("marker-settings-dialog").close();
  render();
};

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
    await refresh({ initial: true });
    setSignedIn(true);
  } catch (error) {
    signOut(error.message);
  } finally {
    $("login").disabled = false;
  }
};
$("logout").onclick = () => {
  if (photoUploads.size) {
    $("mutation-status").textContent = "資料尚未儲存完成，請等待完成或點選失敗項目重試後再登出。";
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

$("export-pdf").onclick = exportPdf;

$("current-space-icon").onclick = openAppearance;
$("appearance-save").onclick = saveAppearance;
$("appearance-close").onclick = () => { if (!appearanceSaving) $("appearance-dialog").close(); };
$("appearance-dialog").oncancel = event => { if (appearanceSaving) event.preventDefault(); };
