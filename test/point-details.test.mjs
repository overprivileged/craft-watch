import test from 'node:test';
import assert from 'node:assert/strict';
import { pointDetails } from '../site/point-details.js';
const app = { name: 'Example', repo: 'org/example' };
const item = { number: 42, title: 'Fix export', state: 'MERGED', author: 'author', merged_by: 'reviewer', created_at: '2026-10-24T10:00:00Z', merged_at: '2026-10-25T11:00:00Z', closed_at: '2026-10-25T11:00:00Z' };
test('PR details expose the correct event time, identity and people', () => {
  const d = pointDetails({ app, item, kind: 'merged' }, Date.parse('2026-10-26'));
  assert.equal(d.heading, 'Example · PR #42');
  assert.equal(d.eventTime, item.merged_at);
  assert.equal(d.title, 'Fix export');
  assert.ok(d.facts.includes('Merged by: reviewer'));
  assert.equal(d.url, 'https://github.com/org/example/pull/42');
});
test('arc details do not reveal a future merge during replay', () => {
  const d = pointDetails({ app, item, kind: 'arcs' }, Date.parse('2026-10-24T12:00:00Z'));
  assert.equal(d.eventLabel, 'Created');
  assert.equal(d.eventTime, item.created_at);
  assert.ok(!d.facts.some(f => f.includes('reviewer')));
  assert.equal(pointDetails({ app, item, kind: 'arcs' }, Date.parse('2026-10-26')).eventLabel, 'Merged');
});
test('open issues and timestamp-only commits do not imply PR identity or completed work', () => {
  const issue = pointDetails({ app, item: { number: 9, title: 'Bug', created_at: item.created_at }, kind: 'issues' }, Date.now());
  assert.equal(issue.heading, 'Example · Issue #9');
  assert.equal(issue.eventLabel, 'Opened');
  const commit = pointDetails({ app, kind: 'commits', at: item.created_at }, Date.now());
  assert.equal(commit.eventTime, item.created_at);
  assert.ok(commit.facts[0].includes('not the commit SHA'));
});
