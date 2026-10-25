import { timelineLayout } from './timeline-layout.js';
import { normalizeEventFilters, effectiveLimit, sampleRecords } from './event-sampling.js';
import { installDragZoom, validateZoom } from './drag-zoom.js';
import { laneYAt, followLanePath } from './connector-path.js';
import { selectArcs, connectorPRs } from './arc-selection.js';
import { pointDetails } from './point-details.js';
import { SYMBOLS, GLOW_LEVELS, DEFAULT_APPEARANCE, normalizeAppearance, symbolOffset, arcDirection, resolutionEvent } from './appearance.js';
import { normalizeRange, rangeStart, timePosition, pstMidnights } from './time-range.js';
import { DEFAULT_LIMITS, normalizeLimits, limitCount, visibleRange } from './display-limits.js';
import { createActivity, upperBound, timestamp, openItemsAt } from './activity.js';
import { orderApps, dropIndex, moveItem, reorderNames, normalizeOrder } from './lane-order.js';
import { createTrack, showRange } from './event-track.js';
import { createGlowLayer } from './glow-layer.js';
// Space view: one ArtCraft core, one lane per app, events placed by time.
// Latest and replay views use an evenly spaced time scale over their selected window.
// Everything from GitHub is written with textContent or attributes, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONO = 'JetBrains Mono, ui-monospace, monospace';
const MAIN_APPS = ['ArtCraft', 'PhotoCraft', 'FilmCraft', 'PdfCraft', 'EffectCraft', 'FigCraft', 'LightCraft', 'VectorCraft'];
// Fit the selected app names at the right edge; grow vertically as apps are added.
let mapLayout = timelineLayout(2, 140);
const CORE = { ...mapLayout.core };
let END_X = mapLayout.endX;
let TIME_START_X = mapLayout.timeStartX;
let NAME_X = mapLayout.nameX;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MODES = {
  hour: { window: HOUR, rate: HOUR / 10e3, label: 'last hour, replayed in 10 s' },
  day: { window: DAY, rate: DAY / 30e3, label: 'last 24 h, replayed in 30 s' },
  month: { window: 30 * DAY, rate: (30 * DAY) / 30e3, label: '30 days, replayed in 30 s' },
};
const STALE_MS = 6 * HOUR; // GitHub can delay scheduled runs by a few hours
const SAMPLES = 400;
const LAYERS = ['arcs', 'commits', 'releases', 'prs', 'opened', 'issues', 'merged', 'closed'];

const $ = (selector) => document.querySelector(selector);
const svg = $('#space');
const params = new URLSearchParams(location.search);
const view = {
  data: null,
  start: 0,
  end: 0,
  sim: 0,
  mode: MODES[params.get('mode')] ? params.get('mode') : 'live',
  replay: false,
  latestRange: '30d',
  scaleFrom: 0,
  zoom: null,
  previewRange: null,
  selected: new Set(),
  order: null,
  layers: new Set(LAYERS),
  limits: { ...DEFAULT_LIMITS },
  releaseLabels: 'all',
  appearance: normalizeAppearance(),
  filters: normalizeEventFilters(),
  activity: null,
  appActivity: [],
  lanes: [],
  playing: false,
  lastUI: 0,
  lastFeed: null,
  lastFrame: performance.now(),
  headLine: null,
  glowLayer: null,
};

const mapEnd = () => view.zoom?.to ?? view.end;
const eventLimit = key => effectiveLimit(view.limits[key], view.filters[key]);
const sampled = (app, key, records, identity) => sampleRecords(records, app.repo, key, view.filters[key], identity);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function translate(p) {
  return el('g', { transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` });
}

function gradient(id, colour, stops, boundingBox = false) {
  const attrs = boundingBox
    ? { id, x1: 0, y1: 0, x2: 1, y2: 0 }
    : { id, gradientUnits: 'userSpaceOnUse', x1: CORE.x, y1: 0, x2: END_X, y2: 0 };
  const node = el('linearGradient', attrs);
  for (const [offset, opacity] of stops) {
    node.append(el('stop', { offset, 'stop-color': colour, 'stop-opacity': opacity }));
  }
  return node;
}

// "artcraft-v0.41.0" -> "0.41.0", "v0.14.0" -> "0.14.0"
function version(tag) {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(tag ?? '');
  return match ? match[1] : tag ?? '';
}

// The full selected range occupies the final two thirds of each lane.
function xOf(t) {
  return TIME_START_X + timePosition(t, view.scaleFrom, mapEnd()) * (END_X - TIME_START_X);
}

function laneY(index, count) {
  if (count === 1) return CORE.y;
  const { laneTop: top, laneBottom: bottom } = mapLayout;
  return top + (index * (bottom - top)) / Math.max(count - 1, 1);
}

// Samples a lane curve so each event can sit exactly on it.
function sampleLane(path) {
  const total = path.getTotalLength();
  const points = [];
  for (let k = 0; k <= SAMPLES; k++) points.push(path.getPointAtLength((total * k) / SAMPLES));
  return points;
}

const yOnLane = laneYAt;

// Puts a timestamp on the lane. Times before the replay window are clamped to its start.
function place(samples, iso) {
  if (!iso) return null;
  if (!Number.isFinite(Date.parse(iso))) return null;
  const t = clamp(Date.parse(iso), view.scaleFrom, mapEnd());
  const x = xOf(t);
  return { t, x, y: yOnLane(samples, x) };
}

// During a replay, events from before its window are not drawn at all.
function inScale(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= view.scaleFrom && t <= mapEnd();
}

// Events are kept as records; showUntil builds nodes only for those inside the display limits.
// Each layer gets its own group, so layers keep their stacking order as nodes come and go.
function addTrack(l, key, records, make) {
  const group = el('g', {});
  l.lane.append(group);
  const track = createTrack(key, records, (record) => {
    const node = make(record);
    node.classList.add('evt');
    return node;
  }, group);
  track.capped = key in view.limits;
  l.tracks.push(track);
  l[`${key}Entries`] = track.records;
}

const inspectionData = new WeakMap();
let inspectedNode = null;
let inspectionSignature = null;
const detailTimeFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
function inspectable(node, data) {
  inspectionData.set(node, data);
  node.setAttribute('data-inspect', '');
  node.setAttribute('tabindex', '0');
  if (!node.hasAttribute('aria-label')) node.setAttribute('aria-label', pointDetails(data, view.sim).heading);
}
function clearInspection() {
  inspectedNode?.classList.remove('inspected');
  inspectedNode = null;
  inspectionSignature = null;
  $('#point-heading').textContent = 'Point details';
  $('#point-title').textContent = 'Hover over a symbol or arc, or focus it with Tab, to inspect it here.';
  $('#point-time').textContent = '';
  $('#point-facts').textContent = 'The last inspected point stays here so you can read its details.';
  $('#point-link').hidden = true;
}
function refreshInspection() {
  if (!inspectedNode) return;
  if (!inspectedNode.isConnected || inspectedNode.style.display === 'none') { clearInspection(); return; }
  const detail = pointDetails(inspectionData.get(inspectedNode), view.sim);
  const signature = JSON.stringify(detail);
  if (signature === inspectionSignature) return;
  inspectionSignature = signature;
  $('#point-heading').textContent = detail.heading;
  $('#point-title').textContent = detail.title;
  const date = new Date(detail.eventTime);
  $('#point-time').textContent = `${detail.eventLabel} · ${Number.isFinite(date.getTime()) ? detailTimeFmt.format(date) : 'Time unavailable'}`;
  $('#point-facts').textContent = detail.facts.join(' · ');
  $('#point-link').href = detail.url;
  $('#point-link').hidden = false;
  $('#point-link').textContent = inspectionData.get(inspectedNode).kind === 'commits' ? 'View commits ↗' : 'Open on GitHub ↗';
}
function inspectPoint(event) {
  if (svg.classList.contains('selecting-time')) return;
  const node = event.target.closest('[data-inspect]');
  if (!node || !svg.contains(node) || node === inspectedNode) return;
  inspectedNode?.classList.remove('inspected');
  inspectedNode = node;
  node.classList.add('inspected');
  refreshInspection();
}
svg.addEventListener('pointerover', inspectPoint);
svg.addEventListener('focusin', inspectPoint);

// Taller arcs for longer PRs: 12 px for a short one, 60 px at the cap.
function arcLift(ms) {
  return Math.min(60, Math.max(12, 12 + (ms / HOUR) * 1.5));
}

function arcPath(from, to, lift) {
  const dx = (to.x - from.x) / 4;
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} C${(from.x + dx).toFixed(1)},${(from.y - lift).toFixed(1)} ${(to.x - dx).toFixed(1)},${(to.y - lift).toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

function linePath(samples, x1, x2) {
  const points = samples.filter((p) => p.x >= x1 && p.x <= x2);
  if (points.length === 0) return `M${x1.toFixed(1)},${yOnLane(samples, x1).toFixed(1)} L${x2.toFixed(1)},${yOnLane(samples, x2).toFixed(1)}`;
  return 'M' + points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L');
}

// A fix counts only when an in-window release carries a patched version from the advisory.
function fixedRelease(advisory, releases) {
  const patched = new Set(advisory.patched ?? []);
  return releases.find((r) => patched.has(version(r.tag)) && Date.parse(r.published_at) >= Date.parse(advisory.published_at)) ?? null;
}

const SYMBOL_COLOURS = { commits: '#c4a1ff', releases: '#f5d77a', prs: '#f3bd68', opened: '#82b6ff', issues: '#67d9e8', merged: '#67d9b2', closed: '#9aa6bc' };
function symbolNode(key, colour = SYMBOL_COLOURS[key], size = view.appearance[key].size) {
  const shape = view.appearance[key].shape;
  const group = el('g', { class: 'event-symbol', 'data-symbol': key, 'data-shape': shape, transform: `scale(${size / 10})` });
  const attrs = { fill: colour, stroke: '#0B101B', 'stroke-width': 0.8 };
  let node;
  if (shape === 'dot') node = el('circle', { ...attrs, r: 5 });
  else if (shape === 'circle') node = el('circle', { r: 4.2, fill: '#0B101B', stroke: colour, 'stroke-width': 1.6 });
  else if (shape === 'square') node = el('rect', { x: -4.2, y: -4.2, width: 8.4, height: 8.4, rx: 0.6, fill: '#0B101B', stroke: colour, 'stroke-width': 1.6 });
  else if (shape === 'cross') node = el('path', { d: 'M-4,-4 L4,4 M-4,4 L4,-4', stroke: colour, 'stroke-width': 2, fill: 'none' });
  else node = el('path', { ...attrs, d: {
    diamond: 'M0,-5 L5,0 L0,5 L-5,0 Z',
    triangle: 'M0,-5 L5,5 L-5,5 Z',
    star: 'M0,-5 L1.5,-1.7 L5,-1.5 L2.2,0.8 L3,4.5 L0,2.5 L-3,4.5 L-2.2,0.8 L-5,-1.5 L-1.5,-1.7 Z',
  }[shape] });
  group.append(node);
  return group;
}
// Glow on line: translucent, additive markers, so a burst at one time brightens instead of hiding.
function glow(node, key) {
  const level = view.appearance[key].glow;
  if (level) {
    node.classList.add('glow');
    node.style.setProperty('--glow-opacity', String(level / 100));
  }
  return node;
}
function symbolPoint(p, key) {
  return { ...p, y: p.y + symbolOffset(view.appearance[key]) };
}
function commitNode(p, app) {
  const holder = translate(symbolPoint(p, 'commits'));
  holder.setAttribute('data-layer', 'commits');
  holder.append(symbolNode('commits', app.colour));
  inspectable(holder, { app, kind: 'commits', at: new Date(p.t).toISOString() });
  return glow(holder, 'commits');
}

// An opening is an event, independent of whether the PR remains open later.
function drawOpened(l) {
  if (!view.layers.has('opened')) return;
  const records = [];
  for (const pr of sampled(l.app, 'opened', l.app.pulls_recent ?? [], pr => pr.number)) {
    if (inScale(pr.created_at)) records.push({ t: Date.parse(pr.created_at), pr });
  }
  addTrack(l, 'opened', records, ({ pr }) => {
    const p = symbolPoint(place(l.samples, pr.created_at), 'opened');
    const link = el('a', { 'data-layer': 'opened', 'data-pr': pr.number, transform: `translate(${p.x} ${p.y})`, href: `https://github.com/${l.app.repo}/pull/${pr.number}`, target: '_blank', rel: 'noopener', 'aria-label': `${l.app.name} · PR #${pr.number} · created · ${pr.title}` });
    glow(link, 'opened').append(symbolNode('opened'));
    inspectable(link, { app: l.app, kind: 'opened', item: pr });
    return link;
  });
}

// Resolutions are independent events, even when arcs are hidden or capped.
function drawResolutions(l) {
  const allowed = Object.fromEntries(['merged', 'closed'].map(key => [key, new Set(sampled(l.app, key, l.app.pulls_recent ?? [], pr => pr.number).map(pr => pr.number))]));
  const records = { merged: [], closed: [] };
  for (const pr of l.app.pulls_recent ?? []) {
    const event = resolutionEvent(pr);
    if (!event || !allowed[event.type].has(pr.number) || !view.layers.has(event.type) || event.t < view.scaleFrom || event.t > mapEnd()) continue;
    records[event.type].push({ t: event.t, pr });
  }
  for (const type of ['merged', 'closed']) {
    if (!view.layers.has(type)) continue;
    addTrack(l, type, records[type], ({ t, pr }) => {
      const p = symbolPoint(place(l.samples, new Date(t).toISOString()), type);
      const label = `${l.app.name} · PR #${pr.number} · ${type === 'merged' ? 'merged' : 'closed without merging'} · ${pr.title}`;
      const link = el('a', { 'data-layer': type, transform: `translate(${p.x} ${p.y})`, href: `https://github.com/${l.app.repo}/pull/${pr.number}`, target: '_blank', rel: 'noopener', 'aria-label': label });
      glow(link, type).append(symbolNode(type));
      inspectable(link, { app: l.app, kind: type, item: pr });
      return link;
    });
  }
}

function createLane(app, index, count, defs, group) {
  const colour = app.colour;
  const y = laneY(index, count);
  const span = END_X - CORE.x;
  const d = `M${CORE.x},${CORE.y} C${CORE.x + span * 0.28},${CORE.y} ${CORE.x + span * 0.58},${y} ${END_X},${y}`;
  const lane = el('g', { 'data-repo': app.repo, opacity: app.ok ? 1 : 0.4 });
  const line = el('path', { d, stroke: `url(#lane-${index})`, 'stroke-width': 1.4, fill: 'none' });
  defs.append(gradient(`lane-${index}`, colour, [[0, 0.1], [0.3, 1], [1, 0.9]]));
  lane.append(el('path', { d, stroke: colour, 'stroke-width': 12, 'stroke-opacity': 0.12, fill: 'none', filter: 'url(#bloom)' }), line);
  group.append(lane);
  return { app, index, count, y, colour, compact: count > MAIN_APPS.length, tracks: [], openedEntries: [], mergedEntries: [], samples: sampleLane(line), lane, defs };
}

function drawCommits(l) {
  const records = [];
  for (const iso of sampled(l.app, 'commits', l.app.commit_times ?? [], iso => iso)) {
    if (inScale(iso)) records.push({ t: Date.parse(iso), iso });
  }
  addTrack(l, 'commits', records, ({ iso }) => commitNode(place(l.samples, iso), l.app));
}

// Keep a small set of arcs near the most recent PR activity at the displayed time.
// Counts use the entire dataset; the map deliberately limits clutter.
function prepareArcs(l) {
  l.prEvents = [];
  for (const pr of l.app.pulls_recent ?? []) {
    const created = timestamp(pr.created_at);
    const ended = timestamp(pr.merged_at || (pr.state !== 'OPEN' && pr.closed_at));
    if (!Number.isFinite(created) || created > mapEnd() || ended < view.scaleFrom) continue;
    l.prEvents.push({ t: created, pr });
    if (Number.isFinite(ended) && ended <= mapEnd()) l.prEvents.push({ t: ended, pr });
  }
  l.prEvents.sort((a, b) => a.t - b.t);
  l.arcGroup = el('g', { class: 'pr-arcs' });
  l.lane.append(l.arcGroup);
  l.arcKey = null;
  l.arcNodes = [];
}

function updateArcs(l, t) {
  const connect = view.appearance.arcs.mode === 'connect';
  let eligible = null;
  if (connect) {
    eligible = new Set();
    if (view.layers.has('opened') && view.layers.has('merged')) {
      eligible = connectorPRs(l.openedEntries, l.mergedEntries, t, { opened: eventLimit('opened'), merged: eventLimit('merged') });
    }
  }
  const ordered = selectArcs(l.prEvents, t, { repo: l.app.repo, filter: view.filters.arcs, count: limitCount(view.limits.arcs), eligible });
  const key = ordered.map((pr) => pr.number).join(',');
  if (key !== l.arcKey) {
    l.arcKey = key;
    const previous = new Map(l.arcNodes.map((node) => [node.pr.number, node]));
    l.arcNodes = ordered.map((pr) => {
      if (previous.has(pr.number)) return previous.get(pr.number);
      const link = el('a', { href: `https://github.com/${l.app.repo}/pull/${pr.number}`, target: '_blank', rel: 'noopener' });
      const path = el('path', { class: 'pr-arc', fill: 'none', 'stroke-width': connect ? view.appearance.arcs.lineSize : view.appearance.arcs.size, 'stroke-linecap': 'round' });
      link.setAttribute('data-pr', pr.number);
      link.append(path);
      inspectable(link, { app: l.app, kind: 'arcs', item: pr });
      return { pr, link, path, state: null };
    });
    l.arcGroup.replaceChildren(...l.arcNodes.map((n) => n.link));
  }
  l.arcNodes.forEach((n, k) => {
    const { pr } = n;
    const end = timestamp(pr.merged_at || (pr.state !== 'OPEN' && pr.closed_at));
    const resolved = Number.isFinite(end) && end <= t;
    const state = resolved ? (pr.merged_at ? 'merged' : 'closed') : 'open';
    if (resolved && n.state === state) return;
    const colour = { open: '#f3bd68', merged: '#67d9b2', closed: '#9aa6bc' }[state];
    const fromPoint = place(l.samples, pr.created_at);
    const toPoint = place(l.samples, new Date(resolved ? end : t).toISOString());
    const from = connect ? symbolPoint(fromPoint, 'opened') : fromPoint;
    const to = connect ? symbolPoint(toPoint, 'merged') : toPoint;
    const lift = arcLift(to.t - from.t) * (k % 2 ? 1 : 0.8);
    n.path.setAttribute('d', connect ? (view.appearance.arcs.connectorShape === 'follow' ? followLanePath(l.samples, from, to, view.appearance.arcs.bend) : `M${from.x},${from.y} L${to.x},${to.y}`) : view.appearance.arcs.position === 'on' ? linePath(l.samples, from.x, to.x) : arcPath(from, to, lift * arcDirection(view.appearance.arcs)));
    n.path.setAttribute('stroke', colour);
    n.path.setAttribute('stroke-opacity', state === 'closed' ? '.45' : '.75');
    n.path.setAttribute('stroke-dasharray', state === 'open' ? '4 5' : 'none');
    if (n.state !== state) {
      n.state = state;
      const label = `${l.app.name} · PR #${pr.number} · ${state === 'closed' ? 'closed without merging' : state} at displayed time · ${pr.title}`;
      n.link.setAttribute('aria-label', label);
    }
  });
}

// Open markers are independent of arcs and use the selected replay time.
function prepareOpenItems(l) {
  l.openLayers = ['prs', 'issues'].filter((key) => view.layers.has(key)).map((key) => {
    const group = el('g', { class: `open-${key}`, 'data-layer': key });
    l.lane.append(group);
    return { key, group, signature: null, records: [...sampled(l.app, key, key === 'prs' ? l.app.pulls_recent ?? [] : l.app.issues_recent ?? [], item => item.number)].sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at)) };
  });
}

function updateOpenItems(l, t) {
  for (const layer of l.openLayers) {
    const items = openItemsAt(layer.records, t, limitCount(eventLimit(layer.key)));
    const signature = items.map((item) => item.number).join(',');
    if (signature === layer.signature) continue;
    layer.signature = signature;
    if (view.appearance[layer.key].glow) view.glowLayer?.invalidate();
    layer.group.replaceChildren(...items.map((item) => {
      const p = place(l.samples, item.created_at);
      const isPR = layer.key === 'prs';
      const label = `${l.app.name} · ${isPR ? 'PR' : 'Issue'} #${item.number} · open at displayed time · ${item.title}`;
      const link = el('a', { transform: `translate(${p.x} ${p.y + symbolOffset(view.appearance[layer.key])})`, href: `https://github.com/${l.app.repo}/${isPR ? 'pull' : 'issues'}/${item.number}`, target: '_blank', rel: 'noopener', 'aria-label': label });
      const marker = symbolNode(layer.key);
      glow(link, layer.key).append(marker);
      inspectable(link, { app: l.app, kind: layer.key, item });
      return link;
    }));
  }
}

// Advisories are few and never capped, so each record builds its own node.
function drawAdvisories(l) {
  const records = [];
  for (const advisory of l.app.advisories?.items ?? []) {
    if (!inScale(advisory.published_at)) continue;
    const from = place(l.samples, advisory.published_at);
    if (!from) continue;
    const fix = fixedRelease(advisory, (l.app.releases_recent ?? []).filter(release => timestamp(release.published_at) <= mapEnd()));
    const to = fix ? place(l.samples, fix.published_at) : { x: END_X, y: yOnLane(l.samples, END_X), t: mapEnd() };
    records.push({ t: from.t, build: () => {
      const group = el('g', {});
      group.append(el('path', {
        d: linePath(l.samples, from.x, to.x),
        fill: 'none',
        stroke: '#EF4444',
        'stroke-width': 3,
        'stroke-opacity': 0.85,
        'stroke-dasharray': '6 6',
        filter: 'url(#bloom)',
      }));
      const ring = translate(from);
      ring.append(
        el('circle', { class: 'ring', r: 10, fill: 'none', stroke: '#EF4444', 'stroke-width': 2.5 }),
        el('text', { x: 0, y: -18, 'text-anchor': 'middle', fill: '#FCA5A5', 'font-size': 13, 'font-weight': 800 },
          `advisory ${advisory.ghsa ?? ''}`.trim()),
      );
      group.append(ring);
      return group;
    } });

    if (fix) {
      records.push({ t: to.t, build: () => {
        const fixed = translate(to);
        fixed.append(
          el('circle', { r: 10, fill: 'none', stroke: '#22C55E', 'stroke-width': 3 }),
          el('text', { x: 0, y: -18, 'text-anchor': 'middle', fill: '#86EFAC', 'font-size': 13, 'font-weight': 800 }, `${version(fix.tag)} · fixed`),
        );
        return fixed;
      } });
    }
  }
  addTrack(l, 'advisories', records, (record) => record.build());
}

// Every displayed release star gets a label when enabled, regardless of overlap.
function placeReleases(lanes) {
  for (const l of lanes) {
    const records = [];
    for (const release of sampled(l.app, 'releases', l.app.releases_recent ?? [], release => release.tag)) {
      if (!inScale(release.published_at)) continue;
      if (Date.parse(release.published_at) < view.start) continue; // the list keeps older releases for the version picker
      records.push({ t: Date.parse(release.published_at), release });
    }
    addTrack(l, 'releases', records, ({ release }) => {
      const p = place(l.samples, release.published_at);
      const holder = el('a', { 'data-layer': 'releases', transform: `translate(${p.x} ${p.y + symbolOffset(view.appearance.releases)})`, href: `https://github.com/${l.app.repo}/releases/tag/${encodeURIComponent(release.tag)}`, target: '_blank', rel: 'noopener', 'aria-label': `${l.app.name} release ${release.tag}` });
      glow(holder, 'releases').append(symbolNode('releases'));
      inspectable(holder, { app: l.app, kind: 'releases', item: release });
      if (view.releaseLabels === 'all') {
        holder.append(el('text', {
          x: 0,
          y: -(view.appearance.releases.size / 2 + 7) * view.appearance.releases.labelHeight,
          'text-anchor': 'middle',
          fill: '#E8ECF2',
          'font-size': 12,
          'font-weight': 700,
          'font-family': MONO,
        }, release.tag));
      }
      return holder;
    });
  }
}

// Lane labels avoid showing today's release or issue count inside a historical replay.
function drawNameLabels(l) {
  const { app, y, colour } = l;
  const link = el('a', { class: 'lane-name', href: `app.html?app=${encodeURIComponent(app.name)}`, 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown' });
  link.append(el('text', { x: NAME_X, y: y + 5, fill: colour, 'font-size': 20, 'font-weight': 750 }, app.name));
  link.append(el('title', {}, `${app.name} · open app dashboard · drag up or down to reorder`));
  link.addEventListener('pointerdown', (event) => startLaneDrag(event, l));
  link.addEventListener('click', (event) => { if (performance.now() < suppressNameClickUntil) event.preventDefault(); });
  link.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const to = l.index + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= view.lanes.length) return;
    moveLane(l.index, to);
    view.lanes[to].nameLink.focus();
  });
  l.lane.append(el('circle', { cx: END_X, cy: y, r: 3, fill: colour }), link);
  l.nameLink = link;
}

// Dragging a name up or down moves its lane; a plain click still opens the app dashboard.
let laneDrag = null;
let suppressNameClickUntil = 0;
function svgY(event) {
  const matrix = svg.getScreenCTM();
  return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()).y : null;
}
function startLaneDrag(event, l) {
  if (event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.stopPropagation(); // A press on a name never starts a time zoom.
  const y = svgY(event);
  if (y === null || view.lanes.length < 2) return;
  laneDrag = { id: event.pointerId, lane: l, clientY: event.clientY, y, to: l.index, moved: false };
}
function cancelLaneDrag() {
  if (!laneDrag) return;
  for (const lane of view.lanes) lane.nameLink.style.transform = '';
  laneDrag.lane.nameLink.classList.remove('dragging');
  laneDrag.cursor?.remove();
  laneDrag = null;
}
window.addEventListener('pointermove', (event) => {
  if (!laneDrag || event.pointerId !== laneDrag.id) return;
  if (!laneDrag.moved) {
    if (Math.abs(event.clientY - laneDrag.clientY) < 6) return;
    laneDrag.moved = true;
    laneDrag.lane.nameLink.classList.add('dragging');
    laneDrag.cursor = el('rect', { class: 'lane-drag-cursor', x: -1e5, y: -1e5, width: 2e5, height: 2e5 });
    svg.append(laneDrag.cursor);
  }
  event.preventDefault();
  const y = svgY(event);
  if (y === null) return;
  const slots = view.lanes.map((lane) => lane.y);
  const from = laneDrag.lane.index;
  const target = clamp(slots[from] + y - laneDrag.y, slots[0], slots[slots.length - 1]);
  laneDrag.to = dropIndex(target, slots);
  // Other names slide into the slots they would take, so the drop position is visible.
  const order = moveItem(slots.map((_, index) => index), from, laneDrag.to);
  for (const lane of view.lanes) {
    const dy = lane.index === from ? target - slots[from] : slots[order.indexOf(lane.index)] - slots[lane.index];
    lane.nameLink.style.transform = dy ? `translate(0px, ${dy.toFixed(1)}px)` : '';
  }
});
window.addEventListener('pointerup', (event) => {
  if (!laneDrag || event.pointerId !== laneDrag.id) return;
  const { moved, lane, to } = laneDrag;
  cancelLaneDrag();
  if (!moved) return;
  suppressNameClickUntil = performance.now() + 600;
  if (to !== lane.index) moveLane(lane.index, to);
});
window.addEventListener('pointercancel', cancelLaneDrag);
window.addEventListener('blur', cancelLaneDrag);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && laneDrag) { cancelLaneDrag(); event.preventDefault(); }
});

function moveLane(from, to) {
  const all = orderApps(view.data.apps, view.order).map((app) => app.name);
  setLaneOrder(reorderNames(all, view.lanes.map((lane) => lane.app.name), from, to));
}

function setLaneOrder(order) {
  const isDefault = !order || order.every((name, index) => name === view.data.apps[index]?.name);
  view.order = isDefault ? null : order;
  try {
    if (view.order) localStorage.setItem('craft-watch-order', JSON.stringify(view.order));
    else localStorage.removeItem('craft-watch-order');
  } catch { /* Preferences are optional. */ }
  $('#reset-order').hidden = !view.order;
  render();
  prepareDashboard();
  updateSelectionUI();
  writeUrl();
}

function drawCore() {
  const group = el('g', {});
  group.append(
    el('circle', { class: 'ring', cx: CORE.x, cy: CORE.y, r: 40, fill: 'none', stroke: '#C4B5FD', 'stroke-width': 2 }),
    el('circle', { class: 'ring', cx: CORE.x, cy: CORE.y, r: 40, fill: 'none', stroke: '#C4B5FD', 'stroke-width': 2, style: 'animation-delay: -1.5s' }),
    el('circle', { class: 'core', cx: CORE.x, cy: CORE.y, r: 46, fill: '#7C3AED', 'fill-opacity': 0.5, filter: 'url(#bloom)' }),
    el('circle', { cx: CORE.x, cy: CORE.y, r: 18, fill: '#FFFFFF' }),
    el('text', { x: CORE.x, y: CORE.y + 72, fill: '#E8ECF2', 'font-size': 18, 'font-weight': 800, 'text-anchor': 'middle', 'letter-spacing': 3 }, 'ARTCRAFT'),
  );
  return group;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const bigFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const zoomTickFmt = new Intl.DateTimeFormat(undefined, {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function latestDuration() {
  const hours = (view.end - view.scaleFrom) / HOUR;
  return hours >= 24 ? `${hours / 24} ${hours === 24 ? 'day' : 'days'}` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

function agoLabel(duration) {
  const hours = duration / HOUR;
  if (hours < 1) return `${Math.round(hours * 60)} min ago`;
  return hours < 24 ? `${hours} h ago` : `${hours / 24} d ago`;
}

// Faint ticks share the same evenly spaced scale as the events.
function drawTicks() {
  const group = el('g', {});
  for (const time of pstMidnights(view.scaleFrom, mapEnd())) {
    const x = xOf(time);
    group.append(el('line', {
      class: 'midnight-guide', 'data-midnight': new Date(time).toISOString(),
      x1: x, x2: x, y1: mapLayout.axisTop, y2: mapLayout.axisBottom,
      stroke: '#b8c4df', 'stroke-opacity': 0.17, 'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none', 'aria-hidden': 'true',
    }));
  }
  const ticks = view.zoom ? [0, 0.25, 0.5, 0.75, 1].map(fraction => {
    const t = view.scaleFrom + fraction * (mapEnd() - view.scaleFrom);
    return [t, zoomTickFmt.format(t), fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'];
  }) : view.replay
    ? [
      [view.scaleFrom, (view.mode === 'month' ? dateFmt : timeFmt).format(view.scaleFrom), 'start'],
      [view.end, 'latest data', 'end'],
    ]
    : [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      const duration = (view.end - view.scaleFrom) * (1 - fraction);
      return [view.end - duration, fraction === 1 ? 'latest data' : agoLabel(duration), fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'];
    });
  for (const [t, label, anchor] of ticks) {
    const x = xOf(t);
    group.append(
      el('line', { x1: x, y1: mapLayout.axisTop, x2: x, y2: mapLayout.axisBottom, stroke: '#FFFFFF', 'stroke-opacity': 0.08, 'stroke-dasharray': '2 6' }),
      el('text', { x, y: 148, 'text-anchor': anchor, fill: '#9AA4B2', 'font-size': 13, 'font-family': MONO }, label),
    );
  }
  return group;
}

function visibleApps() {
  return orderApps(view.data.apps.filter((app) => view.selected.has(app.name)), view.order);
}

function fitTimeline(apps) {
  svg.toggleAttribute('hidden', apps.length === 0);
  // Measure the same SVG font used for labels, instead of reserving a wide fixed gutter.
  const measure = el('text', { visibility: 'hidden', 'font-size': 20, 'font-weight': 750 });
  svg.append(measure);
  let labelWidth = 0;
  for (const app of apps) {
    measure.textContent = app.name;
    labelWidth = Math.max(labelWidth, measure.getComputedTextLength());
  }
  measure.remove();
  mapLayout = timelineLayout(apps.length, Math.ceil(labelWidth));
  Object.assign(CORE, mapLayout.core);
  END_X = mapLayout.endX;
  TIME_START_X = mapLayout.timeStartX;
  NAME_X = mapLayout.nameX;
  svg.setAttribute('viewBox', `0 ${mapLayout.top} ${mapLayout.width} ${mapLayout.height}`);
}

function render() {
  dragZoom.cancel();
  cancelLaneDrag();
  clearInspection();
  view.glowLayer?.dispose();
  view.glowLayer = null;
  const defs = el('defs', {});
  defs.append(el('filter', { id: 'bloom', x: '-50%', y: '-50%', width: '200%', height: '200%' }));
  defs.querySelector('filter').append(el('feGaussianBlur', { stdDeviation: 5 }));

  const group = el('g', {});
  const apps = visibleApps();
  fitTimeline(apps);
  const lanes = apps.map((app, index) => createLane(app, index, apps.length, defs, group));
  for (const l of lanes) {
    if (view.layers.has('commits')) drawCommits(l);
    if (view.layers.has('arcs')) prepareArcs(l);
    drawOpened(l);
    drawResolutions(l);
    prepareOpenItems(l);
    drawAdvisories(l);
    drawNameLabels(l);
  }
  view.lanes = lanes;
  if (view.layers.has('releases')) placeReleases(lanes);

  view.headLine = el('line', { y1: mapLayout.axisTop, y2: mapLayout.axisBottom, stroke: '#FFFFFF', 'stroke-opacity': 0.3, 'stroke-dasharray': '4 8' });
  svg.replaceChildren(defs, drawTicks(), group, drawCore(), view.headLine);
  if (Object.entries(view.appearance).some(([key, style]) => view.layers.has(key) && style.glow)) {
    view.glowLayer = createGlowLayer(svg, mapLayout);
    if (view.glowLayer) svg.insertBefore(view.glowLayer.element, group.nextSibling);
  }
  svg.classList.toggle('glow-batched', Boolean(view.glowLayer));
  svg.classList.toggle('replay', view.replay);
  showUntil(view.sim);
  setHead(view.sim);
}

// Shows each layer's events up to time t, within its display limit, rather than the end of
// the replay. Works forwards and backwards.
function showUntil(t) {
  for (const lane of view.lanes) {
    for (const track of lane.tracks) {
      const [from, to] = visibleRange(track.records, t, track.capped ? eventLimit(track.key) : null);
      if (showRange(track, from, to) && view.appearance[track.key]?.glow) view.glowLayer?.invalidate();
    }
  }
}

function setHead(t) {
  if (!view.headLine) return;
  const x = xOf(t);
  view.headLine.setAttribute('x1', x.toFixed(1));
  view.headLine.setAttribute('x2', x.toFixed(1));
  view.headLine.style.display = view.replay ? '' : 'none';
}

function renderClock() {
  $('#bigclock').hidden = !view.replay;
  if (view.replay) {
    $('#bigclock').textContent = bigFmt.format(view.sim);
    $('#clock').textContent = `Replay · ${MODES[view.mode].label}${view.playing ? '' : ' · paused'}`;
  } else if (view.zoom) {
    $('#clock').textContent = `Zoomed · ${zoomTickFmt.format(view.scaleFrom)} → ${zoomTickFmt.format(mapEnd())}`;
  } else {
    $('#clock').textContent = `Last ${latestDuration()} · data up to ${fmt.format(view.end)}`;
  }
}

function renderStatus() {
  const ageMs = Date.now() - view.end;
  const minutes = Math.max(0, Math.round(ageMs / 60e3));
  const ago = minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  const status = $('#status');
  const stale = ageMs > STALE_MS;
  status.classList.toggle('warn', stale);
  status.textContent = stale
    ? `Data delayed: last update ${ago}. Numbers may be out of date.`
    : `Updated ${ago}`;
  // Apps whose last refresh failed keep their old numbers, marked stale since their last good refresh.
  const staleSince = view.data.apps.filter((a) => a.ok === false).map((a) => a.stale_since).filter(Boolean).sort()[0];
  if (staleSince) {
    status.textContent += ` · ${view.data.apps.filter((a) => a.ok === false).length} app(s) stale since ${fmt.format(new Date(staleSince))}`;
  }
}

function html(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

const METRIC_KEYS = ['open', 'opened', 'merged', 'closed', 'commits', 'releases'];
const metricText = (counts, key) => counts[key] === null ? '—' : `${key === 'open' && counts.estimated ? '≈' : ''}${counts[key].toLocaleString()}`;

function prepareAppBreakdown(apps) {
  view.appActivity = apps.map((app) => {
    const activity = createActivity([app], view.scaleFrom, view.end);
    const row = html('tr', { 'data-app': app.name });
    row.style.setProperty('--app-colour', app.colour);
    const identity = html('th', { scope: 'row' });
    const link = html('a', { href: `app.html?app=${encodeURIComponent(app.name)}`, class: 'breakdown-app' });
    link.append(html('span', { class: 'app-swatch', 'aria-hidden': 'true' }), app.name, html('span', { class: 'breakdown-arrow', 'aria-hidden': 'true' }, '↗'));
    identity.append(link);
    const warnings = [];
    if (activity.incomplete) warnings.push('Partial PR history');
    if (activity.sampledCommits) warnings.push('Partial commit history');
    if (!activity.openKnown) warnings.push('Open PR count unavailable');
    if (warnings.length) identity.append(html('small', { class: 'breakdown-warning' }, warnings.join(' · ')));
    row.append(identity);
    const cells = Object.fromEntries(METRIC_KEYS.map((key) => {
      const cell = html('td', { 'data-metric': key, class: key });
      const number = html('span', { class: 'breakdown-number' });
      const track = html('span', { class: 'breakdown-track', 'aria-hidden': 'true' });
      const bar = html('span');
      track.append(bar);
      cell.append(number, track);
      row.append(cell);
      return [key, { number, bar }];
    }));
    return { activity, row, cells };
  });
  $('#app-breakdown-body').replaceChildren(...view.appActivity.map(({ row }) => row));
  $('#app-breakdown-empty').hidden = apps.length > 0;
  $('#app-breakdown-scroll').hidden = apps.length === 0;
}

function renderAppBreakdown() {
  const preview = view.previewRange;
  const rows = view.appActivity.map((entry) => ({ ...entry, counts: preview ? entry.activity.at(preview.to, preview.from) : entry.activity.at(view.sim) }));
  const maxima = Object.fromEntries(METRIC_KEYS.map((key) => [key, Math.max(1, ...rows.map(({ counts }) => counts[key] ?? 0))]));
  for (const { counts, cells } of rows) {
    for (const key of METRIC_KEYS) {
      const text = metricText(counts, key);
      if (cells[key].number.textContent !== text) cells[key].number.textContent = text;
      cells[key].bar.style.width = `${100 * (counts[key] ?? 0) / maxima[key]}%`;
    }
  }
  $('.app-breakdown').classList.toggle('is-preview', Boolean(preview));
  $('#app-breakdown-scope').title = preview ? `${detailTimeFmt.format(preview.from)} → ${detailTimeFmt.format(preview.to)}` : '';
  $('.breakdown-table th.open').title = preview ? 'Estimated open PR backlog at the end of the drag selection. Other columns count events inside the selection.' : 'Open PR backlog at the displayed time.';
  $('#app-breakdown-scope').textContent = preview ? 'Drag preview' : view.zoom ? 'Selected interval' : view.replay ? 'Following the playhead' : `Last ${latestDuration()}`;
}

const EVENT_LABELS = { opened: 'PR created', merged: 'PR merged', closed: 'PR closed unmerged', commits: 'Commit', releases: 'Release' };
function renderDashboard() {
  if (!view.activity) return;
  const counts = view.activity.at(view.sim);
  for (const key of METRIC_KEYS) {
    const text = metricText(counts, key);
    const node = $(`#count-${key}`);
    if (node.textContent !== text) node.textContent = text;
  }
  renderAppBreakdown();
  $('#open-note').textContent = !view.activity.openKnown ? 'Count unavailable' : counts.estimated ? 'Estimated at replay time' : 'At the latest app updates';
  $('#metrics-heading').textContent = view.zoom ? 'Activity in the selected interval' : view.replay ? 'Activity since replay start' : `Activity in the last ${latestDuration()}`;
  $('#count-scope').textContent = `${view.selected.size} selected ${view.selected.size === 1 ? 'app' : 'apps'}`;
  $('#feed-heading').textContent = view.zoom ? 'Events at the end of the selected interval' : view.replay ? 'Events reaching the playhead' : 'Latest events';
  if (view.lastFeed !== counts.cursor) {
    view.lastFeed = counts.cursor;
    const rows = [...counts.recent].reverse().map((event) => {
      const row = html('li');
      const meta = html('div', { class: 'event-meta' });
      meta.append(html('span', { class: `event-type ${event.type}` }, EVENT_LABELS[event.type]), html('span', {}, `· ${event.app.name}`), html('time', { datetime: new Date(event.t).toISOString() }, bigFmt.format(event.t)));
      row.append(meta, html('a', { href: event.url, target: '_blank', rel: 'noopener', title: event.title }, event.title));
      return row;
    });
    $('#event-feed').replaceChildren(...(rows.length ? rows : [html('li', { class: 'event-empty' }, view.selected.size ? 'No recorded events yet in this window. Scrub forward or try a longer replay.' : 'Choose apps to see their activity.')]));
  }
  for (const lane of view.lanes) {
    if (view.layers.has('arcs')) updateArcs(lane, view.sim);
    updateOpenItems(lane, view.sim);
  }
  refreshInspection();
  const progress = (view.sim - view.scaleFrom) / (view.end - view.scaleFrom);
  $('#scrub').value = String(Math.round(progress * 1000));
  $('#scrub').setAttribute('aria-valuetext', fmt.format(view.sim));
  $('#play-progress').textContent = `${Math.round(progress * 100)}%`;
  $('#play-pause').textContent = view.playing ? 'Pause' : view.sim >= view.end ? 'Replay again' : 'Play';
  $('#play-pause').setAttribute('aria-label', view.playing ? 'Pause replay' : 'Play replay');
  renderClock();
  $('#reset-zoom').hidden = !view.zoom;
  $('#zoom-state').textContent = view.zoom ? 'Zoomed interval · drag again to zoom further' : 'Drag anywhere on the map to zoom · drag an app name to reorder · Esc cancels';
}

function prepareDashboard() {
  const apps = visibleApps();
  view.activity = createActivity(apps, view.scaleFrom, view.end);
  prepareAppBreakdown(apps);
  view.lastFeed = null;
  $('#empty-selection').hidden = apps.length > 0;
  $('#space').hidden = apps.length === 0;
  $('#playback').hidden = !view.replay;
  $('#range-start').textContent = bigFmt.format(view.scaleFrom);
  $('#range-end').textContent = bigFmt.format(view.end);
  const notes = [];
  if (apps.length) {
    if (view.activity.sampledCommits) notes.push('Commit history is incomplete for some selected apps. Unlimited shows all loaded timestamps; run npm run data:commits to fetch the full window.');
    if (view.replay || view.zoom) notes.push('≈ Historical open PR totals are estimates; reopen transitions are not recorded.');
    if (view.activity.incomplete) notes.push('Some selected apps have delayed or incomplete PR records; event totals may be partial.');
    if (!view.activity.openKnown) notes.push('The open PR total is unavailable for at least one selected app.');
    notes.push('Merges and commits are not releases. Counts are separate measures, not additive.');
  }
  $('#coverage-note').textContent = notes.join(' ');
  updateLimitNotes();
  renderDashboard();
}

function markModeButtons() {
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(!view.zoom && button.dataset.mode === view.mode));
}

function writeUrl() {
  const query = new URLSearchParams(location.search);
  if (view.replay) query.set('mode', view.mode); else query.delete('mode');
  if (view.data) query.set('apps', view.selected.size === view.data.apps.length ? 'all' : [...view.selected].join(',') || 'none');
  if (view.order) query.set('order', view.order.join(',')); else query.delete('order');
  query.set('layers', view.layers.size === LAYERS.length ? 'all' : LAYERS.filter((key) => view.layers.has(key)).join(',') || 'none');
  for (const key of LAYERS) query.set(`limit_${key}`, view.limits[key] === null ? 'all' : String(view.limits[key]));
  query.set('labels', view.releaseLabels);
  query.set('range', view.latestRange);
  const appearance = Object.fromEntries(Object.entries(view.appearance).filter(([key, style]) => Object.entries(style).some(([name, value]) => DEFAULT_APPEARANCE[key][name] !== value)));
  if (Object.keys(appearance).length) query.set('appearance', JSON.stringify(appearance)); else query.delete('appearance');
  query.set('filters', JSON.stringify(view.filters));
  query.set('arc_filter', view.filters.arcs.mode);
  query.set('arc_probability', String(view.filters.arcs.probability));
  query.set('arc_seed', String(view.filters.arcs.seed));
  if (view.zoom) { query.set('zoom_from', String(view.zoom.from)); query.set('zoom_to', String(view.zoom.to)); }
  else { query.delete('zoom_from'); query.delete('zoom_to'); }
  const text = query.toString();
  history.replaceState(null, '', `${location.pathname}${text ? `?${text}` : ''}${location.hash}`);
}

function updateLayerUI() {
  $('#layer-count').textContent = `${view.layers.size}/${LAYERS.length}`;
  for (const input of document.querySelectorAll('#layer-picker input[data-layer-toggle]')) input.checked = view.layers.has(input.value);
  for (const label of document.querySelectorAll('[data-legend]')) label.hidden = !view.layers.has(label.dataset.legend);
  $('#layers-empty').hidden = view.layers.size > 0;
  syncArcMode();
}

function setLayers(names) {
  view.layers = new Set(names.filter((key) => LAYERS.includes(key)));
  try { localStorage.setItem('craft-watch-layers', JSON.stringify([...view.layers])); } catch { /* Preferences are optional. */ }
  updateLayerUI();
  if (view.data) {
    render();
    renderDashboard();
  }
  writeUrl();
}

function restoreLayers() {
  let names = LAYERS;
  try {
    const saved = JSON.parse(localStorage.getItem('craft-watch-layers'));
    if (Array.isArray(saved)) names = saved;
  } catch { /* Storage may be unavailable. */ }
  const query = params.get('layers');
  if (query !== null) names = query === 'all' ? LAYERS : query === 'none' ? [] : query.split(',');
  const valid = names.filter((key) => LAYERS.includes(key));
  view.layers = new Set(valid.length || !names.length ? valid : LAYERS);
  updateLayerUI();
}

const LIMIT_NAMES = { arcs: 'arcs', commits: 'commits', releases: 'releases', prs: 'open PRs', opened: 'PR creation events', issues: 'open issues', merged: 'merged PRs', closed: 'PRs closed unmerged' };
function updateLimitNotes() {
  $('#map-limits-note').textContent = 'Per app: ' + LAYERS.map((key) => view.filters[key].mode === 'probability' ? `${Math.round(view.filters[key].probability * 10000) / 100}% of ${LIMIT_NAMES[key]} (chance)` : `${view.limits[key] === null ? 'unlimited' : view.limits[key]} ${LIMIT_NAMES[key]}`).join(' · ') + '.';
  if (!view.data) return;
  const apps = visibleApps();
  const timestamps = apps.reduce((sum, app) => sum + (app.commit_times?.length ?? 0), 0);
  const partial = apps.some((app) => app.truncated?.commits);
  $('#limits-data-note').textContent = `${timestamps.toLocaleString()} commit timestamps loaded for the selected apps. ${partial ? 'Some history is incomplete. Unlimited cannot recover missing records; npm run data:commits fetches the full 30-day history.' : 'The loaded commit history has no reported truncation.'} Open PR / issue records may omit older unchanged items and reopen transitions.`;
}

function syncFilterRow(key) {
  const probability = view.filters[key].mode === 'probability';
  for (const button of document.querySelectorAll(`[data-filter-key="${key}"]`)) button.setAttribute('aria-pressed', String(button.dataset.filterMode === view.filters[key].mode));
  $(`#count-controls-${key}`).hidden = probability;
  $(`#probability-controls-${key}`).hidden = !probability;
  const unlimited = view.limits[key] === null;
  $(`#unlimited-${key}`).checked = unlimited;
  $(`#limit-${key}`).disabled = unlimited;
  if (document.activeElement !== $(`#limit-${key}`)) $(`#limit-${key}`).value = String(view.limits[key] ?? DEFAULT_LIMITS[key] ?? 100);
  for (const id of [`probability-${key}`, `probability-slider-${key}`]) {
    if (document.activeElement !== $(`#${id}`)) $(`#${id}`).value = String(Math.round(view.filters[key].probability * 10000) / 100);
  }
}
function syncLimitInputs() {
  for (const key of LAYERS) syncFilterRow(key);
  $('#release-labels').checked = view.releaseLabels === 'all';
  updateLimitNotes();
}

function applyLimits(values, labels, filters = view.filters) {
  view.limits = normalizeLimits(values);
  view.filters = normalizeEventFilters(filters);
  view.releaseLabels = labels === 'none' ? 'none' : 'all';
  try {
    localStorage.setItem('craft-watch-limits', JSON.stringify({ ...view.limits, labels: view.releaseLabels }));
    localStorage.setItem('craft-watch-event-filters', JSON.stringify(view.filters));
  } catch { /* Preferences are optional. */ }
  syncLimitInputs();
  if (view.data) { render(); renderDashboard(); }
  writeUrl();
}
function setEventFilter(key, values) {
  applyLimits(view.limits, view.releaseLabels, { ...view.filters, [key]: { ...view.filters[key], ...values } });
}

function restoreLimits() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('craft-watch-limits')) ?? {}; } catch { /* Preferences are optional. */ }
  const values = Object.fromEntries(LAYERS.map((key) => [key, params.has(`limit_${key}`) ? params.get(`limit_${key}`) : saved[key]]));
  view.limits = normalizeLimits(values);
  const labels = params.get('labels') ?? saved.labels;
  view.releaseLabels = labels === 'none' ? 'none' : 'all';
  syncLimitInputs();
}

function syncArcMode() {
  const connect = view.appearance.arcs.mode === 'connect';
  $('#mode-arcs').value = view.appearance.arcs.mode;
  $('#position-arcs').disabled = connect;
  $('#size-arcs').disabled = connect;
  $('#lineSize-arcs').disabled = !connect;
  $('#connectorShape-arcs').value = view.appearance.arcs.connectorShape;
  $('#connectorShape-arcs').disabled = !connect;
  $('#bend-arcs').disabled = !connect || view.appearance.arcs.connectorShape !== 'follow';
  $('#arc-mode-note').textContent = connect
    ? (view.layers.has('opened') && view.layers.has('merged') ? 'Connects visible PR created and PR merged points for the same PR. Both events must be within the selected range and their display limits. PR open is independent. Follow lane keeps connectors close to the app line; higher bend strength makes the transition steeper near the middle.' : 'Enable both PR created and PR merged to show connector lines.')
    : 'Curved lifetimes include open, merged and closed PRs. Connect mode joins opening and merge symbols with straight or lane-following lines.';
}
function restoreEventFilters() {
  let saved = {}, legacy = {};
  try { saved = JSON.parse(localStorage.getItem('craft-watch-event-filters')) ?? {}; } catch { /* Preferences are optional. */ }
  try { legacy = JSON.parse(localStorage.getItem('craft-watch-arc-filter')) ?? {}; } catch { /* Preferences are optional. */ }
  let urlFilters = null;
  if (params.has('filters')) {
    try { urlFilters = JSON.parse(params.get('filters')); } catch { /* Ignore malformed links. */ }
  }
  const values = urlFilters ?? saved;
  // Preserve links and preferences from the original arc-only probability control.
  if (!urlFilters?.arcs && (params.has('arc_filter') || !saved.arcs)) {
    view.filters = normalizeEventFilters({ ...values, arcs: {
      mode: params.get('arc_filter') ?? legacy.mode,
      probability: params.get('arc_probability') ?? legacy.probability,
      seed: params.get('arc_seed') ?? legacy.seed,
    } });
  } else view.filters = normalizeEventFilters(values);
}

function buildLimitControls() {
  const names = { arcs: 'Arcs / connectors', commits: 'Commits', releases: 'Releases', prs: 'PR open', opened: 'PR created', issues: 'Issue open', merged: 'PR merged', closed: 'PR closed unmerged' };
  for (const key of LAYERS) {
    const row = html('div', { class: 'density-row' });
    const header = html('div', { class: 'density-row-heading' });
    header.append(html('span', { class: 'density-name' }, names[key]));
    const modes = html('div', { class: 'density-switch', role: 'group', 'aria-label': `${names[key]} selection method` });
    for (const mode of ['count', 'probability']) {
      const button = html('button', { type: 'button', 'data-filter-key': key, 'data-filter-mode': mode, 'aria-pressed': String(mode === 'count') }, mode === 'count' ? 'Count' : 'Probability');
      button.addEventListener('click', () => setEventFilter(key, { mode }));
      modes.append(button);
    }
    header.append(modes);
    const count = html('div', { id: `count-controls-${key}`, class: 'density-controls' });
    const number = html('input', { id: `limit-${key}`, type: 'number', min: 1, step: 1, 'aria-label': `${names[key]} count limit per app` });
    const unlimited = html('input', { id: `unlimited-${key}`, type: 'checkbox', 'aria-label': `Unlimited ${names[key]}` });
    const label = html('label', { class: 'unlimited-label' });
    label.append(unlimited, 'Unlimited');
    count.append(html('span', { class: 'density-caption' }, 'Most recent'), number, label);
    number.addEventListener('input', () => {
      if (number.value && number.checkValidity() && Number.isSafeInteger(Number(number.value))) applyLimits({ ...view.limits, [key]: Number(number.value) }, view.releaseLabels);
    });
    number.addEventListener('blur', () => syncFilterRow(key));
    unlimited.addEventListener('change', () => applyLimits({ ...view.limits, [key]: unlimited.checked ? null : Number(number.value) || DEFAULT_LIMITS[key] || 100 }, view.releaseLabels));
    const probability = html('div', { id: `probability-controls-${key}`, class: 'density-controls probability-controls', hidden: '' });
    const slider = html('input', { id: `probability-slider-${key}`, type: 'range', min: 0, max: 100, step: 1, 'aria-label': `${names[key]} probability slider` });
    const percent = html('label', { class: 'density-percent' });
    const value = html('input', { id: `probability-${key}`, type: 'number', min: 0, max: 100, step: 'any', 'aria-label': `${names[key]} probability percent` });
    percent.append(value, '%');
    const resample = html('button', { type: 'button', id: `resample-${key}`, 'aria-label': `Resample ${names[key]}`, title: 'Draw a new sample at the same probability' }, '↻ Resample');
    // The slider previews its percentage during a drag and applies on release.
    slider.addEventListener('input', () => { value.value = slider.value; });
    slider.addEventListener('change', () => setEventFilter(key, { probability: Number(slider.value) / 100 }));
    value.addEventListener('input', () => {
      if (value.value && value.checkValidity()) setEventFilter(key, { probability: Number(value.value) / 100 });
    });
    value.addEventListener('blur', () => syncFilterRow(key));
    resample.addEventListener('click', () => setEventFilter(key, { seed: (view.filters[key].seed + 1) >>> 0 }));
    probability.append(slider, percent, resample);
    row.append(header, count, probability);
    $('#density-controls').append(row);
  }
}

function syncAppearance() {
  syncArcMode();
  if (document.activeElement !== $('#bend-arcs')) $('#bend-arcs').value = view.appearance.arcs.bend;
  if (document.activeElement !== $('#lineSize-arcs')) $('#lineSize-arcs').value = view.appearance.arcs.lineSize;
  const heightInput = $('#labelHeight-releases');
  if (document.activeElement !== heightInput) heightInput.value = view.appearance.releases.labelHeight;
  for (const [key, style] of Object.entries(view.appearance)) {
    $(`#position-${key}`).value = style.position;
    const sizeInput = $(`#size-${key}`);
    if (document.activeElement !== sizeInput) sizeInput.value = style.size;
    if (key !== 'arcs') {
      $(`#shape-${key}`).value = style.shape;
      $(`#glow-${key}`).value = String(style.glow);
      const preview = $(`#preview-${key}`);
      preview.replaceChildren(symbolNode(key, SYMBOL_COLOURS[key], 16));
      const legend = document.querySelector(`[data-legend="${key}"] b`);
      legend.textContent = SYMBOLS[style.shape].split(' ')[0];
    }
  }
}
function applyAppearance(values) {
  view.appearance = normalizeAppearance(values);
  try { localStorage.setItem('craft-watch-appearance', JSON.stringify(view.appearance)); } catch { /* Preferences are optional. */ }
  syncAppearance();
  if (view.data) { render(); renderDashboard(); }
  writeUrl();
}
function restoreAppearance() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('craft-watch-appearance')) ?? {}; } catch { /* Preferences are optional. */ }
  if (params.has('appearance')) {
    try { saved = JSON.parse(params.get('appearance')); } catch { saved = {}; }
  }
  view.appearance = normalizeAppearance(saved);
  syncAppearance();
}
function buildAppearanceControls() {
  const names = { commits: 'Commits', releases: 'Releases', prs: 'PR open', opened: 'PR created', issues: 'Issue open', merged: 'PR merged', closed: 'PR closed without merging', arcs: 'Arcs' };
  for (const key of LAYERS) {
    const row = html('div', { class: 'appearance-row' });
    const title = html('label', { class: 'appearance-name' }, names[key]);
    const toggle = html('input', { type: 'checkbox', value: key, 'data-layer-toggle': key, 'aria-label': `Show ${names[key]}` });
    toggle.checked = view.layers.has(key);
    if (key !== 'arcs') {
      const preview = el('svg', { id: `preview-${key}`, viewBox: '-12 -12 24 24', width: 24, height: 24, 'aria-hidden': 'true' });
      title.prepend(preview);
    }
    title.prepend(toggle);
    row.append(title);
    if (key === 'prs' || key === 'opened') row.append(html('small', { class: 'release-label-hint' }, key === 'prs' ? 'Current state: PRs still open at the displayed time.' : 'Creation events within this range. Points remain after the PR merges or closes.'));
    for (const field of (key === 'arcs' ? ['mode', 'position', 'size', 'connectorShape', 'lineSize', 'bend'] : key === 'releases' ? ['shape', 'position', 'size', 'labelHeight', 'glow'] : ['shape', 'position', 'size', 'glow'])) {
      if (key === 'arcs' && field === 'shape') continue;
      const numeric = ['size', 'labelHeight', 'lineSize', 'bend'].includes(field);
      const caption = field === 'glow' ? 'Glow on line' : field === 'connectorShape' ? 'Connector shape' : field === 'bend' ? 'Bend strength' : field === 'mode' ? 'Style' : field === 'lineSize' ? 'Line thickness' : field === 'labelHeight' ? 'Label height ×' : field === 'size' ? (key === 'arcs' ? 'Thickness' : 'Size') : field === 'shape' ? 'Symbol' : 'Position';
      const label = html('label', { for: `${field}-${key}` }, caption);
      const input = numeric
        ? html('input', { id: `${field}-${key}`, type: 'number', min: field === 'bend' ? 0 : field === 'labelHeight' || key === 'arcs' ? 0.5 : 2, max: field === 'bend' ? 3 : field === 'labelHeight' ? 5 : key === 'arcs' ? 8 : 48, step: 'any', 'aria-label': `${names[key]} ${caption.toLowerCase()}` })
        : html('select', { id: `${field}-${key}`, 'aria-label': `${names[key]} ${caption.toLowerCase()}` });
      if (!numeric) {
        const options = field === 'glow' ? GLOW_LEVELS : field === 'connectorShape' ? { straight: 'Straight', follow: 'Follow lane / S-curve' } : field === 'mode' ? { lifetime: 'PR lifetime arcs', connect: 'Creation → merge line' } : field === 'shape' ? SYMBOLS : { above: 'Above line', on: 'On line', below: 'Below line' };
        for (const [value, text] of Object.entries(options)) input.append(html('option', { value }, text));
      }
      input.addEventListener(numeric ? 'input' : 'change', () => {
        if (numeric && (!input.value || !input.checkValidity())) return;
        applyAppearance({ ...view.appearance, [key]: { ...view.appearance[key], [field]: numeric ? Number(input.value) : input.value } });
      });
      if (numeric) input.addEventListener('change', () => {
        if (!input.value || !input.checkValidity()) { input.value = view.appearance[key][field]; }
      });
      label.append(input);
      row.append(label);
    }
    if (key === 'arcs') row.append(html('small', { id: 'arc-mode-note', class: 'release-label-hint' }));
    if (key === 'releases') {
      const label = html('label', { class: 'release-label-toggle' }, 'Show version names');
      const checkbox = html('input', { type: 'checkbox', id: 'release-labels' });
      checkbox.checked = view.releaseLabels === 'all';
      label.prepend(checkbox);
      row.append(label, html('small', { class: 'release-label-hint' }, 'Names appear above every visible release. 1× is the original height; 2× doubles the distance from the symbol centre.'));
    }
    $('#appearance-controls').append(row);
  }
}

function restoreRange() {
  let saved;
  try { saved = localStorage.getItem('craft-watch-range'); } catch { /* Preferences are optional. */ }
  view.latestRange = normalizeRange(params.get('range') ?? saved);
  $('#latest-range').value = view.latestRange;
}

function setMode(mode) {
  dragZoom.cancel();
  view.zoom = null;
  view.mode = mode;
  view.replay = mode !== 'live';
  view.playing = view.replay && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  view.lastFrame = performance.now();
  if (view.data) {
    view.scaleFrom = view.replay ? Math.max(view.start, view.end - MODES[mode].window) : rangeStart(view.start, view.end, view.latestRange);
    view.sim = view.replay ? view.scaleFrom : view.end;
    render();
    prepareDashboard();
  }
  markModeButtons();
  writeUrl();
}

function updateSelectionUI() {
  const apps = visibleApps();
  $('#app-summary').replaceChildren(document.createTextNode(`${apps.length} ${apps.length === 1 ? 'app' : 'apps'} selected`), html('span', { 'aria-hidden': 'true' }, '⌄'));
  $('#selection-label').textContent = apps.map((a) => a.name).join(', ');
  for (const input of document.querySelectorAll('#app-options input')) input.checked = view.selected.has(input.value);
  $('#app-links').replaceChildren(...apps.map((app) => {
    const link = html('a', { href: `app.html?app=${encodeURIComponent(app.name)}` });
    const swatch = html('span', { class: 'app-swatch', 'aria-hidden': 'true' });
    swatch.style.setProperty('--app-colour', app.colour);
    link.append(swatch, app.name, ' ↗');
    return link;
  }));
}

function setSelection(names) {
  view.selected = new Set(names.filter((name) => view.data.apps.some((a) => a.name === name)));
  try { localStorage.setItem('craft-watch-apps', JSON.stringify([...view.selected])); } catch { /* Storage may be disabled. */ }
  render();
  prepareDashboard();
  updateSelectionUI();
  writeUrl();
}

function buildPicker() {
  const options = view.data.apps.map((app) => {
    const label = html('label', { class: 'app-option' });
    const input = html('input', { type: 'checkbox', value: app.name });
    const swatch = html('span', { class: 'app-swatch', 'aria-hidden': 'true' });
    swatch.style.setProperty('--app-colour', app.colour);
    label.append(input, swatch, app.name);
    input.addEventListener('change', () => {
      const next = new Set(view.selected);
      if (input.checked) next.add(app.name); else next.delete(app.name);
      setSelection([...next]);
    });
    return label;
  });
  $('#app-options').replaceChildren(...options);
  updateSelectionUI();
}

function frame(now) {
  const elapsed = Math.min(250, Math.max(0, now - view.lastFrame));
  view.lastFrame = now;
  if (view.replay && view.playing && !document.hidden) {
    view.sim = Math.min(view.end, view.sim + elapsed * MODES[view.mode].rate);
    if (view.sim >= view.end) view.playing = false;
    showUntil(view.sim);
    setHead(view.sim);
    if (now - view.lastUI >= 100 || !view.playing) {
      renderDashboard();
      view.lastUI = now;
    }
  }
  requestAnimationFrame(frame);
}

function build(data) {
  view.data = data;
  view.end = Date.parse(data.generated_at);
  view.start = view.end - data.window_days * DAY;
  let names = MAIN_APPS;
  try {
    const saved = JSON.parse(localStorage.getItem('craft-watch-apps'));
    if (Array.isArray(saved)) names = saved;
  } catch { /* Ignore malformed or unavailable preferences. */ }
  const query = params.get('apps');
  if (query !== null) names = query === 'all' ? data.apps.map((a) => a.name) : query === 'none' ? [] : query.split(',');
  const valid = names.filter((name) => data.apps.some((a) => a.name === name));
  view.selected = new Set(valid.length || !names.length ? valid : MAIN_APPS.filter((name) => data.apps.some((a) => a.name === name)));
  try { view.order = normalizeOrder(JSON.parse(localStorage.getItem('craft-watch-order'))); } catch { /* Ignore malformed or unavailable preferences. */ }
  if (params.get('order') !== null) view.order = normalizeOrder(params.get('order').split(',').filter(Boolean));
  $('#reset-order').hidden = !view.order;
  buildPicker();
  restoreLayers();
  restoreEventFilters();
  restoreLimits();
  restoreRange();
  restoreAppearance();
  setMode(view.mode);
  const savedZoom = validateZoom(params.get('zoom_from'), params.get('zoom_to'), view.start, view.end);
  if (savedZoom) applyZoom(savedZoom, false);
  renderStatus();
}

function showFailure(message) {
  $('#status').classList.add('warn');
  $('#status').textContent = message;
}

let resumeAfterDrag = false;
let previewFrame = 0;
function previewAppCounts(range) {
  view.previewRange = range;
  if (!range) {
    cancelAnimationFrame(previewFrame);
    previewFrame = 0;
    renderAppBreakdown();
  } else if (!previewFrame) {
    previewFrame = requestAnimationFrame(() => {
      previewFrame = 0;
      renderAppBreakdown();
    });
  }
}
function applyZoom(range, animate = true) {
  view.zoom = range;
  view.scaleFrom = range.from;
  view.sim = range.to;
  view.replay = false;
  view.mode = 'live';
  view.playing = false;
  render();
  prepareDashboard();
  markModeButtons();
  writeUrl();
  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    svg.animate([{opacity:0.25, transform:'scaleX(0.98)'},{opacity:1, transform:'scaleX(1)'}], {duration:280,easing:'ease-out'});
  }
}
const dragZoom = installDragZoom(svg, {
  getRange: () => view.data && view.selected.size ? {from:view.scaleFrom,to:mapEnd(),left:TIME_START_X,right:END_X,top:mapLayout.axisTop,bottom:mapLayout.axisBottom} : null,
  onStart: () => { resumeAfterDrag = view.playing; view.playing = false; },
  onCancel: () => { view.playing = resumeAfterDrag; view.lastFrame = performance.now(); },
  onPreview: (text, range) => {
    $('#zoom-selection').hidden = !text;
    $('#zoom-state').hidden = Boolean(text);
    $('#zoom-selection').textContent = text ?? '';
    previewAppCounts(range);
  },
  onSelect: range => applyZoom(range),
});
$('#reset-zoom').addEventListener('click', () => setMode('live'));
$('#reset-order').addEventListener('click', () => view.data && setLaneOrder(null));

buildAppearanceControls();
buildLimitControls();
$('#appearance-defaults').addEventListener('click', () => applyAppearance(DEFAULT_APPEARANCE));

for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(button.dataset.mode));
$('#latest-range').addEventListener('change', (event) => {
  view.latestRange = normalizeRange(event.target.value);
  try { localStorage.setItem('craft-watch-range', view.latestRange); } catch { /* Preferences are optional. */ }
  setMode('live');
});
$('#select-main').addEventListener('click', () => view.data && setSelection(MAIN_APPS));
$('#select-all').addEventListener('click', () => view.data && setSelection(view.data.apps.map((a) => a.name)));
$('#select-none').addEventListener('click', () => view.data && setSelection([]));
$('#app-search').addEventListener('input', (event) => {
  let shown = 0;
  for (const option of document.querySelectorAll('.app-option')) {
    option.hidden = !option.textContent.toLowerCase().includes(event.target.value.trim().toLowerCase());
    if (!option.hidden) shown++;
  }
  $('#search-empty').hidden = shown > 0;
});
for (const picker of [$('#app-picker'), $('#layer-picker'), $('#limits-picker')]) {
  document.addEventListener('click', (event) => { if (!picker.contains(event.target)) picker.open = false; });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && picker.open) {
      picker.open = false;
      picker.querySelector('summary').focus();
    }
  });
}
for (const input of document.querySelectorAll('#layer-picker input[data-layer-toggle]')) {
  input.addEventListener('change', () => {
    const next = new Set(view.layers);
    if (input.checked) next.add(input.value); else next.delete(input.value);
    setLayers([...next]);
  });
}
$('#layers-all').addEventListener('click', () => setLayers(LAYERS));
$('#layers-none').addEventListener('click', () => setLayers([]));
$('#release-labels').addEventListener('change', (event) => {
  view.releaseLabels = event.target.checked ? 'all' : 'none';
  try { localStorage.setItem('craft-watch-limits', JSON.stringify({ ...view.limits, labels: view.releaseLabels })); } catch { /* Preferences are optional. */ }
  if (view.data) { render(); renderDashboard(); }
  writeUrl();
});
$('#limits-close').addEventListener('click', () => { $('#limits-picker').open = false; $('#limits-summary').focus(); });
$('#limits-defaults').addEventListener('click', () => applyLimits(DEFAULT_LIMITS, view.releaseLabels, normalizeEventFilters()));
$('#limits-unlimited').addEventListener('click', () => applyLimits(Object.fromEntries(LAYERS.map(key => [key, null])), view.releaseLabels, Object.fromEntries(LAYERS.map(key => [key, { ...view.filters[key], mode: 'count' }]))));
$('#play-pause').addEventListener('click', () => {
  if (view.sim >= view.end) view.sim = view.scaleFrom;
  view.playing = !view.playing;
  view.lastFrame = performance.now();
  showUntil(view.sim);
  setHead(view.sim);
  renderDashboard();
});
$('#restart').addEventListener('click', () => setMode(view.mode));
$('#scrub').addEventListener('input', (event) => {
  view.playing = false;
  view.sim = view.scaleFrom + Number(event.target.value) / 1000 * (view.end - view.scaleFrom);
  showUntil(view.sim);
  setHead(view.sim);
  renderDashboard();
});
// Open the explainer when following a legend link, including a direct #guide URL.
function openGuide() { if (location.hash === '#guide') $('#guide').open = true; }
window.addEventListener('hashchange', openGuide);
openGuide();

async function load() {
  const response = await fetch('data/apps.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.apps) || !Number.isFinite(Date.parse(data.generated_at))) throw new Error('invalid activity data');
  if (!view.data) build(data);
  else if (data.generated_at !== view.data.generated_at) {
    // Keep a replay anchored to its snapshot until the user returns to Latest.
    if (view.replay || view.zoom) {
      renderStatus();
      return;
    }
    const selection = [...view.selected];
    view.data = data;
    view.end = Date.parse(data.generated_at);
    view.start = view.end - data.window_days * DAY;
    view.sim = view.end;
    view.scaleFrom = rangeStart(view.start, view.end, view.latestRange);
    buildPicker();
    setSelection(selection);
  }
  renderStatus();
}
load().catch((error) => showFailure(`Could not load data (${error.message}). Run npm run data:preview, then refresh.`));
setInterval(() => { if (view.data) renderStatus(); }, 30000);
setInterval(() => load().catch(() => showFailure('Refresh failed; showing the last loaded data.')), 300000);
requestAnimationFrame(frame);
