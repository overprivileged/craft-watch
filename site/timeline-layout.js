// Keep horizontal scale independent of app count; extra lanes grow the canvas vertically.
export function timelineLayout(appCount, labelWidth) {
  const width = 1920, top = 110;
  const extraHeight = Math.max(0, appCount - 2) * 90;
  const height = 720 + extraHeight;
  const core = { x: 100, y: 540 + extraHeight / 2 };
  const endX = width - 16 - 18 - Math.max(0, labelWidth);
  return {
    width, top, height, core, endX, nameX: endX + 18,
    timeStartX: core.x + (endX - core.x) / 3,
    laneTop: 230, laneBottom: top + height - 70,
    axisTop: 160, axisBottom: top + height - 40,
  };
}
