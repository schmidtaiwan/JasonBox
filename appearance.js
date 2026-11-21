"use strict";
const spaceColors = ["#244d38", "#1768a6", "#7544a0", "#b73559", "#b85208", "#8a6500", "#087b7b", "#444444"];

function spaceAppearance(entry) {
  // The order is independent of names and display order.
  const siblings = entries.filter(space => space.level > 0 && space.level < 4 && space.parent === entry.parent)
    .map(space => String(space.id)).sort();
  const index = Math.max(0, siblings.indexOf(String(entry.id)));
  const color = spaceColors[index] || generatedSpaceColor(index);
  return { photoOnly: entry.markerMode !== "name" && Boolean(entry.hasPhoto || entry.photo), color };
}

function generatedSpaceColor(index) {
  const hue = (index * 137.508) % 360;
  const channel = offset => {
    const sector = (offset + hue / 30) % 12;
    const value = .35 - .62 * .35 * Math.max(-1, Math.min(sector - 3, 9 - sector, 1));
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return "#" + channel(0) + channel(8) + channel(4);
}

const spaceNameSegments = Intl.Segmenter && new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
function spaceMarkerText(entry, color) {
  const text = svgNode("text", {
    class: "space-marker-initials", "text-anchor": "middle", "dominant-baseline": "central",
    "aria-hidden": "true"
  });
  const name = entry.name.trim();
  const characters = spaceNameSegments ? Array.from(spaceNameSegments.segment(name), value => value.segment) : Array.from(name);
  text.textContent = characters.slice(0, 2).join("");
  const rgb = color.slice(1).match(/../g).map(channel => parseInt(channel, 16));
  text.style.fill = markerTone([...rgb, 255]) === "dark" ? "#000" : "#fff";
  return text;
}

let photoClipSequence = 0;
function addPhotoThumbnail(svg, entry, size, color) {
  if (!entry.hasPhoto && !entry.photo) return;
  const draw = url => {
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
    rim.style.stroke = "var(--space-photo-rim, " + color + ")";
    rim.style.strokeWidth = "1.5";
    svg.append(defs, image, rim);
  };
  const cached = floorThumbs.get(floorPhotoKey(entry));
  if (cached && !entry.photo) { draw(cached); return; }
  if (floorSnapshotOnly) return;
  const pending = entry.photo ? Promise.resolve(entry.photo) : loadSnapshotPhoto(entry.photoId || entry.id, entry.updatedAt);
  pending.then(blob => {
    if (!svg.isConnected) return;
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    draw(url);
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
    spaceMarkerText(entry, appearance.color));
  return svg;
}
function renderCurrentSpaceIcon() {
  const host = $("current-space-icon");
  host.hidden = !current || current.level === 0;
  host.replaceChildren();
  if (host.hidden) return;
  host.append(spaceIconNode(current));
}
