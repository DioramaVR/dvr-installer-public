# DioramaVR launcher for a UEVR mod. The "<Game> (VR)" entries run this (hidden):
# it makes sure SteamVR has a headset, starts the game through Steam (so the
# normal Steam entry is untouched and stays flat), waits for it to load, then
# attaches UEVR from the uevr folder next to it. It keeps running until the
# game exits, so Steam shows the VR entry as playing.
# launch.json next to it: { game, appid, process, attachDelay }.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$conf = Get-Content (Join-Path $here 'launch.json') -Raw | ConvertFrom-Json
$uevr = Join-Path $here 'uevr'
$logDir = Join-Path $env:LOCALAPPDATA 'DioramaVR'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir "$($conf.process)-launch.log"
Set-Content $logFile "$(Get-Date -Format s) launcher for $($conf.game)" -Encoding utf8

function Log($m) { Add-Content $logFile "$(Get-Date -Format s) $m" -Encoding utf8 }
function Say($m) {
    Log "message: $m"
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($m, "$($conf.game) (VR)") | Out-Null
}
function WaitFor($seconds, [scriptblock]$cond) {
    $end = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $end) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}
function GameProcess { Get-Process $conf.process -ErrorAction SilentlyContinue | Select-Object -First 1 }
function HasUevr($p) {
    try { return [bool]($p.Modules | Where-Object { $_.ModuleName -eq 'UEVRBackend.dll' }) } catch { return $false }
}

try {
    # UEVR sets up VR once, when it attaches: the headset has to be there first.
    # The compositor only runs while SteamVR has a headset.
    if (-not (Get-Process vrcompositor -ErrorAction SilentlyContinue)) {
        if (-not (Get-Process vrserver -ErrorAction SilentlyContinue)) {
            Log 'starting SteamVR'
            Start-Process 'steam://rungameid/250820'
        }
        if (-not (WaitFor 90 { Get-Process vrcompositor -ErrorAction SilentlyContinue })) {
            Say "SteamVR can't see a headset. Connect your headset (Quest Link, Steam Link, Virtual Desktop...), then start $($conf.game) (VR) again."
            exit 1
        }
    }
    Log 'SteamVR has a headset'

    $game = GameProcess
    if ($game -and (HasUevr $game)) {
        Log 'already in VR'
    } else {
        if (-not $game) {
            Log "starting the game (steam://rungameid/$($conf.appid))"
            Start-Process "steam://rungameid/$($conf.appid)"
            if (-not (WaitFor 180 { GameProcess })) { Say "$($conf.game) didn't start."; exit 1 }
            $game = GameProcess
            # Let the window and the renderer come up before UEVR hooks it.
            WaitFor 180 { $g = GameProcess; $g -and $g.MainWindowHandle -ne 0 } | Out-Null
            Start-Sleep -Seconds ([int]$conf.attachDelay)
        }
        Log "attaching UEVR to $($conf.process) ($($game.Id))"
        $injector = Start-Process (Join-Path $uevr 'UEVRInjector.exe') -ArgumentList "--attach=$($conf.process)" `
            -WorkingDirectory $uevr -WindowStyle Minimized -PassThru
        if (-not (WaitFor 60 { $g = GameProcess; (-not $g) -or (HasUevr $g) })) {
            Say "UEVR didn't attach to $($conf.game). The game keeps running flat; the log is $logFile."
            exit 1
        }
        Log 'UEVR attached'
    }

    # Stay until the game closes, then close the injector we started.
    $game = GameProcess
    if ($game) { $game.WaitForExit() }
    Log 'game closed'
    if ($injector -and -not $injector.HasExited) { $injector.CloseMainWindow() | Out-Null; Start-Sleep 2; if (-not $injector.HasExited) { $injector.Kill() } }
} catch {
    Say "Something went wrong starting $($conf.game) in VR: $($_.Exception.Message)"
    exit 1
}
