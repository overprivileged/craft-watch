import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Run the actual collector in a temporary project with all network calls replaced.
// Check its published apps.json, including fallback and existing summary counts.
const run = promisify(execFile);
const mock = `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const scenario = process.argv[2];
const total = { small: 2, complete: 150, capped: 1200, failure: 150, empty: 0 }[scenario];
const timestamp = new Date(Date.now() - 3600e3).toISOString();
let pages = 0;
globalThis.fetch = async (url, init) => {
  const json = (body) => ({ ok: true, json: async () => body });
  if (url === 'https://api.github.com/graphql') {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('object(expression:')) {
      pages++;
      assert.ok(pages <= 10);
      assert.equal(variables.head, pages === 1 ? 'main' : 'pinned-head');
      assert.equal(variables.after, pages === 1 ? null : 'cursor-' + (pages - 1));
      assert.equal(Date.parse(variables.until) - Date.parse(variables.since), 30 * 864e5);
      if (scenario === 'failure' && pages === 2) return json({ errors: [{ message: 'history unavailable' }] });
      const start = (pages - 1) * 100;
      const count = Math.min(100, total - start);
      return json({ data: { repository: { object: { oid: 'pinned-head', history: {
        totalCount: total,
        nodes: Array.from({ length: count }, (_, i) => ({ oid: 'sha-' + (start + i), committedDate: timestamp })),
        pageInfo: { hasNextPage: start + count < total, endCursor: 'cursor-' + pages },
      } } } } });
    }
    if (query.includes('rateLimit')) return json({ data: {
      rateLimit: { remaining: 5000 }, repository: {
        isArchived: false,
        defaultBranchRef: scenario === 'empty' ? null : { name: 'main', target: { history: {
          totalCount: total, nodes: Array.from({ length: Math.min(100, total) }, (_, i) => ({
            message: i === 0 ? 'Change\\nCo-authored-by: codex' : 'Change', committedDate: timestamp,
          })),
        } } },
        openPulls: { totalCount: 0 }, openIssues: { totalCount: 0 }, closedIssues: { totalCount: 0 },
      },
    } });
    for (const field of ['pullRequests', 'issues']) {
      if (query.includes(field + '(first:')) return json({ data: { repository: {
        [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } });
    }
    if (query.includes('history(first: 1,')) return json({ data: { repository: {
      defaultBranchRef: { target: { history: { totalCount: 42 } } },
    } } });
    throw new Error('Unexpected GraphQL request');
  }
  if (url.startsWith('https://api.securityscorecards.dev/')) return json({ score: 5, date: '2026-10-29' });
  if (['releases', 'security-advisories'].some((path) => url === 'https://api.github.com/repos/example/app/' + path + '?per_page=100')) return json([]);
  throw new Error('Unexpected URL');
};
await import('./scripts/collect.mjs');
await writeFile(new URL('./calls.json', import.meta.url), JSON.stringify({ pages }));
`;

for (const [scenario, count, total, truncated, pages] of [
  ['small', 2, 2, false, 0],
  ['complete', 150, 150, false, 2],
  ['capped', 1000, 1200, true, 10],
  ['failure', 100, 150, true, 2],
  ['empty', 0, 0, false, 0],
]) {
  test(`collector publishes correct commit data: ${scenario}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'craft-watch-commits-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'scripts'));
    for (const file of ['collect.mjs', 'commit-history.mjs']) {
      await copyFile(new URL('../scripts/' + file, import.meta.url), join(root, 'scripts', file));
    }
    await writeFile(join(root, 'repos.json'), JSON.stringify({ apps: [{ name: 'Example', repo: 'example/app', colour: '#ffffff' }] }));
    await writeFile(join(root, 'mock.mjs'), mock);
    const { stdout } = await run(process.execPath, [join(root, 'mock.mjs'), scenario], {
      env: { ...process.env, GITHUB_TOKEN: 'test-placeholder' }, timeout: 10000,
    });
    const output = JSON.parse(await readFile(join(root, 'data/apps.json'), 'utf8'));
    const [app] = output.apps;
    assert.equal(app.ok, true);
    assert.equal(output.window_days, 30);
    assert.equal(app.commit_times.length, count);
    assert.equal(app.commits.total, total);
    assert.equal(app.commits.last_24h, 42);
    assert.equal(app.commits.ai_tagged, scenario === 'empty' ? 0 : 1);
    assert.equal(app.commits.ai_tagged_pct, scenario === 'empty' ? null : scenario === 'small' ? 50 : 1);
    assert.equal(app.truncated.commits, truncated);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'calls.json'), 'utf8')), { pages });
    if (scenario === 'failure') assert.match(stdout, /latest timestamps retained/);
  });
}
