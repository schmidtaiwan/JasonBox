"use strict";

// Coordinates are stored relative to the original image, independent of screen size.
const planBounds = [
  [112, 42, 418, 873], [482, 118, 802, 822],
  [860, 118, 1182, 822], [1238, 118, 1564, 822]
];
let planAdjustment = null;
let floorRenderRevision = 0;
let adjustmentScroll = null;

function lockAdjustmentScroll(locked) {
  if (locked && !adjustmentScroll) {
    const body = document.body;
    adjustmentScroll = { x: window.scrollX, y: window.scrollY, style: body.style.cssText };
    document.documentElement.classList.add("adjustment-scroll-lock");
    body.style.position = "fixed";
    body.style.top = -adjustmentScroll.y + "px";
    body.style.left = -adjustmentScroll.x + "px";
    body.style.width = "100%";
    body.style.overflow = "hidden";
  } else if (!locked && adjustmentScroll) {
    const previous = adjustmentScroll;
    adjustmentScroll = null;
    document.documentElement.classList.remove("adjustment-scroll-lock");
    document.body.style.cssText = previous.style;
    window.scrollTo(previous.x, previous.y);
  }
}

// iOS touch scrolling and desktop wheel scrolling must also stay locked.
for (const type of ["touchmove", "wheel"]) {
  document.addEventListener(type, event => {
    if (adjustmentScroll) event.preventDefault();
  }, { passive: false });
}
document.addEventListener("keydown", event => {
  if (adjustmentScroll && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
      && event.target === document.body) event.preventDefault();
});


function startAdjustment(entry) {
  if (floorSnapshotOnly || photoUploads.has(entry.id)) return false;
  planAdjustment = { ...entry, scale: 1 };
  renderAdjustmentTools();
  return true;
}

function renderAdjustmentTools() {
  lockAdjustmentScroll(Boolean(planAdjustment));
  const host = $("marker-tools");
  host.hidden = !planAdjustment;
  if (!planAdjustment) { host.replaceChildren(); return; }
  const label = element("p", "拖曳「" + planAdjustment.name + "」，放開後自動儲存。");
  const cancel = button("取消", "quiet", () => { planAdjustment = null; render(); });
  host.replaceChildren(label, cancel);
}

function attachMarkerGesture(marker, svg, entry) {
  let timer, press, suppressClick = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  marker.onpointerdown = event => {
    if (event.button !== undefined && event.button !== 0) return;
    entry = entries.find(record => record.id === entry.id) || entry;
    event.stopPropagation();
    suppressClick = false;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    marker.setPointerCapture(event.pointerId);
    if (planAdjustment?.id === entry.id) return;
    timer = setTimeout(() => {
      if (!startAdjustment(entry)) return;
      suppressClick = true;
      marker.classList.add("adjusting");
    }, 1000);
  };
  marker.onpointermove = event => {
    if (!press || event.pointerId !== press.id) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (planAdjustment?.id !== entry.id) {
      if (distance > 10) { clear(); suppressClick = true; }
      return;
    }
    if (distance < 3 && !press.dragged) return;
    press.dragged = true;
    suppressClick = true;
    event.preventDefault();
    const point = svg.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const local = point.matrixTransform(matrix.inverse());
    const floor = floorNumber(ancestors(entry)[0]?.name || "");
    if (!floor) return;
    const [left, top, right, bottom] = planBounds[floor - 1];
    planAdjustment.x = Math.min(right - 12, Math.max(left + 12, local.x)) / 1672;
    planAdjustment.y = Math.min(bottom - 12, Math.max(top + 12, local.y)) / 941;
    marker.setAttribute("transform", `translate(${planAdjustment.x * 1672},${planAdjustment.y * 941}) scale(1.3)`);
  };
  marker.onpointerup = event => {
    if (press?.id !== event.pointerId) return;
    const dragged = press.dragged;
    press = null;
    clear();
    if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
    if (planAdjustment?.id !== entry.id) return;
    const record = planAdjustment;
    planAdjustment = null;
    if (dragged && (record.x !== entry.x || record.y !== entry.y)) {
      marker.classList.remove("adjusting");
      renderAdjustmentTools();
      queuePhotoUpload(record, { preserveMap: true });
    }
    else render();
  };
  const cancelPress = event => {
    if (press?.id !== event.pointerId) return;
    clear();
    press = null;
    suppressClick = true;
    if (planAdjustment?.id !== entry.id) return;
    planAdjustment = null;
    render();
  };
  marker.onpointercancel = cancelPress;
  marker.onlostpointercapture = cancelPress;
  marker.oncontextmenu = event => event.preventDefault();
  marker.onclick = event => {
    event.stopPropagation();
    if (suppressClick || planAdjustment) return;
    navigate(entries.find(record => record.id === entry.id) || entry);
  };
  marker.onkeydown = event => {
    if (event.key === "F2") {
      event.preventDefault(); event.stopPropagation();
      if (startAdjustment(entry)) renderFloorPlans("");
    }
  };
}

function formatTime(value) {
  if (!value || Number.isNaN(Date.parse(value))) return "尚無時間紀錄";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date(value));
}

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderFloorPlans(query) {
  floorRenderRevision++;
  $("floor-plans").hidden = Boolean(query) || Boolean(current && current.level > 0);
  const floor = ancestors(current).find(entry => entry.level === 0);
  const number = floor ? floorNumber(floor.name) : null;
  const host = $("floor-image");
  host.className = number ? "interactive-plan single-plan" : "interactive-plan";
  host.removeAttribute("role");
  const bounds = number ? planBounds[number - 1] : null;
  const view = bounds ? [bounds[0] - 8, 20, bounds[2] - bounds[0] + 16, 910] : [0, 0, 1672, 941];
  const svg = svgNode("svg", { viewBox: view.join(" "), "aria-label": "樓層平面圖", role: "group" });
  svg.append(svgNode("image", { href: "assets/floor-plans.png?v=62", width: 1672, height: 941 }));
  for (const stored of entries.filter(item => item.level !== 4 && Number.isFinite(item.x) && Number.isFinite(item.y))) {
    const entry = stored.id === planAdjustment?.id ? planAdjustment : stored;
    if (number && floorNumber(ancestors(entry)[0]?.name || "") !== number) continue;
    const marker = svgNode("g", {
      transform: `translate(${entry.x * 1672},${entry.y * 941}) scale(1.3)`,
      role: "button", tabindex: "0", "aria-label": "開啟存放空間：" + entry.name,
      class: "storage-marker" + (entry.id === current?.id ? " active" : "") + (entry.id === planAdjustment?.id ? " adjusting" : "")
    });
    const { photoOnly, color } = spaceAppearance(entry);
    const circle = svgNode("circle", { r: 19 });
    circle.style.fill = photoOnly ? "transparent" : color;
    if (photoOnly) circle.style.stroke = "none";
    marker.append(circle);
    if (photoOnly) addPhotoThumbnail(marker, entry, 38, color);
    else marker.append(svgNode("path", { d: defaultSpaceIcon }));
    if (!markerSettings.iconsOnly) {
      const size = 17 * markerSizes[markerSettings.size];
      const text = svgNode("text", { y: markerSettings.position === "above" ? -25 : 24 + size * .76, "text-anchor": "middle" });
      text.textContent = entry.name;
      text.style.fontSize = size + "px";
      text.style.fill = markerSettings.color;
      marker.append(text);
    }
    const open = event => { event.stopPropagation(); navigate(entries.find(record => record.id === entry.id) || entry); };
    marker.onclick = open;
    marker.onkeydown = event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); open(event); }
    };
    const keyboardOpen = marker.onkeydown;
    attachMarkerGesture(marker, svg, entry);
    const adjustKey = marker.onkeydown;
    marker.onkeydown = event => { adjustKey(event); if (!planAdjustment) keyboardOpen(event); };
    svg.append(marker);
  }
  host.replaceChildren(svg);
  $("floor-tabs").replaceChildren(...[1, 2, 3, 4].map(value => {
    const entry = entries.find(item => item.level === 0 && floorNumber(item.name) === value);
    const tab = button(value + "F", number === value ? "floor-tab selected" : "floor-tab", () => navigate(entry));
    tab.disabled = !entry;
    tab.setAttribute("aria-pressed", String(number === value));
    return tab;
  }), button("ALL", number ? "floor-tab" : "floor-tab selected", () => navigate(null)));
  renderAdjustmentTools();
}



// A space photo uses its own normalized coordinates, independent of floor markers.
// Choose whichever of black/white has the greater contrast against the sampled photo.
function markerTone(pixels) {
  let luminance = 0;
  let count = 0;
  const linear = channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  };
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255;
    luminance += alpha * (.2126 * linear(pixels[i]) + .7152 * linear(pixels[i + 1]) + .0722 * linear(pixels[i + 2])) + (1 - alpha);
    count++;
  }
  const average = count ? luminance / count : 1;
  return average + .05 >= .0525 / (average + .05) ? "dark" : "light";
}
let spaceLayoutGeneration = 0;
function addResizableSpacePhoto(host, canvas, image, spaceId) {
  const key = "jasonbox-space-photo-height:" + spaceId;
  const minimum = 120;
  const maximum = 1800;
  const viewport = element("div", "", "space-photo-viewport");
  const handle = element("div", "上下拖曳調整照片框", "space-photo-resize");
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", "調整照片框高度");
  handle.setAttribute("aria-valuemin", String(minimum));
  handle.setAttribute("aria-valuemax", String(maximum));
  let height;
  let drag;
  const showFullPhoto = () => {
    height = undefined;
    viewport.style.maxHeight = "none";
    viewport.style.height = "";
    canvas.style.minWidth = "";
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    handle.removeAttribute("aria-valuenow");
  };
  const fitPhoto = () => {
    if (!height || !image.naturalWidth || !image.naturalHeight) return;
    canvas.style.minWidth = Math.ceil(height * image.naturalWidth / image.naturalHeight) + "px";
  };
  const resize = value => {
    height = Math.min(maximum, Math.max(minimum, Math.round(value)));
    viewport.style.maxHeight = "none";
    viewport.style.height = height + "px";
    handle.setAttribute("aria-valuenow", String(height));
    fitPhoto();
  };
  const save = () => {
    if (!height) return;
    try { localStorage.setItem(key, String(height)); } catch {}
  };
  try {
    const saved = localStorage.getItem(key);
    if (saved === "fit") showFullPhoto();
    else if (Number.isInteger(Number(saved)) && Number(saved) >= minimum && Number(saved) <= maximum) resize(Number(saved));
  } catch {}
  handle.onpointerdown = event => {
    if (drag || event.button !== 0) return;
    drag = { id: event.pointerId, y: event.clientY, height: viewport.getBoundingClientRect().height };
    handle.setPointerCapture(event.pointerId);
  };
  handle.onpointermove = event => {
    if (drag?.id === event.pointerId) resize(drag.height + event.clientY - drag.y);
  };
  handle.onlostpointercapture = event => {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    save();
  };
  handle.onkeydown = event => {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    resize(viewport.getBoundingClientRect().height + (event.key === "ArrowDown" ? 24 : -24));
    save();
  };
  viewport.append(canvas);
  const controls = element("div", "", "space-photo-frame-controls");
  controls.append(handle, button("顯示全圖", "quiet", () => {
    showFullPhoto();
    try { localStorage.setItem(key, "fit"); } catch {}
  }));
  host.append(viewport, controls);
  return fitPhoto;
}

function renderSpaceLayout(query) {
  const generation = ++spaceLayoutGeneration;
  const host = $("space-layout");
  host.replaceChildren();
  host.hidden = Boolean(query) || !current || current.level === 0;
  if (host.hidden) return;
  const space = current;
  host.append(element("h2", space.name + "的位置圖"));
  const upload = button(space.hasPhoto ? "管理空間照片" : "上傳空間照片", "quiet", () => edit(space));
  upload.disabled = photoUploads.has(space.id);
  host.append(upload);
  if (uploadStatus(space)) host.append(button(uploadStatus(space), "quiet", () => openItem(space)));
  if (!space.hasPhoto) {
    host.append(element("p", "可上傳空間照片；按下方「加入」新增區、格、層或物品。", "muted"));
    return;
  }
  const canvas = element("div", "", "space-photo-canvas");
  const image = element("img", "", "space-photo");
  image.alt = space.name + "的照片";
  canvas.append(image);
  const fitPhoto = addResizableSpacePhoto(host, canvas, image, space.id);
  if (space.spaceAlbum) {
    const gallery = element("div", "", "batch-preview");
    host.append(gallery);
    drive.spacePhotos(space.id).then(files => {
      if (generation !== spaceLayoutGeneration) return;
      for (const file of files) {
        const tile = button("", "", () => edit(space));
        tile.setAttribute("aria-label", "管理照片：" + file.name);
        const placeholder = element("span", "照片", "thumb");
        tile.append(placeholder);
        gallery.append(tile);
        displayThumbnail(placeholder, { ...file, hasPhoto: true });
      }
    }).catch(() => {});
  }
  const imagePoint = value => {
    const x = Number.isFinite(value.photoX) ? value.photoX : .5;
    const y = Number.isFinite(value.photoY) ? value.photoY : .5;
    return space.coverTransform ? photoPoint(space.coverTransform, x, y) : [x, y];
  };
  const outsidePhoto = ([x, y]) => x < 0 || x > 1 || y < 0 || y > 1;
  const displayPoint = value => {
    const [x, y] = imagePoint(value);
    return [x, y].map(coordinate => Math.max(.05, Math.min(.95, coordinate)));
  };
  let samples;
  const markers = [];
  const recolor = (marker, value) => {
    if (!samples) return;
    const [displayX, displayY] = displayPoint(value);
    const x = Math.round(displayX * (samples.width - 1));
    const y = Math.round(displayY * (samples.height - 1));
    const left = Math.max(0, x - 8), top = Math.max(0, y - 8);
    const pixels = samples.context.getImageData(left, top, Math.min(17, samples.width - left), Math.min(17, samples.height - top)).data;
    marker.setAttribute("data-tone", markerTone(pixels));
  };
  image.onload = () => {
    if (generation !== spaceLayoutGeneration) return;
    fitPhoto();
    try {
      const sample = document.createElement("canvas");
      const scale = Math.min(256 / image.naturalWidth, 256 / image.naturalHeight);
      sample.width = Math.max(1, Math.round(image.naturalWidth * scale));
      sample.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = sample.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, sample.width, sample.height);
      samples = { width: sample.width, height: sample.height, context };
      for (const item of markers) recolor(item.marker, item.value);
    } catch {
      // The default black badge with a white outline remains legible if sampling is unavailable.
      samples = undefined;
    }
  };
  const show = blob => {
    if (generation !== spaceLayoutGeneration) return;
    image.src = URL.createObjectURL(blob);
    objectUrls.push(image.src);
  };
  if (space.photo) show(space.photo);
  else drive.photo(space.photoId).then(show).catch(error => {
    if (generation === spaceLayoutGeneration) host.append(element("p", "照片載入失敗：" + error.message, "muted"));
  });
  const pointAt = event => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(.97, Math.max(.03, (event.clientX - rect.left) / rect.width));
    const y = Math.min(.97, Math.max(.03, (event.clientY - rect.top) / rect.height));
    const [photoX, photoY] = space.coverTransform ? inversePhotoPoint(space.coverTransform, x, y) : [x, y];
    return { photoX, photoY };
  };
  const positions = entries.filter(entry => entry.parent === space.id && entry.level !== 4);
  for (const position of positions) {
    const marker = button("", "space-photo-marker", () => navigate(position));
    marker.setAttribute("aria-label", "開啟內部位置：" + position.name);
    const iconHost = element("span", "", "space-photo-icon");
    iconHost.append(spaceIconNode(position));
    marker.append(iconHost);
    if (!markerSettings.iconsOnly) {
      const label = element("span", position.name, "space-photo-label");
      label.style.fontSize = .85 * markerSizes[markerSettings.size] + "rem";
      if (markerSettings.position === "above") label.classList.add("label-above");
      if (markerSettings.color !== "#183d2a") {
        label.classList.add("custom-label");
        label.style.color = markerSettings.color;
      }
      marker.append(label);
    }
    marker.setAttribute("data-tone", "dark");
    const appearance = { marker, value: position };
    markers.push(appearance);
    const place = value => {
      const [x, y] = displayPoint(value);
      marker.style.left = x * 100 + "%";
      marker.style.top = y * 100 + "%";
      appearance.value = value;
      recolor(marker, value);
    };
    place(position);
    let drag;
    let suppressClick = false;
    marker.onclick = event => { event.stopPropagation(); if (!suppressClick) navigate(position); };
    marker.onpointerdown = event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.stopPropagation();
      suppressClick = false;
      drag = { x: event.clientX, y: event.clientY };
      marker.setPointerCapture(event.pointerId);
    };
    marker.onpointermove = event => {
      if (!drag) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8 && !suppressClick) return;
      suppressClick = true;
      drag.point = pointAt(event);
      place(drag.point);
    };
    marker.onpointerup = async event => {
      if (!drag) return;
      const point = drag.point;
      drag = null;
      if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
      if (!point) return;
      try {
        const saved = await drive.save({ ...position, ...point });
        entries = entries.map(entry => entry.id === saved.id ? saved : entry);
      } catch (error) {
        place(position);
        $("mutation-status").textContent = "位置移動尚未儲存：" + error.message;
      }
    };
    marker.onpointercancel = () => { drag = null; suppressClick = true; place(position); };
    canvas.append(marker);
  }
  const croppedPositions = positions.filter(position => outsidePhoto(imagePoint(position)));
  if (croppedPositions.length) {
    const shortcuts = element("nav", "", "cropped-position-links");
    shortcuts.setAttribute("aria-label", "原位置超出照片裁切範圍的空間");
    shortcuts.append(element("span", "原位置超出裁切範圍：", "muted"),
      ...croppedPositions.map(position => button(position.name, "secondary", () => navigate(position))));
    host.append(shortcuts);
  }
  host.append(element("p", space.level < 3 ? "按下方「加入」新增內部位置；拖曳圖示調整位置，點圖示查看內容。" : "點圖示查看內容。", "muted"));
}
