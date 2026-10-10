@echo off
setlocal
title MyBox for Windows 网络还原工具
cd /d "%~dp0"

:: 1. 管理员权限检查与自动提权
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo 正在申请管理员权限以还原网络路由...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/c cd /d \"\"%~dp0\"\" && \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

cls
echo ============================================================
echo          正在彻底清理旁路由临时设置，还原 Windows 默认网络
echo ============================================================
echo.

:: 1. 停止客户端本地后台服务 (端口 3038)
echo [1/4] 正在关闭本地伴侣服务...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3038" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: 2. 恢复以太网网卡为 DHCP 自动获取 IP 与 DNS
echo [2/4] 正在恢复网卡为 DHCP 自动获取 IP 与自动获取 DNS...
netsh interface ip set address name="以太网" source=dhcp >nul 2>&1
netsh interface ip set dns name="以太网" source=dhcp >nul 2>&1

:: 3. 清理可能残留的临时路由
echo [3/4] 正在清理临时路由...
route delete 0.0.0.0 mask 128.0.0.0 192.168.3.2 >nul 2>&1
route delete 128.0.0.0 mask 128.0.0.0 192.168.3.2 >nul 2>&1
route delete 0.0.0.0 192.168.3.2 >nul 2>&1

:: 4. 刷新本地 DNS 缓存
echo [4/4] 正在清理本地 DNS 缓存...
ipconfig /flushdns >nul 2>&1

echo.
echo ============================================================
echo [完成] Windows 本地网络已彻底恢复！
echo 当前网络状态：已恢复主路由 (192.168.3.1) DHCP 自动获取 IP 与 DNS。
echo ============================================================
echo.
pause
exit /b 0