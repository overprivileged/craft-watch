import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, normalizeLimits, limitCount, visibleRange } from '../site/display-limits.js';
import { openItemsAt } from '../site/activity.js';
import { readCommitHistory } from '../scripts/commit-history.mjs';
test('limits distinguish unlimited from malformed or empty values', () => {
  assert.deepEqual(normalizeLimits(), DEFAULT_LIMITS);
  assert.deepEqual(normalizeLimits({ arcs: 'all', commits: '250', releases: 0, prs: -1, issues: 1.5 }), { arcs: null, commits: 250, releases: null, prs: 20, opened: 100, issues: 20, merged: 100, closed: 100 });
  assert.equal(normalizeLimits({ commits: '', arcs: true }).commits, 100);
  assert.equal(normalizeLimits({ arcs: true }).arcs, 10);
  assert.equal(limitCount(null), Infinity);
});
test('commit and release caps follow the displayed time, including backwards seeks', () => {
  const events = [1, 2, 3, 4, 5].map((t) => ({ t }));
  assert.deepEqual(visibleRange(events, 3, 2), [1, 3]);
  assert.deepEqual(visibleRange(events, 5, 2), [3, 5]);
  assert.deepEqual(visibleRange(events, 1, 2), [0, 1]);
  assert.deepEqual(visibleRange(events, 3, null), [0, 3]);
  assert.deepEqual(visibleRange(events, 0, null), [0, 0]);
});
test('unlimited open markers do not silently retain the previous 20-item cap', () => {
  const items = Array.from({ length: 75 }, (_, i) => ({ number: i, state: 'OPEN', created_at: '2026-10-01T00:00:00Z' }));
  assert.equal(openItemsAt(items, Date.parse('2026-10-02'), limitCount(null)).length, 75);
  assert.equal(openItemsAt(items, Date.parse('2026-10-02'), 30).length, 30);
});
test('full commit collection paginates a pinned head and keeps same-time distinct commits', async () => {
  const calls = [];
  const result = await readCommitHistory(async (_, variables) => {
    calls.push(variables);
    return { repository: { object: { oid: 'pinned-head', history: {
      totalCount: 2, nodes: [{ oid: variables.after ? 'second' : 'first', committedDate: '2026-10-01T00:00:00Z' }],
      pageInfo: { hasNextPage: !variables.after, endCursor: 'next-page' },
    } } } };
  }, { owner: 'example', name: 'test', branch: 'main', since: '2026-09-25T00:00:00Z', until: '2026-10-25T00:00:00Z' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].head, 'pinned-head');
  assert.equal(calls[1].after, 'next-page');
  assert.equal(result.times.length, 2);
});
test('partial commit pagination is rejected instead of labelled complete', async () => {
  await assert.rejects(readCommitHistory(async () => ({ repository: { object: { oid: 'head', history: { totalCount: 3, nodes: [], pageInfo: { hasNextPage: false } } } } }), { owner: 'x', name: 'y', branch: 'main' }), /Incomplete commit history/);
});
