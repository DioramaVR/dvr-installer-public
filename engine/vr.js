// Is SteamVR running, and does it have a headset? Read only from this PC: the
// running vrserver.exe, and SteamVR's own log (Steam/logs/vrserver.txt) for that
// same run. The log isn't a stable interface, so anything unexpected reports
// the headset as unknown (null) rather than guessing. Asynchronous throughout:
// the app polls this every couple of seconds from its main process.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function vrserverPid() {
  if (process.env.DVR_SKIP_PROCESS_CHECK) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq vrserver.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true },
      (err, out) => resolve(err ? null : out.match(/"vrserver\.exe","(\d+)"/i)?.[1] || null));
  });
}

// Headset state from one run's log text: connected once SteamVR logs
// "Active HMD set to <driver>.<serial>", unless a later line says there's none
// (Steam Link adds a "Disconnected" placeholder headset; SteamVR logs "No
// connected devices found" when nothing answers).
function headsetFromLog(session) {
  const active = session.lastIndexOf('Active HMD set to ');
  const none = Math.max(session.lastIndexOf("with serial number 'Disconnected"), session.lastIndexOf('No connected devices found'));
  if (active < 0) return { headset: none >= 0 ? false : null, hmd: null };
  if (active < none) return { headset: false, hmd: null };
  return { headset: true, hmd: session.slice(active + 18).match(/^[^\r\n]*/)[0].trim() || null };
}

// { steamvr, headset: true | false | null (can't tell), hmd: "driver.serial" | null }
async function status(steamDir) {
  const pid = await vrserverPid();
  if (!pid) return { steamvr: false, headset: false, hmd: null };
  let log;
  try { log = await fs.promises.readFile(path.join(steamDir, 'logs', 'vrserver.txt'), 'utf8'); } catch { return { steamvr: true, headset: null, hmd: null }; }
  // This run's part of the log starts at its own startup line.
  const start = log.lastIndexOf(`startup with PID=${pid},`);
  if (start < 0) return { steamvr: true, headset: null, hmd: null };
  return { steamvr: true, ...headsetFromLog(log.slice(start)) };
}

module.exports = { status, headsetFromLog };
