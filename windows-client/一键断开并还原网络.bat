@echo off
title MyBox for Windows 网络还原工具
chcp 65001 >nul

:: ========================================================
:: 1. 管理员权限自提权检测 (UAC)
:: ========================================================
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [提示] 正在请求管理员权限以还原网络路由和 DNS...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo ========================================================
echo       正在彻底清理旁路由临时路由，还原 Windows 默认网络
echo ========================================================
echo.

:: 1. 停止客户端本地后台服务 (端口 3038)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3038" ^| findstr "LISTENING"') do (
    if not "%%a"=="" (
        taskkill /F /PID %%a >nul 2>&1
    )
)

:: 2. 删除指向 192.168.3.2 旁路由的低跃点临时默认路由
route delete 0.0.0.0 192.168.3.2 >nul 2>&1

:: 3. 恢复所有活动物理网卡的 DNS 为自动获取 (DHCP)
powershell -NoProfile -Command "Get-NetIPInterface -AddressFamily IPv4 | Where-Object { $_.ConnectionState -eq 'Connected' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }" >nul 2>&1

:: 4. 刷新本地 DNS 缓存
ipconfig /flushdns >nul 2>&1

echo [完成] Windows 本地网络已彻底恢复！
echo 当前网络状态：已恢复主路由 (192.168.3.1) 直连与自动获取 DNS。
echo.
pause
exit /b 0
