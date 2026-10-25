import test from 'node:test';
import assert from 'node:assert/strict';
import { openItemsAt } from '../site/activity.js';
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const items = [
  { number: 4, state: 'OPEN', created_at: iso(8) },
  { number: 3, state: 'CLOSED', created_at: iso(3), closed_at: iso(7) },
  { number: 2, state: 'MERGED', created_at: iso(2), merged_at: iso(5), closed_at: iso(5) },
  { number: 1, state: 'OPEN', created_at: iso(1) },
];
test('open markers appear at creation and disappear exactly at merge or closure', () => {
  const numbers = (t) => openItemsAt(items, t * 1000).map((p) => p.number);
  assert.deepEqual(numbers(0), []);
  assert.deepEqual(numbers(3), [3, 2, 1]);
  assert.deepEqual(numbers(5), [3, 1]);
  assert.deepEqual(numbers(7), [1]);
  assert.deepEqual(numbers(8), [4, 1]);
  assert.deepEqual(numbers(3), [3, 2, 1]); // backwards scrubbing restores open items
});
test('open marker cap favors newest records and does not use future or invalid records', () => {
  assert.deepEqual(openItemsAt(items, 10000, 1).map((p) => p.number), [4]);
  assert.deepEqual(openItemsAt([{ state: 'OPEN', created_at: 'invalid' }, { state: 'CLOSED', created_at: iso(1) }], 10000), []);
});
test('current reopened items ignore obsolete closure timestamps', () => {
  assert.equal(openItemsAt([{ state: 'OPEN', created_at: iso(1), closed_at: iso(2) }], 10000).length, 1);
});
