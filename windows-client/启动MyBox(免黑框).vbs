Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
Set app = CreateObject("Shell.Application")

' 1. 以管理员权限静默启动伴侣服务并接管网络
psCmd = "Set-Location '" & currentDir & "'; Get-NetTCPConnection -LocalPort 3038 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Start-Process node -ArgumentList 'core/server.mjs' -WindowStyle Hidden"
app.ShellExecute "powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command """ & psCmd & """", "", "runas", 0

' 2. 稍等后台服务就绪
WScript.Sleep 1600

' 3. 拉起 Edge 原生独立视窗 (无任何浏览器边框)
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(edgePath) Then
    edgePath = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
End If
If Not fso.FileExists(edgePath) Then
    edgePath = sh.ExpandEnvironmentStrings("%LocalAppData%\Microsoft\Edge\Application\msedge.exe")
End If

If fso.FileExists(edgePath) Then
    sh.Run """" & edgePath & """ --app=http://127.0.0.1:3038 --window-size=1020,680", 1, False
Else
    sh.Run "http://127.0.0.1:3038", 1, False
End If