import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity, upperBound } from '../site/activity.js';
const iso = (n) => new Date(n * 1000).toISOString();
const pr = (number, created, ended, merged = false) => ({ number, title: `Change ${number}`, state: ended ? merged ? 'MERGED' : 'CLOSED' : 'OPEN', created_at: iso(created), closed_at: ended ? iso(ended) : null, merged_at: merged ? iso(ended) : null });
const app = {
  name: 'TestCraft', repo: 'example/test', ok: true,
  coverage: { pulls_complete_from: iso(0) }, pulls: { open_now: 2 },
  pulls_recent: [pr(1, 1, 4, true), pr(2, 2, 6), pr(3, 5), pr(4, 8)],
  commit_times: [iso(0), iso(3), iso(7), 'invalid', iso(12)],
  releases_recent: [{ tag: 'v1', published_at: iso(9) }],
};
test('replay follows opening, merging, and unmerged closure independently', () => {
  const index = createActivity([app], 0, 10000);
  assert.deepEqual(Object.fromEntries(Object.entries(index.at(3000)).filter(([k]) => ['open','opened','merged','closed','commits','releases'].includes(k))), { opened: 2, merged: 0, closed: 0, commits: 1, releases: 0, open: 2 });
  assert.equal(index.at(4000).merged, 1);
  assert.equal(index.at(4000).closed, 0);
  assert.equal(index.at(4000).open, 1);
  assert.equal(index.at(6000).closed, 1);
  assert.equal(index.at(6000).open, 1);
  assert.equal(index.at(10000).open, 2);
  assert.equal(index.at(10000).estimated, false);
  assert.equal(index.at(10000).releases, 1);
  assert.equal(index.at(10000).commits, 2);
});
test('window boundaries, carry-in PRs, and backwards scrubbing', () => {
  const index = createActivity([app], 3000, 10000);
  assert.equal(index.at(3000).open, 2);
  assert.equal(index.at(3000).commits, 0);
  assert.equal(index.at(3000).opened, 0);
  assert.equal(index.at(10000).merged, 1);
  assert.equal(index.at(10000).closed, 1);
  assert.equal(index.at(10000).opened, 2);
  assert.equal(index.at(5000).open, 2);
  assert.equal(index.at(3000).merged, 0);
  assert.equal(index.at(3000).recent.length, 0);
});
test('app selection scopes counts; empty and missing data are distinguished', () => {
  assert.equal(createActivity([], 0, 10000).at(10000).open, 0);
  assert.equal(createActivity([app, { ...app, name: 'SecondCraft' }], 0, 10000).at(10000).merged, 2);
  assert.equal(createActivity([{ name: 'Unavailable' }], 0, 10000).at(10000).open, null);
  assert.equal(createActivity([{ ...app, ok: false }], 0, 10000).incomplete, true);
  assert.equal(createActivity([{ ...app, truncated: { commits: true } }], 0, 10000).sampledCommits, true);
});
test('reopened PR with an old closed timestamp is not counted as a final closure', () => {
  const index = createActivity([{ ...app, pulls_recent: [{ ...pr(1, 1, 4), state: 'OPEN' }] }], 0, 10000);
  assert.equal(index.at(10000).closed, 0);
  assert.equal(index.at(3000).estimated, true);
});
test('events are sorted and bounded without exposing future outcomes', () => {
  const index = createActivity([app], 0, 10000);
  assert.ok(index.at(3000).recent.every((e) => e.t <= 3000));
  assert.equal(index.at(10000).recent.length, 3);
  assert.equal(index.at(10000).recent.at(-1).type, 'releases');
  assert.equal(upperBound([{ t: 1 }, { t: 2 }, { t: 2 }, { t: 4 }], 2), 3);
});
