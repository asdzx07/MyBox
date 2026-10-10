@echo off
chcp 65001 >nul
title MyBox 网络还原工具
echo ===================================================
echo     MyBox - 正在恢复 Windows 默认网络设置 (DHCP)
echo ===================================================
echo.
echo 正在还原本地网卡设置...
for %%i in ("以太网" "WLAN" "Wi-Fi" "Ethernet" "本地连接") do (
    netsh interface ip set address name=%%i source=dhcp >nul 2>&1
    netsh interface ip set dns name=%%i source=dhcp >nul 2>&1
)
ipconfig /flushdns >nul 2>&1

echo.
echo [√] 网络已成功恢复为 DHCP 自动获取（直连主路由）！
echo [√] 本地 DNS 缓存已刷新。
echo.
pause