"use strict";

const identityPhoto = [1, 0, 0, 1, 0, 0];

function photoPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix || identityPhoto;
  return [a * x + c * y + e, b * x + d * y + f];
}

function inversePhotoPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix || identityPhoto;
  const det = a * d - b * c;
  return [(d * (x - e) - c * (y - f)) / det, (a * (y - f) - b * (x - e)) / det];
}

function combinePhotoTransforms(next, previous) {
  const [a, b, c, d, e, f] = previous || identityPhoto;
  const [x, y] = photoPoint(next, e, f);
  const [right, down] = [photoPoint(next, a + e, b + f), photoPoint(next, c + e, d + f)];
  return [right[0] - x, right[1] - y, down[0] - x, down[1] - y, x, y];
}

async function editPhotoImage(blob, apply) {
  const dialog = document.getElementById("photo-editor");
  const canvas = document.getElementById("photo-canvas");
  const rotate = document.getElementById("rotate-photo");
  const reset = document.getElementById("reset-crop");
  const confirm = document.getElementById("apply-crop");
  const sliders = Array.from(dialog.querySelectorAll('input[type="range"]'));
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  let turns = 0;
  const context = canvas.getContext("2d");
  let transform;

  function draw() {
    const odd = turns % 2;
    const sourceWidth = image.naturalWidth;
    const sourceHeight = image.naturalHeight;
    const width = odd ? sourceHeight : sourceWidth;
    const height = odd ? sourceWidth : sourceHeight;
    const [left, top, right, bottom] = sliders.map(input => Number(input.value) / 100);
    const cropWidth = 1 - left - right;
    const cropHeight = 1 - top - bottom;
    const scale = Math.min(1, 1440 / Math.max(width * cropWidth, height * cropHeight));
    canvas.width = Math.max(1, Math.round(width * cropWidth * scale));
    canvas.height = Math.max(1, Math.round(height * cropHeight * scale));
    context.setTransform(canvas.width / (width * cropWidth), 0, 0, canvas.height / (height * cropHeight), 0, 0);
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width * cropWidth, height * cropHeight);
    context.translate(width * (.5 - left), height * (.5 - top));
    context.rotate(turns * Math.PI / 2);
    context.drawImage(image, -sourceWidth / 2, -sourceHeight / 2);
    const rotation = [identityPhoto, [0, 1, -1, 0, 1, 0], [-1, 0, 0, -1, 1, 1], [0, -1, 1, 0, 0, 1]][turns];
    transform = combinePhotoTransforms([1 / cropWidth, 0, 0, 1 / cropHeight, -left / cropWidth, -top / cropHeight], rotation);
  }

  try {
    await image.decode();
    if (dialog.open) return;
    const resetValues = () => sliders.forEach(input => { input.value = "0"; });
    resetValues();
    confirm.disabled = false;
    rotate.onclick = () => { turns = (turns + 1) % 4; resetValues(); draw(); };
    reset.onclick = () => { turns = 0; resetValues(); draw(); };
    for (const input of sliders) input.oninput = draw;
    document.getElementById("cancel-crop").onclick = () => dialog.close();
    confirm.onclick = () => {
      confirm.disabled = true;
      const appliedTransform = transform;
      canvas.toBlob(result => {
        if (!dialog.open) return;
        if (result) {
          apply(result, appliedTransform);
          dialog.close();
        } else confirm.disabled = false;
      }, "image/jpeg", .88);
    };
    draw();
    dialog.showModal();
    await new Promise(resolve => dialog.addEventListener("close", resolve, { once: true }));
  } finally {
    URL.revokeObjectURL(url);
  }
}
