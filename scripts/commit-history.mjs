// Bound each app to 10 pages / 1,000 timestamps, within the caller's reporting window.
const MAX_PAGES = 10;

// Pin pagination to one commit so concurrent pushes cannot shift the history pages.
const QUERY = `query($owner: String!, $name: String!, $head: String!, $since: GitTimestamp!, $until: GitTimestamp!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(expression: $head) { ... on Commit {
      oid
      history(first: 100, since: $since, until: $until, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { oid committedDate }
      }
    } }
  }
}`;
export async function readCommitHistory(request, { owner, name, branch, since, until }) {
  let after = null, head = branch, total = 0;
  const commits = new Map();
  let truncated = false;
  const cursors = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await request(QUERY, { owner, name, head, since, until, after });
    const commit = data?.repository?.object;
    if (!commit?.history) throw new Error('Default branch history unavailable');
    if (page === 0) head = commit.oid;
    const history = commit.history;
    total = history.totalCount;
    for (const node of history.nodes) {
      if (!Number.isFinite(Date.parse(node.committedDate))) throw new Error('Invalid commit timestamp');
      commits.set(node.oid, node.committedDate);
    }
    truncated = history.pageInfo.hasNextPage;
    if (!truncated) break;
    if (!history.pageInfo.endCursor || cursors.has(history.pageInfo.endCursor)) throw new Error('Commit pagination did not advance');
    after = history.pageInfo.endCursor;
    cursors.add(after);
  }
  if (!truncated && commits.size !== total) throw new Error(`Incomplete commit history (${commits.size}/${total})`);
  return { times: [...commits.values()].sort((a, b) => Date.parse(b) - Date.parse(a)), total, truncated };
}
