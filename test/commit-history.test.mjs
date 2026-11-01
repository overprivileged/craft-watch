import test from 'node:test';
import assert from 'node:assert/strict';
import { readCommitHistory } from '../scripts/commit-history.mjs';

const options = {
  owner: 'example', name: 'app', branch: 'main',
  since: '2026-10-01T00:00:00.000Z', until: '2026-10-31T00:00:00.000Z',
};
const node = (oid, day = 25) => ({ oid, committedDate: `2026-10-${day}T12:00:00.000Z` });
function response(nodes, totalCount, hasNextPage = false, endCursor = null) {
  return { repository: { object: {
    oid: 'pinned-head', history: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } },
  } } };
}

test('walks pages pinned to the initial head, deduplicates SHAs and sorts timestamps', async () => {
  const calls = [];
  const pages = [
    response([node('a', 25), node('b', 27)], 3, true, 'cursor-1'),
    response([node('b', 27), node('c', 27)], 3),
  ];
  const result = await readCommitHistory(async (query, variables) => {
    assert.match(query, /history\(first: 100, since: \$since, until: \$until, after: \$after\)/);
    calls.push(variables);
    return pages.shift();
  }, options);
  assert.deepEqual(result, {
    times: [node('b', 27).committedDate, node('c', 27).committedDate, node('a', 25).committedDate],
    total: 3, truncated: false,
  });
  const { branch, ...window } = options;
  assert.deepEqual(calls, [
    { ...window, head: branch, after: null },
    { ...window, head: 'pinned-head', after: 'cursor-1' },
  ]);
});

for (const total of [1000, 1001]) {
  test(`stops after ten pages with correct truncation for ${total} commits`, async () => {
    let calls = 0;
    const result = await readCommitHistory(async () => {
      const start = calls++ * 100;
      assert.ok(calls <= 10, 'must not request an eleventh page');
      return response(Array.from({ length: 100 }, (_, i) => node(`sha-${start + i}`)), total, calls * 100 < total, `cursor-${calls}`);
    }, options);
    assert.equal(calls, 10);
    assert.equal(result.times.length, 1000);
    assert.equal(result.total, total);
    assert.equal(result.truncated, total > 1000);
  });
}

test('handles empty history in one call', async () => {
  let calls = 0;
  const result = await readCommitHistory(async () => { calls++; return response([], 0); }, options);
  assert.equal(calls, 1);
  assert.deepEqual(result, { times: [], total: 0, truncated: false });
});

test('rejects unavailable history', async () => {
  await assert.rejects(readCommitHistory(async () => ({ repository: { object: null } }), options), /history unavailable/);
});

test('rejects invalid timestamps', async () => {
  await assert.rejects(readCommitHistory(async () => response([{ oid: 'a', committedDate: 'invalid' }], 1), options), /Invalid commit timestamp/);
});

test('rejects incomplete results when the server claims pagination finished', async () => {
  await assert.rejects(readCommitHistory(async () => response([node('a')], 2), options), /Incomplete commit history/);
});

for (const cursors of [[null], ['a', 'a'], ['a', 'b', 'a']]) {
  test(`rejects stalled pagination: ${JSON.stringify(cursors)}`, async () => {
    let calls = 0;
    await assert.rejects(readCommitHistory(async () => response([node(`sha-${calls}`)], 10, true, cursors[calls++]), options), /pagination did not advance/);
    assert.equal(calls, cursors.length);
  });
}

test('propagates request failures instead of claiming complete history', async () => {
  let calls = 0;
  await assert.rejects(readCommitHistory(async () => {
    if (calls++) throw new Error('request failed');
    return response([node('a')], 2, true, 'cursor-1');
  }, options), /request failed/);
});
