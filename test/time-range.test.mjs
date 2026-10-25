import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRange, rangeStart, timePosition, pstMidnights } from '../site/time-range.js';
import { createActivity } from '../site/activity.js';

const HOUR = 3600e3;
const end = Date.parse('2026-10-25T15:00:00Z');
const start = end - 720 * HOUR;

test('each Latest range ends at the snapshot, with a linear axis and matching activity window', () => {
  for (const [range, hours] of [['1h', 1], ['8h', 8], ['1d', 24], ['3d', 72], ['7d', 168], ['14d', 336], ['30d', 720]]) {
    const from = rangeStart(start, end, range);
    assert.equal(from, end - hours * HOUR);
    assert.equal(timePosition(from, from, end), 0);
    assert.equal(timePosition((from + end) / 2, from, end), 0.5);
    assert.equal(timePosition(end, from, end), 1);
    assert.equal(timePosition(from - 1, from, end), 0);
    assert.equal(timePosition(end + 1, from, end), 1);
    const app = { commit_times: [from - 1, from + 1, end, end + 1].map(t => new Date(t).toISOString()), prs: [], releases: [] };
    assert.equal(createActivity([app], from, end).at(end).commits, 2);
  }
});

test('invalid preferences fall back and short snapshots do not stretch beyond available history', () => {
  for (const value of [null, undefined, '', 'bad', 'toString', '__proto__']) assert.equal(normalizeRange(value), '30d');
  assert.equal(rangeStart(end - HOUR, end, '30d'), end - HOUR);
  assert.equal(rangeStart(end, end, '1h'), end);
  assert.equal(timePosition(end, end, end), 1);
});

test('midnight guides use fixed PST (UTC−8), including daylight-saving dates', () => {
  const ticks = pstMidnights(Date.parse('2026-10-23T07:00:00Z'), Date.parse('2026-10-25T15:00:00Z'));
  assert.deepEqual(ticks.map(t => new Date(t).toISOString()), ['2026-10-23T08:00:00.000Z', '2026-10-24T08:00:00.000Z', '2026-10-25T08:00:00.000Z']);
  const aroundDST = pstMidnights(Date.parse('2026-10-31T08:00:00Z'), Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(aroundDST.length, 3);
  assert(aroundDST.every(t => new Date(t).getUTCHours() === 8));
  assert.equal(aroundDST[1] - aroundDST[0], 24 * HOUR);
});

test('midnight guides honor zoom boundaries and omit intervals without a midnight', () => {
  const midnight = Date.parse('2026-10-25T08:00:00Z');
  assert.deepEqual(pstMidnights(midnight, midnight + HOUR), [midnight]);
  assert.deepEqual(pstMidnights(midnight - HOUR, midnight), [midnight]);
  assert.deepEqual(pstMidnights(midnight + 1, midnight + HOUR), []);
  assert.deepEqual(pstMidnights(midnight, midnight - 1), []);
  assert.deepEqual(pstMidnights(NaN, midnight), []);
});
