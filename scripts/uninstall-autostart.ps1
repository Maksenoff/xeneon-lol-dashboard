# Retire le lancement automatique et arrête le backend en cours d'exécution.

$lnkPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Xeneon LoL Backend.lnk'
if (Test-Path $lnkPath) {
  Remove-Item $lnkPath
  Write-Host "Raccourci supprimé : $lnkPath"
} else {
  Write-Host 'Aucun raccourci de démarrage trouvé.'
}

# Arrête la boucle de relance (powershell run-backend.ps1) puis le serveur node
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*run-backend.ps1*' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*dist/server.js*') } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "Processus arrêté : $($_.Name) ($($_.ProcessId))"
  }
