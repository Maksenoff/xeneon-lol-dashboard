' Lance run-backend.ps1 sans fenêtre visible (utilisé par le raccourci du dossier Démarrage).
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\run-backend.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
