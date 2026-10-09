@echo off
chcp 936 >nul
title MyBox for Windows 控制台
cd /d "%~dp0"

:: 1. 管理员权限检查与自动提权
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] 正在申请管理员权限以配置网络分流路由...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/k cd /d \"\"%~dp0\"\" && \"\"%~f0\"\" :elevated' -Verb RunAs"
    exit /b
)

cls
echo ============================================================
echo          MyBox for Windows 伴侣客户端 (sing-box UI)
echo ============================================================
echo.

:: 2. 检查 Node.js 运行时
echo [2/4] 正在检测 Node.js 运行环境...
set NODE_CMD=
where node >nul 2>&1
if %errorlevel% equ 0 set NODE_CMD=node
if not defined NODE_CMD if exist "C:\nvm4w\nodejs\node.exe" set NODE_CMD=C:\nvm4w\nodejs\node.exe
if not defined NODE_CMD if exist "C:\Program Files\nodejs\node.exe" set NODE_CMD=C:\Program Files\nodejs\node.exe

if not defined NODE_CMD (
    echo.
    echo [错误] 本机未检测到 Node.js，请先安装 Node.js (https://nodejs.org/)
    echo 安装完成后请重新运行此脚本。
    echo.
    pause
    exit /b 1
)

:: 3. 释放 3038 端口并启动后台伴侣服务
echo [3/4] 正在启动本地服务与旁路由连接网关...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3038" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

start "" /b "%NODE_CMD%" "%~dp0core\server.mjs"

:: 稍候 1.5 秒等待微服务就绪
ping 127.0.0.1 -n 3 >nul

:: 4. 拉起桌面应用视窗
echo [4/4] 正在调起 sing-box 风格客户端视窗...

set EDGE_PATH=
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set EDGE_PATH="%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE_PATH if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set EDGE_PATH="%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE_PATH if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set EDGE_PATH="%LocalAppData%\Microsoft\Edge\Application\msedge.exe"

if defined EDGE_PATH (
    start "" %EDGE_PATH% --app="http://127.0.0.1:3038" --window-size=1020,680
) else (
    start "" "http://127.0.0.1:3038"
)

cls
echo ============================================================
echo         MyBox for Windows 桌面客户端已启动并接管网络
echo ============================================================
echo   [?] 本地控制台: http://127.0.0.1:3038
echo   [?] 旁路由网关: 192.168.3.2 (MyBox 分流已生效)
echo   [?] 客户端视窗: 已在桌面以 sing-box 极简界面呈现
echo ============================================================
echo.
echo   操作提示：
echo   1. 本机保持主路由 (192.168.3.1) DHCP 自动获取 IP 不变；
echo   2. 在弹出的客户端窗口中可直接切换节点、修改分流策略；
echo   3. 若要退出并恢复主路由直连：
echo      - 可在客户端「设置」页点击「退出应用」；
echo      - 或在此窗口按任意键彻底还原网络后退出。
echo.
echo ============================================================
echo   按任意键将自动还原 Windows 默认网络并退出...
pause >nul

echo.
echo 正在还原网络为默认主路由直连，请稍候...
"%NODE_CMD%" -e "import('./core/network.mjs').then(m => m.disconnectGateway('192.168.3.2'))" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3038" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo [完成] 已恢复 Windows 默认网络 (主路由 192.168.3.1 直连)。
ping 127.0.0.1 -n 2 >nul
exit /b 0