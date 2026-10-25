import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrack, showRange } from '../site/event-track.js';
import { visibleRange } from '../site/display-limits.js';

// Just enough DOM for append, prepend, remove and fragments.
class FakeNode {
  constructor(name, document) { this.name = name; this.ownerDocument = document; this.children = []; this.parent = null; }
  take(nodes) { return nodes.flatMap((node) => node.fragment ? node.children.splice(0) : [node]); }
  attach(nodes, at) {
    for (const node of nodes) { node.remove(); node.parent = this; }
    this.children.splice(at, 0, ...nodes);
  }
  append(...nodes) { const list = this.take(nodes); this.attach(list, this.children.length); }
  prepend(...nodes) { this.attach(this.take(nodes), 0); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
}
function fakeTrack(times) {
  const document = { createDocumentFragment: () => Object.assign(new FakeNode('#fragment', document), { fragment: true }) };
  const group = new FakeNode('g', document);
  let made = 0;
  const track = createTrack('commits', times.map((t) => ({ t })), (record) => { made++; return new FakeNode(`t${record.t}`, document); }, group);
  return { track, group, shown: () => group.children.map((node) => node.name), made: () => made };
}

test('records are sorted and nothing is built until shown', () => {
  const { track, shown, made } = fakeTrack([5, 1, 3]);
  assert.deepEqual(track.records.map((r) => r.t), [1, 3, 5]);
  assert.deepEqual(shown(), []);
  assert.equal(made(), 0);
});

test('only the capped range exists in the DOM, in time order, forwards and backwards', () => {
  const { track, shown, made } = fakeTrack([1, 2, 3, 4, 5, 6, 7, 8]);
  const at = (t, cap) => showRange(track, ...visibleRange(track.records, t, cap));
  at(8, 3);
  assert.deepEqual(shown(), ['t6', 't7', 't8']);
  assert.equal(made(), 3, 'hidden history is never built');
  at(6, 3);
  assert.deepEqual(shown(), ['t4', 't5', 't6']);
  at(7, 3);
  assert.deepEqual(shown(), ['t5', 't6', 't7']);
  at(2, 3);
  assert.deepEqual(shown(), ['t1', 't2']);
  at(0, 3);
  assert.deepEqual(shown(), []);
  at(8, null);
  assert.deepEqual(shown(), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
  at(8, 2);
  assert.deepEqual(shown(), ['t7', 't8']);
  assert.equal(made(), 8, 'returning nodes are reused, not rebuilt');
});

test('a jump to a non-overlapping range replaces every node', () => {
  const { track, shown } = fakeTrack([1, 2, 3, 4, 5, 6, 7, 8]);
  showRange(track, 0, 2);
  showRange(track, 5, 8);
  assert.deepEqual(shown(), ['t6', 't7', 't8']);
  showRange(track, 1, 3);
  assert.deepEqual(shown(), ['t2', 't3']);
});
