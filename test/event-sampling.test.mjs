import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEventFilters, effectiveLimit, sampleRecords } from '../site/event-sampling.js';
import { connectorPRs, selectArcs } from '../site/arc-selection.js';
import { visibleRange } from '../site/display-limits.js';
import { openItemsAt } from '../site/activity.js';

const records = Array.from({ length: 1000 }, (_, number) => ({ number, t: number, pr: { number } }));
const filter = { mode: 'probability', probability: 0.5, seed: 1 };
const sample = (key, f = filter, list = records) => sampleRecords(list, 'owner/repo', key, f, r => r.number);

test('every layer supports validated count/probability settings, including zero and one', () => {
  const filters = normalizeEventFilters({ commits: { mode: 'probability', probability: 0 }, merged: { mode: 'probability', probability: 1 }, prs: { mode: 'bad', probability: 9 } });
  assert.equal(filters.commits.probability, 0);
  assert.equal(filters.merged.probability, 1);
  assert.equal(filters.prs.mode, 'count');
  for (const key of Object.keys(filters).filter(key => key !== 'arcs')) {
    assert.equal(sample(key, { ...filter, probability: 0 }).length, 0);
    assert.equal(sample(key, { ...filter, probability: 1 }).length, records.length);
    assert.equal(sample(key, { ...filter, mode: 'count' }), records);
    assert.equal(effectiveLimit(20, filter), null);
    assert.equal(effectiveLimit(20, { mode: 'count' }), 20);
  }
});

test('samples are stable, distributed across history, and independent between layers and resamples', () => {
  const a = sample('commits');
  assert.deepEqual(sample('commits'), a);
  assert.deepEqual(sample('commits', filter, [...records].reverse()).reverse(), a);
  assert(a.length > 400 && a.length < 600);
  assert(a.some(r => r.t < 100) && a.some(r => r.t > 900));
  assert.notDeepEqual(sample('commits', { ...filter, seed: 2 }), a);
  assert.notDeepEqual(sample('merged'), a);
  const [, reached] = visibleRange(a, 500, effectiveLimit(2, filter));
  assert.deepEqual(a.slice(0, reached), a.filter(r => r.t <= 500));
  const zoomed = a.filter(r => r.t > 200 && r.t <= 500);
  assert.deepEqual(sample('commits').filter(r => r.t > 200 && r.t <= 500), zoomed);
});

test('timestamp-only commits at the same time receive independent draws', () => {
  const times = Array(100).fill('2026-10-25T00:00:00Z');
  const result = sampleRecords(times, 'owner/repo', 'commits', filter, iso => iso);
  assert(result.length > 25 && result.length < 75);
  assert.deepEqual(sampleRecords(times, 'owner/repo', 'commits', filter, iso => iso), result);
});

test('sampling preserves open state and connector endpoint requirements while replay rewinds', () => {
  const items = [
    { number: 1, created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-03T00:00:00Z', state: 'MERGED' },
    { number: 2, created_at: '2026-10-02T00:00:00Z', state: 'OPEN' },
  ];
  const all = { ...filter, probability: 1 };
  assert.equal(openItemsAt(sampleRecords(items, 'r', 'prs', all, r => r.number), Date.parse('2026-10-02T12:00:00Z'), Infinity).length, 2);
  assert.equal(openItemsAt(items, Date.parse('2026-10-04T00:00:00Z'), Infinity).length, 1);
  const opened = sample('opened');
  const merged = sample('merged');
  const limits = { opened: null, merged: 20 };
  const eligible = connectorPRs(opened, merged, 700, limits);
  assert(eligible.size <= 20);
  const arcs = selectArcs(records, 700, { repo: 'owner/repo', filter: all, count: 1, eligible });
  for (const pr of arcs) {
    assert(opened.some(e => e.pr.number === pr.number && e.t <= 700));
    assert(merged.filter(e => e.t <= 700).slice(-20).some(e => e.pr.number === pr.number));
  }
  assert.equal(connectorPRs([], merged, 700, limits).size, 0);
  assert([...connectorPRs(opened, merged, 200, limits)].every(number => number <= 200));
});
