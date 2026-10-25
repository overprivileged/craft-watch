import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedTimeRange, validateZoom } from '../site/drag-zoom.js';
import { createActivity } from '../site/activity.js';
const start=Date.parse('2026-10-25T00:00:00Z'),end=start+8*3600e3;
test('drag boundaries use only horizontal time and work in either direction',()=>{
  const expected={from:start+2*3600e3,to:start+6*3600e3};
  assert.deepEqual(selectedTimeRange(935,1405,700,1640,start,end),expected);
  assert.deepEqual(selectedTimeRange(1405,935,700,1640,start,end),expected);
  assert.deepEqual(selectedTimeRange(-100,2000,700,1640,start,end),{from:start,to:end});
  assert.equal(selectedTimeRange(100,600,700,1640,start,end),null);
  assert.equal(selectedTimeRange(800,800,700,1640,start,end),null);
});
test('nested zoom uses the current interval; invalid saved bounds cannot produce a broken scale',()=>{
  const first=selectedTimeRange(935,1405,700,1640,start,end);
  assert.deepEqual(selectedTimeRange(935,1405,700,1640,first.from,first.to),{from:start+3*3600e3,to:start+5*3600e3});
  assert.equal(validateZoom(null,null,start,end),null);
  assert.equal(validateZoom('bad',end,start,end),null);
  assert.equal(validateZoom(end,start,start,end),null);
  assert.equal(validateZoom(start,start+999,start,end),null);
  assert.deepEqual(validateZoom(start-1000,end+1000,start,end),{from:start,to:end});
});
test('zoomed historical totals remain anchored to the snapshot rather than treating its endpoint as now',()=>{
  const app={name:'Example',repo:'org/repo',pulls:{open_now:1},pulls_recent:[{number:1,state:'OPEN',created_at:new Date(start+7*3600e3).toISOString()}],commit_times:[1,3,5,7].map(h=>new Date(start+h*3600e3).toISOString())};
  const counts=createActivity([app],start+2*3600e3,end).at(start+6*3600e3);
  assert.equal(counts.commits,2);assert.equal(counts.open,0);assert.equal(counts.estimated,true);
});
