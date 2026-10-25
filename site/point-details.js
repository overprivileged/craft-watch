import { resolutionEvent } from './appearance.js';

export function pointDetails({ app, kind, item = {}, at }, time) {
  const facts = [];
  let heading, title, eventLabel, eventTime, url;
  if (['opened', 'prs', 'merged', 'closed', 'arcs', 'issues'].includes(kind)) {
    const issue = kind === 'issues';
    const resolution = issue ? null : resolutionEvent(item);
    const resolved = resolution && resolution.t <= time;
    const state = kind === 'arcs' ? (resolved ? resolution.type : 'prs') : kind;
    heading = `${app.name} · ${issue ? 'Issue' : 'PR'} #${item.number}`;
    title = item.title || 'Untitled';
    eventLabel = state === 'merged' ? 'Merged' : state === 'closed' ? 'Closed without merging' : issue ? 'Opened' : 'Created';
    eventTime = state === 'merged' ? item.merged_at : state === 'closed' ? item.closed_at : item.created_at;
    facts.push(state === 'opened' ? 'PR creation event (remains after merging or closing)' : state === 'merged' ? 'Merged into the target branch' : state === 'closed' ? 'Closed without merging' : 'Open at the displayed time');
    if (item.author) facts.push(`Author: ${item.author}`);
    if (state === 'merged' && item.merged_by) facts.push(`Merged by: ${item.merged_by}`);
    if (state === 'prs' && item.is_draft) facts.push('Draft PR');
    url = `https://github.com/${app.repo}/${issue ? 'issues' : 'pull'}/${item.number}`;
  } else if (kind === 'releases') {
    heading = `${app.name} · Release ${item.tag}`;
    title = `Published version ${item.tag}`;
    eventLabel = 'Published';
    eventTime = item.published_at;
    if (item.has_checksums) facts.push('Checksums available');
    url = `https://github.com/${app.repo}/releases/tag/${encodeURIComponent(item.tag)}`;
  } else {
    heading = `${app.name} · Commit`;
    title = 'Recorded commit on the default branch';
    eventLabel = 'Committed';
    eventTime = at;
    facts.push('This snapshot stores the timestamp, but not the commit SHA, message or associated PR.');
    url = `https://github.com/${app.repo}/commits`;
  }
  return { heading, title, eventLabel, eventTime, facts, url };
}
