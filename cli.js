#!/usr/bin/env node
// node cli.js refresh          (fetch the list of mods: the registry and each game's index)
// node cli.js list
// node cli.js releases <mod>   (the releases you can install, and the recommended one)
// node cli.js check            (can this PC run it?)
// node cli.js accounts
// node cli.js install <mod> [--version V] [--game-dir DIR] [--set key=value ...]
//                           [--steam-account ID] [--desktop] [--local]
//     downloads the release (default: the recommended one) and installs it;
//     --local installs the active version on this PC instead (a loaded file, a dev build)
// node cli.js uninstall <mod> [--game-dir DIR]
// node cli.js shortcut add|remove <mod> --steam-account ID [--game-dir DIR]
// node cli.js sideload <zip>             (load a mod file, e.g. a closed beta; it becomes active)
// node cli.js versions <mod> [--game-dir DIR]   (the versions on this PC)
// node cli.js use <mod> <version|dev>    (reinstall to apply it to the game)
// node cli.js public <mod>               (back to the public release after a file)
// node cli.js betas <mod> on|off         (include open betas for this game)
//
// Every command but check and accounts reads the list of mods first (cached;
// it works offline from the last good copy). Steam shortcut changes need Steam
// closed; pass --close-steam to have the CLI close it and start it again afterwards.
const engine = require('./engine');

function parseArgs(argv) {
  const pos = [];
  const flags = { set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--set') {
      const [k, ...v] = argv[++i].split('=');
      flags.set[k] = v.join('=');
    } else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      flags[key] = next && !next.startsWith('--') ? (i++, next) : true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const entry = (modId) => {
  const s = engine.status().find((x) => x.id === modId || x.appid === Number(modId));
  if (!s) throw new Error(`No mod "${modId}". Known: ${engine.status().map((x) => x.id).join(', ')}`);
  return s;
};

function gameDirFor(modId, flags) {
  if (flags.gameDir) return flags.gameDir;
  const st = entry(modId);
  if (!st.gameDir) throw new Error(`${st.game} isn't installed through Steam here. Pass --game-dir.`);
  return st.gameDir;
}

const label = (maturity, source) => (source === 'dev' ? 'dev build' : engine.maturityLabel(maturity) || maturity || '');
// "1.0.0 (Stable)", "0.1.0 (Closed beta, from a file)" or "2026.11.01 (dev build)".
const versionText = (s) => {
  if (!s.version) return 'no version on this PC';
  const from = s.source === 'file' ? ', from a file' : s.active?.pending ? ', downloads at install' : '';
  return `${s.version} (${label(s.maturity, s.source)}${from})`;
};
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function withSteamClosed(flags, fn) {
  const steamDir = engine.steam.findSteam();
  const wasRunning = engine.steam.steamRunning();
  if (wasRunning) {
    if (!flags.closeSteam) throw new Error('Steam is running. Close it, or pass --close-steam.');
    console.log('Closing Steam...');
    if (!(await engine.steam.closeSteam(steamDir))) throw new Error("Steam didn't close in time.");
  }
  try { return fn(); } finally {
    if (wasRunning) { console.log('Starting Steam again.'); engine.steam.startSteam(steamDir); }
  }
}

const commands = {
  async refresh() {
    const r = await engine.refresh({ force: true });
    const games = engine.status();
    console.log(r.offline ? 'Offline: using the last list of mods.' : 'Fetched the list of mods.');
    console.log(`${games.filter((g) => g.status).length} games listed, ${games.filter((g) => g.releases.length).length} with releases you can install.`);
    if (r.newerInstaller) console.log(`A newer DioramaVR installer is available${r.newerInstaller.latest ? ` (${r.newerInstaller.latest})` : ''}${r.newerInstaller.url ? `: ${r.newerInstaller.url}` : ''}.`);
    for (const a of r.announcements) console.log(`Note: ${a.title}: ${a.text}${a.link ? ` (${a.link})` : ''}`);
    for (const e of r.errors) console.log(`  (${e.what}: ${e.error})`);
  },

  list() {
    const steamDir = engine.steam.findSteam();
    console.log(`Steam: ${steamDir || 'not found'}`);
    for (const s of engine.status()) {
      const state = s.status === 'coming' ? `coming${s.closedBeta ? ' (in closed beta on Patreon)' : ''}`
        : !s.owned ? 'not installed in Steam'
          : s.installed ? `mod installed (${s.installedVersion || 'unknown version'}${s.installedSource === 'file' ? ', from a file' : ''})`
            : s.recommended || s.payloadReady ? 'ready to install' : 'nothing to install yet';
      console.log(`\n${s.id}  ${s.name}${s.wave ? `  [${s.wave.name}]` : ''}`);
      console.log(`  game:  ${s.game} (appid ${s.appid})${s.gameDir ? ` at ${s.gameDir}` : ''}`);
      console.log(`  using: ${versionText(s)}`);
      if (s.recommended) console.log(`  latest: ${s.recommended.version} (${label(s.recommended.maturity)})${s.optInBeta ? '  (open betas included)' : ''}`);
      if (s.updateAvailable) console.log(`  update: ${s.updateAvailable.version} is available${s.installedSource === 'file' ? ' (a newer public version: node cli.js public ' + s.id + ')' : ''}`);
      if (s.owned) console.log(`  build: ${s.buildid || '?'}${s.buildTested ? '' : '  (game updated since the mod was tested)'}`);
      console.log(`  state: ${state}`);
      for (const k of s.knownIssues) console.log(`  issue: [${k.severity}] ${k.title}`);
      if (s.steamShortcut) console.log(`  steam: "${s.steamShortcut.name}" in account ${s.steamShortcut.accountId}`);
    }
  },

  releases([modId]) {
    if (!modId) throw new Error('Pass the mod: node cli.js releases <mod>');
    const s = entry(modId);
    if (!s.releases.length) {
      console.log(s.status === 'coming' ? `${s.name} is coming${s.closedBeta ? ' (in closed beta on Patreon)' : ''}.` : `No releases of ${s.name} to install${s.optInBeta ? '' : ' (open betas are off: node cli.js betas ' + s.id + ' on)'}.`);
      return;
    }
    for (const r of s.releases) {
      const marks = [s.recommended?.version === r.version && 'recommended', s.installedVersion === r.version && 'installed', r.tested && 'tested on your game build'].filter(Boolean);
      console.log(`${s.recommended?.version === r.version ? '*' : ' '} ${r.version.padEnd(10)} ${label(r.maturity).padEnd(11)} ${r.date || ''}  ${mb(r.size)}${r.coreVersion ? `  core ${r.coreVersion}` : ''}${marks.length ? `  (${marks.join(', ')})` : ''}`);
      if (r.notes) console.log(`    ${r.notes}`);
    }
  },

  async check() {
    const r = await engine.preflight.check();
    const mark = { ok: 'OK  ', warn: 'WARN', bad: 'FAIL', info: 'TIP ' };
    for (const c of r.checks) {
      console.log(`${mark[c.status]}  ${c.title}: ${c.summary}`);
      if (c.detail && c.status !== 'ok') console.log(`      ${c.detail}`);
      if (c.link) console.log(`      ${c.link.url}`);
    }
  },

  accounts() {
    const steamDir = engine.steam.findSteam();
    for (const a of engine.steam.accounts(steamDir)) {
      console.log(`${a.id}  ${a.persona || '(unknown name)'}${a.mostRecent ? '  (last signed in)' : ''}`);
    }
  },

  async install([modId], flags) {
    const st = entry(modId);
    const gameDir = gameDirFor(modId, flags);
    const listed = st.recommended || st.releases.length;
    let last = -1;
    const onProgress = ({ step, done, total }) => {
      if (step === 'download') { process.stdout.write(`  downloading ${mb(done)} / ${mb(total)}\r`); return; }
      if (step === 'verify') { console.log('\n  checking'); return; }
      const pct = Math.floor((done / total) * 100);
      if (step === 'copy' && pct >= last + 10) { last = pct; process.stdout.write(`  ${pct}%\r`); }
    };
    let m;
    if (listed && !flags.local) {
      const version = typeof flags.version === 'string' ? flags.version : undefined;
      console.log(`Installing ${st.name} ${version || st.recommended?.version || ''} into ${gameDir}`);
      m = await engine.installRelease({ modId: st.id, version, gameDir, chosen: flags.set, onProgress });
    } else {
      console.log(`Installing ${st.name} ${st.version || ''} (this PC's) into ${gameDir}`);
      m = await engine.install({ modId: st.id, gameDir, chosen: flags.set, onProgress });
    }
    console.log(`Copied ${m.files.length} files. Version ${m.version}. Options: ${JSON.stringify(m.options)}`);
    if (flags.steamAccount) {
      await withSteamClosed(flags, () => {
        const r = engine.addSteamEntry({ modId: st.id, gameDir, accountId: String(flags.steamAccount) });
        console.log(`Added "${engine.vrName(engine.getMod(st.id))}" to Steam (backup: ${r.backup || 'none needed'}).`);
      });
    }
    if (flags.desktop) console.log(`Desktop shortcut: ${engine.addDesktopEntry({ modId: st.id, gameDir })}`);
  },

  async uninstall([modId], flags) {
    const gameDir = gameDirFor(modId, flags);
    // By id, so it also works when no version of the mod is left to load.
    let id = modId;
    try { id = entry(modId).id; } catch { }
    const manifest = engine.readManifest(gameDir, { id });
    if (manifest?.steamShortcut) {
      const { accountId, appid } = manifest.steamShortcut;
      await withSteamClosed(flags, () => engine.removeSteamEntry({ modId: id, accountId, appid }));
      console.log('Removed the Steam shortcut.');
    }
    const r = engine.uninstall({ modId: id, gameDir });
    console.log(r.keptLoader
      ? `Removed the mod. BepInEx stays${r.otherPlugins.length ? ` for: ${r.otherPlugins.join(', ')}` : ' (it was there before)'}.`
      : 'Removed the mod and BepInEx. The game is back to normal.');
    console.log('Saves were not touched.');
  },

  sideload([zip]) {
    if (!zip) throw new Error('Pass the zip: node cli.js sideload <zip>');
    const r = engine.sideload(zip);
    console.log(`${r.message} It's the active version now.`);
    const st = engine.status().find((s) => s.id === r.id);
    if (st?.installed) console.log(`${r.game} has ${st.installedVersion} installed: reinstall to switch (node cli.js install ${r.id} --local).`);
  },

  versions([modId], flags) {
    if (!modId) throw new Error('Pass the mod: node cli.js versions <mod>');
    const id = engine.getMod(modId).id;
    const list = engine.versions(id, { gameDirs: flags.gameDir ? { [id]: flags.gameDir } : {} });
    for (const v of list) {
      const marks = [v.active && 'active', v.installed && 'installed', v.source === 'file' && 'from a file', v.source === 'download' && 'downloaded'].filter(Boolean).join(', ');
      console.log(`${v.active ? '*' : ' '} ${v.version.padEnd(12)} ${label(v.maturity, v.source).padEnd(12)} ${v.date || ''}${marks ? `  (${marks})` : ''}`);
    }
  },

  use([modId, version], flags) {
    if (!modId || !version) throw new Error('Pass the mod and a version: node cli.js use <mod> <version|dev>');
    const id = entry(modId).id;
    engine.setActive(id, version === 'dev' ? null : version);
    const st = engine.status({ gameDirs: flags.gameDir ? { [id]: flags.gameDir } : {} }).find((s) => s.id === id);
    console.log(`${st.name}: using ${versionText(st)}.`);
    if (st.installed && (st.installedVersion !== st.version || st.installedSource !== st.source)) {
      console.log(`${st.game} still has ${st.installedVersion} installed: reinstall to switch.`);
    }
  },

  public([modId]) {
    if (!modId) throw new Error('Pass the mod: node cli.js public <mod>');
    const st = entry(modId);
    const r = engine.backToPublic(st.id);
    console.log(`${st.name}: using the public ${r.version} (${label(r.maturity)}). Install to apply it: node cli.js install ${st.id}`);
  },

  betas([modId, onOff]) {
    if (!modId || !['on', 'off'].includes(onOff)) throw new Error('Pass the mod and on or off: node cli.js betas <mod> on|off');
    const st = entry(modId);
    engine.setBetaOptIn(st.id, onOff === 'on');
    const now = entry(st.id);
    console.log(`${st.name}: open betas ${onOff}. Recommended: ${now.recommended ? `${now.recommended.version} (${label(now.recommended.maturity)})` : 'none'}.`);
  },

  async shortcut([action, modId], flags) {
    if (!flags.steamAccount) throw new Error('Pass --steam-account ID (see "node cli.js accounts").');
    const accountId = String(flags.steamAccount);
    await withSteamClosed(flags, () => {
      if (action === 'add') {
        const r = engine.addSteamEntry({ modId, gameDir: gameDirFor(modId, flags), accountId });
        console.log(`Added (appid ${r.appid}, backup ${r.backup || 'none'})`);
      } else if (action === 'remove') {
        console.log(engine.removeSteamEntry({ modId, accountId }).removed ? 'Removed' : 'Not found');
      } else throw new Error('shortcut add|remove');
    });
  },
};

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!commands[cmd]) {
    console.log('Usage: node cli.js refresh | list | releases <mod> | check | accounts | install <mod> [--version V] | uninstall <mod> | shortcut add|remove <mod> | sideload <zip> | versions <mod> | use <mod> <version|dev> | public <mod> | betas <mod> on|off');
    process.exit(cmd ? 1 : 0);
  }
  try {
    if (!['check', 'accounts', 'refresh'].includes(cmd)) await engine.refresh();
    await commands[cmd](pos, flags);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
})();
