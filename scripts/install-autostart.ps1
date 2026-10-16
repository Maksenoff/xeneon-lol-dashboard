# Installe le lancement automatique du backend à l'ouverture de session Windows :
# compile le backend puis crée un raccourci « Xeneon LoL Backend » dans le dossier Démarrage
# de l'utilisateur (aucun droit administrateur nécessaire). Désinstallation : uninstall-autostart.ps1.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'backend'

Write-Host 'Compilation du backend…'
Push-Location $backend
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'La compilation a échoué.' }
Pop-Location

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Xeneon LoL Backend.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'start-hidden.vbs') + '"'
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Description = 'Backend local LoL pour les widgets iCUE (Xeneon Edge)'
$lnk.Save()
Write-Host "Raccourci créé : $lnkPath"

# Démarrage immédiat, sans attendre la prochaine ouverture de session
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $PSScriptRoot 'start-hidden.vbs') + '"')
Write-Host 'Backend lancé en arrière-plan (journal : %LOCALAPPDATA%\xeneon-lol\logs\backend.log).'
