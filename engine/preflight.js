// "Can this PC run it?": read-only checks from local information (registry,
// WMI, Steam's files). Nothing is changed and nothing goes online.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const steam = require('./steam');

const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const STEAMVR_APPID = 250820;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (err, out) => resolve(err ? '' : out));
  });
}

// Visual C++ 2015-2022 x64 runtime: the installer's registry key, with the
// DLLs themselves as a fallback (some apps drop them in System32 directly).
async function vcRuntime() {
  for (const key of ['HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64']) {
    const out = await run('reg', ['query', key]);
    if (/Installed\s+REG_DWORD\s+0x1/.test(out)) {
      return { installed: true, version: out.match(/Version\s+REG_SZ\s+(\S+)/)?.[1] || null, via: 'registry' };
    }
  }
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const dlls = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  if (dlls.every((d) => fs.existsSync(path.join(sys, d)))) return { installed: true, version: null, via: 'dlls' };
  return { installed: false, version: null, via: null };
}

// Sorts a display adapter into discrete / integrated / virtual by its name and
// vendor. Virtual ones (Meta, Virtual Desktop, Parsec, remote display) are ignored.
function classifyGpu({ Name: name = '', AdapterCompatibility: vendor = '', PNPDeviceID: pnp = '' }) {
  const n = name.toLowerCase();
  if (!/^pci\\/i.test(pnp) || /virtual|remote|basic display|parsec|meta /.test(n)) return { name, kind: 'virtual' };
  if (/nvidia|geforce|quadro|rtx|gtx/.test(n) || /ven_10de/i.test(pnp)) return { name, vendor: 'NVIDIA', kind: 'discrete' };
  // Laptop chips read like "Radeon 780M Graphics"; cards like "Radeon RX 7600".
  if (/radeon\s*(rx|pro|vii|r[5-9]\s|hd\s)|firepro/.test(n)) return { name, vendor: 'AMD', kind: 'discrete' };
  if (/amd|radeon|ati/.test(n) || /ven_1002/i.test(pnp)) return { name, vendor: 'AMD', kind: 'integrated' };
  if (/arc(\(tm\))?\s*[ab]\d{3}/.test(n)) return { name, vendor: 'Intel', kind: 'discrete' };
  if (/intel/.test(n) || /ven_8086/i.test(pnp) || /intel/i.test(vendor)) return { name, vendor: 'Intel', kind: 'integrated' };
  return { name, vendor, kind: 'unknown' };
}

const asList = (j) => (Array.isArray(j) ? j : j ? [j] : []);

async function wmi() {
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '@{ gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,PNPDeviceID);'
    + ' batteries = @(Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining) } | ConvertTo-Json -Depth 3']);
  try { return JSON.parse(out); } catch { return { gpus: [], batteries: [] }; }
}

// Each check: { id, title, status: 'ok' | 'warn' | 'bad' | 'info', summary, detail?, link? }
async function check() {
  const [vc, sys] = await Promise.all([vcRuntime(), wmi()]);
  const checks = [];

  const gpus = asList(sys.gpus).map(classifyGpu).filter((g) => g.kind !== 'virtual');
  const discrete = gpus.filter((g) => g.kind === 'discrete');
  const integrated = gpus.filter((g) => g.kind === 'integrated');
  const hybrid = discrete.length > 0 && integrated.length > 0;
  if (discrete.length) {
    checks.push({ id: 'gpu', title: 'Graphics card', status: 'ok', summary: discrete.map((g) => g.name).join(', ') });
  } else if (integrated.length) {
    checks.push({ id: 'gpu', title: 'Graphics card', status: 'bad', summary: `Only integrated graphics found (${integrated.map((g) => g.name).join(', ')})`,
      detail: 'PC VR needs a separate NVIDIA or AMD graphics card. It may start, but will most likely be too slow to use.' });
  } else {
    checks.push({ id: 'gpu', title: 'Graphics card', status: 'warn', summary: gpus.length ? gpus.map((g) => g.name).join(', ') : "Couldn't read the graphics cards",
      detail: 'Make sure this PC has an NVIDIA or AMD graphics card.' });
  }

  const steamDir = steam.findSteam();
  const steamvr = steamDir ? steam.findApp(steamDir, STEAMVR_APPID) : null;
  checks.push(steamvr
    ? { id: 'steamvr', title: 'SteamVR', status: 'ok', summary: 'Installed' }
    : process.env.DVR_STEAM_DIR
      ? { id: 'steamvr', title: 'SteamVR', status: 'info', summary: 'Not in the test Steam folder', detail: 'The app is pointed at a test Steam folder (DVR_STEAM_DIR), so the real SteamVR install isn\'t looked at.' }
      : { id: 'steamvr', title: 'SteamVR', status: 'bad', summary: 'Not installed',
      detail: 'Install SteamVR from Steam (it\'s free). The mods run through it.', link: { label: 'SteamVR on Steam', url: `https://store.steampowered.com/app/${STEAMVR_APPID}/` } });

  checks.push(vc.installed
    ? { id: 'vcredist', title: 'Visual C++ runtime', status: 'ok', summary: vc.version ? `Installed (${vc.version})` : 'Installed' }
    : { id: 'vcredist', title: 'Visual C++ runtime', status: 'bad', summary: 'Missing',
      detail: 'The mod loader needs Microsoft\'s Visual C++ 2015-2022 runtime (x64). Download it from Microsoft, run it, then come back.', link: { label: 'Download from Microsoft', url: VCREDIST_URL } });

  const batteries = asList(sys.batteries);
  if (batteries.length) {
    // BatteryStatus 1 = discharging; 2+ = on mains power / charging.
    const onBattery = batteries.some((b) => b.BatteryStatus === 1);
    const charge = batteries[0].EstimatedChargeRemaining;
    checks.push(onBattery
      ? { id: 'power', title: 'Power', status: 'warn', summary: `On battery${charge != null ? ` (${charge}%)` : ''}`,
        detail: 'Plug the laptop in before playing. On battery, Windows slows the graphics card right down.' }
      : { id: 'power', title: 'Power', status: 'ok', summary: 'Plugged in' });
  }

  if (hybrid) {
    checks.push({ id: 'hybrid', title: 'Laptop graphics', status: 'info', summary: `Two graphics chips (${integrated[0].name} + ${discrete[0].name})`,
      detail: 'So the game uses the fast one: Windows Settings > System > Display > Graphics. Add the game\'s exe (e.g. TPM.exe) and SteamVR\'s vrserver.exe and vrcompositor.exe (in Steam\\steamapps\\common\\SteamVR\\bin\\win64), and set each to "High performance".' });
  }

  checks.push({ id: 'memory', title: 'Memory', status: os.totalmem() >= 15e9 ? 'ok' : 'warn', summary: `${Math.round(os.totalmem() / 2 ** 30)} GB RAM`,
    detail: os.totalmem() >= 15e9 ? undefined : '16 GB is recommended. Close other programs while playing.' });

  const worst = checks.some((c) => c.status === 'bad') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, checks, vcRuntime: vc.installed };
}

module.exports = { check, classifyGpu, vcRuntime, VCREDIST_URL };
