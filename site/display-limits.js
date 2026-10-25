export const DEFAULT_LIMITS = Object.freeze({ arcs: 10, commits: 100, releases: null, prs: 20, opened: 100, issues: 20, merged: 100, closed: 100 });
export function validLimit(value, fallback) {
  if (value === null || value === 'all') return null;
  const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return typeof value !== 'boolean' && Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
export function normalizeLimits(values = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [key, validLimit(values?.[key], fallback)]));
}
export const limitCount = (value) => value === null ? Infinity : value;
export function visibleRange(items, time, cap) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].t <= time) lo = mid + 1; else hi = mid;
  }
  return [cap === null ? 0 : Math.max(0, lo - cap), lo];
}
