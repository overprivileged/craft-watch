import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivity } from '../site/activity.js';
import { installDragZoom } from '../site/drag-zoom.js';

const hour = 3600e3;
const start = Date.parse('2026-10-01T00:00:00Z');
const end = start + 10 * hour;
const iso = n => new Date(start + n * hour).toISOString();
const apps = [
  { name: 'A', repo: 'o/a', pulls: {open_now: 1},
    pulls_recent: [
      {number: 1, state: 'MERGED', created_at: iso(1), merged_at: iso(6)},
      {number: 2, state: 'CLOSED', created_at: iso(3), closed_at: iso(7)},
      {number: 3, state: 'OPEN', created_at: iso(8)},
    ], commit_times: [iso(2), iso(4), iso(4), iso(9)], releases_recent: [{tag: 'v1', published_at: iso(5)}] },
  { name: 'B', repo: 'o/b', pulls: {open_now: 1}, pulls_recent: [{number: 9, state: 'OPEN', created_at: iso(2)}], commit_times: [iso(3), iso(7)], releases_recent: [] },
];
const keys = ['open', 'opened', 'merged', 'closed', 'commits', 'releases', 'estimated'];

test('live per-app range counts exactly match committed zoom counts, including backwards changes', () => {
  for (const app of apps) {
    const activity = createActivity([app], start, end);
    const original = activity.at(end);
    for (const [left, right] of [[2, 9], [4, 7], [1, 5], [5, 5], [7, 10], [2, 6]]) {
      const preview = activity.at(start + right * hour, start + left * hour);
      const committed = createActivity([app], start + left * hour, end).at(start + right * hour);
      for (const key of keys) assert.equal(preview[key], committed[key], `${app.name}: ${key} in ${left}–${right}`);
      assert.deepEqual(preview.recent, committed.recent);
    }
    assert.deepEqual(activity.at(end), original, 'preview must not mutate the active time window');
  }
});

test('range previews exclude left boundary, include right boundary, and preserve backlog semantics', () => {
  const counts = createActivity(apps, start, end).at(start + 7 * hour, start + 4 * hour);
  assert.equal(counts.commits, 1);
  assert.equal(counts.merged, 1);
  assert.equal(counts.closed, 1);
  assert.equal(counts.releases, 1);
  assert.equal(counts.opened, 0);
  assert.equal(counts.open, 1); // B is still open; A's later PR has not been created.
  assert.equal(counts.estimated, true);
  assert.equal(createActivity([{name:'Unknown'}], start, end).at(start + 7 * hour, start + 4 * hour).open, null);
});

test('drag previews update before release, work in reverse, and clear on Escape, cancellation and clicks', t => {
  const previous = Object.fromEntries(['document', 'window', 'DOMPoint'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  class Node extends EventTarget {
    classList = {add() {}, remove() {}};
    setAttribute() {}
    append() {}
    remove() {}
    getScreenCTM() { return {inverse() { return {}; }}; }
    setPointerCapture() { this.captured = true; }
    hasPointerCapture() { return Boolean(this.captured); }
    releasePointerCapture() { this.captured = false; }
  }
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), {createElementNS: () => new Node()});
  globalThis.DOMPoint = class { constructor(x,y) { this.x=x; this.y=y; } matrixTransform() { return this; } };
  const svg = new Node();
  let preview = null, selection = null, cancelled = 0;
  installDragZoom(svg, {
    getRange: () => ({from:start,to:end,left:0,right:100,top:0,bottom:2000}),
    onStart() {}, onCancel() { cancelled++; },
    onPreview(text, range) { preview = range; }, onSelect(range) { selection = range; },
  });
  const fire = (target, type, fields = {}) => target.dispatchEvent(Object.assign(new Event(type, {cancelable:true}), {pointerId:1,button:0,isPrimary:true,clientX:20,clientY:1500,...fields}));
  fire(svg, 'pointerdown');
  fire(svg, 'pointermove', {clientX:80});
  assert.deepEqual(preview, {from:start + 2*hour,to:start + 8*hour});
  assert.equal(selection, null, 'counts can preview before the zoom commits');
  fire(window, 'pointerup', {clientX:80});
  assert.equal(preview, null);
  assert.deepEqual(selection, {from:start + 2*hour,to:start + 8*hour});
  selection = null;
  fire(svg, 'pointerdown', {clientX:80});
  fire(svg, 'pointermove', {clientX:30});
  assert.deepEqual(preview, {from:start + 3*hour,to:start + 8*hour});
  fire(document, 'keydown', {key:'Escape'});
  assert.equal(preview, null);
  assert.equal(selection, null);
  fire(svg, 'pointerdown'); fire(svg, 'pointermove', {clientX:70}); fire(svg, 'pointercancel');
  assert.equal(preview, null);
  fire(svg, 'pointerdown'); fire(window, 'pointerup');
  assert.equal(selection, null);
  assert.equal(cancelled, 3);
});
