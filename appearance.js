"use strict";
const defaultSpaceIcon = "M-9-8H9V9H-9Z M-9-1H9 M-3-5H3 M-3 4H3";
const spaceColors = ["#244d38", "#1768a6", "#7544a0", "#b73559", "#b85208", "#8a6500", "#087b7b", "#444444"];

function spaceAppearance(entry) {
  // The order is independent of names and display order.
  const siblings = entries.filter(space => space.level > 0 && space.level < 4 && space.parent === entry.parent)
    .map(space => String(space.id)).sort();
  const index = Math.max(0, siblings.indexOf(String(entry.id)));
  const color = spaceColors[index] || "hsl(" + ((index * 137.508) % 360).toFixed(2) + " 62% 35%)";
  return { photoOnly: Boolean(entry.hasPhoto || entry.photo), color };
}

const iconPhotoCache = new Map();
let photoClipSequence = 0;
function addPhotoThumbnail(svg, entry, size, color) {
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
    const radius = size / 2;
    const image = svgNode("image", {
      href: url, x: -radius, y: -radius, width: size, height: size,
      preserveAspectRatio: "xMidYMid slice", "pointer-events": "none"
    });
    const clipId = "space-photo-clip-" + ++photoClipSequence;
    const clip = svgNode("clipPath", { id: clipId });
    clip.append(svgNode("circle", { r: radius }));
    const defs = svgNode("defs", {});
    defs.append(clip);
    image.setAttribute("clip-path", "url(#" + clipId + ")");
    const rim = svgNode("circle", { r: radius, "pointer-events": "none" });
    rim.style.fill = "none";
    rim.style.stroke = color;
    rim.style.strokeWidth = "1.5";
    svg.append(defs, image, rim);
  }).catch(() => {});
}
function spaceIconNode(entry) {
  const appearance = spaceAppearance(entry);
  const svg = svgNode("svg", { viewBox: "-24 -24 48 48", "aria-hidden": "true", class: "space-choice-icon" });
  if (appearance.photoOnly) {
    addPhotoThumbnail(svg, entry, 44, appearance.color);
    return svg;
  }
  svg.append(svgNode("circle", { r: 22, fill: appearance.color }),
    svgNode("path", { d: defaultSpaceIcon, fill: "none", stroke: "white", "stroke-width": 2, "stroke-linejoin": "round" }));
  return svg;
}
function renderCurrentSpaceIcon() {
  const host = $("current-space-icon");
  host.hidden = !current || current.level === 0;
  host.replaceChildren();
  if (host.hidden) return;
  host.append(spaceIconNode(current));
}
