"use strict";

const floorThumbs = new Map();
let floorSnapshotSignature;
let floorSnapshotSession = 0;
let floorSnapshotWriting = false;
let floorSnapshotDirty = false;

function floorPhotoKey(entry) {
  return (entry.photoId || entry.id) + ":" + (entry.coverTransform?.join(",") || "");
}

function floorSnapshotRecords(allEntries) {
  return allEntries.filter(entry => entry.level === 0 ||
    (entry.level === 1 && Number.isFinite(entry.x) && Number.isFinite(entry.y)))
    .map(({ id, level, parent, name, x, y, hasPhoto, photoId, coverTransform, updatedAt, updatedBy }) =>
      ({ id, level, parent, name, x, y, hasPhoto, photoId, coverTransform, updatedAt, updatedBy }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function restoreFloorSnapshot(snapshot) {
  if (snapshot?.schema !== 1 || !Array.isArray(snapshot.records) ||
      !snapshot.records.some(entry => entry.level === 0) || snapshot.records.some(entry =>
        typeof entry?.id !== "string" || typeof entry.name !== "string" || ![0, 1].includes(entry.level))) return null;
  const records = floorSnapshotRecords(snapshot.records);
  for (const entry of records) {
    const key = floorPhotoKey(entry);
    const value = snapshot.thumbs?.[key];
    if (typeof value === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value)) floorThumbs.set(key, value);
  }
  floorSnapshotSignature = JSON.stringify(records);
  return records;
}

async function makeFloorThumbnail(entry) {
  const blob = await loadSnapshotPhoto(entry.photoId, entry.updatedAt);
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    canvas.getContext("2d").drawImage(image, (image.naturalWidth - edge) / 2,
      (image.naturalHeight - edge) / 2, edge, edge, 0, 0, 96, 96);
    return canvas.toDataURL("image/jpeg", .72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function updateFloorSnapshot() {
  if (!signedIn || floorSnapshotOnly || !drive.writeFloorSnapshot) return;
  floorSnapshotDirty = true;
  if (floorSnapshotWriting) return;
  floorSnapshotWriting = true;
  const session = floorSnapshotSession;
  try {
    while (floorSnapshotDirty && session === floorSnapshotSession && signedIn) {
      floorSnapshotDirty = false;
      const records = floorSnapshotRecords(entries.filter(entry => !photoUploads.has(entry.id)));
      const signature = JSON.stringify(records);
      const photos = records.filter(entry => entry.level === 1 && entry.photoId);
      if (signature === floorSnapshotSignature && photos.every(entry => floorThumbs.has(floorPhotoKey(entry)))) continue;
      const thumbs = {};
      for (let offset = 0; offset < photos.length && session === floorSnapshotSession; offset += 4) {
        await Promise.all(photos.slice(offset, offset + 4).map(async entry => {
          const key = floorPhotoKey(entry);
          try {
            thumbs[key] = floorThumbs.get(key) || await makeFloorThumbnail(entry);
            if (session === floorSnapshotSession) floorThumbs.set(key, thumbs[key]);
          } catch {
            // Keep the marker available even if its photo cannot be downloaded.
          }
        }));
      }
      if (session !== floorSnapshotSession) return;
      if (photoUploads.size || floorSnapshotDirty) continue;
      await drive.writeFloorSnapshot({ schema: 1, records, thumbs });
      floorSnapshotSignature = signature;
      for (const key of floorThumbs.keys()) if (!Object.hasOwn(thumbs, key)) floorThumbs.delete(key);
    }
  } catch {
    // The full inventory is still available if the snapshot cannot be saved.
  } finally {
    floorSnapshotWriting = false;
    if (floorSnapshotDirty && signedIn) void updateFloorSnapshot();
  }
}

function clearFloorSnapshot() {
  floorSnapshotSession++;
  floorSnapshotDirty = false;
  floorSnapshotSignature = undefined;
  floorThumbs.clear();
}
