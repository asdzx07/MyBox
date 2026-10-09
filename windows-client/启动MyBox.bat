@echo off
title MyBox for Windows 启动器
chcp 65001 >nul

:: ========================================================
:: 1. 管理员权限自提权检测 (UAC)
:: ========================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [提示] 正在请求管理员权限以配置网络分流路由...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: 切换到当前脚本所在目录
cd /d "%~dp0"

echo ========================================================
echo       MyBox for Windows 桌面客户端 (sing-box UI)
echo ========================================================
echo.

:: ========================================================
:: 2. 检查 Node.js 环境
:: ========================================================
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [错误] 本机未检测到 Node.js，请先安装 Node.js (v18 或更高版本)。
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: ========================================================
:: 3. 停止已存在的 3038 端口旧进程
:: ========================================================
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3038" ^| findstr "LISTENING"') do (
    if not "%%a"=="" (
        taskkill /F /PID %%a >nul 2>&1
    )
)

:: ========================================================
:: 4. 后台启动本地微服务
:: ========================================================
echo [1/3] 正在启动 MyBox 伴侣服务...
start /b "" node "%~dp0core\server.mjs" > "%temp%\mybox_client.log" 2>&1

:: 稍候 1 秒等待本地端口就绪
timeout /t 1 /nobreak >nul

:: ========================================================
:: 5. 调起桌面独立视窗客户端 (Edge App 模式)
:: ========================================================
echo [2/3] 正在拉起 sing-box 风格桌面客户端视窗...

set "EDGE_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) else if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE_EXE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
)

if defined EDGE_EXE (
    start "" "%EDGE_EXE%" --app="http://127.0.0.1:3038" --window-size=1020,680 --user-data-dir="%temp%\mybox_edge_profile"
) else (
    start http://127.0.0.1:3038
)

echo [3/3] 客户端启动成功！
echo.
echo 说明：
echo 1. 本机保持主路由 192.168.3.1 DHCP 自动分配 IP 不变；
echo 2. 客户端界面内可一键接管/断开旁路由，并可实时修改 MyBox 策略与节点。
echo 3. 若要退出，可在客户端设置页中点击「退出应用」，或运行「一键断开并还原网络.bat」。
echo.
timeout /t 3 /nobreak >nul
exit /b 0
