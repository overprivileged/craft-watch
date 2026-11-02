import { loadApps } from './data.js';
import { updateVerdict } from './verdicts.js';
// Space view: one ArtCraft core, one lane per app, events placed by time.
// Live shows the last 30 days on a stretched time scale. Replays zoom the lanes to their own window.
// Everything from GitHub is written with textContent or attributes, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MONO = 'JetBrains Mono, ui-monospace, monospace';
const MAIN_APPS = ['ArtCraft', 'PhotoCraft', 'FilmCraft', 'PdfCraft', 'EffectCraft', 'FigCraft', 'LightCraft', 'VectorCraft'];
const CORE = { x: 230, y: 540 };
const END_X = 1640;
const NAME_X = END_X + 18;
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const MODES = {
  hour: { window: HOUR, rate: HOUR / 10e3, label: 'last hour, replayed in 10 s' },
  day: { window: DAY, rate: DAY / 30e3, label: 'last 24 h, replayed in 30 s' },
  month: { window: 30 * DAY, rate: (30 * DAY) / 30e3, label: '30 days, replayed in 30 s' },
};
const STALE_MS = 6 * HOUR; // GitHub can delay scheduled runs by a few hours
const SAMPLES = 400;
const ARC_CAP = 10; // most recent PRs per app
const ARC_MIN_WIDTH = 15; // narrower arcs are not drawn; merges still get their dot
const LABEL_GAP = 70; // minimum px between version labels, and from the app name
const LABEL_LANE_GAP = 25; // closer lanes than this get no version labels at all

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
  scaleFrom: 0,
  showAll: params.get('apps') === 'all',
  events: [],
  shown: 0,
  lastFrame: performance.now(),
  headLine: null,
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// A stable number in [0, 1) from a string (FNV-1a), so each point twinkles the same way on every load.
function hash01(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

// One point in eight (picked by hash, so always the same ones) flares and keeps its pulse ring;
// the rest only twinkle softly. Animating size on every point made the map drop to ~15 fps.
const FLARE_SHARE = 0.125;
const flares = (key) => hash01(`${key}!`) < FLARE_SHARE;
const TWINKLE_SHARE = 0.35;

// Twinkle timing for one point: its own speed and its own place in the cycle.
function twinkle(key) {
  const a = hash01(key);
  const b = hash01(`${key}#`);
  const duration = 2.4 + a * 3.6; // 2.4–6 s
  // Only some points twinkle (picked by hash); the rest glow steadily. Each animated SVG point
  // costs a repaint every frame, so fewer moving points keeps the map smooth on slow computers.
  const moving = flares(key) || hash01(`${key}~`) < TWINKLE_SHARE;
  return {
    class: flares(key) ? 'twinkle' : moving ? 'twinkle-soft' : 'still',
    style: `--tw: ${duration.toFixed(2)}s; animation-delay: ${(-b * duration).toFixed(2)}s`,
  };
}

// Edges brighten in a wave that runs left to right: the delay grows with x.
const WAVE_S = 4;
function waveDelay(x) {
  return `animation-delay: ${((x / END_X) * WAVE_S - WAVE_S).toFixed(2)}s`;
}

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

function lastActivity(pr) {
  return Math.max(...[pr.created_at, pr.merged_at, pr.closed_at].map((iso) => (iso ? Date.parse(iso) : 0)));
}

// Live time scale: the last 24 h take the rightmost 30% of the lanes, the last 7 days take 60%,
// and the rest of the 30 days share the left 40%. Replays use a straight scale over their window.
function xOf(t) {
  const left = CORE.x;
  const width = END_X - CORE.x;
  const clamped = clamp(t, view.scaleFrom, view.end);
  if (view.replay) return left + ((clamped - view.scaleFrom) / (view.end - view.scaleFrom)) * width;
  const t1 = view.end - DAY;
  const t7 = view.end - 7 * DAY;
  if (clamped >= t1) return left + 0.7 * width + ((clamped - t1) / (view.end - t1)) * 0.3 * width;
  if (clamped >= t7) return left + 0.4 * width + ((clamped - t7) / (t1 - t7)) * 0.3 * width;
  return left + ((clamped - view.scaleFrom) / (t7 - view.scaleFrom)) * 0.4 * width;
}

function laneY(index, count) {
  const [top, bottom] = count <= MAIN_APPS.length ? [230, 760] : [170, 780];
  return top + (index * (bottom - top)) / Math.max(count - 1, 1);
}

// Samples a lane curve so each event can sit exactly on it.
function sampleLane(path) {
  const total = path.getTotalLength();
  const points = [];
  for (let k = 0; k <= SAMPLES; k++) points.push(path.getPointAtLength((total * k) / SAMPLES));
  return points;
}

function yOnLane(samples, x) {
  if (x <= samples[0].x) return samples[0].y;
  if (x >= samples[samples.length - 1].x) return samples[samples.length - 1].y;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].x < x) lo = mid;
    else hi = mid;
  }
  return samples[lo].y;
}

// Puts a timestamp on the lane. Times before the replay window are clamped to its start.
function place(samples, iso) {
  if (!iso) return null;
  const t = clamp(Date.parse(iso), view.scaleFrom, view.end);
  const x = xOf(t);
  return { t, x, y: yOnLane(samples, x) };
}

// During a replay, events from before its window are not drawn at all.
function inScale(iso) {
  return !view.replay || Date.parse(iso) >= view.scaleFrom;
}

function addEvent(t, node, group) {
  node.classList.add('evt');
  node.style.display = 'none';
  group.append(node);
  view.events.push({ t, el: node });
}

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

function commitNode(p, colour, key) {
  const holder = translate(p);
  holder.append(
    el('circle', { r: 1.6, fill: colour, 'fill-opacity': 0.35, ...twinkle(key) }),
  );
  // Pulse rings only on the flaring points: a ring on every commit was the site's main drag on frame rate.
  if (flares(key)) {
    holder.append(el('circle', {
      class: 'commit-pulse',
      r: 2.2,
      fill: 'none',
      stroke: colour,
      'stroke-width': 0.6,
      style: `animation-delay: ${(-(p.t % 3000) / 1000).toFixed(2)}s`,
    }));
  }
  return holder;
}

// Where a version label would sit, as a box in page coordinates.
function labelBox(p, above, text) {
  const width = text.length * 7.4 + 4;
  const baseline = above ? p.y - 10 : p.y + 22;
  return { x0: p.x - width / 2, x1: p.x + width / 2, y0: baseline - 11, y1: baseline + 3 };
}

const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

function createLane(app, index, count, defs, group) {
  const colour = app.colour;
  const y = laneY(index, count);
  const d = `M${CORE.x},${CORE.y} C620,${CORE.y} 1050,${y} ${END_X},${y}`;
  const lane = el('g', { 'data-repo': app.repo, opacity: app.ok ? 1 : 0.4 });
  const line = el('path', { d, stroke: `url(#lane-${index})`, 'stroke-width': 1.4, fill: 'none' });
  defs.append(gradient(`lane-${index}`, colour, [[0, 0.1], [0.3, 1], [1, 0.9]]));
  lane.append(el('path', { d, stroke: colour, 'stroke-width': 12, 'stroke-opacity': 0.12, fill: 'none', filter: 'url(#bloom)' }), line);
  // A pulse of light that travels the lane from the core outwards; lanes start one after another.
  lane.append(el('path', {
    d,
    class: 'lane-wave',
    stroke: colour,
    'stroke-width': 2.4,
    'stroke-linecap': 'round',
    fill: 'none',
    pathLength: 1000,
    'stroke-dasharray': '70 930',
    style: `animation-delay: ${(-(index / Math.max(count, 1)) * 6).toFixed(2)}s`,
  }));
  group.append(lane);
  return { app, index, count, y, colour, compact: count > MAIN_APPS.length, samples: sampleLane(line), lane, defs };
}

// The map draws at most this many commit points per lane, spread evenly over time. Since the data
// keeps up to ~1,000 commits per app, drawing every one meant ~9,000 animated points and a frozen
// page; the design was made for ~100 per lane. Totals and counts still use every commit.
const DOT_CAP = 100;
const DOT_CAP_COMPACT = 60;

function evenSample(list, cap) {
  if (list.length <= cap) return list;
  const step = list.length / cap;
  return Array.from({ length: cap }, (_, k) => list[Math.floor(k * step)]);
}

function drawCommits(l) {
  const times = (l.app.commit_times ?? []).filter(inScale);
  for (const iso of evenSample(times, l.compact ? DOT_CAP_COMPACT : DOT_CAP)) {
    const p = place(l.samples, iso);
    if (p) addEvent(p.t, commitNode(p, l.colour, `${l.app.repo}|${iso}`), l.lane);
  }
}

function drawArcs(l) {
  const prs = [...(l.app.pulls_recent ?? [])].sort((a, b) => lastActivity(b) - lastActivity(a)).slice(0, ARC_CAP);
  prs.forEach((pr, k) => {
    const from = place(l.samples, pr.created_at);
    if (!from) return;
    const endIso = pr.merged_at ?? pr.closed_at;
    const to = endIso ? place(l.samples, endIso) : { t: view.end, x: END_X, y: yOnLane(l.samples, END_X) };
    if (!to) return;
    const drawArc = inScale(pr.created_at) && to.x - from.x >= ARC_MIN_WIDTH;
    const lift = arcLift(to.t - from.t) * (k % 2 ? 1 : 0.8); // alternate a little so neighbouring arcs separate
    const title = `PR #${pr.number} · ${pr.title}`;

    if (pr.merged_at) {
      if (drawArc) {
        const arc = el('path', {
          d: arcPath(from, to, lift),
          fill: 'none',
          stroke: l.colour,
          'stroke-width': 1.2,
          'stroke-opacity': 0.85,
          'stroke-dasharray': '1.5 4',
          'stroke-linecap': 'round',
          class: 'arc-wave',
          style: waveDelay(from.x),
        });
        arc.append(el('title', {}, `Merged · ${title}`));
        addEvent(from.t, arc, l.lane);
      }
      const landing = translate(to);
      landing.append(el('circle', { r: 7, fill: 'none', stroke: '#FFFFFF', 'stroke-opacity': 0.35 }));
      landing.append(el('circle', { r: 3.2, fill: '#FFFFFF', ...twinkle(`${l.app.repo}|pr${pr.number}`) }));
      landing.querySelector('circle:last-child').append(el('title', {}, `Merged · ${title}`));
      addEvent(to.t, landing, l.lane);
    } else if (pr.closed_at) {
      // Closed without merging: the arc fades out and never rejoins the lane.
      if (!drawArc) return;
      const id = `fade-${l.index}-${k}`;
      l.defs.append(gradient(id, l.colour, [[0, 0.9], [1, 0]], true));
      const arc = el('path', { d: arcPath(from, to, -lift), fill: 'none', stroke: `url(#${id})`, 'stroke-width': 1.2, class: 'arc-wave', style: waveDelay(from.x) });
      arc.append(el('title', {}, `Closed without merging · ${title}`));
      addEvent(from.t, arc, l.lane);
    } else {
      // Still open: the arc runs to the lane end and does not land.
      if (!drawArc) return;
      const arc = el('path', {
        d: arcPath(from, to, lift),
        fill: 'none',
        stroke: l.colour,
        'stroke-width': 1,
        'stroke-opacity': 0.45,
        'stroke-dasharray': '1.5 4',
        'stroke-linecap': 'round',
        class: 'arc-wave',
        style: waveDelay(from.x),
      });
      arc.append(el('title', {}, `Open · ${title}`));
      addEvent(from.t, arc, l.lane);
    }
  });
}

function drawAdvisories(l) {
  for (const advisory of l.app.advisories?.items ?? []) {
    if (!inScale(advisory.published_at)) continue;
    const from = place(l.samples, advisory.published_at);
    if (!from) continue;
    const fix = fixedRelease(advisory, l.app.releases_recent ?? []);
    const to = fix ? place(l.samples, fix.published_at) : { x: END_X, y: yOnLane(l.samples, END_X), t: view.end };
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
    addEvent(from.t, group, l.lane);

    if (fix) {
      const fixed = translate(to);
      fixed.append(
        el('circle', { r: 10, fill: 'none', stroke: '#22C55E', 'stroke-width': 3 }),
        el('text', { x: 0, y: -18, 'text-anchor': 'middle', fill: '#86EFAC', 'font-size': 13, 'font-weight': 800 }, `${version(fix.tag)} · fixed`),
      );
      addEvent(to.t, fixed, l.lane);
    }
  }
}

// Distance between this lane and the nearest other visible lane at x.
function gapToNeighbour(lanes, l, x) {
  const y = yOnLane(l.samples, x);
  let gap = Infinity;
  for (const other of lanes) {
    if (other !== l) gap = Math.min(gap, Math.abs(yOnLane(other.samples, x) - y));
  }
  return gap;
}

// Version labels for every lane together. Newest first. A label is skipped when it is:
// closer than LABEL_LANE_GAP to a neighbouring lane, within LABEL_GAP px of any other label or of any app name,
// or overlapping a label already placed. Accepted labels alternate above and below the lane.
function placeReleases(lanes) {
  const candidates = [];
  for (const l of lanes) {
    for (const release of l.app.releases_recent ?? []) {
      if (!inScale(release.published_at)) continue;
      if (Date.parse(release.published_at) < view.start) continue; // the list keeps older releases for the version picker
      const p = place(l.samples, release.published_at);
      if (p) candidates.push({ l, release, p, label: null });
    }
  }
  candidates.sort((a, b) => b.p.t - a.p.t);

  const accepted = [];
  const boxes = [];
  for (const c of candidates) {
    if (c.p.x > NAME_X - LABEL_GAP) continue; // too close to an app name
    if (gapToNeighbour(lanes, c.l, c.p.x) < LABEL_LANE_GAP) continue; // lanes too close: dots only
    if (accepted.some((x) => Math.abs(x - c.p.x) < LABEL_GAP)) continue;
    const text = version(c.release.tag);
    const preferAbove = accepted.length % 2 === 0;
    const placed = [preferAbove, !preferAbove]
      .map((above) => ({ above, box: labelBox(c.p, above, text) }))
      .find(({ box }) => !boxes.some((other) => overlaps(other, box)));
    if (!placed) continue;
    boxes.push(placed.box);
    accepted.push(c.p.x);
    c.label = { above: placed.above, text };
  }

  for (const c of candidates) {
    const holder = translate(c.p);
    holder.append(el('circle', { r: 3.6, fill: '#FFFFFF', stroke: c.l.colour, 'stroke-width': 1.2, ...twinkle(`${c.l.app.repo}|${c.release.tag}`) }));
    holder.querySelector('circle').append(el('title', {}, `Release ${c.release.tag} · ${c.l.app.name}`));
    if (c.label) {
      holder.append(el('text', {
        x: 0,
        y: c.label.above ? -10 : 22,
        'text-anchor': 'middle',
        fill: '#E8ECF2',
        'font-size': 12,
        'font-weight': 700,
        'font-family': MONO,
      }, c.label.text));
    }
    addEvent(c.p.t, holder, c.l.lane);
  }
}

// End of lane: the name with the latest version beside it, then the amber open-report count.
// Update light colours, the same rules as the App page's "Should I update today?" card.
const LIGHT = { red: '#EF4444', yellow: '#FACC15', green: '#22C55E', grey: '#6B7585' };

// End of lane: an update light, the name with the latest version, then the open-report count.
// The light opens the app page and shows the one-line reason on hover. The name opens the journey.
function drawNameLabels(l) {
  const { app, y, colour, compact } = l;
  const verdict = updateVerdict(app, view.end);
  const latest = app.releases?.latest ? version(app.releases.latest.tag) : 'no release yet';
  const reports = app.issues?.open_now ?? 0;
  const textX = NAME_X + 20;
  const nameLine = el('text', { x: textX, y: y + (compact ? 5 : 6), fill: colour, 'font-size': compact ? 16 : 18, 'font-weight': 800 });
  nameLine.append(document.createTextNode(app.name), el('tspan', { dx: 8, fill: '#9AA4B2', 'font-size': 12, 'font-weight': 500, 'font-family': MONO }, latest));
  const reportsLabel = el('text', { x: textX, y: y + (compact ? 19 : 26), fill: '#FACC15', 'font-size': compact ? 11 : 13, 'font-weight': 700 }, `${reports} open reports`);
  reportsLabel.append(el('title', {}, 'Open issues on GitHub'));

  const appHref = `app.html?app=${encodeURIComponent(app.name)}`;
  const dot = el('circle', { cx: NAME_X + 7, cy: y + (compact ? -4 : -5), r: 5, fill: LIGHT[verdict.colour], stroke: '#0B0D12', 'stroke-width': 1.5 });
  dot.append(el('title', {}, `${verdict.title}: ${verdict.text}`));
  const light = el('a', { href: appHref });
  light.append(dot);

  // The name opens the app page too, where the update light lives.
  const journey = el('a', { href: `app.html?app=${encodeURIComponent(app.name)}` });
  journey.append(nameLine);
  const reportsLink = el('a', { href: appHref });
  reportsLink.append(reportsLabel);

  l.lane.append(
    el('circle', { cx: END_X, cy: y, r: 5, fill: colour, filter: 'url(#bloom)' }),
    el('circle', { cx: END_X, cy: y, r: 2.6, fill: '#FFFFFF' }),
    light,
    journey,
    reportsLink,
  );
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
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// Faint date ticks so the uneven time scale stays honest.
function drawTicks() {
  const group = el('g', {});
  const ticks = view.replay
    ? [
      [view.scaleFrom, (view.mode === 'month' ? dateFmt : timeFmt).format(view.scaleFrom), 'start'],
      [view.end, 'now', 'end'],
    ]
    : [
      [view.start, '30 d ago', 'start'],
      [view.end - 7 * DAY, '7 d', 'middle'],
      [view.end - DAY, '1 d', 'middle'],
      [view.end, 'now', 'end'],
    ];
  for (const [t, label, anchor] of ticks) {
    const x = xOf(t);
    group.append(
      el('line', { x1: x, y1: 160, x2: x, y2: 790, stroke: '#FFFFFF', 'stroke-opacity': 0.08, 'stroke-dasharray': '2 6' }),
      el('text', { x, y: 148, 'text-anchor': anchor, fill: '#9AA4B2', 'font-size': 13, 'font-family': MONO }, label),
    );
  }
  return group;
}

function drawHeadline(count) {
  const group = el('g', {});
  group.append(
    el('text', { x: 960, y: 868, 'text-anchor': 'middle', fill: '#E8ECF2', 'font-size': 60, 'font-weight': 800, 'letter-spacing': -1.5 }, 'Every pulse is a real change.'),
    el('text', { x: 960, y: 918, 'text-anchor': 'middle', fill: '#C9D1DC', 'font-size': 24, 'font-weight': 600 }, `${count} apps. One source. Watched live.`),
  );
  return group;
}

function visibleApps() {
  return view.data.apps.filter((app) => view.showAll || MAIN_APPS.includes(app.name));
}

function render() {
  const defs = el('defs', {});
  defs.append(el('filter', { id: 'bloom', x: '-50%', y: '-50%', width: '200%', height: '200%' }));
  defs.querySelector('filter').append(el('feGaussianBlur', { stdDeviation: 5 }));

  const group = el('g', {});
  const apps = visibleApps();
  view.events = [];
  view.shown = 0;
  const lanes = apps.map((app, index) => createLane(app, index, apps.length, defs, group));
  for (const l of lanes) {
    drawCommits(l);
    drawArcs(l);
    drawAdvisories(l);
    drawNameLabels(l);
  }
  placeReleases(lanes);
  view.events.sort((a, b) => a.t - b.t);

  view.headLine = el('line', { y1: 150, y2: 800, stroke: '#FFFFFF', 'stroke-opacity': 0.3, 'stroke-dasharray': '4 8' });
  svg.replaceChildren(defs, drawTicks(), group, drawCore(), view.headLine, drawHeadline(apps.length));
  svg.classList.toggle('replay', view.replay);
  showUntil(view.sim);
  setHead(view.sim);
}

// Shows events up to time t and hides the rest. Works forwards and backwards.
function showUntil(t) {
  const events = view.events;
  let i = view.shown;
  while (i < events.length && events[i].t <= t) {
    events[i].el.style.display = '';
    i++;
  }
  while (i > 0 && events[i - 1].t > t) {
    i--;
    events[i].el.style.display = 'none';
  }
  view.shown = i;
}

function setHead(t) {
  if (!view.headLine) return;
  const x = xOf(t);
  view.headLine.setAttribute('x1', x.toFixed(1));
  view.headLine.setAttribute('x2', x.toFixed(1));
  view.headLine.style.display = view.replay ? '' : 'none';
}

function renderClock() {
  const big = $('#bigclock');
  big.hidden = !view.replay;
  if (view.replay) {
    big.textContent = bigFmt.format(view.sim);
    $('#clock').textContent = `Replay · ${MODES[view.mode].label}`;
  } else {
    $('#clock').textContent = `Live · data up to ${fmt.format(view.end)}`;
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

function renderTotals() {
  const apps = view.data.apps;
  const sum = (read) => apps.reduce((total, app) => total + (read(app) ?? 0), 0);
  const items = [
    ['commits (code saves, 30 days)', sum((a) => a.commits?.total)],
    ['proposed changes (30 days)', sum((a) => a.pulls?.opened)],
    ['accepted changes (30 days)', sum((a) => a.pulls?.merged)],
    ['new versions (30 days)', sum((a) => a.releases?.in_window)],
    ['published advisories (30 days)', sum((a) => a.advisories?.in_window)],
    ['open reports (open issues)', sum((a) => a.issues?.open_now)],
  ];
  const nodes = items.map(([label, value]) => {
    const item = document.createElement('span');
    const number = document.createElement('strong');
    number.textContent = String(value);
    item.append(number, ` ${label}`);
    return item;
  });
  $('#totals').replaceChildren(...nodes);
}

function renderMoreButton() {
  const others = view.data.apps.length - MAIN_APPS.length;
  const button = $('#more');
  button.hidden = others <= 0;
  button.textContent = view.showAll ? `Show ${MAIN_APPS.length} main apps` : `+${others} more apps`;
  button.setAttribute('aria-expanded', String(view.showAll));
}

function markModeButtons() {
  for (const button of document.querySelectorAll('[data-mode]')) {
    const on = button.dataset.mode === view.mode;
    button.setAttribute('aria-pressed', String(on));
  }
}

// Keeps the view in the URL, so a view can be linked: ?mode=day&apps=all
function writeUrl() {
  const query = new URLSearchParams();
  if (view.replay) query.set('mode', view.mode);
  if (view.showAll) query.set('apps', 'all');
  const text = query.toString();
  history.replaceState(null, '', text ? `?${text}` : location.pathname);
}

// Live goes back to the normal view at once. A replay starts at the beginning of its window.
function setMode(mode) {
  view.mode = mode;
  view.replay = mode !== 'live';
  if (view.data) {
    view.scaleFrom = view.replay ? view.end - MODES[mode].window : view.start;
    view.sim = view.replay ? view.scaleFrom : view.end;
    render();
  }
  markModeButtons();
  writeUrl();
  if (view.data) {
    renderClock();
    startLoop();
  }
}

// Toggling apps keeps the current mode and clock.
function setShowAll(on) {
  view.showAll = on;
  render();
  renderMoreButton();
  writeUrl();
}

function frame(now) {
  const elapsed = now - view.lastFrame;
  view.lastFrame = now;
  if (view.replay) {
    view.sim += elapsed * MODES[view.mode].rate;
    if (view.sim >= view.end) view.sim = view.scaleFrom; // loop: showUntil hides everything again
  } else {
    view.sim = view.end;
  }
  showUntil(view.sim);
  setHead(view.sim);
  renderClock();
  if (view.replay) requestAnimationFrame(frame);
  else view.looping = false;
}

function startLoop() {
  if (view.looping || !view.replay) return;
  view.looping = true;
  view.lastFrame = performance.now();
  requestAnimationFrame(frame);
}

// The page is a fixed 1920x1080 canvas; scale it to fit whatever window it is in.
function fitStage() {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--scale', String(scale));
}

function build(data) {
  view.data = data;
  view.end = Date.parse(data.generated_at);
  view.start = view.end - data.window_days * DAY;
  setMode(view.mode);
  renderTotals();
  renderMoreButton();
  renderStatus();
  setInterval(renderStatus, 30e3);
  startLoop();
}

function showFailure(message) {
  const status = $('#status');
  status.classList.add('warn');
  status.textContent = message;
}

for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => setMode(button.dataset.mode));
}

$('#more').addEventListener('click', () => setShowAll(!view.showAll));

window.addEventListener('resize', fitStage);
fitStage();
markModeButtons();
loadApps()
  .then(build)
  .catch((error) => showFailure(`Could not load the data (${error.message}).`));
