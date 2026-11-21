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
        const masks = await masksAt(model, processor, width, height, prompt.x, prompt.y);
        const candidate = masks.find(({ area }) => area >= 4 && area <= stride * .95);
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
