import test from 'node:test';
import assert from 'node:assert/strict';
import { arcDraw, normalizeArcFilter, selectArcs } from '../site/arc-selection.js';
const events = Array.from({length: 1000}, (_, n) => ({t: n, pr: { number: n }}));
const options = { repo: 'org/repo', count: 10, filter: normalizeArcFilter() };
const numbers = rows => rows.map(pr => pr.number);
test('count mode follows latest reached activity and deduplicates PR events', () => {
  const list = [{t:1,pr:{number:1}},{t:2,pr:{number:2}},{t:3,pr:{number:1}}];
  assert.deepEqual(numbers(selectArcs(list, 3, {...options,count:1})), [1]);
  assert.deepEqual(numbers(selectArcs(list, 2, {...options,count:1})), [2]);
});
test('probability ignores count cap and samples throughout the range, once per PR', () => {
  const opt = {...options, filter: normalizeArcFilter({mode:'probability', probability:0.5, seed:17})};
  const selected = numbers(selectArcs(events, 1000, opt));
  assert.ok(selected.length > 400 && selected.length < 600);
  assert.ok(selected.some(n=>n<100) && selected.some(n=>n>900));
  assert.deepEqual(numbers(selectArcs(events, 1000, opt)), selected);
  assert.deepEqual(numbers(selectArcs(events, 400, opt)), selected.filter(n=>n<=400));
  const doubled = events.flatMap(e=>[e,e]);
  assert.deepEqual(numbers(selectArcs(doubled, 1000, opt)), selected);
  assert.notDeepEqual(numbers(selectArcs(events, 1000, {...opt,filter:{...opt.filter,seed:18}})), selected);
  assert.equal(selectArcs(events,1000,{...opt,filter:{...opt.filter,probability:0}}).length,0);
  assert.equal(selectArcs(events,1000,{...opt,filter:{...opt.filter,probability:1}}).length,1000);
});
test('connectors only select visible eligible merges and stay empty with either layer hidden', () => {
  assert.deepEqual(numbers(selectArcs(events,1000,{...options,eligible:new Set([1,50,300])})),[1,50,300]);
  assert.deepEqual(selectArcs(events,1000,{...options,eligible:new Set()}),[]);
  assert.deepEqual(numbers(selectArcs(events,49,{...options,eligible:new Set([1,50,300])})),[1]);
});
test('invalid probabilities and seeds fall back, valid boundary probabilities are preserved', () => {
  assert.deepEqual(normalizeArcFilter({probability:'',seed:-1}),{mode:'count',probability:0.5,seed:1});
  assert.equal(normalizeArcFilter({probability:0}).probability,0);
  assert.equal(normalizeArcFilter({probability:2}).probability,0.5);
  assert.ok(arcDraw('org/repo',1,1)>=0 && arcDraw('org/repo',1,1)<1);
});
