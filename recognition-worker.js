"use strict";

let model;
self.onmessage = async ({ data: { pixels, width, height } }) => {
  let input;
  try {
    if (!model) {
      importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js",
        "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js");
      await self.tf.setBackend("cpu");
      model = await self.cocoSsd.load({ base: "lite_mobilenet_v2" });
    }
    const rgb = new Int32Array(width * height * 3);
    for (let from = 0, to = 0; from < pixels.length; from += 4, to += 3) {
      rgb[to] = pixels[from];
      rgb[to + 1] = pixels[from + 1];
      rgb[to + 2] = pixels[from + 2];
    }
    input = self.tf.tensor3d(rgb, [height, width, 3], "int32");
    const results = await model.detect(input, 20, .5);
    self.postMessage({ names: [...new Set(results.map(result => result.class))] });
  } catch {
    self.postMessage({ error: true });
  } finally {
    input?.dispose();
  }
};
