"use strict";

const labels = ["樓層", "房間", "櫃子", "分類箱", "物品"];
const $ = id => document.getElementById(id);
const editor = $("editor");
let entries = [];
let current = null;
let draft;
let objectUrls = [];
let previewUrl;
let photoVersion = 0;
let saving = false;
const configKey = "JasonBox.googleConfig";
let googleConfig;

try {
  googleConfig = JSON.parse(localStorage.getItem(configKey));
} catch {
  googleConfig = null;
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
  if (current) current = entries.find(entry => entry.id === current.id) ?? null;
  render();
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
  current = entry;
  $("search").value = "";
  render();
  window.scrollTo(0, 0);
}

function card(entry, searching) {
  const row = element("div", "", "card");
  const isItem = entry.level === 4;
  const open = button("", "card-main", () => isItem ? edit(entry) : navigate(entry));
  const count = entries.filter(child => child.parent === entry.id).length;
  const path = ancestors(entry).slice(0, -1).map(parent => parent.name).join(" / ");
  const description = element("span", "");
  description.append(element("strong", entry.name));
  if (searching && path) description.append(element("small", path));
  else if (!isItem) description.append(element("small", count + " 個" + labels[entry.level + 1]));
  const thumb = element("span", labels[entry.level], "thumb");
  const arrow = element("span", "›");
  arrow.setAttribute("aria-hidden", "true");
  open.append(thumb, description, arrow);
  if (entry.hasPhoto) {
    thumb.dataset.id = entry.id;
    thumbnails.observe(thumb);
  }
  row.append(open);
  if (!isItem) {
    const editButton = button("編輯", "quiet", () => edit(entry));
    editButton.setAttribute("aria-label", "編輯 " + entry.name);
    row.append(editButton);
  }
  return row;
}

function render() {
  thumbnails.disconnect();
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = [];
  const depth = current ? current.level + 1 : 0;
  const query = $("search").value.trim().toLocaleLowerCase();
  const visible = query
    ? entries.filter(entry => entry.level >= 3 && entry.name.toLocaleLowerCase().includes(query))
    : entries.filter(entry => entry.parent === (current?.id ?? null));
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
    ? labels[current.level]
    : entries.filter(entry => entry.level === 0).length + " 個樓層　·　" +
      entries.filter(entry => entry.level === 4).length + " 件物品";
  $("list-title").textContent = query ? "搜尋結果" : labels[depth] + "清單";
  $("count").textContent = visible.length + (depth === 4 && !query ? " 件" : " 筆");
  $("add").textContent = "＋ 新增" + labels[depth];
  $("list").replaceChildren(...visible.map(entry => card(entry, Boolean(query))));
  if (!visible.length) {
    const message = query ? "找不到符合的物品或分類箱。" : "這裡還沒有" + labels[depth] + "。";
    $("list").append(element("p", message, "empty"));
  }
}

function edit(entry) {
  draft = entry ? { ...entry } : { level: current ? current.level + 1 : 0, parent: current?.id ?? null };
  const label = labels[draft.level];
  $("form").reset();
  $("form-status").textContent = "";
  $("editor-title").textContent = (entry ? "編輯" : "新增") + label;
  $("location").textContent = ancestors(entries.find(parent => parent.id === draft.parent))
    .map(parent => parent.name).join(" / ");
  $("name").value = draft.name ?? "";
  $("name").placeholder = ["例如 1 樓", "例如 房間 1", "例如 衣櫃", "例如 冬衣箱", "例如 羊毛圍巾"][draft.level];
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
}
$("form").onsubmit = async event => {
  event.preventDefault();
  if ($("save").disabled) return;
  const name = $("name").value.trim();
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
    closeEditor();
    render();
  } catch (error) {
    showError(error);
  } finally {
    saving = false;
    busy(false);
  }
};

function showPhoto(blob = draft?.photo) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : undefined;
  $("preview").hidden = !previewUrl;
  $("remove-photo").hidden = !blob && !(draft?.hasPhoto && !draft.photoRemoved);
  if (previewUrl) $("preview").src = previewUrl;
  else $("preview").removeAttribute("src");
}

function setSignedIn(signedIn) {
  document.querySelector("main").hidden = !signedIn;
  document.querySelector("footer").hidden = !signedIn;
  $("gate").hidden = signedIn;
  $("logout").hidden = !signedIn;
  $("add").disabled = !signedIn;
}

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
  if (!googleConfig) {
    $("login-status").textContent = "請先匯入 Google 登入設定檔。";
    return;
  }
  $("login").disabled = true;
  $("login-status").textContent = "正在連接 Google Drive…";
  try {
    await drive.login(googleConfig);
    await refresh();
    setSignedIn(true);
  } catch (error) {
    signOut(error.message);
  } finally {
    $("login").disabled = false;
  }
};
$("logout").onclick = () => signOut();

$("import-config").onchange = async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || $("login").disabled) return;
  try {
    const config = JSON.parse(await file.text());
    if (typeof config.clientId !== "string" || typeof config.owner !== "string" ||
        !/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(config.clientId) ||
        !/^[^\s@]+@gmail\.com$/i.test(config.owner)) {
      throw new Error("設定格式不符");
    }
    const next = { clientId: config.clientId, owner: config.owner.toLowerCase() };
    localStorage.setItem(configKey, JSON.stringify(next));
    googleConfig = next;
    $("login-status").textContent = "設定已儲存在此瀏覽器，可以登入 Google。";
  } catch {
    $("login-status").textContent = "無法匯入設定。請選擇 JasonBox 的 JSON 設定檔，並確認瀏覽器允許儲存設定。";
  }
};

if (window.location.protocol === "file:") {
  $("login").disabled = true;
  const link = element("a", "http://localhost:8000/");
  link.href = "http://localhost:8000/";
  $("login-status").append("請先執行 preview.cmd，再開啟 ", link, " 以登入 Google。");
}
