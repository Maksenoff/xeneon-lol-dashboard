# Lance le backend compilé en boucle : s'il s'arrête (plantage, mise en veille…), il redémarre après 10 s.
# Les journaux vont dans %LOCALAPPDATA%\xeneon-lol\logs\backend.log (taille limitée à ~5 Mo).
# Lancé au démarrage de Windows par start-hidden.vbs (raccourci dans le dossier Démarrage).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'
$logDir = Join-Path $env:LOCALAPPDATA 'xeneon-lol\logs'
$log = Join-Path $logDir 'backend.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [launcher] $msg" | Out-File -FilePath $log -Append -Encoding utf8
}

# Une seule instance : si le port 3417 répond déjà, on ne relance rien.
try {
  Invoke-WebRequest -Uri 'http://localhost:3417/api/health' -UseBasicParsing -TimeoutSec 3 | Out-Null
  Write-Log 'Backend déjà en cours d''exécution, rien à faire.'
  exit 0
} catch {}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Log 'node introuvable dans le PATH : arrêt.'
  exit 1
}

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
    Move-Item -Force $log "$log.old"
  }
  Write-Log "Démarrage : $node dist/server.js"
  Push-Location $backend
  # Redirection via cmd : PowerShell 5.1 écrirait le journal en UTF-16 avec *>>.
  cmd /c "`"$node`" dist/server.js >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  Pop-Location
  Write-Log "Backend arrêté (code $code), redémarrage dans 10 s."
  Start-Sleep -Seconds 10
}
