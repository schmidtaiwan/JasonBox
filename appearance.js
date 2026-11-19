"use strict";
const spaceIcons = [
  ["cabinet", "櫃子", "M-9-8H9V9H-9Z M-9-1H9 M-3-5H3 M-3 4H3"],
  ["bed", "床", "M-10 8V-8 M10 8V-3H-10 M-10 3H10 M-7-3V-7H-1V-3"],
  ["box", "箱子", "M-9-6H9V9H-9Z M-10-6L0-10 10-6 M0-6V9 M-3-2H3"],
  ["shelf", "層架", "M-9-10V10 M9-10V10 M-9-5H9 M-9 2H9 M-9 8H9"],
  ["drawer", "抽屜", "M-9-10H9V10H-9Z M-9-3H9 M-9 4H9 M-2-7H2 M-2 0H2 M-2 7H2"],
  ["closet", "衣櫃", "M-9-10H9V10H-9Z M0-10V10 M-3-1V2 M3-1V2"],
  ["bag", "提袋", "M-8-4H8L10 10H-10Z M-4-4V-7A4 4 0 0 1 4-7V-4"],
  ["home", "房間", "M-11-1L0-10 11-1 M-8-3V10H8V-3 M-3 10V2H3V10"],
  ["photo", "照片縮圖", "M-10-8H10V8H-10Z M-8 5L-2-2 3 3 6 0 9 5 M4-4H5"],
  ["photo-only", "僅照片（透明底）", ""]
];
const spaceColors = [
  ["森林綠", "#244d38"], ["海洋藍", "#1768a6"], ["紫色", "#7544a0"], ["玫瑰紅", "#b73559"],
  ["橘色", "#b85208"], ["金棕色", "#8a6500"], ["青綠色", "#087b7b"], ["深灰色", "#444444"]
];
function spaceAppearance(entry) {
  const key = entry.iconKey === "photo-only" && !entry.hasPhoto && !entry.photo ? "cabinet" : entry.iconKey;
  return {
    icon: spaceIcons.find(icon => icon[0] === key) || spaceIcons[0],
    color: spaceColors.some(color => color[1] === entry.iconColor) ? entry.iconColor : spaceColors[0][1]
  };
}
const iconPhotoCache = new Map();
function addPhotoThumbnail(svg, entry, size) {
  if (!entry.hasPhoto && !entry.photo) return;
  const key = (entry.photoId || entry.id) + ":" + entry.updatedAt;
  let pending = entry.photo ? Promise.resolve(entry.photo) : iconPhotoCache.get(key);
  if (!pending) {
    pending = drive.photo(entry.photoId || entry.id);
    iconPhotoCache.set(key, pending);
    pending.catch(() => iconPhotoCache.delete(key));
    if (iconPhotoCache.size > 24) iconPhotoCache.delete(iconPhotoCache.keys().next().value);
  }
  pending.then(blob => {
    if (!svg.isConnected) return;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    svg.append(svgNode("image", { href: url, x: -size / 2, y: -size / 2, width: size, height: size, preserveAspectRatio: entry.iconKey === "photo-only" ? "xMidYMid meet" : "xMidYMid slice", "pointer-events": "none" }));
  }).catch(() => {});
}
function spaceIconNode(entry) {
  const appearance = spaceAppearance(entry);
  const svg = svgNode("svg", { viewBox: "-24 -24 48 48", "aria-hidden": "true", class: "space-choice-icon" });
  if (appearance.icon[0] === "photo-only") {
    addPhotoThumbnail(svg, entry, 44);
    return svg;
  }
  svg.append(svgNode("circle", { r: 22, fill: appearance.color }),
    svgNode("path", { d: appearance.icon[2], fill: "none", stroke: "white", "stroke-width": 2, "stroke-linejoin": "round" }));
  if (appearance.icon[0] === "photo") addPhotoThumbnail(svg, entry, 34);
  return svg;
}
function renderCurrentSpaceIcon() {
  const host = $("current-space-icon");
  host.hidden = !current || current.level === 0;
  host.replaceChildren();
  if (host.hidden) return;
  host.append(spaceIconNode(current));
  host.setAttribute("aria-label", "變更「" + current.name + "」的圖示與顏色");
}
let appearanceDraft;
let appearanceSaving = false;
function renderAppearanceChoices() {
  $("icon-choices").replaceChildren(...spaceIcons.map(icon => {
    const choice = button("", "appearance-choice", () => {
      appearanceDraft.iconKey = icon[0]; renderAppearanceChoices();
    });
    choice.append(spaceIconNode({ ...appearanceDraft, iconKey: icon[0] }), element("span", icon[1]));
    choice.setAttribute("aria-pressed", String(spaceAppearance(appearanceDraft).icon[0] === icon[0]));
    const needsPhoto = icon[0] === "photo" || icon[0] === "photo-only";
    choice.disabled = appearanceSaving || (needsPhoto && !appearanceDraft.hasPhoto);
    if (needsPhoto && !appearanceDraft.hasPhoto) choice.title = "請先上傳這個空間的照片";
    return choice;
  }));
  $("color-choices").replaceChildren(...spaceColors.map(([name, color]) => {
    const choice = button(name, "color-choice", () => {
      appearanceDraft.iconColor = color; renderAppearanceChoices();
    });
    choice.style.backgroundColor = color;
    choice.setAttribute("aria-pressed", String(spaceAppearance(appearanceDraft).color === color));
    choice.disabled = appearanceSaving;
    return choice;
  }));
  $("appearance-preview").replaceChildren(spaceIconNode(appearanceDraft), element("span", appearanceDraft.name));
}
function openAppearance() {
  if (!current || current.level === 0) return;
  if (photoUploads.has(current.id)) {
    $("mutation-status").textContent = "請等空間照片上傳完成後再變更圖示。"; return;
  }
  appearanceDraft = { ...current };
  $("appearance-status").textContent = "";
  renderAppearanceChoices();
  $("appearance-dialog").showModal();
}
async function saveAppearance() {
  if (!appearanceDraft || appearanceSaving) return;
  appearanceSaving = true;
  $("appearance-save").disabled = true;
  $("appearance-close").disabled = true;
  renderAppearanceChoices();
  $("appearance-status").textContent = "儲存中…";
  try {
    const saved = await drive.save(appearanceDraft);
    entries = entries.map(entry => entry.id === saved.id ? saved : entry);
    if (current?.id === saved.id) current = saved;
    $("appearance-dialog").close();
    render();
  } catch (error) { $("appearance-status").textContent = "儲存失敗：" + error.message; }
  finally {
    appearanceSaving = false;
    $("appearance-save").disabled = false;
    $("appearance-close").disabled = false;
    renderAppearanceChoices();
  }
}
