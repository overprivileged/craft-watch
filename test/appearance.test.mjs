import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance, DEFAULT_APPEARANCE, symbolOffset, arcDirection, resolutionEvent } from '../site/appearance.js';
import { visibleRange, normalizeLimits } from '../site/display-limits.js';

test('appearance preferences reject unsafe shapes, positions and sizes', () => {
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE);
  const styles = normalizeAppearance({ commits: { shape: '__proto__', position: 'elsewhere', size: Infinity }, merged: { shape: 'triangle', position: 'below', size: '24' }, arcs: { position: 'on', size: -1 } });
  assert.deepEqual(styles.commits, DEFAULT_APPEARANCE.commits);
  assert.deepEqual(styles.merged, { shape: 'triangle', position: 'below', size: 24, glow: 0 });
  assert.equal(normalizeAppearance({ merged: { glow: '25' } }).merged.glow, 25);
  assert.equal(normalizeAppearance({ merged: { glow: 40 } }).merged.glow, 0);
  assert.deepEqual(styles.arcs, { position: 'on', size: 1.8, mode: 'lifetime', lineSize: 1.8, connectorShape: 'straight', bend: 1 });
  assert.equal(symbolOffset(styles.merged), 24);
  assert.equal(symbolOffset({ position: 'above', size: 24 }), -24);
  assert.equal(symbolOffset({ position: 'on', size: 24 }), 0);
  assert.equal(arcDirection(styles.arcs), 0);
  assert.equal(arcDirection({ position: 'below' }), -1);
});

test('merge and unmerged closure markers use resolution timestamps without duplicating merged closures', () => {
  const merged = resolutionEvent({ state: 'MERGED', merged_at: '2026-10-25T01:00:00Z', closed_at: '2026-10-25T01:00:00Z' });
  assert.deepEqual(merged, { type: 'merged', t: Date.parse('2026-10-25T01:00:00Z') });
  assert.equal(resolutionEvent({ state: 'CLOSED', closed_at: '2026-10-25T02:00:00Z' }).type, 'closed');
  assert.equal(resolutionEvent({ state: 'OPEN', closed_at: '2026-10-25T02:00:00Z' }), null);
  assert.equal(resolutionEvent({ state: 'CLOSED', closed_at: 'invalid' }), null);
});

test('resolution display caps handle replay forwards/backwards independently of arc caps', () => {
  const limits = normalizeLimits({ arcs: 1, merged: 2, closed: 'all' });
  const events = [1, 2, 3, 4].map(t => ({ t }));
  assert.deepEqual(visibleRange(events, 3, limits.merged), [1, 3]);
  assert.deepEqual(visibleRange(events, 1, limits.merged), [0, 1]);
  assert.deepEqual(visibleRange(events, 4, limits.closed), [0, 4]);
});
