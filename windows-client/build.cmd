@echo off
setlocal

where msbuild >nul 2>nul
if errorlevel 1 (
  echo MSBuild was not found. Install Visual Studio Build Tools with the .NET Framework 4.8 targeting pack.
  exit /b 1
)

msbuild "%~dp0MyBox.csproj" /t:Rebuild /p:Configuration=Release /p:Platform=AnyCPU
if errorlevel 1 exit /b %errorlevel%

echo Build output: "%~dp0build\Release\MyBox.exe"
endlocal
