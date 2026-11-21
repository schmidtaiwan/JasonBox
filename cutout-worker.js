import { env, AutoProcessor, SamModel, RawImage, Tensor } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = new URL("./models/", self.location.href).href;
env.useBrowserCache = true;
env.backends.onnx.wasm.numThreads = 1;
const modelId = "slimsam-77-uniform";
let tools;
let prepared;

function loadCutoutTools() {
  tools ||= Promise.all([
    SamModel.from_pretrained(modelId, { quantized: true }),
    AutoProcessor.from_pretrained(modelId)
  ]).catch(error => {
    tools = undefined;
    throw error;
  });
  return tools;
}


async function masksAt(model, processor, width, height, x, y) {
  const { inputs, embeddings } = prepared;
  const [resizedHeight, resizedWidth] = inputs.reshaped_input_sizes[0];
  const prediction = await model({
    ...embeddings,
    input_points: new Tensor("float32", [x * resizedWidth, y * resizedHeight], [1, 1, 1, 2]),
    input_labels: new Tensor("int64", [1n], [1, 1, 1])
  });
  const masks = (await processor.post_process_masks(prediction.pred_masks,
    inputs.original_sizes, inputs.reshaped_input_sizes))[0][0];
  const stride = width * height;
  const index = Math.floor(y * height) * width + Math.floor(x * width);
  return Array.from(prediction.iou_scores.data, (score, i) => {
    const mask = masks.data.subarray(i * stride, (i + 1) * stride);
    return { score, mask, area: mask.length === stride && mask[index]
      ? mask.reduce((sum, value) => sum + Number(Boolean(value)), 0) : 0 };
  }).sort((a, b) => b.score - a.score);
}

function rasterizeOutline(shape, width, height) {
  const mask = new Uint8Array(width * height);
  let area = 0;
  let point;
  let bestSpan = 0;
  const centerY = shape.reduce((sum, point) => sum + point.y, 0) / shape.length;
  for (let row = 0; row < height; row++) {
    const y = (row + .5) / height;
    const crossings = [];
    for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) {
      const a = shape[i], b = shape[j];
      if ((a.y > y) !== (b.y > y)) crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const start = Math.max(0, Math.ceil(crossings[i] * width - .5));
      const end = Math.min(width, Math.ceil(crossings[i + 1] * width - .5));
      if (end <= start) continue;
      mask.fill(1, row * width + start, row * width + end);
      area += end - start;
      const span = (end - start) / (1 + 4 * Math.abs(y - centerY));
      if (span > bestSpan) {
        bestSpan = span;
        point = { x: (start + end) / (2 * width), y };
      }
    }
  }
  return { mask, area, point };
}

function outlineOverlap(candidate, outline) {
  let intersection = 0;
  for (let i = 0; i < outline.mask.length; i++) {
    if (outline.mask[i] && candidate.mask[i]) intersection++;
  }
  return intersection / (candidate.area + outline.area - intersection);
}

async function selectPromptMask(model, processor, width, height, prompt) {
  const outline = prompt.shape && rasterizeOutline(prompt.shape, width, height);
  const point = outline ? outline.point : prompt;
  if (!point) return;
  const masks = await masksAt(model, processor, width, height, point.x, point.y);
  const candidates = masks.filter(({ area }) => area >= 4 && area <= width * height * .95);
  if (!outline) return candidates[0];
  return candidates.map(candidate => ({ ...candidate, overlap: outlineOverlap(candidate, outline) }))
    .sort((a, b) => b.overlap - a.overlap)
    .find(candidate => candidate.overlap >= .12);
}

function distinctMasks(candidates, limit) {
  const selected = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const duplicate = selected.some(other => {
      let intersection = 0;
      for (let i = 0; i < candidate.mask.length; i++) {
        if (candidate.mask[i] && other.mask[i]) intersection++;
      }
      return intersection / Math.min(candidate.area, other.area) > .8;
    });
    if (!duplicate) selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected.map(({ mask }) => Uint8Array.from(mask));
}

self.onmessage = async ({ data: { type, key, pixels, width, height, x, y, prompts } }) => {
  try {
    const [model, processor] = await loadCutoutTools();
    if (type === "preload") return;
    if (prepared?.key !== key || prepared.width !== width || prepared.height !== height) {
      const image = new RawImage(pixels, width, height, 4).rgb();
      const inputs = await processor(image);
      prepared = { key, width, height, inputs, embeddings: await model.get_image_embeddings(inputs) };
    }
    const stride = width * height;
    if (type === "selected") {
      const candidates = [];
      for (const prompt of prompts) {
        const candidate = await selectPromptMask(model, processor, width, height, prompt);
        if (candidate) candidates.push(candidate);
      }
      const masks = distinctMasks(candidates, 12);
      self.postMessage({ masks }, masks.map(mask => mask.buffer));
    } else {
      const candidates = await masksAt(model, processor, width, height, x, y);
      const candidate = candidates.find(({ area }) => area >= 4 && area <= stride * .95);
      const mask = candidate && Uint8Array.from(candidate.mask);
      self.postMessage({ mask }, mask ? [mask.buffer] : []);
    }
  } catch {
    if (type !== "preload") self.postMessage({ error: true });
  }
};
