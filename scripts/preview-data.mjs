// Fetch the same public snapshot as the upstream site. No GitHub token is needed.
import { mkdir, writeFile, rename } from 'node:fs/promises';
const root = new URL('../data/', import.meta.url);
const source = 'https://overprivileged.github.io/craft-watch/data/apps.json';
try {
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.apps) || !Number.isFinite(Date.parse(data.generated_at))) throw new Error('Invalid snapshot');
  await mkdir(root, { recursive: true });
  await writeFile(new URL('apps.json.tmp', root), JSON.stringify(data) + '\n');
  await rename(new URL('apps.json.tmp', root), new URL('apps.json', root));
  console.log(`Saved public data for ${data.apps.length} apps, updated ${data.generated_at}. Run npm run dev to preview.`);
} catch (error) {
  console.error(`Could not fetch preview data: ${error.message}. Any existing snapshot was kept.`);
  process.exitCode = 1;
}
