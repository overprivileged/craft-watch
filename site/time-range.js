const HOUR = 3600e3;
export const LATEST_RANGES = Object.freeze({
  '1h': HOUR, '8h': 8 * HOUR, '1d': 24 * HOUR, '3d': 72 * HOUR,
  '7d': 168 * HOUR, '14d': 336 * HOUR, '30d': 720 * HOUR,
});

export function normalizeRange(value) {
  return Object.hasOwn(LATEST_RANGES, value) ? value : '30d';
}

export function rangeStart(availableStart, end, range) {
  return Math.min(end, Math.max(availableStart, end - LATEST_RANGES[normalizeRange(range)]));
}

export function timePosition(time, start, end) {
  if (end <= start) return 1;
  return Math.min(1, Math.max(0, (time - start) / (end - start)));
}

// PST is fixed UTC−8, including dates when Pacific daylight time is in effect.
export function pstMidnights(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const day = 24 * HOUR, offset = 8 * HOUR;
  const first = Math.ceil((start - offset) / day) * day + offset;
  const ticks = [];
  for (let time = first; time <= end; time += day) ticks.push(time);
  return ticks;
}
