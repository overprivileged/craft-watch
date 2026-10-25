import { normalizeArcFilter, arcDraw } from './arc-selection.js';
import { DEFAULT_LIMITS } from './display-limits.js';

export function normalizeEventFilters(values = {}) {
  return Object.fromEntries(Object.keys(DEFAULT_LIMITS).map(key => [key, normalizeArcFilter(values?.[key])]));
}

export const effectiveLimit = (limit, filter) => filter.mode === 'probability' ? null : limit;

// Assign identities before any time-window filtering. Timestamp-only commits can
// share a timestamp; occurrence numbers let each recorded commit get its own draw.
export function sampleRecords(records, repo, key, filter, identity) {
  if (filter.mode !== 'probability') return records;
  const occurrences = new Map();
  return records.filter(record => {
    const id = String(identity(record));
    const occurrence = occurrences.get(id) ?? 0;
    occurrences.set(id, occurrence + 1);
    return arcDraw(repo, `${key}:${id}:${occurrence}`, filter.seed) < filter.probability;
  });
}
