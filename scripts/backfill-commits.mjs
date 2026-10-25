// Enrich the local preview snapshot; no changes are sent to GitHub.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readCommitHistory } from './commit-history.mjs';
const CONCURRENCY = 3;
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GITHUB_TOKEN in your environment to fetch full commit history.');
  process.exit(1);
}
const path = new URL('../data/apps.json', import.meta.url);
const data = JSON.parse(await readFile(path, 'utf8'));
const since = new Date(Date.parse(data.generated_at) - data.window_days * 864e5).toISOString();
async function request(query, variables) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const body = await response.json();
      if (body.errors) throw new Error('GitHub could not return commit history');
      return body.data;
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
let next = 0, failed = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < data.apps.length) {
    const app = data.apps[next++];
    if (!app.default_branch) continue;
    try {
      const [owner, name] = app.repo.split('/');
      const { times, total } = await readCommitHistory(request, { owner, name, branch: app.default_branch, since, until: data.generated_at });
      app.commit_times = times;
      app.truncated = { ...app.truncated, commits: false };
      app.commit_history = { from: since, until: data.generated_at, fetched_at: new Date().toISOString(), total };
      console.log(`${app.name}: ${times.length} commit timestamps loaded`);
    } catch (error) {
      failed++;
      console.error(`${app.name}: ${error.message}; previous timestamps retained`);
    }
  }
}));
// Do not overwrite a snapshot refreshed by another process during this fetch.
const latest = JSON.parse(await readFile(path, 'utf8'));
if (latest.generated_at !== data.generated_at) throw new Error('Snapshot changed; rerun against the new snapshot');
const temp = new URL('../data/apps.json.tmp', import.meta.url);
await writeFile(temp, JSON.stringify(data) + '\n');
await rename(temp, path);
console.log(`Saved local commit history${failed ? `; ${failed} apps could not be refreshed` : ' for all available apps'}. Refresh your browser.`);
if (failed) process.exitCode = 1;
