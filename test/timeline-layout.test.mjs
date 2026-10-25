import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineLayout } from '../site/timeline-layout.js';
import { selectedTimeRange } from '../site/drag-zoom.js';

test('additional apps add vertical room without shrinking the horizontal timeline', () => {
  const small = timelineLayout(2, 100);
  for (const count of [3, 4, 8, 16]) {
    const layout = timelineLayout(count, 100);
    assert.equal(layout.height, small.height + (count - 2) * 90);
    assert.equal(layout.endX, small.endX);
    assert.equal(layout.timeStartX, small.timeStartX);
    assert(layout.laneBottom < layout.axisBottom);
    assert(layout.axisBottom < layout.top + layout.height);
    assert(layout.core.y > layout.laneTop && layout.core.y < layout.laneBottom);
    assert((layout.laneBottom - layout.laneTop) / (count - 1) >= 100);
  }
  assert.equal(timelineLayout(0, 0).height, small.height);
  assert.equal(timelineLayout(1, 100).height, small.height);
});

test('labels hug the right edge and zoom still covers the full range after resizing', () => {
  for (const labelWidth of [70, 100, 160]) {
    const layout = timelineLayout(12, labelWidth);
    assert.equal(layout.nameX + labelWidth, layout.width - 16);
    assert.equal(layout.nameX - layout.endX, 18);
    assert.equal(layout.timeStartX, layout.core.x + (layout.endX - layout.core.x) / 3);
    assert.deepEqual(selectedTimeRange(layout.timeStartX, layout.endX, layout.timeStartX, layout.endX, 0, 10000), {from:0,to:10000});
  }
  assert(timelineLayout(2, 70).endX > timelineLayout(2, 160).endX);
});
