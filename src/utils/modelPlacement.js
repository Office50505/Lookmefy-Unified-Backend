export const DEFAULT_MODEL_PLACEMENT = Object.freeze({
  x: 0.5,
  floorY: 0.92,
  scale: 1
});

export function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

export function normalizedPlacement(placement = {}) {
  return {
    x: clamp(placement.x ?? DEFAULT_MODEL_PLACEMENT.x, 0.26, 0.74),
    floorY: clamp(placement.floorY ?? DEFAULT_MODEL_PLACEMENT.floorY, 0.72, 0.97),
    scale: clamp(placement.scale ?? DEFAULT_MODEL_PLACEMENT.scale, 0.72, 1.25)
  };
}

export function calculateModelPlacement({ stageWidth, stageHeight, imageWidth, imageHeight, placement, controlsInset = 0 }) {
  const width = Math.max(0, Number(stageWidth) || 0);
  const height = Math.max(0, Number(stageHeight) || 0);
  const naturalWidth = Math.max(1, Number(imageWidth) || 1);
  const naturalHeight = Math.max(1, Number(imageHeight) || 1);
  const current = normalizedPlacement(placement);

  if (!width || !height) {
    return {
      ...current,
      modelWidth: 0,
      modelHeight: 0,
      bottom: 0,
      leftPercent: current.x * 100,
      shadowWidth: 0,
      shadowHeight: 0
    };
  }

  const stageRatio = width / height;
  const heightRatio = width < 520 ? 0.62 : width < 900 ? 0.72 : 0.8;
  const reservedBottom = Math.max(56, Math.min(112, height * 0.11));
  const reservedTop = Math.max(18, height * 0.04);
  const floorY = clamp(current.floorY, (reservedTop + 120) / height, 1 - reservedBottom / height);
  const floorPx = height * floorY;
  const maxHeightByFloor = Math.max(160, floorPx - reservedTop);
  const maxHeightByStage = Math.max(160, height * heightRatio);
  const maxWidth = Math.max(150, width * (stageRatio < 0.9 ? 0.58 : 0.42) - controlsInset);
  const aspect = naturalWidth / naturalHeight;
  const targetHeight = Math.min(maxHeightByFloor, maxHeightByStage, maxWidth / aspect) * current.scale;
  const modelHeight = clamp(targetHeight, Math.min(150, height * 0.52), Math.max(160, maxHeightByFloor));
  const modelWidth = modelHeight * aspect;
  const halfWidthRatio = modelWidth / width / 2;
  const safeX = clamp(current.x, halfWidthRatio + 0.02, 1 - halfWidthRatio - 0.02);

  return {
    x: safeX,
    floorY,
    scale: current.scale,
    modelWidth,
    modelHeight,
    bottom: Math.max(0, height - floorPx),
    leftPercent: safeX * 100,
    shadowWidth: clamp(modelWidth * 0.42, 72, width * 0.24),
    shadowHeight: clamp(modelHeight * 0.035, 12, 28)
  };
}
