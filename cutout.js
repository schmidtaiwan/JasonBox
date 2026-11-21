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
function getCutoutWorker() {
  cutoutWorker ||= new Worker("cutout-worker.js?v=" + PAGE_BUILD, { type: "module" });
  return cutoutWorker;
}

function preloadCutoutModel() {
  if (typeof Worker !== "function" || cutoutWorker) return;
  try {
    const worker = getCutoutWorker();
    worker.onerror = () => {
      worker.terminate();
      if (cutoutWorker === worker) cutoutWorker = undefined;
    };
    worker.postMessage({ type: "preload" });
  } catch {
    cutoutWorker?.terminate();
    cutoutWorker = undefined;
  }
}

let pendingCutout = Promise.resolve();
function detectCutout(key, pixels, width, height, options) {
  const request = pendingCutout.then(() => sendCutoutRequest(key, pixels, width, height, options));
  pendingCutout = request.catch(() => {});
  return request;
}

function sendCutoutRequest(key, pixels, width, height, options) {
  const worker = getCutoutWorker();
  return new Promise((resolve, reject) => {
    const fail = () => {
      clearTimeout(timeout);
      worker.terminate();
      cutoutWorker = undefined;
      reject(new Error("無法載入輪廓擷取模型，請稍後再試。"));
    };
    const timeout = setTimeout(fail, options.type === "selected" ? 240000 : 120000);
    worker.onerror = fail;
    worker.onmessage = ({ data }) => {
      if (data.error) return fail();
      clearTimeout(timeout);
      resolve(data);
    };
    try { worker.postMessage({ key, pixels, width, height, ...options }, [pixels.buffer]); }
    catch { fail(); }
  });
}

function cutoutSource(image, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  const width = canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  return { canvas, context, width, height, pixels: context.getImageData(0, 0, width, height) };
}

function encodeCutout({ canvas, context, width, height, pixels }, mask) {
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

async function makeObjectCutout(image, point, key) {
  const source = cutoutSource(image, 900);
  const { mask } = await detectCutout(key, source.pixels.data.slice(), source.width, source.height, point);
  return encodeCutout(source, mask);
}

async function makeSelectedCutouts(image, key, prompts) {
  const source = cutoutSource(image, 640);
  const original = source.pixels.data.slice();
  const { masks } = await detectCutout(key, original.slice(), source.width, source.height, { type: "selected", prompts });
  const photos = [];
  for (const mask of masks) {
    source.pixels.data.set(original);
    const photo = await encodeCutout(source, mask);
    if (photo) photos.push(photo);
  }
  return photos;
}

async function makeHandDrawnCutouts(image, shapes) {
  const scale = Math.min(1, 1440 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const photos = [];
  for (const shape of shapes) {
    const xs = shape.map(point => point.x * width);
    const ys = shape.map(point => point.y * height);
    const left = Math.floor(Math.min(...xs));
    const top = Math.floor(Math.min(...ys));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(Math.max(...xs)) - left;
    canvas.height = Math.ceil(Math.max(...ys)) - top;
    if (canvas.width < 2 || canvas.height < 2) continue;
    const context = canvas.getContext("2d");
    context.beginPath();
    context.moveTo(xs[0] - left, ys[0] - top);
    for (let i = 1; i < shape.length; i++) context.lineTo(xs[i] - left, ys[i] - top);
    context.closePath();
    context.clip("evenodd");
    context.drawImage(image, -left, -top, width, height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) continue;
    const photo = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (photo) photos.push(photo);
  }
  return photos;
}

async function cropHandDrawnSource(source, originalUrl) {
  const url = source.file ? URL.createObjectURL(source.file) : originalUrl;
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return await makeHandDrawnCutouts(image, source.prompts.map(prompt => prompt.shape));
  } finally {
    if (source.file) URL.revokeObjectURL(url);
  }
}
