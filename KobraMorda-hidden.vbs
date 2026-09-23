' Runs KobraMorda without a console window; output goes to backend\data\bridge.log
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir & "\backend"
sh.Run "cmd /c ""if not exist dist\server.js call npm run build & node dist\server.js >> data\bridge.log 2>&1""", 0, False
