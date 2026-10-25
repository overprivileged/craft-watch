// The replay uses recorded timestamps, never interpolated or invented events.
export const timestamp = (iso) => iso ? Date.parse(iso) : NaN;
export function upperBound(items, t) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (items[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function createActivity(apps, from, end) {
  const events = [];
  const types = { opened: [], merged: [], closed: [], commits: [], releases: [] };
  let openNow = 0;
  let openKnown = true;
  let incomplete = false;
  let sampledCommits = false;
  for (const app of apps) {
    if (Number.isFinite(app.pulls?.open_now)) openNow += app.pulls.open_now;
    else openKnown = false;
    const coverage = timestamp(app.coverage?.pulls_complete_from);
    incomplete ||= app.ok === false || !Number.isFinite(coverage) || coverage > from + 1000;
    sampledCommits ||= Boolean(app.truncated?.commits);
    const add = (type, iso, title, url, pr = null) => {
      const t = timestamp(iso);
      if (!Number.isFinite(t) || t > end) return;
      const event = { type, t, title, url, app, pr };
      types[type].push(event);
      if (t > from) events.push(event);
    };
    for (const pr of app.pulls_recent ?? []) {
      const url = `https://github.com/${app.repo}/pull/${pr.number}`;
      add('opened', pr.created_at, `#${pr.number} ${pr.title}`, url, pr);
      if (pr.merged_at) add('merged', pr.merged_at, `#${pr.number} ${pr.title}`, url, pr);
      else if (pr.closed_at && pr.state !== 'OPEN') add('closed', pr.closed_at, `#${pr.number} ${pr.title}`, url, pr);
    }
    for (const iso of app.commit_times ?? []) add('commits', iso, 'Commit on the default branch', `https://github.com/${app.repo}/commits`);
    for (const release of app.releases_recent ?? []) {
      add('releases', release.published_at, release.tag, `https://github.com/${app.repo}/releases/tag/${encodeURIComponent(release.tag)}`);
    }
  }
  events.sort((a, b) => a.t - b.t);
  for (const list of Object.values(types)) list.sort((a, b) => a.t - b.t);
  const starts = Object.fromEntries(Object.entries(types).map(([key, list]) => [key, upperBound(list, from)]));
  return {
    events, incomplete, sampledCommits, openKnown,
    at(time, intervalStart = from) {
      const t = Math.max(from, Math.min(end, time));
      const windowStart = Math.max(from, Math.min(t, intervalStart));
      const windowStarts = windowStart === from ? starts : Object.fromEntries(Object.entries(types).map(([key, list]) => [key, upperBound(list, windowStart)]));
      const positions = Object.fromEntries(Object.entries(types).map(([key, list]) => [key, upperBound(list, t)]));
      const counts = Object.fromEntries(Object.keys(types).map((key) => [key, positions[key] - windowStarts[key]]));
      // Work backwards from GitHub's open total. Reopen transitions are not collected,
      // so historical totals are always labelled estimates, even with complete coverage.
      const after = (key) => types[key].length - positions[key];
      const open = openKnown ? Math.max(0, openNow - after('opened') + after('merged') + after('closed')) : null;
      const cursor = upperBound(events, t);
      return { ...counts, open, estimated: t < end, recent: events.slice(Math.max(0, cursor - 3), cursor).filter(event => event.t > windowStart), cursor };
    },
  };
}

// Input records are sorted newest first. Current OPEN state ignores obsolete closure
// timestamps after a reopen; intermediate reopen history is unavailable in the snapshot.
export function openItemsAt(records, time, limit = 20) {
  const items = [];
  for (const item of records) {
    const created = timestamp(item.created_at);
    const ended = timestamp(item.merged_at || (item.state !== 'OPEN' && item.closed_at));
    if (!Number.isFinite(created) || created > time || ended <= time) continue;
    if (item.state !== 'OPEN' && !Number.isFinite(ended)) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}
