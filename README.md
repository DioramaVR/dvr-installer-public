# DioramaVR installer

A small Electron app that installs the free DioramaVR tabletop VR mods. It
reads DioramaVR's signed list of mods, finds your installed Steam games, shows
a gallery of the games there's a mod for, and downloads and installs (or
uninstalls) the mods you pick. It can also put a "<Game> (VR)" shortcut on
your desktop. It doesn't add anything to Steam: the mod lives in the game
folder, so starting the game as usual with a headset connected starts it in
VR. (Older versions added a "(VR)" entry to the Steam and SteamVR libraries;
uninstalling removes it, which needs Steam closed and restarted.) The exe
ships no mods itself: they're downloaded, or loaded from a file (closed betas).

It only reads Steam's files on this PC: the registry, `libraryfolders.vdf`,
`appmanifest_*.acf`, `loginusers.vdf` and the library art cache. It never calls
any online Steam API, so no account is looked up anywhere.

## Layout

```
engine/            Node engine: no Electron, testable on its own
  steam.js         Steam path, libraries, installed apps, art, accounts, start/stop
  vdf.js           text + binary KeyValues (shortcuts.vdf)
  shortcuts.js     desktop .lnk; removes an older install's non-Steam "(VR)" shortcut and its grid art
  cfg.js           BepInEx .cfg editing
  options.js       shared options (left-handed, eye resolution)
  loaders.js       what each loader type puts in a game folder
  folders.js       base folders a folder mod can name (Documents, the game)
  uevr.js          downloads + caches the pinned UEVR release; UEVR config.txt
  uevr-launch.ps1  the launcher the "(VR)" entries run for UEVR mods
  index.js         status / refresh / installRelease / install / uninstall / Steam entries / sideload / versions
  remote.js        the signed registry and game indexes (cached; works offline), beta opt-in, announcements
  download.js      a release's zip into a temp folder, size and SHA-256 checked first
  package.js       mod packages in the cache, read with dvr-package; how each arrived (packages.json)
  active.js        which version of each mod is active (cache/active.json)
cli.js             command line over the engine
app/               Electron main, preload, renderer (gallery -> options -> progress -> done)
mods/<id>/         dev builds only: mod.json, build.json (how to build), payload/ (built, git-ignored); not in the exe
scripts/           build-mods.js (payloads). The icon, smoke, flame and fonts come from tools/dvr-brand (npm run sync there).
test/              node --test, against a fake Steam folder + dummy game
```

## Commands

```
npm run build-mods          # dev builds: every mod's payload from its repo's HEAD (mods/<id>/)
npm test                    # engine tests (temp folders and a localhost server only)
npm start                   # run the app
npm run dist                # portable exe -> dist/DioramaVR-<version>.exe (no mods inside)

node cli.js refresh         # fetch the list of mods (registry + each game's index)
node cli.js list
node cli.js releases tpm-vr # what you can install, and the recommended release
node cli.js check           # can this PC run it? (GPU, SteamVR, VC++ runtime, power, RAM)
node cli.js accounts        # Steam accounts on this PC (for shortcut remove)
node cli.js install tpm-vr [--version V] [--game-dir DIR] [--set eyeResolution=0.8] [--desktop] [--local]
node cli.js uninstall tpm-vr [--game-dir DIR] [--close-steam]   # also removes an older install's Steam entry
node cli.js shortcut remove tpm-vr --steam-account ID [--close-steam]
node cli.js sideload <zip>  # load a mod file (e.g. a closed beta); it becomes active
node cli.js versions tpm-vr # the versions on this PC
node cli.js use tpm-vr <version|dev>
node cli.js public tpm-vr   # back to the public release after a file
node cli.js betas tpm-vr on|off
```

`install` downloads the release (default: the recommended one: tested on your
game build if there is one, else the newest; open betas only if you turned
them on for that game) and installs it; `--local` installs the version already
on this PC instead (a loaded file, a dev build). The registry URL is built in;
`DVR_REGISTRY_URL` points elsewhere (staging, tests).

## Mod packages

The package format (a zip with a signed manifest) and every check on it
belong to [dvr-package](https://github.com/DioramaVR/dvr-package), a pinned
dependency: its `docs/SPEC.md` is the format. The installer only **reads**
packages: it never packs, signs or writes indexes. Loading a zip runs
dvr-package's reader (format, `minAppVersion` against this app's version, the
signature against dvr-package's `trusted-keys.json`, every file's SHA-256,
`mod.json`), then unpacks it into `%LOCALAPPDATA%\DioramaVR\cache\mods\`.
A refusal shows the player plain words for its error code (`engine/index.js`,
`PLAYER_MESSAGES`). A zip for a game this PC doesn't have still loads (a
tester may load it first), but install says the game is missing.

Unsigned zips never load in the packaged app. For development, make a dev
pack from a built mod folder with dvr-package's `dvr-pack` (unsigned unless
it's a release) and load it from `npm start` with `DVR_DEV=1` set.

`build-mods` makes development builds only (`mods/<id>/` and
`DVR_EXTRA_MODS`, shown as "dev build"; never packaged). Release builds are
made by dvr-actions, and packed and signed with dvr-package. A mod's
build.json `"licenses"` names its licence data folder in the archived mod
commit (`components.json` and the texts); build-mods writes the notices with
dvr-package's licences module.

Mods that aren't released yet live in their own repos, not in `mods/`:
`DVR_EXTRA_MODS` (folders holding a mod.json and build.json, separated by
`;`) adds them for the CLI, the app and `build-mods` on this PC. Their payload
is built next to their mod.json and is never packaged.

To test against a copy instead of your real Steam: `DVR_STEAM_DIR` (fake Steam
folder), `DVR_DESKTOP_DIR`, `DVR_SKIP_PROCESS_CHECK=1` (doesn't check for a
running game, and treats Steam as closed so it's never shut down). `DVR_MOCK=1
npm start` runs the UI on the demo data in `app/renderer/mock.js`.
`DVR_SCREENSHOT=out.png` (optionally with `DVR_SCREENSHOT_JS`) captures the
window and quits.

## Install and uninstall

- The payload is copied into the game folder. Anything it overwrites is backed up
  to `<game>/.dvr/<id>/backup/`. Every file written is listed in
  `<game>/.dvr/<id>.json`.
- If BepInEx was already in the game before the first install, its files are left
  alone. Only the mod's loader settings (`loaderConfig`, e.g. console off) are
  applied, and the original config is backed up.
- The chosen options are written into the plugin's `.cfg`. BepInEx keeps them when
  it fills in the rest on first launch.
- `steam_appid.txt` is written if the mod needs it and the file isn't already there.
- On uninstall, if other BepInEx plugins are present, or BepInEx was there before
  us, only the mod's plugin folder and config are removed and backups are put
  back. Otherwise BepInEx is removed entirely, including what it generated. Saves
  live outside the game folder and are never touched.

## Steam entries

Steam rewrites `userdata/<account>/config/shortcuts.vdf` from memory when it
exits, so the file is only changed while Steam is closed. The app offers to close
Steam and restart it afterwards. Only the account picked in the app is changed.
The file is backed up next to itself (`shortcuts.vdf.dvr-<time>.bak`) before
every write. The entry is flagged `OpenVR` so it shows in SteamVR, and gets the
game's library art in `config/grid/`.

## Adding a mod

Add `mods/<id>/mod.json` (see `mods/tpm-vr/mod.json`) and a `build.json`. Loader
types are `bepinex6-il2cpp`, `bepinex5-mono`, `uevr` and `folder` (below). A mod can ship a `video` (path in its folder): a diorama
turntable clip with alpha (`mods/tpm-vr/hover.webm`), kept for a planned per-game
view where it would fill the background. The cards themselves use the game art.

## UEVR mods (Unreal Engine games)

UEVR attaches to a game that's already running, so nothing goes where the game
loads it by itself: the normal Steam entry stays flat, as before.
`test/uevr.test.js` has a complete example mod.json.

- **UEVR isn't shipped.** Its licence is "All rights reserved", so install
  downloads the official release that mod.json's `loader` names (`url`, pinned
  by `sha256`, from praydog's GitHub), checks the hash and caches it in
  `%LOCALAPPDATA%\DioramaVR\cache\uevr-<version>`. A mismatch stops the install
  before anything is copied. The `.pdb` files are left out.
- **Game folder:** `DioramaVR/<mod>/` (`plugin.folder`) holds `launch.ps1`,
  `launch.json` and `uevr/`. Nothing in the game's own folders changes.
- **UEVR profile:** payload paths under `profile/` go to
  `%APPDATA%\UnrealVRMod\<uevr.profile>` (the script, the menu plugin), and
  `loaderConfig` is merged into its `config.txt`. A profile that was already
  there (the player's own UEVR setup) is kept: files we overwrite are backed
  up and put back on uninstall. Otherwise uninstall removes the whole
  profile, including what UEVR wrote there.
- **"(VR)" entries** (the desktop shortcut and the app's Play button) run
  `launch.ps1` through PowerShell, hidden, with the game's icon. It starts
  SteamVR if needed and stops with a message if there's no headset (UEVR sets
  up VR only once, when it attaches), starts the game through Steam, waits
  for its window plus `uevr.attachDelay` seconds, runs `UEVRInjector.exe
  --attach=<process>`, checks that `UEVRBackend.dll` loaded, and stays until
  the game exits (so Steam shows it playing). It logs to
  `%LOCALAPPDATA%\DioramaVR\<process>-launch.log`.
- **build.json** takes `repo` and `archive` (the mod repo's last commit),
  `steps` (commands run in that copy, e.g. zig for the menu plugin) and
  `profileFiles` (profile path: path in the copy).

## Folder mods (games with their own mod support)

For a game that loads mods from a folder of its own (Timberborn:
`Documents\Timberborn\Mods\<mod>`), one general type, `folder`, so the next
such game needs only data, no new code (dvr-package SPEC section 3, 0.1.5).
`test/folder.test.js` has a complete example mod.json.

- **mod.json:** `loader: { type: "folder", version: "1" }` and
  `folder: { target, path }` (from game.json `install.folder`). `target` is
  `documents` (the player's Documents folder as Windows knows it, from
  `User Shell Folders\Personal`, so a Documents folder moved by OneDrive is
  found; `DVR_DOCUMENTS_DIR` overrides it) or `game` (the game's folder).
  `path` is relative; dvr-package's rules refuse `..`, drives and the like,
  and the installer checks again before writing.
- **Where files go:** payload `<plugin.folder>/X` goes to `<target>/<path>/X`,
  and any other payload path P (`licenses/...`) to `<target>/<path>/P`, so
  nothing lands outside the mod's folder. `plugin.config` maps the same way.
  The manifest stays in the game folder (`.dvr/<id>.json`), as for the others.
- **Nothing to download or configure:** no loader files, no `loaderConfig`.
- **Uninstall** removes exactly the files installed, then the folders left
  empty (up to the mod's folder); anything the game or the player added is
  kept. A file that was already there is backed up and put back.
- **Installed?** The manifest says so and the mod's folder is still there (the
  player may delete it by hand); otherwise it shows as not installed.
- **Launch:** the game exe with `launchArgs`, as for BepInEx.

## Can this PC run it?

`engine/preflight.js` runs read-only, local checks, shown at the top of the
gallery and by `node cli.js check`:
- a discrete NVIDIA/AMD graphics card (virtual displays such as Meta's and
  Virtual Desktop's are ignored);
- SteamVR installed (appid 250820's appmanifest);
- the Visual C++ 2015-2022 x64 runtime (from the registry, with the DLLs as a
  fallback); if it's missing, Install stops and offers Microsoft's download;
- battery or mains power on laptops;
- with both integrated and discrete graphics, a tip to set "High performance"
  for the game and SteamVR in Windows' graphics settings.

The receiver needs nothing but the exe and an internet connection for the
first download. The game, SteamVR and the headset's own PC app are the only
other things to install, because each mod's package carries BepInEx and its
.NET runtime (Unity's own libraries are never shipped: BepInEx gets them on
the player's PC).
