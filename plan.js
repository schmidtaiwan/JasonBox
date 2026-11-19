"use strict";

// Coordinates are stored relative to the original image, independent of screen size.
const planBounds = [
  [112, 42, 418, 873], [482, 118, 802, 822],
  [860, 118, 1182, 822], [1238, 118, 1564, 822]
];

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
  svg.append(svgNode("image", { href: "assets/floor-plans.png?v=5", width: 1672, height: 941 }));
  const addAt = (x, y) => {
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
  for (const entry of entries.filter(item => item.level !== 4 && Number.isFinite(item.x) && Number.isFinite(item.y))) {
    if (number && floorNumber(ancestors(entry)[0]?.name || "") !== number) continue;
    const marker = svgNode("g", {
      transform: `translate(${entry.x * 1672},${entry.y * 941}) scale(${number ? 1.3 : 3})`,
      role: "button", tabindex: "0", "aria-label": "開啟存放空間：" + entry.name,
      class: "storage-marker" + (entry.id === current?.id ? " active" : "")
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
}
