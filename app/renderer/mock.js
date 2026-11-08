// Stand-in for preload.js when index.html is opened in a plain browser (or
// DVR_MOCK=1), so the UI can be designed and screenshotted without Electron or
// the network. Never used by the app. It plays the engine's part (engine.status,
// refresh, installRelease, backToPublic, ...) on made-up data:
// - Two Point Museum: owned, public releases (1.1.0 open beta,
//   1.0.0 and 0.9.0 stable), known issues. Loading any .zip without "bad" in its
//   name loads it as 0.1.0, closed beta, from a file.
// - Timberborn: owned, installed 1.0.0, 1.1.0 out (an update); no wave.
// - Death's Door: not owned, coming, in closed beta on Patreon (Wave 1).
// - Cataclismo: owned, coming (Wave 1).
// - Risk of Rain 2: listed, but its index couldn't be read (unavailable).
// Two Point Museum's options come with its package (once it's installed); its
// line, notes, tutorial and media with its data zip (gameData, on opening its page).
if (!window.dvr) {
  const art = (appid, files) => Object.fromEntries(Object.entries(files).map(([k, f]) =>
    [k, `file:///C:/Program%20Files%20(x86)/Steam/appcache/librarycache/${appid}/${f}`]));
  const shared = [
    { id: 'leftHanded', label: 'Left-handed', help: 'Point and click with the left controller.', type: 'bool', default: false, shared: true },
    { id: 'eyeResolution', label: 'Eye resolution', help: 'Lower it if the headset view stutters.', type: 'number', default: 1, min: 0.5, max: 1.5, step: 0.05, unit: '%', scale: 100, shared: true },
  ];
  const MB = 1048576;
  const rel = (version, maturity, extra = {}) => ({ version, maturity, date: '2026-11-20', coreVersion: '0.1.1', size: Math.round(19.1 * MB), tested: false, notes: null, ...extra });
  const waves = { test: { id: 'test', name: 'Test wave' }, 1: { id: '1', name: 'Wave 1' } };
  const games = [
    { id: 'tpm-vr', name: 'Two Point Museum VR', game: 'Two Point Museum', appid: 2185060, owned: true, installed: false, buildid: '26287332',
      wave: waves.test, status: 'stable', closedBeta: false, optInBeta: false, source: 'download', active: null, installedVersion: null,
      all: [rel('1.1.0', 'open-beta', { date: '2026-12-02', notes: 'Smoother table turning.' }), rel('1.0.0', 'stable', { tested: true }), rel('0.9.0', 'stable', { coreVersion: '0.1.0', date: '2026-11-12', tested: true })],
      knownIssues: [
        { id: 'crate-cinema', title: 'Crate openings show on a flat screen', severity: 'minor', text: 'Opening an expedition crate and other scenes away from the museum show on a big flat screen instead of the table. The table comes back when you return to the museum.' },
        { id: 'window-clicks', title: 'Split window modes are still being tested', severity: 'annoying', text: "Clicks in the Arranged and Free window modes haven't been fully tested. If a button doesn't respond, switch to Panel on the VR menu's Game UI page." },
        { id: 'save-thumbnails', title: 'Save pictures can come out blank', severity: 'minor', text: 'A museum saved while in VR may show a plain dark picture on the level select card. The save itself is fine.' },
      ],
      firstLaunch: 'It takes a few minutes, with a blank window, while BepInEx reads the game. It needs the internet that first time. Keep your VPN off.',
      art: art(2185060, { capsule: 'library_600x900.jpg', hero: 'library_hero.jpg', logo: 'logo.png' }),
      needToKnow: ["The game's camera tutorial asks you to tilt the camera: click the right stick. The table itself doesn't tilt, so lean or move your head to see it from another angle."],
      tutorial: [{ title: 'Getting started', text: 'Load a save as usual. The museum appears as a diorama on a table in front of you.', controls: [] },
        { title: 'Move the table', text: 'Reach out and grab it.', controls: [['Either grip', 'Move the table'], ['Both grips', 'Scale and turn it'], ['Left stick up / down', 'Zoom']] }],
      video: new URL('../../mods/tpm-vr/hover.webm', location.href).href,
      options: [...shared, { id: 'desktopView', label: 'Keep the monitor view', help: "Draw the game on the monitor too while you're in VR. Costs frame rate.", type: 'bool', default: false }] },
    { id: 'timberborn-vr', name: 'Timberborn VR', game: 'Timberborn', appid: 1062090, owned: true, installed: true, buildid: '1999', steamShortcut: {},
      wave: null, status: 'stable', closedBeta: false, optInBeta: false, source: 'download', active: null, installedVersion: '1.0.0', installedMaturity: 'stable',
      all: [rel('1.1.0', 'stable', { tested: true, notes: 'The VR menu draws again.' }), rel('1.0.0', 'stable')], knownIssues: [],
      art: art(1062090, { capsule: 'e1e203d598f5a7d5fb77c9d3994e7d6cd5998d00/library_capsule.jpg', hero: '37cf8d9c5e04102133140edf4dd2aaa46cbf15c7/library_hero.jpg' }), options: shared.slice(0, 1) },
    { id: 'deathsdoor-vr', name: "Death's Door VR", game: "Death's Door", appid: 894020, owned: false, installed: false,
      wave: waves[1], status: 'coming', closedBeta: true, optInBeta: false, source: null, active: null, all: [], knownIssues: [],
      art: art(894020, { capsule: 'library_600x900.jpg', hero: 'library_hero.jpg' }), options: [] },
    { id: 'ror2-vr', name: 'Risk of Rain 2 VR', game: 'Risk of Rain 2', appid: 4243, owned: false, installed: false,
      wave: null, status: 'stable', unavailable: true, closedBeta: false, optInBeta: false, source: null, active: null, all: [], knownIssues: [], art: {}, options: [] },
    { id: 'cataclismo-vr', name: 'Cataclismo VR', game: 'Cataclismo', appid: 4242, owned: true, installed: false,
      wave: waves[1], status: 'coming', closedBeta: false, optInBeta: false, source: null, active: null, all: [], knownIssues: [], art: {}, options: [] },
  ];
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1; return 0; };
  const pickOf = (r) => (r ? { version: r.version, maturity: r.maturity } : null);
  // What the engine works out from the index, the opt-in and the Steam build.
  function derive(g) {
    g.releases = g.all.filter((r) => r.maturity === 'stable' || g.optInBeta);
    const rec = g.releases.find((r) => r.tested) || g.releases[0] || null;
    g.recommended = pickOf(rec);
    const base = g.source === 'file' ? g.active?.version : g.installedVersion;
    g.updateAvailable = base && g.releases[0] && cmp(g.releases[0].version, base) > 0 ? pickOf(g.releases[0]) : null;
    const v = g.installedVersion || g.active?.version || g.recommended?.version;
    g.buildTested = !v || !!g.all.find((r) => r.version === v)?.tested || g.source === 'file';
    return g;
  }
  games.forEach(derive);
  const find = (id) => games.find((g) => g.id === id);

  const loadOne = (name) => {
    if (!/\.zip$/i.test(name)) return { file: name, ok: false, error: "This isn't a .zip file. DioramaVR mods come as a .zip." };
    if (/bad/i.test(name)) return { file: name, ok: false, error: 'This file is damaged or has been changed. Download it again.' };
    if (/unsigned/i.test(name)) return { file: name, ok: false, error: "This file isn't signed by DioramaVR, so it can't be installed. Only use files from DioramaVR or its Patreon." };
    const g = find('tpm-vr');
    Object.assign(g, { source: 'file', active: { version: '0.1.0', maturity: 'closed-beta', coreVersion: '0.1.1' } });
    derive(g);
    return { file: name, ok: true, info: { id: g.id, version: '0.1.0', maturity: 'closed-beta', maturityLabel: 'Closed beta', name: g.name, game: g.game, appid: g.appid } };
  };
  let progress = () => {};
  const wait = (ms) => new Promise((r) => setTimeout(r, ms * (window.MOCK_FAST ? 0.05 : 1)));
  // Without a package on this PC, only what the index says (no options, tutorial or notes).
  const DETAILS = ['firstLaunch', 'needToKnow', 'tutorial', 'options', 'video'];
  const out = (g) => {
    const { all, ...rest } = g;
    if (!g.active && !g.installed) for (const k of DETAILS) rest[k] = k === 'options' || k === 'needToKnow' ? [] : null;
    return rest;
  };
  window.dvr = {
    // The registry as read: online, nothing to announce (dev mode's Banners toggle shows those).
    refresh: async () => { await wait(400); return { offline: false, newerInstaller: null, announcements: [], errors: [] }; },
    status: async () => games.map(out),
    // Two Point Museum's data zip (the engine fetches it when the page opens).
    gameData: async (id) => {
      await wait(700);
      const g = find(id);
      if (id !== 'tpm-vr') return null;
      const hero = { file: g.art.hero, kind: 'image', role: 'hero', alt: '' };
      const clip = { file: new URL('../../mods/tpm-vr/hover.webm', location.href).href, kind: 'video', alt: '', poster: null, sources: [] };
      return { id, line: 'Your museum as a living model in front of you.', firstLaunch: g.firstLaunch, needToKnow: g.needToKnow,
        tutorial: g.tutorial.map((t) => ({ title: t.title, text: t.text })), knownIssues: g.knownIssues,
        media: [hero, { ...clip, role: 'turntable' }, { ...clip, role: 'hover' }, { file: g.art.capsule, kind: 'image', role: 'gallery', alt: 'A capsule.' }] };
    },
    sideload: async () => ({ canceled: false, results: [loadOne('tpm-vr-0.1.0.zip')] }),
    sideloadFiles: async (files) => ({ canceled: false, results: Array.from(files, (f) => loadOne(f.name)) }),
    backToPublic: async (id) => { const g = find(id); Object.assign(g, { source: 'download', active: g.recommended ? { ...g.recommended, coreVersion: '0.1.1' } : null }); derive(g); return g.recommended; },
    setBetaOptIn: async (id, on) => { find(id).optInBeta = !!on; derive(find(id)); },
    dismissAnnouncement: async () => {},
    // SteamVR comes on after a moment, then the headset.
    vrStatus: (() => { const t0 = Date.now(); return async () => ({ steamvr: Date.now() - t0 > 3000, headset: Date.now() - t0 > 6000, hmd: null }); })(),
    accounts: async () => [{ id: '111', persona: 'Main account', mostRecent: true }, { id: '222', persona: 'Second account' }],
    getSettings: async () => ({}),
    setSettings: async () => {},
    steamRunning: async () => true,
    openStore: async (id) => console.log('store', id),
    openLink: async (url) => console.log('link', url),
    // The real file, read the way the renderer reads its own files.
    credits: async () => { try { return await (await fetch('../../credits.json')).json(); } catch { return null; } },
    // The first tester's laptop: hybrid graphics, unplugged.
    preflight: async () => {
      await wait(900);
      return { status: 'warn', vcRuntime: true, checks: [
        { id: 'gpu', title: 'Graphics card', status: 'ok', summary: 'NVIDIA GeForce RTX 4060 Laptop GPU' },
        { id: 'steamvr', title: 'SteamVR', status: 'ok', summary: 'Installed' },
        { id: 'vcredist', title: 'Visual C++ runtime', status: 'ok', summary: 'Installed (v14.40.33810.00)' },
        { id: 'power', title: 'Power', status: 'warn', summary: 'On battery (64%)', detail: 'Plug the laptop in before playing. On battery, Windows slows the graphics card right down.' },
        { id: 'hybrid', title: 'Laptop graphics', status: 'info', summary: 'Two graphics chips (Intel(R) UHD Graphics + NVIDIA GeForce RTX 4060 Laptop GPU)', detail: 'So the game uses the fast one: Windows Settings > System > Display > Graphics. Add the game\'s exe (e.g. TPM.exe) and SteamVR\'s vrserver.exe and vrcompositor.exe (in Steam\\steamapps\\common\\SteamVR\\bin\\win64), and set each to "High performance".' },
        { id: 'memory', title: 'Memory', status: 'ok', summary: '16 GB RAM' },
      ] };
    },
    launch: async () => {},
    window: async () => {},
    onProgress: (fn) => { progress = fn; },
    run: async (plan) => {
      if (plan.closeSteam) { progress({ stage: 'closing-steam' }); await wait(800); }
      for (const { modId, version } of plan.install) {
        const g = find(modId);
        const r = version && g.all.find((x) => x.version === version);
        if (r) {
          for (let d = 0; d <= r.size; d += r.size / 20) { progress({ modId, stage: 'download', done: Math.round(d), total: r.size }); await wait(90); }
          progress({ modId, stage: 'verify' }); await wait(500);
        }
        for (let d = 0; d <= 302; d += 25) { progress({ modId, stage: 'copy', done: Math.min(d, 302), total: 302 }); await wait(120); }
        progress({ modId, stage: 'config' }); await wait(300);
        if (plan.steam) { progress({ modId, stage: 'steam' }); await wait(300); }
        progress({ modId, stage: 'done' });
        if (r) Object.assign(g, { source: 'download', active: { version: r.version, maturity: r.maturity, coreVersion: r.coreVersion } });
        Object.assign(g, { installed: true, installedVersion: g.active?.version || version, installedMaturity: g.active?.maturity });
        derive(g);
      }
      for (const modId of plan.uninstall) {
        progress({ modId, stage: 'removing' }); await wait(400); progress({ modId, stage: 'done' });
        Object.assign(find(modId), { installed: false, installedVersion: null }); derive(find(modId));
      }
      return [...plan.install.map((p) => ({ modId: p.modId, ok: true })), ...plan.uninstall.map((m) => ({ modId: m, ok: true }))];
    },
  };
}
