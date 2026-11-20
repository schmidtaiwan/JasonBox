import { env, AutoProcessor, SamModel, RawImage, Tensor } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;
env.backends.onnx.wasm.numThreads = 1;
const modelId = "Xenova/slimsam-77-uniform";
let tools;
let prepared;

self.onmessage = async ({ data: { key, pixels, width, height, x, y } }) => {
  try {
    tools ||= Promise.all([
      SamModel.from_pretrained(modelId, { quantized: true }),
      AutoProcessor.from_pretrained(modelId)
    ]);
    const [model, processor] = await tools;
    if (prepared?.key !== key) {
      const image = new RawImage(pixels, width, height, 4).rgb();
      const inputs = await processor(image);
      prepared = { key, inputs, embeddings: await model.get_image_embeddings(inputs) };
    }
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
    const index = Math.min(height - 1, Math.floor(y * height)) * width + Math.min(width - 1, Math.floor(x * width));
    const candidates = Array.from(prediction.iou_scores.data, (score, i) => ({ score, i }))
      .sort((a, b) => b.score - a.score);
    for (const { i } of candidates) {
      const mask = masks.data.subarray(i * stride, (i + 1) * stride);
      if (mask.length !== stride || !mask[index]) continue;
      const area = mask.reduce((sum, value) => sum + Number(Boolean(value)), 0);
      if (area < 4 || area > stride * .95) continue;
      const result = Uint8Array.from(mask);
      self.postMessage({ mask: result }, [result.buffer]);
      return;
    }
    self.postMessage({ empty: true });
  } catch {
    self.postMessage({ error: true });
  }
};
