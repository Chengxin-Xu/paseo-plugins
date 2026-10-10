export type ViewportLayout = {
  imageWidth: number;
  imageHeight: number;
  offsetX: number;
  offsetY: number;
  scale: number;
};
export type ViewportLayoutInput = {
  containerWidth: number;
  containerHeight: number;
  frameWidth: number;
  frameHeight: number;
  mode?: 'fit' | 'actual';
};

/** Fit the complete frame inside the stage without upscaling. */
export function computeViewportLayout(input: ViewportLayoutInput): ViewportLayout {
  const { containerWidth, containerHeight, frameWidth, frameHeight } = input;
  if (![containerWidth, containerHeight, frameWidth, frameHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return { imageWidth: 0, imageHeight: 0, offsetX: 0, offsetY: 0, scale: 0 };
  }
  const scale = input.mode === 'actual' ? 1 : Math.min(1, containerWidth / frameWidth, containerHeight / frameHeight);
  const imageWidth = frameWidth * scale;
  const imageHeight = frameHeight * scale;
  const offsetX = (containerWidth - imageWidth) / 2;
  const offsetY = (containerHeight - imageHeight) / 2;
  return { imageWidth, imageHeight, offsetX: input.mode === 'actual' ? offsetX : Math.max(0, offsetX), offsetY: input.mode === 'actual' ? offsetY : Math.max(0, offsetY), scale };
}

/** Stage-local pointer coordinates. Letterbox bars never produce a page action. */
export function mapViewportPoint(point: { x: number; y: number }, layout: ViewportLayout, frame: { frameWidth: number; frameHeight: number }): { x: number; y: number } | null {
  if (![point.x, point.y, layout.scale, layout.imageWidth, layout.imageHeight, frame.frameWidth, frame.frameHeight].every(Number.isFinite) || layout.scale <= 0 || frame.frameWidth <= 0 || frame.frameHeight <= 0) return null;
  if (point.x < layout.offsetX || point.y < layout.offsetY || point.x >= layout.offsetX + layout.imageWidth || point.y >= layout.offsetY + layout.imageHeight) return null;
  const localX = point.x - layout.offsetX;
  const localY = point.y - layout.offsetY;
  if (localX < 0 || localY < 0 || localX >= layout.imageWidth || localY >= layout.imageHeight) return null;
  const x = localX / layout.scale;
  const y = localY / layout.scale;
  return x >= 0 && y >= 0 && x < frame.frameWidth && y < frame.frameHeight ? { x, y } : null;
}
