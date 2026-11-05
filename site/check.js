// "Is it real or fake?": a guided check for people who are not technical.
// Files are fingerprinted in the browser (nothing is uploaded). Links are checked against the official list and
// public GitHub facts (api.github.com, no token, no cookies). Every piece of text, including GitHub data, is set with textContent.

const OWNER_REPO = 'overprivileged/craft-watch';
const MAX_BYTES = 2.5 * 1024 ** 3; // browsers read the whole file into memory to hash it
const SHORT_LINK_HOSTS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly', 'cutt.ly', 'rebrand.ly', 'shorturl.at', 'rb.gy', 'lnkd.in']);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const SOURCES = [
  ['Google ad', 'Ads at the top of Google often copy the real page. Use the link from the official site or from this page, not the ad.'],
  ['Another GitHub page', 'Anyone can copy a GitHub page. Only the team’s own page is real. Check the address.'],
  ['A website', 'Websites that offer the app often add extra things to the file. Use only the official page.'],
  ['Discord or a friend', 'Files passed along in chats can be changed on the way. Get it from the official page.'],
];

const CHOICES = [
  { id: 'download', icon: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19.5h14'], title: 'I want to download an app', sub: 'Which app, and which device?' },
  { id: 'file', icon: ['M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z', 'M14 3.5v5h5', 'M12 11v6', 'M9.5 14.5 12 17l2.5-2.5'], title: 'I already downloaded a file', sub: 'Drop it here. It stays on your computer.' },
  { id: 'link', icon: ['M10 14a3.5 3.5 0 0 0 4.95 0l3-3a3.5 3.5 0 0 0-4.95-4.95l-1.1 1.1', 'M14 10a3.5 3.5 0 0 0-4.95 0l-3 3a3.5 3.5 0 0 0 4.95 4.95l1.1-1.1'], title: 'Someone sent me a link', sub: 'Paste it here. We check it without opening it.' },
  { id: 'other', icon: ['M9 3v4', 'M15 3v4', 'M7 7h10v3.5a5 5 0 0 1-10 0z', 'M12 15.5V21'], title: 'I found a plugin, website version or phone app', sub: 'Made by someone else?' },
  { id: 'installed', icon: ['M12 3.5 21 19.5H3z', 'M12 10v4', 'M12 16.8v.2'], title: 'I already installed something fake', sub: 'Let’s fix it in a few steps.' },
];

const DEVICES = [
  { id: 'mac', label: 'Mac' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
  { id: 'android', label: 'Android' },
  { id: 'iphone', label: 'iPhone' },
];

const $ = (id) => document.getElementById(id);

// Small DOM builder. Strings become text nodes; `text` sets textContent. Never innerHTML.
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.includes('-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...kids.filter((kid) => kid !== null && kid !== undefined && kid !== false && kid !== ''));
  return node;
};

const safeUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : '#';
  } catch {
    return '#';
  }
};
// Who makes an app, when it is not the ArtCraft team (shown on this page only).
const makerLine = (app) => (app.maker ? el('p', { class: 'note', text: `Made by ${app.maker}` }) : '');
const safeColour = (value) => (/^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#A78BFA');
const bigLink = (href, label, extra = '') => el('a', { class: `big ${extra}`.trim(), href: safeUrl(href), target: '_blank', rel: 'noopener', text: label });
const GLYPH = { ok: '✓', bad: '✕', wait: '!' };
const card = (kind, heading, ...kids) => el('div', { class: `answer ${kind}` },
  el('div', { class: 'icon', text: GLYPH[kind], 'aria-hidden': 'true' }),
  el('div', { class: 'body' }, el('h2', { text: heading }), ...kids));
const dateFmt = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const sizeFmt = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const reveal = (node) => { if (node) node.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); };
const isPhone = () => window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;

// ---- Data -----------------------------------------------------------------
let data = null;            // files.json: { apps, site, keep_days, generated_at, without_digest }
let allFiles = [];          // { app, tag, name, size, date, sha }
let bySha = new Map();      // sha256 -> [file]
let byName = new Map();     // file name -> [file]
let appByRepo = new Map();  // "owner/repo" (lower case) -> app from repos.json
let siteHost = '';
let unofficial = [];        // data/unofficial.json items (empty until we have tested something)

async function loadData() {
  try {
    const res = await fetch('data/files.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    for (const app of raw.apps) appByRepo.set(app.repo.toLowerCase(), app);
    siteHost = new URL(raw.site).hostname.replace(/^www\./, '');
    for (const [sha, appIndex, tag, name, size, date] of raw.files) {
      const file = { app: raw.apps[appIndex], tag, name, size, date, sha };
      allFiles.push(file);
      bySha.set(sha, [...(bySha.get(sha) ?? []), file]);
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
    data = raw;
    const updated = new Date(raw.generated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    $('status').textContent = `${raw.files.length.toLocaleString('en')} official files · updated ${updated}`;
    $('coverage').textContent = `Covered: every release of the ${raw.apps.length} apps from the last ${raw.keep_days} days, plus each app’s latest release.`
      + (raw.without_digest ? ` ${raw.without_digest.toLocaleString('en')} older files have no fingerprint on GitHub and can’t be checked here.` : '');
    $('official-summary').textContent = `See all ${raw.apps.length} official download pages`;
    $('official').replaceChildren(...raw.apps.map((app) => el('li', {},
      el('strong', { text: app.name }), el('br'), app.maker ? el('span', { class: 'fine', text: `Made by ${app.maker}` }) : '', app.maker ? el('br') : '',
      el('a', { href: safeUrl(app.download), target: '_blank', rel: 'noopener', text: app.download.replace('https://', '') }))));
  } catch (error) {
    $('status').textContent = `Could not load the official file list (${error.message}). Try again in a minute.`;
  }
  try {
    const res = await fetch('data/unofficial.json', { cache: 'no-cache' });
    unofficial = res.ok ? ((await res.json()).items ?? []) : [];
  } catch {
    unofficial = [];
  }
  if (currentKey === 'download') renderDownload();
}

const artCraft = () => data?.apps.find((app) => app.repo === 'storytold/artcraft') ?? null;
const siteUrl = () => (data ? data.site : 'https://getartcraft.com');
const isOfficialHost = (host) => host === siteHost;

// The app whose short name appears in a file name or link, e.g. "pdfcraft" in "pdfcraft-0.18.1-macos.dmg".
function guessApp(text) {
  const lower = (text || '').toLowerCase();
  if (!data || !lower) return null;
  return data.apps
    .filter((app) => lower.includes(app.repo.split('/')[1].toLowerCase()))
    .sort((a, b) => b.repo.length - a.repo.length)[0] ?? null;
}

function latestOf(app) {
  return allFiles.filter((f) => f.app === app && f.date).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

function reportUrl(link = '') {
  const shown = link || '(paste the link here)';
  const body = ['Link:', shown, '', 'Where I saw it:', '', 'What made me suspicious:', '', 'Please remove anything personal from the link before posting.'].join('\n');
  return `https://github.com/${OWNER_REPO}/issues/new?${new URLSearchParams({ title: `Lookalike report: ${shown}`, body })}`;
}

// ---- Lookalikes: a name 1–2 edits away from an official one (or the same after swapping l/1, o/0, rn/m) ----
function lev(a, b) {
  const m = a.length, n = b.length;
  const D = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) D[i][0] = i;
  for (let j = 0; j <= n; j++) D[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  // Walk back to find which characters of a differ from b.
  const marks = new Set();
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && D[i][j] === D[i - 1][j - 1]) { i--; j--; }
    else if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + 1) { marks.add(i - 1); i--; j--; }
    else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { marks.add(i - 1); i--; }
    else { j--; } // a character is missing from a
  }
  return { d: D[m][n], marks };
}
const confusable = (text) => text.toLowerCase().replace(/rn/g, 'm').replace(/1/g, 'l').replace(/0/g, 'o');

function lookalikeOf(candidate, officials) {
  const cand = candidate.toLowerCase();
  let best = null;
  for (const official of officials) {
    const off = official.toLowerCase();
    if (!cand || cand === off) continue;
    const raw = lev(cand, off);
    const swapped = lev(confusable(cand), confusable(off)).d;
    const score = Math.min(raw.d, swapped);
    const hit = (score >= 1 && score <= 2) || swapped === 0;
    if (hit && (!best || score < best.score)) best = { official, marks: raw.marks, score };
  }
  return best;
}
const markedNodes = (text, marks) => [...text].map((ch, i) => (marks.has(i) ? el('mark', { class: 'diff', text: ch }) : document.createTextNode(ch)));

function lookalikeHint(owner, repo) {
  if (!data) return null;
  const owners = [...new Set(data.apps.map((a) => a.repo.split('/')[0]))];
  const repos = data.apps.map((a) => a.repo.split('/')[1]);
  const ownerHit = lookalikeOf(owner, owners);
  const repoHit = ownerHit ? null : lookalikeOf(repo, repos);
  if (!ownerHit && !repoHit) return null;
  const shown = (ownerHit ?? repoHit).official;
  return el('p', {},
    el('span', { class: 'lookalike', text: `⚠️ Looks like “${shown}” but it isn’t.` }),
    el('code', { class: 'addr' }, 'github.com/',
      ...(ownerHit ? markedNodes(owner, ownerHit.marks) : [owner]), '/',
      ...(repoHit ? markedNodes(repo, repoHit.marks) : [repo])));
}

function siteHint(host) {
  if (!data) return null;
  const hit = lookalikeOf(host, [siteHost]);
  if (!hit) return null;
  return el('p', {},
    el('span', { class: 'lookalike', text: `⚠️ Looks like “${siteHost}” but it isn’t.` }),
    el('code', { class: 'addr' }, ...markedNodes(host, hit.marks)));
}

// Simple line icons: our own paths, 1.75 px stroke, drawn in the current colour (no external files).
const NS = 'http://www.w3.org/2000/svg';
const svgIcon = (paths) => {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 24, height: 24, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, String(v));
  for (const d of paths) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
};

// ---- Routing --------------------------------------------------------------
const SECTIONS = {
  '': $('home'),
  download: $('screen-download'),
  file: $('screen-file'),
  link: $('screen-link'),
  other: $('screen-other'),
  installed: $('screen-installed'),
};
let currentKey = '';

function route() {
  const hash = location.hash.replace('#', '');
  currentKey = Object.hasOwn(SECTIONS, hash) ? hash : '';
  for (const [key, node] of Object.entries(SECTIONS)) node.hidden = key !== currentKey;
  if (currentKey === 'download') renderDownload();
  if (currentKey === 'other') $('other-result').hidden = true;
  if (currentKey === 'installed') $('installed-result').hidden = true;
  window.scrollTo(0, 0);
  SECTIONS[currentKey].querySelector('h1').focus({ preventScroll: true });
}

function renderHome() {
  const order = isPhone() ? [CHOICES[2], ...CHOICES.filter((c) => c.id !== 'link')] : CHOICES; // phone visitors: the link check first
  $('home-choices').replaceChildren(...order.map((c) => el('a', { class: 'choice', href: `#${c.id}` },
    el('span', { class: 'emoji' }, svgIcon(c.icon)),
    el('span', {}, el('strong', { text: c.title }), el('small', { text: c.sub })),
    el('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }))));
  $('report-home').href = reportUrl('');
}

// ---- 1. Download an app ---------------------------------------------------
const dl = { app: null, device: null };
// The app's own icon (site/icons, 64 px) over its coloured letter. If the icon is missing, the letter stays.
const appBadge = (app) => {
  const letter = el('span', { class: 'dot', text: app.name.charAt(0), 'aria-hidden': 'true' });
  letter.style.background = safeColour(app.colour);
  const short = app.repo.split('/')[1].toLowerCase();
  const icon = el('img', { class: 'app-icon', src: `icons/${short}.png`, alt: '', width: 32, height: 32, loading: 'lazy' });
  icon.addEventListener('error', () => icon.remove());
  return el('span', { class: 'badge-wrap' }, letter, icon);
};

// Device tiles: the file type a computer download comes as. Phones: "no official app" unless an official phone file is listed.
const DEVICE_LIST = [
  { id: 'mac', label: 'Mac', hint: '.dmg' },
  { id: 'windows', label: 'Windows', hint: '.exe / .msi' },
  { id: 'linux', label: 'Linux', hint: '.AppImage / .deb' },
  { id: 'android', label: 'Android', hint: 'no official app' },
  { id: 'iphone', label: 'iPhone', hint: 'no official app' },
];
const phoneHint = (id) => {
  const wanted = id === 'android' ? /\.(apk|aab)$/i : /\.ipa$/i;
  return allFiles.some((f) => wanted.test(f.name)) ? 'official file listed' : 'no official app';
};

function renderDownload() {
  const body = $('download-body');
  if (!data) { body.replaceChildren(el('p', { class: 'lead', text: 'Loading the official list…' })); return; }

  if (!dl.app) {
    body.replaceChildren(
      el('p', { class: 'step', text: 'Step 1 of 2 · Which app?' }),
      el('div', { class: 'tiles' }, ...data.apps.map((app) => {
        const tile = el('button', { class: 'tile', type: 'button' }, appBadge(app),
          el('span', { class: 'text' }, el('strong', { text: app.name }), app.maker ? el('small', { text: `Made by ${app.maker}` }) : ''));
        tile.addEventListener('click', () => { dl.app = app; dl.device = null; renderDownload(); reveal(body.querySelector('.step')); });
        return tile;
      })),
      el('p', { class: 'fine', text: 'Fakes can copy logos too, so always check the file.' }));
    return;
  }

  const app = dl.app;
  const devices = isPhone() ? [DEVICE_LIST[3], DEVICE_LIST[4], ...DEVICE_LIST.slice(0, 3)] : DEVICE_LIST; // phone visitors: phone choices first
  const back = el('button', { class: 'link-btn', type: 'button', text: '← Choose another app' });
  back.addEventListener('click', () => { dl.app = null; renderDownload(); });
  body.replaceChildren(
    back,
    el('p', { class: 'step', text: `Step 2 of 2 · ${app.name}: which device?` }),
    el('div', { class: 'devices' }, ...devices.map((d) => {
      const button = el('button', { class: 'device', type: 'button', 'aria-pressed': String(dl.device === d.id) },
        el('span', { class: 'text' }, el('strong', { text: d.label }), el('small', { text: d.id === 'android' || d.id === 'iphone' ? phoneHint(d.id) : d.hint })));
      button.addEventListener('click', () => { dl.device = d.id; renderDownload(); reveal(body.querySelector('.answer')); });
      return button;
    })));

  if (!dl.device) return;
  const latest = latestOf(app);
  const latestLine = latest ? el('p', { class: 'fine', text: `Latest release: ${latest.tag}${latest.date ? ` (${dateFmt(latest.date)})` : ''}` }) : '';

  if (dl.device === 'android' || dl.device === 'iphone') {
    const wanted = dl.device === 'android' ? /\.(apk|aab)$/i : /\.ipa$/i;
    const phoneFile = allFiles.filter((f) => f.app === app && wanted.test(f.name)).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
    if (phoneFile) {
      body.append(card('ok', 'The team published a phone app.',
        el('p', { text: `${app.name} ${phoneFile.tag}: ${phoneFile.name}` }),
        el('p', { class: 'fine', text: `Released ${dateFmt(phoneFile.date)}` }),
        bigLink(`${app.download.replace(/\/releases$/, '')}/releases/tag/${encodeURIComponent(phoneFile.tag)}`, 'Open the official release page')));
    } else {
      body.append(card('bad', 'There is no real phone app yet.',
        el('p', { text: 'Any phone version you find was made by someone else.' }),
        bigLink(app.download, `Get the real ${app.name} for your computer`)));
    }
  } else {
    body.append(card('ok', 'Get it here. This is the real one.',
      el('p', { text: `${app.name} is published only on its official GitHub page.` }),
      makerLine(app),
      latestLine,
      bigLink(app.download, `Open the real ${app.name} download page`)));
  }
}

// ---- 2. Already downloaded a file -----------------------------------------
const drop = $('drop');
const fileInput = $('file');

function showFile(...nodes) {
  const box = $('file-result');
  box.replaceChildren(...nodes);
  box.hidden = false;
  reveal(box);
}

function sourceBlock() {
  const line = el('p', { class: 'note', 'aria-live': 'polite' });
  const buttons = SOURCES.map(([label, text]) => {
    const button = el('button', { class: 'source', type: 'button', text: label });
    button.addEventListener('click', () => { line.textContent = text; });
    return button;
  });
  return el('div', { class: 'group' },
    el('h3', { text: 'Where did you get it?', style: 'margin:8px 0 0;font-size:1.05rem' }),
    el('div', { class: 'choices two' }, ...buttons),
    line);
}

function moreChecks(sha) {
  return el('details', {},
    el('summary', { text: 'More checks' }),
    el('p', { text: 'Ask antivirus sites what they think. One or two alarms can be false.' }),
    el('p', {}, el('a', { href: `https://www.virustotal.com/gui/file/${sha}`, target: '_blank', rel: 'noopener', text: 'What do antivirus apps say? (opens VirusTotal, nothing is uploaded)' })),
    el('p', { text: 'Who signed it?' }),
    el('ul', {},
      el('li', {}, el('strong', { text: 'Mac: ' }), 'open Terminal and run ', el('code', { text: 'spctl -a -vv /Applications/App.app' }), ' (use the app’s real name).'),
      el('li', {}, el('strong', { text: 'Windows: ' }), 'right-click the file → Properties → Digital Signatures.')));
}

function showVerdict(sha, fileName, fileSize) {
  const hits = bySha.get(sha);
  const meta = fileName ? el('p', { class: 'fine', text: `${fileName} · ${sizeFmt(fileSize)}` }) : '';
  if (hits) {
    const hit = hits[0];
    const renamed = fileName && fileName !== hit.name
      ? el('p', { text: `Your file is named “${fileName}”. The official name is “${hit.name}”. Same file, only the name differs.` })
      : '';
    showFile(card('ok', 'Real. This file is exactly what the team made.',
      el('p', { text: `${hit.app.name} ${hit.tag}${hit.date ? `, released ${dateFmt(hit.date)}` : ''}.` }),
      makerLine(hit.app),
      renamed,
      bigLink(`${hit.app.download.replace(/\/releases$/, '')}/releases/tag/${encodeURIComponent(hit.tag)}`, 'Open the official release page')), meta);
    return;
  }
  const guess = guessApp(fileName);
  const sameName = fileName && byName.has(fileName);
  showFile(card('bad', 'Not real. Don’t open it.',
    el('p', { text: 'Delete it and get the real one here.' }),
    sameName ? el('p', { text: 'The name matches an official file, but the contents are different. Something was changed or added.' }) : '',
    bigLink(guess ? guess.download : siteUrl(), guess ? `Get the real ${guess.name}` : 'Get the real one from the official site'),
    sourceBlock(),
    moreChecks(sha)), meta);
}

const sha256Hex = async (buffer) => {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

let fileRun = 0;
async function checkFile(file) {
  if (!file) return;
  const run = ++fileRun;
  const progress = $('file-progress');
  $('file-result').hidden = true;
  if (!data) { progress.textContent = 'The official file list is still loading. Try again in a moment.'; return; }
  if (file.size > MAX_BYTES) {
    progress.textContent = '';
    showFile(card('wait', 'This file is too big to check in the browser.',
      el('p', { text: `${file.name} is ${sizeFmt(file.size)}. Open “Too big for the browser” below, run the command, and paste the line.` })));
    $('paste-box').open = true;
    return;
  }
  progress.textContent = `Checking ${file.name} (${sizeFmt(file.size)})… Nothing is uploaded.`;
  $('progress-bar').hidden = false;
  try {
    const sha = await sha256Hex(await file.arrayBuffer());
    if (run !== fileRun) return;
    progress.textContent = '';
    showVerdict(sha, file.name, file.size);
  } catch (error) {
    if (run !== fileRun) return;
    progress.textContent = '';
    showFile(card('wait', 'We couldn’t read this file in the browser.',
      el('p', { text: `Open “Too big for the browser” below and use the command instead. (${error.message})` })));
    $('paste-box').open = true;
  } finally {
    $('progress-bar').hidden = true;
    fileInput.value = '';
  }
}

$('choose').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => checkFile(fileInput.files[0]));
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => checkFile(e.dataTransfer.files[0]));

$('hashform').addEventListener('submit', (e) => {
  e.preventDefault();
  // Accept the whole line from shasum / sha256sum / certutil: the first standalone 64-character hex value.
  const match = $('hash').value.toLowerCase().match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/);
  if (!match) { showFile(card('wait', 'That doesn’t look like the right line.', el('p', { text: 'Paste the whole line the command printed. It has 64 letters a–f and numbers in it.' }))); return; }
  if (!data) { showFile(card('wait', 'The official file list is still loading. Try again in a moment.')); return; }
  showVerdict(match[0], '', 0);
});

// ---- 3. Someone sent me a link --------------------------------------------
let linkRun = 0;

function parseLink(raw) {
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  let unwrapped = false;
  // google.com/url?q=<real address>: look past Google's redirect to the address it points to.
  for (let i = 0; i < 3 && /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/url'; i++) {
    const inner = url.searchParams.get('q') ?? url.searchParams.get('url');
    if (!inner) break;
    try { url = new URL(inner); } catch {
      try { url = new URL(`https://${inner}`); } catch { break; }
    }
    unwrapped = true;
  }
  return { url, unwrapped };
}

// Public GitHub facts for a repository. Unauthenticated: 60 requests an hour per visitor.
async function gh(path) {
  let res;
  try { res = await fetch(`https://api.github.com${path}`); } catch { return { status: 'error' }; }
  if (res.status === 403 || res.status === 429) return { status: 'limit' };
  if (res.status === 404) return { status: 'missing' };
  if (!res.ok) return { status: 'error' };
  return { status: 'ok', json: await res.json() };
}

function factsList(facts) {
  if (facts.status === 'missing') return el('p', { class: 'fine', text: 'GitHub has no public page at this address. It may have been removed or renamed.' });
  if (facts.status === 'limit') return el('p', { class: 'fine', text: 'GitHub says wait a bit, so we can’t show the details right now.' });
  if (facts.status === 'error') return el('p', { class: 'fine', text: 'We couldn’t reach GitHub just now.' });
  const repo = facts.repo;
  return el('ul', { class: 'evidence' },
    el('li', { text: `Account: ${repo.owner?.login ?? 'unknown'}` }),
    el('li', { text: `Created: ${dateFmt(repo.created_at) || 'unknown'}` }),
    el('li', { text: `A copy (fork) of another project: ${repo.fork ? 'yes' : 'no'}` }),
    el('li', { text: `Stars: ${Number(repo.stargazers_count ?? 0).toLocaleString('en')}` }),
    el('li', { text: `Published releases: ${facts.hasReleases ? 'yes' : 'none found'}` }));
}

async function repoFacts(owner, repo) {
  const [info, releases] = await Promise.all([gh(`/repos/${owner}/${repo}`), gh(`/repos/${owner}/${repo}/releases?per_page=1`)]);
  if (info.status !== 'ok') return info;
  return { status: 'ok', repo: info.json, hasReleases: releases.status === 'ok' && releases.json.length > 0 };
}

async function checkLink(raw) {
  const run = ++linkRun;
  const out = $('link-result');
  const put = (...nodes) => { if (run === linkRun) { out.replaceChildren(...nodes); out.hidden = false; reveal(out); } };
  $('report-link').href = reportUrl(raw.trim());
  if (!data) { put(card('wait', 'The official list is still loading. Try again in a moment.')); return; }

  const parsed = parseLink(raw);
  if (!parsed) { put(card('wait', 'That doesn’t look like a web address.', el('p', { text: 'Copy the whole address and paste it again.' }))); return; }
  const { url, unwrapped } = parsed;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const note = unwrapped ? el('p', { class: 'fine', text: `We looked past a Google link. The address it points to is on: ${host}` }) : '';

  if (SHORT_LINK_HOSTS.has(host)) {
    put(card('wait', 'This is a short link. We can’t see where it goes yet.',
      el('p', { text: 'Open it, then copy the address from the top bar and paste it here.' }), note));
    return;
  }

  if (host === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const [owner = '', repo = ''] = parts;
    if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) {
      put(card('bad', 'Not from the team. The real one is here.',
        el('p', { text: 'This is not a project page.' }),
        bigLink(siteUrl(), 'Get the real one from the official site'), note));
      return;
    }
    const app = appByRepo.get(`${owner}/${repo}`.toLowerCase());
    const isReleaseFile = parts[2] === 'releases' && parts[3] === 'download' && parts.length === 6;
    if (isReleaseFile) {
      let tag = '';
      let file = '';
      try { tag = decodeURIComponent(parts[4]); file = decodeURIComponent(parts[5]); } catch { /* fall through with empty values */ }
      await checkReleaseFile(run, put, app, owner, repo, tag, file, note);
      return;
    }

    if (app) {
      put(card('ok', 'Real. This is the team’s page.',
        el('p', { text: `${app.name} is published by the team on GitHub (${app.repo}).` }),
        makerLine(app),
        bigLink(app.download, `Open the official ${app.name} download page`), note));
      return;
    }
    const guess = guessApp(`${owner}/${repo}`);
    const evidence = el('div', { class: 'fine', text: 'Checking what GitHub says about this page…' });
    put(card('bad', 'Not from the team. The real one is here.',
      el('p', { text: `This page belongs to ${owner}, not to the team.` }),
      lookalikeHint(owner, repo),
      evidence,
      bigLink(guess ? guess.download : siteUrl(), guess ? `Get the real ${guess.name}` : 'Get the real one from the official site'), note));
    const facts = await repoFacts(owner, repo);
    if (run === linkRun) evidence.replaceWith(factsList(facts));
    return;
  }

  if (isOfficialHost(host)) {
    put(card('ok', 'Real. This is the team’s site.',
      bigLink(siteUrl(), 'Open the team’s official site'), note));
    return;
  }

  put(card('bad', 'Not the team’s site.',
    el('p', { text: `This address is on: ${host}` }),
    siteHint(host),
    el('p', { text: 'Look-alike sites often copy the real page. Get the app from the official site or GitHub page.' }),
    bigLink(siteUrl(), 'Get the real one from the official site'), note));
}

async function checkReleaseFile(run, put, app, owner, repo, tag, file, note) {
  if (!app) {
    const evidence = el('div', { class: 'fine', text: 'Checking what GitHub says about this page…' });
    put(card('bad', 'Not from the team. The real one is here.',
      el('p', { text: `This file is on a page that belongs to ${owner}, not to the team. Don’t open it.` }),
      lookalikeHint(owner, repo),
      evidence,
      bigLink(siteUrl(), 'Get the real one from the official site'), note));
    const facts = await repoFacts(owner, repo);
    if (run === linkRun) evidence.replaceWith(factsList(facts));
    return;
  }
  const releasePage = `${app.download.replace(/\/releases$/, '')}/releases/tag/${encodeURIComponent(tag)}`;
  put(card('wait', 'Checking this file with GitHub…', el('p', { text: 'We read GitHub’s fingerprint for the file. We don’t download it.' })));
  const res = await gh(`/repos/${app.repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (run !== linkRun) return;

  if (res.status === 'limit') {
    put(card('ok', 'From the team’s release page.',
      el('p', { text: 'We couldn’t check this exact file: GitHub says wait a bit (it allows a limited number of checks an hour for each visitor).' }),
      el('p', { text: 'Download it from the official page, then drop it on “I already downloaded a file”.' }),
      bigLink(releasePage, 'Open the official release page'), note));
    return;
  }
  if (res.status === 'missing') {
    put(card('bad', 'Not on the team’s release page.',
      el('p', { text: 'We can’t find that release. Don’t open the file.' }),
      bigLink(app.download, `Get the real ${app.name}`), note));
    return;
  }
  if (res.status !== 'ok') {
    put(card('wait', 'We couldn’t reach GitHub just now.', el('p', { text: 'Try again in a minute.' }), note));
    return;
  }

  const asset = (res.json.assets ?? []).find((a) => a.name === file);
  if (!asset) {
    put(card('bad', 'This file isn’t on the team’s release page.',
      el('p', { text: 'Don’t open it. Get the real one here.' }),
      bigLink(app.download, `Get the real ${app.name}`), note));
    return;
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(asset.digest)) {
    put(card('wait', 'We can’t check this file’s fingerprint.',
      el('p', { text: 'GitHub doesn’t list one for it. It is on the team’s release page.' }),
      bigLink(releasePage, 'Open the official release page'), note));
    return;
  }
  const hit = bySha.get(asset.digest.slice(7))?.[0];
  if (hit) {
    put(card('ok', 'Official file. You didn’t even download it.',
      el('p', { text: `${hit.name} from ${app.name} ${hit.tag}${hit.date ? `, released ${dateFmt(hit.date)}` : ''}.` }),
      makerLine(app),
      bigLink(releasePage, 'Open the official release page'), note));
    return;
  }
  put(card('wait', 'On the team’s release page, but not in our list.',
    el('p', { text: `Our list covers the last ${data.keep_days} days of releases plus each app’s latest release. An older file can’t be confirmed here.` }),
    bigLink(app.download, 'Get the newest version here'), note));
}

$('linkform').addEventListener('submit', (e) => {
  e.preventDefault();
  checkLink($('link-input').value);
});

// ---- 4. Plugin, website version or phone app ------------------------------
const KIND_LABEL = { plugin: 'plugin', website: 'website version', phone: 'phone app' };

$('screen-other').querySelectorAll('[data-kind]').forEach((button) => {
  button.addEventListener('click', () => {
    const kind = button.dataset.kind;
    const tested = unofficial.filter((item) => item.kind === kind);
    const list = tested.length
      ? el('ul', { class: 'tested' }, ...tested.map((item) => el('li', {},
        el('strong', { text: item.name ?? 'Untitled' }),
        el('p', { text: item.result ?? '' }),
        el('span', { text: item.tested_on ? `Tested ${dateFmt(item.tested_on)}` : '' }))))
      : el('p', { class: 'note', text: `We haven’t tested this ${KIND_LABEL[kind]} yet.` });
    const box = $('other-result');
    box.replaceChildren(card('wait', 'Not made by the team.',
      el('p', { text: `This ${KIND_LABEL[kind]} was not made by the team. Only use it if you trust who made it.` }),
      el('p', { text: 'Before you use it, ask:' }),
      el('ul', {},
        el('li', { text: 'Can you see who made it?' }),
        el('li', { text: 'Is the code public?' }),
        el('li', { text: 'Does it ask for more than it needs?' })),
      el('h3', { text: 'Our test notes', style: 'margin:8px 0 0;font-size:1.05rem' }),
      list,
      bigLink(siteUrl(), 'Get the real one from the official site')));
    box.hidden = false;
    reveal(box);
  });
});

// ---- 5. Already installed something fake ----------------------------------
$('screen-installed').querySelectorAll('[data-yes]').forEach((button) => {
  button.addEventListener('click', () => {
    const artcraft = artCraft();
    const link = artcraft ? artcraft.download : siteUrl();
    const box = $('installed-result');
    if (button.dataset.yes === 'yes') {
      box.replaceChildren(card('bad', 'Fix it in three steps.',
        el('ol', {},
          el('li', { text: 'Delete it.' }),
          el('li', { text: 'Change that password.' }),
          el('li', { text: 'Get the real one here.' })),
        bigLink(link, 'Delete it, get the real one here')));
    } else {
      box.replaceChildren(card('wait', 'Good. Now fix it.',
        el('ol', {},
          el('li', { text: 'Delete it.' }),
          el('li', { text: 'Get the real one here.' }),
          el('li', { text: 'Done.' })),
        bigLink(link, 'Get the real one')));
    }
    box.hidden = false;
    reveal(box);
  });
});

// ---- Start ----------------------------------------------------------------
renderHome();
window.addEventListener('hashchange', route);
route();
loadData();
