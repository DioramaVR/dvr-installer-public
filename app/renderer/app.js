// Renderer: gallery -> one game's page -> progress -> done. All work happens in
// the main process through window.dvr (see preload.js).
const api = window.dvr;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Electron wraps errors from the main process as "Error invoking remote method 'x': Error: ...".
const ipcError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const state = {
  games: [],
  settings: {},
  pc: null,
  current: null, // id of the game whose page is open
  vr: { steamvr: false, headset: false }, // SteamVR running / headset connected (engine/vr.js)
  opts: {},      // game id -> { option id -> value }
  // dev mode overrides: SteamVR on, first game installed, first game installed from a closed-beta file, banners, offline
  test: { vr: null, installed: false, file: false, banners: false, offline: false },
  pick: {},      // game id -> the version chosen in its picker ('local' = the one loaded from a file, or a dev build)
  remote: { offline: false, newerInstaller: null, announcements: [], errors: [] }, // the last refresh
  refreshing: false,
  data: {},      // game id -> its data zip's text and its media (null: none, or not had); fetched when its page opens
  shot: {},      // game id -> the gallery picture shown
};
const game = () => state.games.find((g) => g.id === state.current);

// ---------- versions ----------
const MATURITY = { 'closed-beta': 'Closed beta', 'open-beta': 'Open beta', stable: 'Stable' };
const maturityLabel = (m) => MATURITY[m] || m || '';
// "1.10.0" > "1.9.2"; missing parts count as 0 (versions are plain numbers, SPEC section 2).
function compareVersions(a, b) {
  const x = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
  return 0;
}

// A game as the page shows it: the engine's entry, with dev mode's pretend
// states laid over the first owned game.
const testGame = () => state.games.find((g) => g.owned && g.status !== 'coming') || state.games.find((g) => g.owned) || state.games[0];
function view(g) {
  if (!g || g.id !== testGame()?.id) return g;
  let v = g;
  if (state.test.file) {
    v = { ...v, source: 'file', active: { version: '0.1.0', maturity: 'closed-beta', coreVersion: '0.1.1' },
      updateAvailable: { version: v.recommended?.version || '1.0.0', maturity: v.recommended?.maturity || 'stable' } };
    if (state.test.installed) v.installedVersion = '0.1.0';
  }
  if (state.test.installed && !v.installedVersion) v = { ...v, installedVersion: v.recommended?.version || v.active?.version || null };
  return v;
}

// What Install would install. local: the engine's active package (loaded from
// a file, or a dev build), installed as it is; otherwise a public release,
// downloaded. Order: the version picked, else the local one, else what's
// installed if it's still offered, else the recommended release.
function selected(g) {
  const v = view(g);
  const rels = v.releases || [];
  const local = (v.source === 'file' || v.source === 'dev') && v.active ? { local: true, ...v.active } : null;
  const byVersion = (ver) => (ver ? rels.find((r) => r.version === ver) : null);
  const pick = state.pick[g.id];
  if (pick === 'local' && local) return local;
  if (pick && byVersion(pick)) return { local: false, ...byVersion(pick) };
  if (local) return local;
  // An update first (the button then says "Update to ..."), else what's installed, else the recommendation.
  const r = byVersion(v.updateAvailable?.version) || byVersion(v.installedVersion) || byVersion(v.recommended?.version) || rels[0];
  return r ? { local: false, ...r } : null;
}
// Something can be installed from the page: a public release, or a version loaded from a file (or a dev build).
const canOpen = (g) => g.owned && ((g.releases || []).length > 0 || !!g.active || isInstalled(g));
// Listed, but its index couldn't be read (offline with no cache, or a bad signature): no versions to offer now.
const unavailable = (g) => g.unavailable === true && !(g.releases || []).length;

async function load() {
  [state.games, state.settings] = await Promise.all([api.status(), api.getSettings()]);
  for (const g of state.games) {
    const saved = state.settings.opts?.[g.id] || {};
    state.opts[g.id] = Object.fromEntries((g.options || []).map((o) => [o.id, g.installedOptions?.[o.id] ?? saved[o.id] ?? o.default]));
  }
  renderGrid();
  renderBanners();
  const first = state.games.find((g) => g.owned) || state.games[0];
  if (first) setAmbient(first);
}

// The registry and the game indexes, fetched (or from the cache when offline);
// then the gallery again with what they list.
async function refresh(force = false) {
  if (!api.refresh) return;
  state.refreshing = true;
  renderBanners();
  try { state.remote = { ...state.remote, ...(await api.refresh({ force })) }; } catch (e) { state.remote = { ...state.remote, offline: true, errors: [{ what: 'refresh', error: ipcError(e) }] }; }
  state.refreshing = false;
  await load();
  if (state.current && !$('game').hidden) renderGame();
}

// ---------- views ----------
function show(view) {
  for (const v of ['home', 'game', 'guide', 'credits']) {
    const e = $(v);
    e.hidden = v !== view;
    if (v === view) { e.classList.remove('entering'); void e.offsetWidth; e.classList.add('entering'); }
  }
  // The game page is solid black edge to edge; the smoke only shows elsewhere.
  document.body.classList.toggle('solid-bg', view === 'game');
  const video = $('gameVideo');
  if (view !== 'game') { video.pause(); video.classList.remove('on'); }
}

function openGame(id) {
  state.current = id;
  closeHowto();
  renderGame();
  show('game');
  const g = game();
  if (g) loadData(g);
}

// Before install, the page shows only what the signed index says (nothing is
// downloaded until Install). The mod's settings, how-to-play and notes come
// with its package: one quiet line says so instead of empty sections.
function renderDetailsNote(g) {
  const before = (g.releases || []).length > 0 && !isInstalled(g) && (!g.active || g.active.pending);
  $('detailsNote').hidden = !before || !!g.options?.length;
}

$('backHome').addEventListener('click', () => { state.current = null; show('home'); });

// ---------- "Can this PC run it?" ----------
const PC_ICONS = {
  ok: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  warn: '<path d="M8 3.5v5.5M8 12.2v.3"/>',
  bad: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  info: '<path d="M8 7v5.5M8 3.8v.3"/>',
  todo: '<path d="M6 3.5L10.5 8 6 12.5"/>',
};
const PC_STATUS = { ok: 'Good to go', warn: 'Should work, see tips', bad: 'Needs attention' };
// Knowing the VR menu is part of being able to play: its guide sits first among
// the checks, pink until it has been opened, then yellow like a passed check.
function guideTile() {
  const read = !!state.settings.vrMenuGuideRead;
  return `<button class="pc-tile guide-tile ${read ? 'ok' : 'todo'}" data-guide>
    <div class="pc-icon"><svg viewBox="0 0 16 16">${PC_ICONS[read ? 'ok' : 'todo']}</svg></div>
    <div><b>Using the VR menu</b><span>${read ? 'Read' : 'Read this first'}</span></div></button>`;
}
const pcNotes = () => (state.pc?.checks || []).filter((c) => c.detail && c.status !== 'ok');

async function loadPc() {
  $('pcTiles').innerHTML = guideTile() + '<div class="pc-tile skeleton"></div>'.repeat(4);
  try { state.pc = await api.preflight(); } catch { state.pc = null; }
  renderPc();
  if (state.current) renderGame();
}

function renderPc() {
  const pc = state.pc;
  const status = $('pcStatus');
  if (!pc) { status.className = 'pc-status warn'; status.textContent = "Couldn't check"; $('pcTiles').innerHTML = guideTile(); return; }
  status.className = `pc-status ${pc.status}`;
  status.textContent = PC_STATUS[pc.status];
  $('pcTiles').innerHTML = guideTile() + pc.checks.map((c, i) => `<div class="pc-tile ${c.status}" style="animation-delay:${i * 0.05}s" title="${esc(c.summary)}">
    <div class="pc-icon"><svg viewBox="0 0 16 16">${PC_ICONS[c.status]}</svg></div><div><b>${esc(c.title)}</b><span>${esc(c.summary)}</span></div></div>`).join('');
  const notes = pcNotes();
  const box = $('pcDetails');
  box.innerHTML = notes.map((c) => `<div class="pc-note ${c.status}"><div><b>${esc(c.title)}:</b> ${esc(c.detail)}</div>${c.link ? `<button class="btn ghost" data-link="${esc(c.link.url)}">${esc(c.link.label)}</button>` : ''}</div>`).join('');
  // Problems are always shown; tips fold away.
  const urgent = notes.some((c) => c.status === 'bad');
  box.hidden = !urgent;
  $('pcMore').hidden = notes.length === 0 || urgent;
  $('pcMore').textContent = `Tips (${notes.length})`;
}
$('pcMore').addEventListener('click', () => {
  $('pcDetails').hidden = !$('pcDetails').hidden;
  $('pcMore').textContent = $('pcDetails').hidden ? `Tips (${pcNotes().length})` : 'Hide tips';
});
document.addEventListener('click', (e) => {
  const l = e.target.closest('[data-link]');
  if (l) api.openLink(l.dataset.link);
});

// ---------- ambient backdrop ----------
let ambientFlip = false, ambientId = null;
function setAmbient(g) {
  const src = g.art.hero || g.art.capsule;
  if (!src || ambientId === g.id) return;
  ambientId = g.id;
  const [a, b] = ambientFlip ? [$('ambientA'), $('ambientB')] : [$('ambientB'), $('ambientA')];
  ambientFlip = !ambientFlip;
  a.style.backgroundImage = `url("${src}")`;
  a.classList.add('on');
  b.classList.remove('on');
}

// ---------- gallery ----------
const badge = (cls, text, title) => `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
const comingText = (g) => (g.closedBeta ? 'In closed beta on Patreon' : 'Coming');

function badgesFor(raw) {
  const g = view(raw);
  const out = [];
  const installed = isInstalled(g);
  // A game with nothing public yet: "Coming", unless the player loaded a closed-beta file for it.
  if (g.status === 'coming' && !g.active && !installed) {
    out.push(badge('coming', comingText(g)));
    if (!g.owned) out.push(badge('missing', 'Not installed on this PC'));
    return out.join('');
  }
  // Listed, but its versions can't be read right now (and nothing of it is on this PC).
  if (unavailable(g) && !g.active && !installed) {
    out.push(badge('coming', 'Unavailable right now', "The list of this mod's versions couldn't be read. It may be back after a restart, or once you're online."));
    if (!g.owned) out.push(badge('missing', 'Not installed on this PC'));
    return out.join('');
  }
  // "owned" means installed in a Steam library on this PC; nothing is checked online.
  if (!g.owned) return badge('missing', 'Not installed on this PC');
  if (installed) out.push(badge('installed', 'Installed'));
  else if (selected(g)) out.push(badge('ready', 'Ready to install'));
  else out.push(badge('missing', 'Not available'));
  if (installed && g.updateAvailable && g.source !== 'file') out.push(badge('update', `Update ${g.updateAvailable.version}`, 'A newer version of the mod is out'));
  if (g.buildTested === false) out.push(badge('updated', 'Game updated since tested', 'The game has been updated since this mod was last tested. It will probably still work.'));
  out.push(versionBadges(g));
  return out.join('');
}

// A version loaded from a file shows its maturity (anything but Stable) and its number.
function versionBadges(g) {
  if (g.source !== 'file' || !g.active) return '';
  const m = g.active.maturity;
  return (m && m !== 'stable' ? badge('beta', maturityLabel(m), 'A test version you loaded from a file') : '') + badge('version', g.active.version);
}

// One plain list (waves are the website's): owned games first, otherwise in
// the order they came (by name).
function sorted() {
  const rank = (g) => (g.owned ? 0 : 1);
  return state.games.map((g, i) => [g, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([g]) => g);
}

// ---------- a game's data zip and media ----------
// Fetched by the engine when the game's page first opens (once per run here;
// the engine keeps them until the hashes change): the text from the data zip,
// the media from the index's assets list (else the zip). null: none, or they
// couldn't be had: the page shows the index alone, quietly.
const playable = (url) => {
  const type = /\.mp4$/i.test(url || '') ? 'video/mp4' : /\.webm$/i.test(url || '') ? 'video/webm' : '';
  return !!type && document.createElement('video').canPlayType(type) !== '';
};
// A video's file, or the first of its other encodings this app can play.
const videoUrl = (m) => (m ? [m.file, ...(m.sources || [])].find(playable) || null : null);
const mediaOf = (g, role, kind) => (state.data[g.id]?.media || []).find((m) => m.role === role && (!kind || m.kind === kind)) || null;
async function loadData(g) {
  if (!api.gameData || g.id in state.data) return;
  state.data[g.id] = null;
  let d = null;
  try { d = await api.gameData(g.id); } catch (e) { console.warn(`data for ${g.id}:`, ipcError(e)); }
  if (!d) return;
  state.data[g.id] = d;
  // The card shows its line from now on.
  const s = state.games.find((x) => x.id === g.id);
  if (s) s.line = d.line || s.line;
  if (state.current === g.id && !$('game').hidden) renderGame();
}
// The page's text: the data zip's when it's here; else what an installed mod has.
function info(g) {
  const d = state.data[g.id]?.hasText === false ? null : state.data[g.id];
  return {
    line: d?.line || g.line || null,
    firstLaunch: d ? d.firstLaunch : g.firstLaunch || null,
    needToKnow: d ? d.needToKnow : g.needToKnow || [],
    tutorial: d ? d.tutorial : (g.tutorial || []).map((t) => ({ title: t.title, text: t.text })),
    knownIssues: issuesShown(g, d),
  };
}
// The known issues for the version selected on the page (else the one the
// engine chose): those since it and not yet fixed in it. The data zip's list
// when it's here, else the index's.
function issuesShown(g, d) {
  const all = d?.allKnownIssues || g.allIssues;
  const v = selected(g)?.version || g.issuesVersion;
  if (!all || !v) return d?.knownIssues || g.knownIssues || [];
  return all.filter((k) => (!k.since || compareVersions(k.since, v) <= 0) && (!k.fixedIn || compareVersions(v, k.fixedIn) < 0));
}

function card(g, i) {
  const coming = (g.status === 'coming' || unavailable(g)) && !g.active && !isInstalled(g);
  const open = canOpen(g);
  const c = el('div', `card${g.owned ? '' : ' unowned'}${coming ? ' coming' : ''}${open ? '' : ' closed'}${g.art?.capsule ? '' : ' no-art'}`);
  c.style.animationDelay = `${0.08 + i * 0.06}s`;
  c.tabIndex = open ? 0 : -1;
  const img = g.art?.capsule ? `<img src="${esc(g.art.capsule)}" alt="" draggable="false">` : `<div class="fallback">${esc(g.game)}</div>`;
  const store = g.owned ? '' : `<button class="store-link" data-store="${g.appid}">View on Steam <svg viewBox="0 0 12 12"><path d="M4 2h6v6M10 2L3 9"/></svg></button>`;
  c.innerHTML = `<div class="frame">${img}<div class="shade"></div><div class="shine"></div></div><div class="ring"></div>
    <div class="go"><svg viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5"/></svg></div>
    <button class="go-launch" data-launch><svg viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z"/></svg>Launch</button>
    <div class="meta"><div class="name">${esc(g.game)}</div>${g.line ? `<div class="line">${esc(g.line)}</div>` : ''}<div class="badges">${badgesFor(g)}</div>${store}</div>`;
  c.dataset.id = g.id;
  // No video on hover: the card stays a still picture.
  c.addEventListener('mouseenter', () => setAmbient(g));
  c.addEventListener('mouseleave', () => { c.style.removeProperty('--rx'); c.style.removeProperty('--ry'); });
  c.addEventListener('mousemove', (e) => {
    if (!open) return;
    const r = c.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    c.style.setProperty('--ry', `${(x - 0.5) * 10}deg`);
    c.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
    c.style.setProperty('--mx', `${x * 100}%`);
    c.style.setProperty('--my', `${y * 100}%`);
  });
  c.addEventListener('click', (e) => {
    const s = e.target.closest('[data-store]');
    if (s) { e.stopPropagation(); api.openStore(s.dataset.store); return; }
    if (e.target.closest('[data-launch]')) { e.stopPropagation(); launchGame(g.id); return; }
    if (open) openGame(g.id);
  });
  c.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && open) { e.preventDefault(); openGame(g.id); } });
  return c;
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  let i = 0;
  for (const g of sorted()) grid.appendChild(card(g, i++));
  const ghost = el('div', 'card ghost', '<div><div class="plus">+</div><b>More games coming</b>New mods appear here as they\'re released, or when you load one from a file.</div>');
  ghost.style.animationDelay = `${0.08 + i * 0.06}s`;
  grid.appendChild(ghost);
  onVr();
}

function openGuide() {
  show('guide');
  $('guide').querySelector('.home-scroll').scrollTop = 0;
  if (!state.settings.vrMenuGuideRead) {
    state.settings.vrMenuGuideRead = true;
    api.setSettings({ vrMenuGuideRead: true });
    if (state.pc) renderPc(); else document.querySelector(".guide-tile").outerHTML = guideTile();
  }
}
$('guideBack').addEventListener('click', () => show('home'));
$('pcTiles').addEventListener('click', (e) => { if (e.target.closest('[data-guide]')) openGuide(); });

// ---------- About / Credits (credits.json) ----------
// Everything from the file is escaped text; links are only its https ones,
// opened by main, which allows exactly the URLs in the file.
const httpsUrl = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const creditLink = (url, label, cls = 'btn ghost') => (httpsUrl(url) ? `<button class="${cls}" data-link="${esc(url)}">${esc(label)}</button>` : '');
function renderCredits(doc) {
  const box = $('creditsBody');
  if (!doc) { box.innerHTML = `<h1>Credits</h1><p class="credits-intro">The credits couldn't be read.</p>`; return; }
  const list = Array.isArray(doc.credits) ? doc.credits : [];
  const meta = (c) => [c.for, c.license && `Licence: ${c.license}`].filter(Boolean).map(esc).join(' · ');
  const top = list.filter((c) => c.highlight).map((c) => `<article class="credit-hero">
      <h2>${esc(c.name)}</h2>
      <p>${meta(c)}</p>
      ${c.notice ? `<p class="credit-notice">${esc(c.notice)}</p>` : ''}
      <div class="credit-actions">
        ${(c.support || []).map((s, i) => creditLink(s.url, `Support on ${s.label}`, i ? 'btn ghost' : 'btn primary support')).join('')}
        ${creditLink(c.url, 'Project page')}
      </div>
    </article>`).join('');
  const rest = list.filter((c) => !c.highlight).map((c) => `<li>
      <div class="credit-name">${httpsUrl(c.url) ? `<button class="credit-link" data-link="${esc(c.url)}">${esc(c.name)}</button>` : esc(c.name)}</div>
      <div class="credit-for">${esc(c.for || '')}</div>
      <div class="credit-licence">${esc(c.license || '')}</div>
      ${c.notice || (c.support || []).length ? `<div class="credit-extra">${c.notice ? `<span>${esc(c.notice)}</span>` : ''}${(c.support || []).map((s) => creditLink(s.url, `Support on ${s.label}`, 'credit-link')).join('')}</div>` : ''}
    </li>`).join('');
  box.innerHTML = `<h1>${esc(doc.title || 'Credits')}</h1>
    ${doc.intro ? `<p class="credits-intro">${esc(doc.intro)}</p>` : ''}
    ${top ? `<div class="credit-heroes">${top}</div>` : ''}
    ${rest ? `<h3>Also inside</h3><ul class="credit-list">${rest}</ul>` : ''}
    ${doc.notices ? `<p class="credits-notices">${esc(doc.notices)}</p>` : ''}
    ${doc.disclaimer ? `<p class="credits-disclaimer">${esc(doc.disclaimer)}</p>` : ''}`;
}
async function openCredits() {
  if (!state.credits) { try { state.credits = await api.credits(); } catch { state.credits = null; } }
  renderCredits(state.credits);
  show('credits');
  $('credits').querySelector('.home-scroll').scrollTop = 0;
}
$('creditsLink').addEventListener('click', openCredits);
$('creditsBack').addEventListener('click', () => show('home'));
$('creditsBody').addEventListener('click', (e) => { const l = e.target.closest('[data-link]'); if (l) api.openLink(l.dataset.link); });

// ---------- game page ----------
function fmt(o, v) {
  if (o.type !== 'number') return v;
  const n = Number(v) * (o.scale || 1);
  const digits = o.scale ? 0 : (String(o.step).split('.')[1] || '').length;
  return `${n.toFixed(digits)}${o.unit === '%' ? '%' : o.unit ? ` ${o.unit}` : ''}`;
}

function optionRow(o, value, onChange) {
  const label = `<b>${esc(o.label)}</b>${o.help ? `<small>${esc(o.help)}</small>` : ''}`;
  if (o.type === 'bool') {
    const row = el('label', 'row toggle-row', `<span>${label}</span>`);
    const input = el('input', 'switch');
    input.type = 'checkbox';
    input.checked = !!value;
    input.addEventListener('change', () => onChange(input.checked));
    row.appendChild(input);
    return row;
  }
  if (o.type === 'number') {
    const row = el('div', 'row slider-row', `<div class="top"><b>${esc(o.label)}</b><output>${fmt(o, value)}</output></div>${o.help ? `<small>${esc(o.help)}</small>` : ''}`);
    const input = el('input');
    Object.assign(input, { type: 'range', min: o.min, max: o.max, step: o.step, value });
    const paint = () => input.style.setProperty('--fill', `${((input.value - o.min) / (o.max - o.min)) * 100}%`);
    paint();
    input.addEventListener('input', () => { paint(); row.querySelector('output').textContent = fmt(o, input.value); onChange(Number(input.value)); });
    row.appendChild(input);
    return row;
  }
  const row = el('div', 'row', `<span>${label}</span>`);
  const sel = el('select');
  for (const c of o.choices) sel.appendChild(new Option(c.label, c.value, false, c.value === value));
  sel.addEventListener('change', () => onChange(sel.value));
  row.appendChild(sel);
  return row;
}

// ---------- the gallery: every picture, one at a time, previous / next ----------
const galleryOf = (g) => (state.data[g.id]?.media || []).filter((m) => m.role === 'gallery' && (m.kind === 'image' || videoUrl(m)));
function renderGallery(g) {
  const shots = galleryOf(g);
  $('gallery').hidden = !shots.length;
  const frame = $('galleryFrame');
  if (!shots.length) { frame.innerHTML = ''; delete frame.dataset.src; return; }
  const i = (((state.shot[g.id] || 0) % shots.length) + shots.length) % shots.length;
  state.shot[g.id] = i;
  const m = shots[i];
  if (frame.dataset.src !== m.file) {
    frame.dataset.src = m.file;
    frame.innerHTML = m.kind === 'video'
      ? `<video src="${esc(videoUrl(m))}" muted loop autoplay playsinline aria-label="${esc(m.alt)}"></video>`
      : `<img src="${esc(m.file)}" alt="${esc(m.alt)}" draggable="false">`;
  }
  $('galleryCount').textContent = `${i + 1} / ${shots.length}`;
  $('galleryPrev').hidden = $('galleryNext').hidden = shots.length < 2;
}
function stepGallery(by) {
  const g = game();
  if (!g) return;
  state.shot[g.id] = (state.shot[g.id] || 0) + by;
  renderGallery(g);
}
$('galleryPrev').addEventListener('click', () => stepGallery(-1));
$('galleryNext').addEventListener('click', () => stepGallery(1));
$('gallery').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { stepGallery(-1); e.preventDefault(); }
  if (e.key === 'ArrowRight') { stepGallery(1); e.preventDefault(); }
});

function renderGame() {
  const g = game();
  if (!g) return;
  const page = $('game');
  const art = g.art || {};

  // Background: the diorama turntable (the data zip's, else an installed mod's)
  // over a blurred wash of the hero art (the data zip's, else Steam's).
  const hero = mediaOf(g, 'hero', 'image')?.file || art.hero || art.capsule;
  $('gameBg').style.backgroundImage = hero ? `url("${hero}")` : 'none';
  const video = $('gameVideo');
  const turntable = mediaOf(g, 'turntable', 'video');
  const clip = videoUrl(turntable) || g.video;
  page.classList.toggle('has-video', !!clip);
  if (clip) {
    if (video.dataset.src !== clip) { video.dataset.src = clip; video.src = clip; video.poster = turntable?.poster || ''; }
    video.onplaying = () => video.classList.add('on');
    video.play().catch(() => {});
  } else { video.removeAttribute('src'); video.classList.remove('on'); }

  $('gameLogo').hidden = !art.logo;
  if (art.logo) $('gameLogo').src = art.logo;
  $('gameName').hidden = !!art.logo;
  $('gameName').textContent = g.game;
  const t = info(g);
  $('gameLine').hidden = !t.line;
  $('gameLine').textContent = t.line || '';
  $('howtoBtn').hidden = !t.tutorial.length;
  $('needToKnow').hidden = !t.needToKnow.length;
  $('needList').innerHTML = t.needToKnow.map((n) => `<p>${esc(n)}</p>`).join('');
  $('firstLaunch').hidden = !t.firstLaunch;
  $('firstLaunchText').textContent = t.firstLaunch || '';
  renderGallery(g);
  $('gameBadges').innerHTML = badgesFor(g);

  const warns = [];
  const vc = state.pc?.checks.find((c) => c.id === 'vcredist' && c.status === 'bad');
  if (vc) warns.push(`<div class="warn bad"><b>Visual C++ runtime missing.</b> ${esc(vc.detail)}<br><button class="btn ghost" style="margin-top:10px;padding:7px 12px;font-size:12.5px" data-link="${esc(vc.link.url)}">${esc(vc.link.label)}</button></div>`);
  // From the testedBuildIds of the version Install would use (the engine works it out).
  if (g.buildTested === false) warns.push(`<div class="warn"><b>The game has been updated</b> since this mod was last tested (build ${esc(g.buildid)}). It will most likely still work; if it doesn't, uninstall here and the game is back to normal.</div>`);
  $('warnings').innerHTML = warns.join('');

  const box = $('options');
  box.innerHTML = '';
  // A mod's options come with its package: none yet, no heading.
  box.parentElement.hidden = !(g.options || []).length;
  for (const o of g.options || []) box.appendChild(optionRow(o, state.opts[g.id][o.id], (v) => { state.opts[g.id][o.id] = v; }));

  $('optDesktop').checked = state.settings.desktop ?? false;

  renderDetailsNote(g);
  renderVersion();
  renderIssues();
  renderInstallButton();
  renderPlay();
}

// Install / Reinstall / Update to <v> / Reinstall with <v>, for what the picker selects.
function renderInstallButton() {
  const g = view(game());
  const installed = isInstalled(g);
  const sel = selected(g);
  const same = sel && g.installedVersion === sel.version;
  const newer = sel && g.installedVersion && compareVersions(sel.version, g.installedVersion) > 0;
  $('uninstallBtn').hidden = !installed;
  $('installLabel').textContent = !installed ? `Install ${g.name}` : !g.installedVersion || same ? 'Reinstall' : newer ? `Update to ${sel.version}` : `Reinstall with ${sel.version}`;
  // An update is the thing to do next, so it stays a full button.
  $('installBtn').classList.toggle('reinstall', installed && !newer);
  $('installBtn').disabled = !sel;
}

// ---------- version: public releases, a file install, open betas ----------
const MB = (n) => (n / 1048576 < 10 ? (n / 1048576).toFixed(1) : Math.round(n / 1048576));
function releaseLabel(r) {
  return `${r.version} · ${maturityLabel(r.maturity)}`;
}

function renderVersion() {
  const g = view(game());
  const sel = selected(g);
  const rels = g.releases || [];
  $('versionSection').hidden = !sel && !rels.length && g.status !== 'coming' && !unavailable(g);
  if (!sel) {
    $('versionName').textContent = g.status === 'coming' ? comingText(g) : unavailable(g) ? 'Unavailable right now' : 'No version available';
    $('versionBadge').hidden = true;
    $('versionNote').textContent = g.status === 'coming' ? 'Nothing to install yet.'
      : unavailable(g) ? "The list of this mod's versions couldn't be read. It may be back after a restart, or once you're online."
        : 'No version of this mod works with this app yet.';
  } else {
    $('versionName').textContent = sel.version;
    $('versionBadge').hidden = !sel.maturity;
    $('versionBadge').className = `badge ${sel.maturity === 'stable' ? 'stable' : sel.maturity === 'open-beta' ? 'open' : 'beta'}`;
    $('versionBadge').textContent = maturityLabel(sel.maturity);
    const bits = [];
    if (sel.local) bits.push(g.source === 'dev' ? 'Dev build' : 'Loaded from a file');
    else if (g.recommended?.version === sel.version) bits.push('Recommended');
    if (sel.coreVersion) bits.push(`core ${sel.coreVersion}`);
    if (!sel.local && sel.size) bits.push(`${MB(sel.size)} MB download`);
    if (!sel.local && sel.date) bits.push(sel.date);
    if (isInstalled(g) && g.installedVersion === sel.version) bits.push('installed');
    else if (isInstalled(g) && g.installedVersion) bits.push(`${g.installedVersion} is installed now`);
    $('versionNote').textContent = bits.join(' · ') + (sel.notes ? `. ${sel.notes}` : '');
  }

  // The picker: every usable public release (newest first), plus the local version.
  const pick = $('versionPick');
  const options = [];
  if ((g.source === 'file' || g.source === 'dev') && g.active) options.push({ value: 'local', label: `${g.active.version} · ${g.source === 'dev' ? 'dev build' : `${maturityLabel(g.active.maturity)} (file)`}` });
  for (const r of rels) options.push({ value: r.version, label: releaseLabel(r) });
  pick.hidden = options.length < 2;
  pick.innerHTML = '';
  for (const o of options) pick.appendChild(new Option(o.label, o.value, false, sel && (o.value === 'local' ? sel.local : !sel.local && o.value === sel.version)));

  // Installed (or loaded) from a file: offer the newer public version, never switch by itself.
  const offer = g.source === 'file' && g.updateAvailable;
  $('publicOffer').hidden = !offer;
  if (offer) $('publicOfferText').textContent = `A newer public version is available: ${g.updateAvailable.version} (${maturityLabel(g.updateAvailable.maturity)}).`;

  // Only when there's a choice: a stable version and a newer open beta.
  const beta = g.betaOffer;
  $('betaRow').hidden = !beta;
  if (beta) $('betaText').textContent = `${beta.version} is an open beta, newer than the stable ${beta.stableVersion}. It may still have bugs.`;
  $('optBeta').checked = !!g.optInBeta;
}

$('versionPick').addEventListener('change', () => {
  state.pick[state.current] = $('versionPick').value;
  renderVersion();
  renderIssues();
  renderInstallButton();
});

$('optBeta').addEventListener('change', async () => {
  const id = state.current;
  const on = $('optBeta').checked;
  delete state.pick[id];
  try { await api.setBetaOptIn(id, on); } catch (e) { await ask("Couldn't change that", ipcError(e), [{ label: 'OK', value: true, primary: true }]); }
  await load();
  renderGame();
});

$('backToPublic').addEventListener('click', async () => {
  const g = game();
  if (state.test.file && g.id === testGame()?.id) { setToggle('From file', false); renderGrid(); renderGame(); return; }
  try {
    const r = await api.backToPublic(g.id);
    delete state.pick[g.id];
    await load();
    renderGame();
    toast(`${g.name} ${r.version} (${maturityLabel(r.maturity)}) is chosen. ${isInstalled(g) ? 'Reinstall' : 'Install'} to use it.`);
  } catch (e) {
    await ask("Couldn't switch to the public version", ipcError(e), [{ label: 'OK', value: true, primary: true }]);
  }
});

// ---------- known issues: for the installed version, else the selected one ----------
const SEVERITY = ['blocking', 'annoying', 'minor'];
function renderIssues() {
  const g = view(game());
  const list = [...info(g).knownIssues].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  $('issuesSection').hidden = !list.length;
  $('issuesList').innerHTML = list.map((k) => `<li class="issue ${SEVERITY.includes(k.severity) ? k.severity : 'minor'}">
    <span class="sev">${esc(k.severity === 'blocking' ? 'Blocking' : k.severity === 'annoying' ? 'Annoying' : 'Minor')}</span>
    <div><b>${esc(k.title)}</b><p>${esc(k.text)}</p></div></li>`).join('');
}

// ---------- home: announcement, newer installer, offline ----------
// Dev mode's "Banners": what a refresh could return.
const TEST_REMOTE = {
  offline: false,
  newerInstaller: { reason: 'app', latest: '0.3.0', url: 'https://dioramavr.app/download/' },
  announcements: [{ id: 'test-banner', title: 'Wave 1 is coming.', text: "Death's Door and Cataclismo are next, in closed beta on Patreon first.", link: 'https://dioramavr.app/' }],
};
function renderBanners() {
  const r = state.test.banners ? TEST_REMOTE : state.remote;
  const out = [];
  const ni = r.newerInstaller;
  if (ni) {
    const text = ni.reason === 'format'
      ? 'This DioramaVR installer is too old to read the mod list. Get the newer one to see new mods and updates.'
      : `A newer DioramaVR installer is available${ni.latest ? ` (${ni.latest})` : ''}.`;
    out.push(`<div class="banner update"><span>${esc(text)}</span>${ni.url ? `<button class="btn ghost" data-link="${esc(ni.url)}">Get it</button>` : ''}</div>`);
  }
  // The newest announcement that's showing (the engine has already filtered by date and version).
  const a = [...(r.announcements || [])].pop();
  if (a) {
    out.push(`<div class="banner note"><span><b>${esc(a.title)}</b> ${esc(a.text)}</span>${a.link ? `<button class="btn ghost" data-link="${esc(a.link)}">More</button>` : ''}
      <button class="banner-x" data-dismiss="${esc(a.id)}" title="Dismiss"><svg viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg></button></div>`);
  }
  $('banners').innerHTML = out.join('');
  const offline = state.test.offline || r.offline;
  $('listNote').hidden = !(offline || state.refreshing);
  $('listNote').textContent = state.refreshing && !offline ? 'Checking for new mods and updates…' : 'Offline: showing the last list';
}
$('banners').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-dismiss]');
  if (!x) return;
  const id = x.dataset.dismiss;
  if (state.test.banners) TEST_REMOTE.announcements = TEST_REMOTE.announcements.filter((a) => a.id !== id);
  else { state.remote.announcements = state.remote.announcements.filter((a) => a.id !== id); api.dismissAnnouncement(id); }
  renderBanners();
});

// ---------- loading a mod from a file ----------
// The Load button (file dialog) or .zip files dropped anywhere on the window.
// The engine checks each zip fully before it's used; nothing in a game changes
// until the player installs from the game's page.
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  t.classList.remove('in'); void t.offsetWidth; t.classList.add('in');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
const busy = () => !$('progressView').hidden;
const loadedText = (i) => `Loaded ${i.name} ${i.version}${i.maturityLabel ? ` (${i.maturityLabel})` : ''}`;

async function afterLoad(pending) {
  let r;
  try { r = await pending; } catch (e) { r = { results: [{ file: null, ok: false, error: ipcError(e) }] }; }
  if (r.canceled) return;
  const ok = r.results.filter((x) => x.ok);
  const bad = r.results.filter((x) => !x.ok);
  if (ok.length) {
    for (const x of ok) delete state.pick[x.info.id]; // the loaded file is what Install uses now
    await load();
    const last = ok[ok.length - 1].info;
    const g = state.games.find((x) => x.id === last.id);
    // Open its page; a game that isn't on this PC can't be installed, so stay on the gallery.
    if (g?.owned) openGame(g.id); else { state.current = null; show('home'); }
    toast(ok.map((x) => loadedText(x.info)).join(' · ') + (g && !g.owned ? `. ${g.game} isn't installed on this PC.` : ''));
  }
  if (bad.length) {
    const title = bad.length === 1 ? `Couldn't load ${bad[0].file || 'the mod'}` : `${bad.length} files couldn't be loaded`;
    const body = bad.length === 1 ? bad[0].error : bad.map((x) => `${x.file}: ${x.error}`).join('\n');
    await ask(title, body, [{ label: 'OK', value: true, primary: true }]);
  }
}

$('loadBtn').addEventListener('click', () => { if (!busy()) afterLoad(api.sideload()); });

// Drag and drop. Electron would otherwise open a dropped file as the page.
{
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const zone = $('dropZone');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; if (!busy()) zone.hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) zone.hidden = true; });
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) && !busy() ? 'copy' : 'none'; });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.hidden = true;
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length || busy()) return;
    afterLoad(api.sideloadFiles(files));
  });
}

$('optDesktop').addEventListener('change', () => { state.settings.desktop = $('optDesktop').checked; });

// ---------- modal ----------
function ask(title, body, buttons) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body;
    const box = $('modalActions');
    box.innerHTML = '';
    for (const b of buttons) {
      const btn = el('button', `btn ${b.primary ? 'primary' : 'link'}`, esc(b.label));
      btn.addEventListener('click', () => { $('modal').hidden = true; resolve(b.value); });
      box.appendChild(btn);
    }
    $('modal').hidden = false;
  });
}

// ---------- run ----------
// The ring only moves forward during a run (showProgress resets it): steps
// can arrive out of order, and Steam closing or starting again changes only
// the label, so the ring stays at 100% while Steam restarts at the end.
let ringAt = 0;
function setRing(pct, step) {
  if (pct != null) ringAt = Math.max(ringAt, pct);
  $('ringBar').style.strokeDashoffset = String(327 * (1 - ringAt / 100));
  $('ringPct').textContent = `${Math.round(ringAt)}%`;
  if (step != null) $('progressStep').textContent = step;
}

api.onProgress((p) => {
  if (!p.modId) {
    setRing(null, p.stage === 'closing-steam' ? 'Closing Steam so the library can be updated…' : 'Starting Steam again…');
    return;
  }
  // Download (the mod's zip, or UEVR) 0-40%, checking it, then copying 45-88%.
  if (p.stage === 'download') setRing(p.total ? (p.done / p.total) * 40 : null, `Downloading${p.what === 'uevr' ? ' UEVR' : ''} · ${MB(p.done)}${p.total ? ` / ${MB(p.total)}` : ''} MB`);
  else if (p.stage === 'verify') setRing(42, 'Checking the download');
  else if (p.stage === 'copy') setRing(45 + (p.done / p.total) * 43, `Copying files · ${p.done} / ${p.total}`);
  else if (p.stage === 'config') setRing(90, 'Writing your settings');
  else if (p.stage === 'removing') setRing(50, 'Removing');
  else if (p.stage === 'done') setRing(100, 'Done');
  else if (p.stage === 'error') setRing(100, p.error);
});

function showProgress(title) {
  $('progressTitle').textContent = title;
  ringAt = 0;
  setRing(0, '');
  $('progressView').hidden = false;
}

// Installing never touches Steam: the mod lives in the game folder, so starting
// the game as usual (headset connected) starts it in VR. Older installers added
// a "<Game> (VR)" entry to Steam; uninstalling removes it, which needs Steam
// closed (Steam only reads its library when it starts, and overwrites changes
// made while it runs). Reinstalling or updating leaves it as it is.
const STEAM_RESTART = 'Steam has to restart to take the "(VR)" entry out of your library. The app closes Steam and starts it again for you; there\'s nothing you need to do.';

async function runInstall() {
  const g = game();
  if (state.pc && !state.pc.vcRuntime) {
    const vc = state.pc.checks.find((c) => c.id === 'vcredist');
    const r = await ask('Visual C++ runtime missing', `${vc.detail} You can install the mod now, but it won't start until the runtime is there.`,
      [{ label: 'Install anyway', value: 'anyway' }, { label: 'Download from Microsoft', value: 'download', primary: true }]);
    if (r === 'download') { api.openLink(vc.link.url); return; }
  }
  // A public release is downloaded (version given); a local one (from a file, or a dev build) installs as it is.
  const sel = selected(g);
  if (!sel) return;
  const plan = {
    install: [{ modId: g.id, chosen: { ...state.opts[g.id] }, ...(sel.local ? {} : { version: sel.version }) }], uninstall: [],
    desktop: $('optDesktop').checked,
  };
  await api.setSettings({ opts: state.opts, desktop: plan.desktop });
  const updating = isInstalled(g) && g.installedVersion && compareVersions(sel.version, g.installedVersion) > 0;
  showProgress(`${updating ? 'Updating' : 'Installing'} ${g.name} ${sel.version}…`);
  let results;
  try { results = await api.run(plan); } catch (e) { results = [{ modId: g.id, ok: false, error: ipcError(e) }]; }
  await wait(600);
  delete state.pick[g.id];
  showDone(results[0], { mode: 'install', ...plan, version: sel.version });
}

async function runUninstall() {
  const g = game();
  const go = await ask(`Uninstall from ${g.game}?`, `The VR mod${g.steamShortcut ? ' and its Steam entry are' : ' is'} removed. BepInEx is removed too, unless other mods use it. Your saves are never touched.`,
    [{ label: 'Cancel', value: false }, { label: 'Uninstall', value: true, primary: true }]);
  if (!go) return;
  let closeSteam = false;
  if (g.steamShortcut && (await api.steamRunning())) {
    closeSteam = await ask('Steam needs to restart', STEAM_RESTART,
      [{ label: 'Cancel', value: null }, { label: 'Close & restart Steam', value: true, primary: true }]);
    if (closeSteam === null) return;
  }
  showProgress(`Uninstalling ${g.name}…`);
  let results;
  try { results = await api.run({ install: [], uninstall: [g.id], closeSteam }); } catch (e) { results = [{ modId: g.id, ok: false, error: ipcError(e) }]; }
  await wait(600);
  showDone(results[0], { mode: 'uninstall' });
}

function showDone(r, plan) {
  const g = game();
  $('progressView').hidden = true;
  const view = $('doneView');
  delete view.dataset.test;
  view.classList.toggle('failed', !r.ok);
  $('launchBtn').hidden = true;
  $('launchOr').hidden = true;
  readyCtx = null;
  $('doneLead').textContent = '';
  $('doneSteps').innerHTML = '';
  $('doneNotes').innerHTML = '';

  if (!r.ok) {
    $('doneTitle').textContent = "That didn't work";
    $('doneSub').textContent = '';
    $('doneNotes').innerHTML = `<div class="warn bad"><b>${esc(g.game)}:</b> ${esc(r.error)}</div>`;
  } else if (plan.mode === 'uninstall') {
    $('doneTitle').textContent = 'Removed';
    $('doneLead').textContent = `${g.game} is back to normal`;
    $('doneSub').textContent = r.keptLoader ? `BepInEx was left in place for your other mods (${(r.otherPlugins || []).join(', ') || 'it was there before'}). Saves weren't touched.` : "Your saves weren't touched.";
  } else {
    const name = `${g.game} (VR)`;
    $('doneTitle').textContent = 'Ready';
    $('doneLead').textContent = `Launch from ${plan.desktop ? 'your desktop' : 'here'}`;
    $('doneSub').textContent = `${g.name}${plan.version ? ` ${plan.version}` : ''} is installed.`;
    const start = plan.desktop ? `Double-click <b>${esc(name)}</b> on your desktop` : null;
    if (info(g).firstLaunch) $('doneNotes').innerHTML = `<div class="warn"><b>First start:</b> ${esc(info(g).firstLaunch)}</div>`;
    readyCtx = { start, canLaunch: !r.dryRun };
    renderReady();
  }
  if (r.ok && r.dryRun) {
    $('doneNotes').insertAdjacentHTML('afterbegin', '<div class="need"><b>Dry run</b>Nothing was installed, removed or changed. This is what it would look like.</div>');
  }
  view.hidden = false;
}

// ---------- launching: live SteamVR and headset checks ----------
// SteamVR running and a headset connected are read from this PC every couple of
// seconds (engine/vr.js). An installed game can be launched (from its page, its
// home card, or the Ready screen) only once both pass. If the headset can't be
// read, its row stays a plain reminder and Launch stays hidden.
const isInstalled = (g) => g.installed || (state.test.installed && g.owned);
const vrReady = () => state.vr.steamvr && state.vr.headset === true;
const testing = () => !!(state.test.vr || state.test.installed || $('doneView').dataset.test);
// Dev mode's screens use real game ids, so launching from them would start the real game.
function launchGame(id) { if (!testing()) api.launch(id); }

const stepRow = (done, html) => `<li class="${done ? 'done' : ''}"><span class="step-check">${done ? '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>' : ''}</span><span>${html}</span></li>`;
const vrRows = (vr) => [
  stepRow(vr.steamvr, vr.steamvr ? '<b>SteamVR</b> is running' : 'Start <b>SteamVR</b>'),
  vr.headset === null ? stepRow(false, 'Your <b>headset</b> is on and connected')
    : stepRow(vr.headset, vr.headset ? 'Your <b>headset</b> is connected' : 'Connect your <b>headset</b> (Link, Air Link or Steam Link)'),
];

// Ready screen: the two checks, then the library step; "or" + Launch now once ready.
let readyCtx = null; // { start: library-step html or null, canLaunch }
function renderReady() {
  const { start, canLaunch } = readyCtx;
  $('doneSteps').innerHTML = [...vrRows(state.vr), ...(start ? [stepRow(false, start)] : [])].join('');
  const ready = (canLaunch || testing()) && vrReady();
  $('launchOr').hidden = !ready || !start;
  $('launchBtn').hidden = !ready;
}

// Game page: checks and Launch, for installed games only.
function renderPlay() {
  const g = game();
  const installed = !!g && isInstalled(g);
  $('playChecks').hidden = !installed;
  if (installed) $('playChecks').innerHTML = vrRows(state.vr).join('');
  $('playBtn').hidden = !(installed && vrReady());
}

function onVr() {
  const ready = vrReady();
  document.querySelectorAll('.card[data-id]').forEach((c) => {
    const g = state.games.find((x) => x.id === c.dataset.id);
    c.classList.toggle('can-launch', !!g && isInstalled(g) && ready);
  });
  if (!$('game').hidden && state.current) renderPlay();
  if (readyCtx && !$('doneView').hidden) renderReady();
}
async function pollVr() {
  if (!document.hidden) {
    try { state.vr = state.test.vr || await api.vrStatus(); } catch { /* keep the last answer */ }
    onVr();
  }
  setTimeout(pollVr, 2000);
}

// ---------- how to play ----------
// The tutorial (the data zip's "tutorial": [{ title, text }]),
// all on one page in place of the game column, so it can be scanned and kept open.
function openHowto() {
  const g = game();
  $('howtoBackLabel').textContent = g.game;
  $('howtoBody').innerHTML = info(g).tutorial.map((t) => `<section class="howto-step">${t.title ? `<h2>${esc(t.title)}</h2>` : ''}${t.text ? `<p>${esc(t.text)}</p>` : ''}</section>`).join('');
  $('gameCol').hidden = true;
  $('howtoCol').hidden = false;
  $('howtoCol').querySelector('.game-scroll').scrollTop = 0;
}
const closeHowto = () => { $('howtoCol').hidden = true; $('gameCol').hidden = false; };
$('howtoBtn').addEventListener('click', openHowto);
$('howtoBack').addEventListener('click', closeHowto);

$('installBtn').addEventListener('click', runInstall);
$('uninstallBtn').addEventListener('click', runUninstall);
// On dev mode's Ready screen the button is only for show: it would start the real game.
$('launchBtn').addEventListener('click', () => launchGame(state.current));
$('playBtn').addEventListener('click', () => launchGame(state.current));
$('doneBack').addEventListener('click', async () => {
  readyCtx = null;
  $('doneView').hidden = true;
  await load();
  renderGame();
});
document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => api.window(b.dataset.win)));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('dropZone').hidden) { $('dropZone').hidden = true; return; }
  if (e.key === 'Escape' && !$('howtoCol').hidden && $('doneView').hidden) { closeHowto(); return; }
  if (e.key === 'Escape' && !$('guide').hidden) { show('home'); return; }
  if (e.key === 'Escape' && !$('credits').hidden) { show('home'); return; }
  if (e.key === 'Escape' && state.current && $('modal').hidden && $('doneView').hidden && $('progressView').hidden) $('backHome').click(); });

// ---------- dev mode: test navigation ----------
let setToggle = () => {};
// Ctrl+Shift+D turns it on or off (remembered), or start the app with --dev.
// Buttons in the title bar jump straight to every screen with sample content;
// nothing is installed or saved from them, and Launch is inert on their screens.
{
  const clearOverlays = () => { $('progressView').hidden = true; $('doneView').hidden = true; $('modal').hidden = true; $('dropZone').hidden = true; toggleAccountMenu(false); };
  const onGame = () => {
    const g = testGame();
    if (g && state.current !== g.id) openGame(g.id);
    else if (g) { closeHowto(); show('game'); }
    return game();
  };
  const ver = () => selected(game())?.version || '1.0.0';
  const screens = {
    Home: () => { state.current = null; show('home'); },
    Game: () => onGame(),
    'How to play': () => { onGame(); openHowto(); },
    Credits: () => openCredits(),
    'VR guide': () => { show('guide'); $('guide').querySelector('.home-scroll').scrollTop = 0; },
    // The ring through a download: the zip coming in, the check, then copying.
    Downloading: () => { const g = onGame(); showProgress(`Installing ${g.name} ${ver()}…`); setRing(26, `Downloading · ${MB(12.4 * 1048576)} / ${MB(19.1 * 1048576)} MB`); },
    Checking: () => { const g = onGame(); showProgress(`Installing ${g.name} ${ver()}…`); setRing(42, 'Checking the download'); },
    Progress: () => { const g = onGame(); showProgress(`Installing ${g.name} ${ver()}…`); setRing(70, 'Copying files · 74 / 120'); },
    Ready: () => { onGame(); showDone({ ok: true }, { mode: 'install', desktop: true, version: ver() }); $('doneView').dataset.test = '1'; onVr(); },
    Removed: () => { onGame(); showDone({ ok: true }, { mode: 'uninstall' }); },
    Failed: () => { onGame(); showDone({ ok: false, error: 'This file is damaged or has been changed. Download it again.' }, { mode: 'install' }); },
    Popup: () => { onGame(); ask('Steam needs to restart', STEAM_RESTART,
      [{ label: 'Cancel', value: null }, { label: 'Close & restart Steam', value: true, primary: true }]); },
    // Sideloading: the drop overlay, and a zip the engine refused.
    Drop: () => { state.current = null; show('home'); $('dropZone').hidden = false; },
    'Load failed': () => { state.current = null; show('home'); ask("Couldn't load tpm-vr-0.1.0.zip",
      "This file isn't signed by DioramaVR, so it can't be installed. Only use files from DioramaVR or its Patreon.", [{ label: 'OK', value: true, primary: true }]); },
  };
  // Toggles: SteamVR and a headset on; the first game installed; installed (or
  // loaded) from a closed-beta file, with a newer public version on offer; the
  // home banners; offline.
  const rerender = () => { renderGrid(); renderBanners(); if (state.current && !$('game').hidden) renderGame(); };
  const toggles = {
    'VR on': () => { state.test.vr = state.test.vr ? null : { steamvr: true, headset: true, hmd: 'test' }; if (state.test.vr) state.vr = state.test.vr; return !!state.test.vr; },
    Installed: () => { state.test.installed = !state.test.installed; rerender(); return state.test.installed; },
    'From file': () => { state.test.file = !state.test.file; delete state.pick[testGame()?.id]; rerender(); return state.test.file; },
    Banners: () => { state.test.banners = !state.test.banners; rerender(); return state.test.banners; },
    Offline: () => { state.test.offline = !state.test.offline; rerender(); return state.test.offline; },
  };
  const keys = { 'From file': 'file', Installed: 'installed', Banners: 'banners', Offline: 'offline' };
  // Turns a toggle off (or on) from elsewhere, e.g. "Use the public version" on a pretend file install.
  setToggle = (name, on) => {
    if (keys[name]) state.test[keys[name]] = on;
    document.querySelector(`[data-toggle="${name}"]`)?.classList.toggle('on', on);
  };
  const nav = $('testNav');
  nav.innerHTML = '<span>Dev</span>' + Object.keys(screens).map((k) => `<button data-screen="${esc(k)}">${esc(k)}</button>`).join('')
    + Object.keys(toggles).map((k) => `<button class="toggle" data-toggle="${esc(k)}">${esc(k)}</button>`).join('');
  nav.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (t) { t.classList.toggle('on', toggles[t.dataset.toggle]()); onVr(); return; }
    const b = e.target.closest('[data-screen]');
    if (!b) return;
    clearOverlays();
    screens[b.dataset.screen]();
  });

  const remembered = () => { try { return localStorage.getItem('dvr.dev') === '1'; } catch { return false; } };
  const setDev = (on) => {
    nav.hidden = !on;
    try { localStorage.setItem('dvr.dev', on ? '1' : '0'); } catch { /* not kept */ }
    if (on) return;
    // Off: drop every pretend state.
    state.test = { vr: null, installed: false, file: false, banners: false, offline: false };
    nav.querySelectorAll('.toggle').forEach((t) => t.classList.remove('on'));
    delete $('doneView').dataset.test;
    renderGrid();
    if (state.current && !$('game').hidden) renderGame();
    onVr();
  };
  nav.hidden = !(api.dev || remembered());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); setDev(nav.hidden); }
  });
}

// The gallery from what's known now, then again once the registry has been read.
load().then(() => refresh());
loadPc();
pollVr();
