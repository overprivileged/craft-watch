import { visibleRange } from './display-limits.js';
import { upperBound } from './activity.js';
export function normalizeArcFilter(value = {}) {
  const p = value?.probability;
  const number = typeof p === 'number' || (typeof p === 'string' && p.trim() !== '') ? Number(p) : NaN;
  const seed = Number(value?.seed);
  return { mode: value?.mode === 'probability' ? 'probability' : 'count', probability: Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0.5, seed: Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : 1 };
}
// One stable pseudo-random draw per PR, independent of ordering, time and styling.
export function arcDraw(repo, number, seed) {
  let hash = 2166136261;
  for (const char of `${seed}:${repo}:${number}`) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15; hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}
export function selectArcs(events, time, { repo, filter, count, eligible = null }) {
  const chosen = new Map();
  const seen = new Set();
  for (let i = upperBound(events, time) - 1; i >= 0; i--) {
    const pr = events[i].pr;
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (eligible && !eligible.has(pr.number)) continue;
    if (filter.mode === 'probability' && arcDraw(repo, pr.number, filter.seed) >= filter.probability) continue;
    chosen.set(pr.number, pr);
    if (filter.mode === 'count' && chosen.size >= count) break;
  }
  return [...chosen.values()].sort((a, b) => a.number - b.number);
}

// A connector exists only when both of its actual event markers are visible.
export function connectorPRs(opened, merged, time, limits) {
  const [openFrom, openTo] = visibleRange(opened, time, limits.opened);
  const [mergeFrom, mergeTo] = visibleRange(merged, time, limits.merged);
  const starts = new Set(opened.slice(openFrom, openTo).map(entry => entry.pr.number));
  return new Set(merged.slice(mergeFrom, mergeTo).filter(entry => starts.has(entry.pr.number)).map(entry => entry.pr.number));
}
