"use strict";

function photoTapPoint(image, clientX, clientY) {
  const rect = image.getBoundingClientRect();
  const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  return x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y } : null;
}

function applyCutoutMask(pixels, mask, width, height) {
  let left = width, right = -1, top = height, bottom = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || !pixels[i * 4 + 3]) {
      pixels[i * 4 + 3] = 0;
      continue;
    }
    const x = i % width;
    const y = Math.floor(i / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  return right >= left ? { left, top, width: right - left + 1, height: bottom - top + 1 } : null;
}

let cutoutWorker;
function detectCutout(key, pixels, width, height, point) {
  cutoutWorker ||= new Worker("cutout-worker.js?v=" + PAGE_BUILD, { type: "module" });
  const worker = cutoutWorker;
  return new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timeout);
      worker.terminate();
      cutoutWorker = undefined;
      reject(new Error("無法載入輪廓擷取模型，請稍後再試。"));
    };
    const timeout = setTimeout(fail, 120000);
    worker.onerror = fail;
    worker.onmessage = ({ data }) => {
      if (data.error) return fail();
      clearTimeout(timeout);
      resolve(data.mask || null);
    };
    try { worker.postMessage({ key, pixels, width, height, ...point }, [pixels.buffer]); }
    catch { fail(); }
  });
}

async function makeObjectCutout(image, point, key) {
  const scale = Math.min(1, 900 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  const width = canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  const mask = await detectCutout(key, pixels.data.slice(), width, height, point);
  if (!mask || mask.length !== width * height) return null;
  const bounds = applyCutoutMask(pixels.data, mask, width, height);
  if (!bounds) return null;
  context.putImageData(pixels, 0, 0);
  const result = document.createElement("canvas");
  result.width = bounds.width;
  result.height = bounds.height;
  result.getContext("2d").drawImage(canvas, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
  return new Promise(resolve => result.toBlob(resolve, "image/png"));
}
