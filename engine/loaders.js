// What each mod loader puts in a game folder (and, for UEVR, its profile
// folder). Install and uninstall go through these so a new loader type is one
// entry here, not a new code path.
//
// A payload path ("rel") is relative to the game folder, except where a
// loader's dest() maps it elsewhere. Each loader has:
//   roots         paths that belong to a loader shared with other mods: left
//                 alone if it was there before us
//   removeRoots   what goes entirely when nothing else uses the loader
//   installed     was the loader (or profile) here before the first install?
//   otherPlugins  other mods that use it
//   loaderConfig  its settings file (mod.json "loaderConfig" goes in there)
//   launch        how the "(VR)" entries start the game in VR
//   extraFiles    files fetched at install time instead of shipped
const fs = require('fs');
const path = require('path');
const cfg = require('./cfg');
const uevr = require('./uevr');
const folders = require('./folders');

const gameExe = (mod, gameDir) => path.join(gameDir, mod.exe);
const direct = (mod, gameDir) => {
  const args = mod.launchArgs || '';
  return { exe: gameExe(mod, gameDir), argv: args ? args.split(' ') : [], args, cwd: gameDir, icon: gameExe(mod, gameDir) };
};

const bepinex = (roots) => ({
  roots,
  removeRoots: () => roots,
  dest: (mod, gameDir, rel) => path.join(gameDir, rel),
  installed: (gameDir) => fs.existsSync(path.join(gameDir, 'BepInEx', 'core')),
  loaderConfig: 'BepInEx/config/BepInEx.cfg',
  writeConfig: cfg.writeFile,
  // Plugins in the game folder other than ours (folders or loose dlls).
  otherPlugins(gameDir, ourFolder) {
    const dir = path.join(gameDir, 'BepInEx', 'plugins');
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const ours = path.basename(ourFolder).toLowerCase();
    return entries.filter((e) => e.toLowerCase() !== ours);
  },
  launch: direct,
  extraFiles: async () => [],
});

// UEVR attaches to the running game from outside, so nothing in the game
// folder loads by itself and the normal Steam entry stays flat. The mod's
// folder (plugin.folder, e.g. DioramaVR/<mod>) holds the launcher and
// UEVR; "profile/..." payload paths go to UEVR's profile for the game
// (%APPDATA%\UnrealVRMod\<uevr.profile>): the script, the menu plugin and
// config.txt. The "(VR)" entries run the launcher, which starts the game
// through Steam and attaches UEVR (launch.ps1).
const PROFILE = 'profile';
const profileDir = (mod) => path.join(uevr.profilesDir(), mod.uevr.profile);
const uevrLoader = {
  roots: [],  // UEVR comes with each mod; nothing shared to leave alone
  removeRoots: (mod) => [PROFILE, mod.plugin.folder],
  dest(mod, gameDir, rel) {
    if (rel === PROFILE) return profileDir(mod);
    if (rel.startsWith(`${PROFILE}/`)) return path.join(profileDir(mod), rel.slice(PROFILE.length + 1));
    return path.join(gameDir, rel);
  },
  // A profile already there (the player's own UEVR setup) is kept: only our
  // files come out again, and what we overwrote is put back.
  installed: (gameDir, mod) => fs.existsSync(profileDir(mod)),
  loaderConfig: `${PROFILE}/config.txt`,
  writeConfig: uevr.writeConfig,
  otherPlugins: () => [],
  launch(mod, gameDir) {
    const script = path.join(gameDir, mod.plugin.folder, 'launch.ps1');
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
    const args = argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
    return { exe, argv, args, cwd: path.dirname(script), icon: gameExe(mod, gameDir) };
  },
  async extraFiles(mod, onProgress) {
    const dir = await uevr.ensure(mod.loader, onProgress);
    return fs.readdirSync(dir).filter((f) => f !== '.ok')
      .map((f) => ({ rel: `${mod.plugin.folder}/uevr/${f}`, src: path.join(dir, f) }));
  },
};

// A game with mod support of its own (Timberborn) loads mods from a folder
// of its own: mod.json folder {target, path} (dvr-package SPEC section 3).
// Payload <plugin.folder>/X goes to <target>/<path>/X, and every other
// payload path P (licenses/...) to <target>/<path>/P: nothing outside it.
// There's no loader to share, download or configure, so uninstall removes
// exactly the files installed (and folders left empty), keeping anything the
// player or the game added. The game starts as usual (launch args).
const underFolder = (rel, root) => rel.toLowerCase() === root.toLowerCase() || rel.toLowerCase().startsWith(root.toLowerCase() + '/');
const folderLoader = {
  roots: [],
  removeRoots: () => [],
  dest(mod, gameDir, rel) {
    const base = folders.modFolder(mod, gameDir);
    const own = mod.plugin.folder;
    const inner = rel.toLowerCase() === own.toLowerCase() ? '' : underFolder(rel, own) ? rel.slice(own.length + 1) : rel;
    return inner ? path.join(base, ...inner.split('/')) : base;
  },
  installed: () => false,
  // Installed means the mod's folder is still there (the player may delete it).
  present: (gameDir, mod) => fs.existsSync(folders.modFolder(mod, gameDir)),
  loaderConfig: null,
  writeConfig: () => { throw new Error('a folder mod has no loader to configure'); },
  otherPlugins: () => [],
  launch: direct,
  extraFiles: async () => [],
};

const LOADERS = {
  'bepinex6-il2cpp': bepinex(['BepInEx', 'dotnet', 'winhttp.dll', 'doorstop_config.ini', '.doorstop_version']),
  'bepinex5-mono': bepinex(['BepInEx', 'winhttp.dll', 'doorstop_config.ini', '.doorstop_version']),
  uevr: uevrLoader,
  folder: folderLoader,
};

function get(type) {
  if (!(type in LOADERS)) throw new Error(`Unknown loader type "${type}"`);
  if (!LOADERS[type]) throw new Error(`Loader type "${type}" isn't supported by this version of the installer yet`);
  return LOADERS[type];
}

module.exports = { get, LOADERS };
