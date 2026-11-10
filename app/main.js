// Electron main process: one frameless window, the engine behind IPC.
const { app, BrowserWindow, ipcMain, shell, protocol, net, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const engine = require('../engine');

protocol.registerSchemesAsPrivileged([{ scheme: 'art', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const saveSettings = (s) => fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));

// The renderer only gets art://app/<appid>/<kind> URLs, served from Steam's
// local library cache (or the mod's own folder for videos), and a game's
// cached data and media files (below); no other file is reachable. (A bare
// numeric host would be parsed as an IPv4 address.)
let statusCache = [];
function artUrl(appid, kind) { return `art://app/${appid}/${kind}`; }
// A file from a game's data zip (cached by the engine): art://data/<mod id>/media/<name>.
const dataUrl = (id, file) => (typeof file === 'string' && /^media\/[^/\\]+$/.test(file) ? `art://data/${id}/${file.split('/').map(encodeURIComponent).join('/')}` : null);
// A file of the index's assets list (cached by the engine): art://assets/<mod id>/<name>.
const assetUrl = (id, file) => (typeof file === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(file) ? `art://assets/${id}/${encodeURIComponent(file)}` : null);
const mediaUrls = (id, m, from) => {
  const url = from === 'assets' ? assetUrl : dataUrl;
  return m && { ...m, file: url(id, m.file), poster: url(id, m.poster), sources: (m.sources || []).map((f) => url(id, f)).filter(Boolean) };
};
const dataMedia = (id, m) => mediaUrls(id, m, 'data');

// "Closed beta" etc.; the engine owns the wording.
const maturityLabel = (m) => (m ? (engine.maturityLabel ? engine.maturityLabel(m) : m) : null);

function publicStatus() {
  statusCache = engine.status();
  return statusCache.map((s) => ({
    ...s,
    // Games the registry lists but this PC doesn't have may have no art.
    art: Object.fromEntries(Object.keys(s.art || {}).map((k) => [k, artUrl(s.appid, k)])),
    video: s.video && fs.existsSync(s.video) ? artUrl(s.appid, 'video') : null,
    hover: s.hover?.media ? mediaUrls(s.id, s.hover.media, s.hover.from) : null,
  }));
}

function createWindow() {
  // DVR_RECORD=dir: draw offscreen at 30 fps and save every frame (JPEG) plus
  // their times (times.json), to make a video of the app; works with the screen off.
  const record = process.env.DVR_RECORD;
  win = new BrowserWindow({
    width: record ? 1600 : 1320, height: record ? 1000 : 840, minWidth: 980, minHeight: 640,
    frame: false, backgroundColor: '#0b0b10', show: !!record, // an offscreen window is never on screen; shown, it animates from the start
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, offscreen: !!record,
      // DVR_MOCK=1: the renderer's mock.js data instead of the engine (UI work, screenshots).
      // --dev (or DVR_DEV=1) starts in dev mode, with the test navigation on.
      additionalArguments: [...(process.env.DVR_MOCK ? ['--dvr-mock'] : []), ...(process.argv.includes('--dev') || process.env.DVR_DEV ? ['--dvr-dev'] : [])],
    },
  });
  if (record) {
    fs.mkdirSync(record, { recursive: true });
    const times = [], t0 = Date.now();
    win.webContents.setFrameRate(30);
    win.webContents.on('paint', (_e, _dirty, image) => {
      times.push(Date.now() - t0);
      fs.writeFile(path.join(record, `f${String(times.length).padStart(5, '0')}.jpg`), image.toJPEG(92), () => {});
    });
    app.on('will-quit', () => fs.writeFileSync(path.join(record, 'times.json'), JSON.stringify(times)));
  }
  // DVR_DEMO=file.js: a module exporting async (win) => {} that drives the
  // window once it has loaded (a scripted walkthrough); the app quits after.
  if (process.env.DVR_DEMO) {
    win.webContents.once('did-finish-load', () => {
      require(path.resolve(process.env.DVR_DEMO))(win).catch((e) => console.error('demo:', e)).finally(() => setTimeout(() => app.quit(), 300));
    });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Running from source: edits to the renderer show up live. CSS swaps in
  // place (the page keeps its state); HTML/JS changes reload the page.
  if (!app.isPackaged) {
    let timer;
    fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, (_, file) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        if (/\.css$/.test(file || '')) win.webContents.executeJavaScript(`document.querySelectorAll('link[rel=stylesheet]').forEach((l) => { l.href = l.href.split('?')[0] + '?' + Date.now(); })`);
        else win.webContents.reloadIgnoringCache();
      }, 150);
    });
  }
  // A file dropped outside the renderer's drop handler must never replace the page.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/store\.steampowered\.com\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // DVR_SCREENSHOT=out.png [DVR_SCREENSHOT_JS=code]: capture and quit (docs/CI).
  if (process.env.DVR_SCREENSHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.DVR_SCREENSHOT_JS) {
        await win.webContents.executeJavaScript(process.env.DVR_SCREENSHOT_JS);
        await new Promise((r) => setTimeout(r, 1200));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.DVR_SCREENSHOT, img.toPNG());
      app.quit();
    });
  }
}

app.whenReady().then(() => {
  protocol.handle('art', (req) => {
    const u = new URL(req.url);
    let file;
    if (u.host === 'data') {
      // Only files the engine has cached for the game's current data hash.
      const [id, ...rest] = u.pathname.split('/').slice(1).map(decodeURIComponent);
      file = engine.gameDataFile ? engine.gameDataFile(id, rest.join('/')) : null;
    } else if (u.host === 'assets') {
      // Only files of the index's assets list, cached and of the right size.
      const [id, name, ...more] = u.pathname.split('/').slice(1).map(decodeURIComponent);
      file = !more.length && engine.gameAssetFile ? engine.gameAssetFile(id, name) : null;
    } else {
      const [appid, kind] = u.pathname.split('/').slice(1);
      const s = statusCache.find((x) => String(x.appid) === appid);
      file = kind === 'video' ? s?.video : s?.art?.[kind];
    }
    if (!file) return new Response('not found', { status: 404 });
    // Video players ask for byte ranges; without them the diorama clip reloads
    // from scratch (and stalls) every time it loops.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (!range) return net.fetch(pathToFileURL(file).toString());
    const size = fs.statSync(file).size;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!(start >= 0 && start <= end)) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const type = { '.webm': 'video/webm', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
    });
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

ipcMain.handle('status', () => publicStatus());
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_, s) => saveSettings({ ...loadSettings(), ...s }));
// Uninstall asks before closing Steam to remove an older install's "(VR)" entry.
ipcMain.handle('steam:running', () => engine.steam.steamRunning());
ipcMain.handle('open-store', (_, appid) => shell.openExternal(`https://store.steampowered.com/app/${Number(appid)}/`));
ipcMain.handle('preflight', () => engine.preflight.check());
// SteamVR running / headset connected, for the Ready screen's live checks.
// Polled every couple of seconds: Steam's folder is looked up once, and the check itself doesn't block.
let vrSteamDir = null;
ipcMain.handle('vr-status', () => {
  vrSteamDir ||= engine.steam.findSteam();
  return vrSteamDir ? engine.vr.status(vrSteamDir) : { steamvr: false, headset: false, hmd: null };
});
// Only links the engine itself hands out: Steam store pages, Microsoft's VC++
// download, and the https links in the last verified registry (the newer
// installer, announcements), and the https links in credits.json.
let remoteLinks = new Set();
ipcMain.handle('open-link', (_, url) => {
  if (url === engine.preflight.VCREDIST_URL || /^https:\/\/store\.steampowered\.com\/app\/\d+\/$/.test(url)
    || ((remoteLinks.has(url) || credits().links.has(url)) && /^https:\/\//.test(url))) shell.openExternal(url);
});

// ---------- About / Credits ----------
// credits.json at the repo root (packaged with the app): only its plain-text
// fields go to the renderer, and only https links, which open-link then allows.
let creditsCache = null;
function credits() {
  if (creditsCache) return creditsCache;
  const str = (v) => (typeof v === 'string' ? v : null);
  const link = (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : null);
  const links = new Set();
  let doc = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'credits.json'), 'utf8'));
    const list = (Array.isArray(raw?.credits) ? raw.credits : []).filter((c) => str(c?.name)).map((c) => ({
      name: c.name, for: str(c.for), license: str(c.license), url: link(c.url), highlight: c.highlight === true, notice: str(c.notice),
      support: (Array.isArray(c.support) ? c.support : []).map((s) => ({ label: str(s?.label), url: link(s?.url) })).filter((s) => s.label && s.url),
    }));
    for (const c of list) for (const u of [c.url, ...c.support.map((s) => s.url)]) if (u) links.add(u);
    doc = { title: str(raw.title) || 'Credits', intro: str(raw.intro), credits: list, notices: str(raw.notices), disclaimer: str(raw.disclaimer) };
  } catch (e) {
    console.warn('credits.json:', e.message);
  }
  return (creditsCache = { doc, links });
}
ipcMain.handle('credits', () => credits().doc);
ipcMain.handle('win', (_, a) => { if (a === 'min') win.minimize(); else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize(); else win.close(); });

// ---------- sideloading a mod zip (vr-iwc.3) ----------
// Only zips the player picked in the open dialog, or dropped on the window, are
// loaded: preload turns dropped File objects into paths (webUtils), and the
// renderer can't hand over a path of its own. Each file gets its own result, so
// one bad zip in a drop doesn't stop the others.
const needEngine = (fn) => { if (typeof engine[fn] !== 'function') throw new Error('This build of the app can\'t load mod files yet.'); };
async function sideloadOne(file) {
  const name = path.basename(file);
  try {
    if (!/\.zip$/i.test(file)) throw new Error('This isn\'t a .zip file. DioramaVR mods come as a .zip.');
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error('The file isn\'t there any more.');
    needEngine('sideload');
    const info = await engine.sideload(file); // sync or async, either works
    return { file: name, ok: true, info: { ...info, maturityLabel: maturityLabel(info.maturity) } };
  } catch (e) {
    return { file: name, ok: false, error: e.message };
  }
}
ipcMain.handle('sideload:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Load a DioramaVR mod', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'DioramaVR mod', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true, results: [] };
  return { canceled: false, results: await loadAll(r.filePaths) };
});
ipcMain.handle('sideload:files', async (_, paths) => {
  // Only preload calls this, with paths it got from dropped File objects (the
  // renderer has no way to send a string here); still, absolute paths only.
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && path.isAbsolute(p))) throw new Error('Nothing to load');
  return { canceled: false, results: await loadAll(paths) };
});
// One at a time: they unpack into the same cache.
async function loadAll(paths) {
  const results = [];
  for (const p of paths) results.push(await sideloadOne(p));
  return results;
}
// ---------- downloads (vr-iwc.2) ----------
// The registry and game indexes: read (or taken from the cache) by the engine,
// which keeps the result for status(). Never throws for a network problem.
ipcMain.handle('refresh', async (_, opts = {}) => {
  needEngine('refresh');
  const r = await engine.refresh({ force: !!opts.force });
  const ni = r?.newerInstaller;
  remoteLinks = new Set([ni?.url, ni?.release?.url, ...(r?.announcements || []).map((a) => a.link)].filter((u) => typeof u === 'string'));
  return { offline: !!r?.offline, newerInstaller: ni || null, announcements: r?.announcements || [], errors: r?.errors || [] };
});
// A game's data zip (line, first launch, need to know, tutorial, known issues,
// media), fetched by the engine once per index hash when the page opens.
// null: none, or it couldn't be had (the page shows the index alone).
ipcMain.handle('game-data', async (_, modId) => {
  if (typeof engine.gameData !== 'function') return null;
  const id = String(modId);
  try {
    const d = await engine.gameData(id);
    return d ? { ...d, media: (d.media || []).map((m) => mediaUrls(id, m, d.mediaFrom)).filter((m) => m.file) } : null;
  } catch (e) {
    console.warn(`data for ${id}:`, e.message);
    return null;
  }
});
// Back from a file install to the public release the engine recommends.
ipcMain.handle('back-to-public', (_, modId) => { needEngine('backToPublic'); return engine.backToPublic(String(modId)); });
ipcMain.handle('set-beta-opt-in', (_, modId, on) => { needEngine('setBetaOptIn'); return engine.setBetaOptIn(String(modId), !!on); });
ipcMain.handle('dismiss-announcement', (_, id) => { needEngine('dismissAnnouncement'); return engine.dismissAnnouncement(String(id)); });

ipcMain.handle('launch', (_, modId) => {
  const s = engine.status().find((x) => x.id === modId);
  if (!s?.gameDir) throw new Error('Game not found');
  const l = engine.launchCommand(modId, s.gameDir);
  spawn(l.exe, l.argv, { cwd: l.cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
});

async function dryRun(plan) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  for (const modId of plan.uninstall) {
    send('progress', { modId, stage: 'removing' });
    await pause(1200);
    send('progress', { modId, stage: 'done' });
    results.push({ modId, action: 'uninstall', ok: true, dryRun: true });
  }
  for (const { modId, version } of plan.install) {
    if (version) {
      // The release's real size (from the index), nothing downloaded.
      const size = statusCache.find((s) => s.id === modId)?.releases?.find((r) => r.version === version)?.size || 19.1 * 1048576;
      for (let done = 0; done <= size; done += size / 25) { send('progress', { modId, stage: 'download', done: Math.round(done), total: Math.round(size) }); await pause(60); }
      send('progress', { modId, stage: 'verify' });
      await pause(500);
    }
    const total = 120;
    for (let done = 0; done <= total; done += 4) { send('progress', { modId, stage: 'copy', done, total }); await pause(60); }
    send('progress', { modId, stage: 'config' });
    await pause(400);
    send('progress', { modId, stage: 'done' });
    results.push({ modId, action: 'install', ok: true, dryRun: true });
  }
  return results;
}

// plan: { install: [{ modId, chosen, version }], uninstall: [modId], desktop: bool, closeSteam: bool }
// Install never touches Steam. Uninstall removes the "(VR)" Steam entry an
// older installer added (the manifest's steamShortcut), which needs Steam
// closed: closeSteam says the player agreed to close and restart it.
ipcMain.handle('run', async (_, plan) => {
  // DVR_DRY_RUN=1: the real Steam, games and accounts are shown, but nothing is changed.
  // The progress screens play through as if it ran, then report that it didn't.
  if (process.env.DVR_DRY_RUN) return dryRun(plan);
  const steamDir = engine.steam.findSteam();
  const results = [];
  const status = engine.status();
  const removing = plan.uninstall.some((id) => status.find((s) => s.id === id)?.steamShortcut);
  let restartSteam = false;
  const step = (modId, stage, extra = {}) => send('progress', { modId, stage, ...extra });

  if (removing && engine.steam.steamRunning()) {
    if (!plan.closeSteam) throw new Error('Steam is running');
    step(null, 'closing-steam');
    if (!(await engine.steam.closeSteam(steamDir))) throw new Error("Steam didn't close. Close it yourself and try again.");
    restartSteam = true;
  }

  for (const modId of plan.uninstall) {
    const s = status.find((x) => x.id === modId);
    try {
      step(modId, 'removing');
      if (s.steamShortcut) engine.removeSteamEntry({ modId, accountId: s.steamShortcut.accountId, appid: s.steamShortcut.appid });
      const r = engine.uninstall({ modId, gameDir: s.gameDir });
      step(modId, 'done');
      results.push({ modId, action: 'uninstall', ok: true, keptLoader: r.keptLoader, otherPlugins: r.otherPlugins });
    } catch (e) { step(modId, 'error', { error: e.message }); results.push({ modId, action: 'uninstall', ok: false, error: e.message }); }
  }

  for (const { modId, chosen, version } of plan.install) {
    const s = status.find((x) => x.id === modId);
    try {
      const onProgress = (p) => step(modId, p.step, p);
      // A version: a public release, downloaded (or from the package cache) and
      // checked first. None: the active package as it is (loaded from a file, or a dev build).
      if (version) {
        needEngine('installRelease');
        await engine.installRelease({ modId, version: String(version), gameDir: s.gameDir, chosen, onProgress });
      } else {
        await engine.install({ modId, gameDir: s.gameDir, chosen, onProgress });
      }
      if (plan.desktop) engine.addDesktopEntry({ modId, gameDir: s.gameDir });
      step(modId, 'done');
      results.push({ modId, action: 'install', ok: true });
    } catch (e) { step(modId, 'error', { error: e.message }); results.push({ modId, action: 'install', ok: false, error: e.message }); }
  }

  if (restartSteam) { step(null, 'starting-steam'); engine.steam.startSteam(steamDir); }
  return results;
});
