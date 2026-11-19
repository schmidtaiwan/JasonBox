"use strict";

// Coordinates are stored relative to the original image, independent of screen size.
const planBounds = [
  [112, 42, 418, 873], [482, 118, 802, 822],
  [860, 118, 1182, 822], [1238, 118, 1564, 822]
];
let planAdjustment = null;
let adjustingSave = false;
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

function markerScale(entry) {
  return Math.min(2.5, Math.max(.5, Number(entry.scale) || 1));
}

function startAdjustment(entry) {
  if (adjustingSave) return;
  planAdjustment = { ...entry, scale: markerScale(entry) };
  renderAdjustmentTools();
}

function renderAdjustmentTools() {
  lockAdjustmentScroll(Boolean(planAdjustment));
  const host = $("marker-tools");
  host.hidden = !planAdjustment;
  if (!planAdjustment) { host.replaceChildren(); return; }
  const label = element("p", "調整「" + planAdjustment.name + "」：拖曳圖示移動，使用按鈕調整大小。");
  const resize = amount => {
    planAdjustment.scale = Math.round(Math.min(2.5, Math.max(.5, planAdjustment.scale + amount)) * 10) / 10;
    renderFloorPlans("");
  };
  const smaller = button("縮小", "quiet", () => resize(-.1));
  const larger = button("放大", "quiet", () => resize(.1));
  const size = element("span", Math.round(planAdjustment.scale * 100) + "%", "marker-size");
  const save = button(adjustingSave ? "儲存中…" : "儲存調整", "primary", saveAdjustment);
  const cancel = button("取消", "quiet", () => { planAdjustment = null; render(); });
  for (const control of [smaller, larger, save, cancel]) control.disabled = adjustingSave;
  host.replaceChildren(label, smaller, size, larger, save, cancel);
}

async function saveAdjustment() {
  if (!planAdjustment || adjustingSave) return;
  adjustingSave = true;
  $("mutation-status").textContent = "";
  renderAdjustmentTools();
  try {
    const saved = await drive.save(planAdjustment);
    entries = entries.map(entry => entry.id === saved.id ? saved : entry);
    if (current?.id === saved.id) current = saved;
    planAdjustment = null;
    render();
  } catch (error) {
    if (error instanceof drive.SessionExpired) {
      adjustingSave = false;
      planAdjustment = null;
      signOut(error.message);
    }
    else $("mutation-status").textContent = "調整尚未儲存：" + error.message;
  } finally {
    adjustingSave = false;
    renderAdjustmentTools();
  }
}

function attachMarkerGesture(marker, svg, entry, number) {
  let timer, press, suppressClick = false;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  marker.onpointerdown = event => {
    if (adjustingSave || (event.button !== undefined && event.button !== 0)) return;
    event.stopPropagation();
    suppressClick = false;
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    marker.setPointerCapture(event.pointerId);
    if (planAdjustment?.id === entry.id) return;
    timer = setTimeout(() => {
      startAdjustment(entry);
      suppressClick = true;
      marker.classList.add("adjusting");
    }, 1000);
  };
  marker.onpointermove = event => {
    if (!press || event.pointerId !== press.id || adjustingSave) return;
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
    marker.setAttribute("transform", `translate(${planAdjustment.x * 1672},${planAdjustment.y * 941}) scale(${(number ? 1.3 : 3) * markerScale(planAdjustment)})`);
  };
  marker.onpointerup = event => {
    if (press?.id !== event.pointerId) return;
    clear();
    if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
    press = null;
  };
  marker.onpointercancel = () => { clear(); press = null; suppressClick = true; };
  marker.onlostpointercapture = () => { clear(); press = null; };
  marker.oncontextmenu = event => event.preventDefault();
  marker.onclick = event => {
    event.stopPropagation();
    if (suppressClick || planAdjustment) return;
    navigate(entry);
  };
  marker.onkeydown = event => {
    if (event.key === "F2") {
      event.preventDefault(); event.stopPropagation(); startAdjustment(entry); renderFloorPlans("");
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
  $("floor-plans").hidden = Boolean(query);
  const floor = ancestors(current).find(entry => entry.level === 0);
  const number = floor ? floorNumber(floor.name) : null;
  const host = $("floor-image");
  host.className = number ? "interactive-plan single-plan" : "interactive-plan";
  host.removeAttribute("role");
  const bounds = number ? planBounds[number - 1] : null;
  const view = bounds ? [bounds[0] - 20, 20, bounds[2] - bounds[0] + 40, 910] : [0, 0, 1672, 941];
  const svg = svgNode("svg", { viewBox: view.join(" "), "aria-label": "點選平面圖新增存放空間", role: "group" });
  svg.append(svgNode("image", { href: "assets/floor-plans.png?v=14", width: 1672, height: 941 }));
  const addAt = (x, y) => {
    if (planAdjustment || adjustingSave) return;
    const index = planBounds.findIndex(([left, top, right, bottom]) => x >= left && x <= right && y >= top && y <= bottom);
    if (index < 0) return;
    const parent = entries.find(entry => entry.level === 0 && floorNumber(entry.name) === index + 1);
    if (!parent) return;
    edit(null, { parent: parent.id, level: 1, x: x / 1672, y: y / 941 });
  };
  svg.onclick = event => {
    // Map CSS pixels through the SVG transform, including letterboxing.
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const local = point.matrixTransform(matrix.inverse());
    addAt(local.x, local.y);
  };
  svg.setAttribute("tabindex", "0");
  svg.onkeydown = event => {
    if (event.target !== svg || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    const [left, top, right, bottom] = bounds || planBounds[0];
    addAt((left + right) / 2, (top + bottom) / 2);
  };
  for (const stored of entries.filter(item => item.level !== 4 && Number.isFinite(item.x) && Number.isFinite(item.y))) {
    const entry = stored.id === planAdjustment?.id ? planAdjustment : stored;
    if (number && floorNumber(ancestors(entry)[0]?.name || "") !== number) continue;
    const marker = svgNode("g", {
      transform: `translate(${entry.x * 1672},${entry.y * 941}) scale(${(number ? 1.3 : 3) * markerScale(entry)})`,
      role: "button", tabindex: "0", "aria-label": "開啟存放空間：" + entry.name,
      class: "storage-marker" + (entry.id === current?.id ? " active" : "") + (entry.id === planAdjustment?.id ? " adjusting" : "")
    });
    marker.append(svgNode("circle", { r: 19 }), svgNode("path", { d: "M-9-7H9V8H-9Z M-9-1H9 M-3-4H3 M-3 3H3" }));
    const text = svgNode("text", { y: 37, "text-anchor": "middle" });
    text.textContent = entry.name;
    marker.append(text);
    const open = event => { event.stopPropagation(); navigate(entry); };
    marker.onclick = open;
    marker.onkeydown = event => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); open(event); }
    };
    const keyboardOpen = marker.onkeydown;
    attachMarkerGesture(marker, svg, entry, number);
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
  }), button("全部樓層", "quiet", () => navigate(null)));
  renderAdjustmentTools();
}
