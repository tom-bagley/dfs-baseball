' Launches the projections viewer in the background with no console window.
' Self-locating: resolves the repo root from this script's own path, so a
' Startup-folder shortcut to this file keeps working if the repo moves.
' node --watch keeps the server current with code changes without manual
' restarts; the port defaults to 8000 (see src/team-projections-server.js).
Dim fso, shell, repoRoot
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = repoRoot
shell.Run "cmd /c node --watch src\team-projections-server.js", 0, False
