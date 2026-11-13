@echo off
rem ============================================================
rem  闲鱼自动化工作台 - 服务管理脚本（SQLite 零依赖版）
rem  功能：启动 / 停止 / 重启 / 诊断 / 修改端口 / 重置密码 / 前台调试
rem  用法：
rem    双击运行        进入交互菜单
rem    start.bat start|stop|restart|status|diag|port|resetpw   命令行模式
rem  注意：本文件需以 ANSI(GBK) 编码、CRLF 换行保存
rem ============================================================
setlocal
cd /d "%~dp0"
title 闲鱼工作台服务管理

rem ---------- 读取 .env 基础配置（缺失时用默认值兜底） ----------
set "APP_PORT=8080"
set "APP_HOST=127.0.0.1"
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul 2>&1
if not exist ".env" (
  > ".env" echo PORT=8080
  >> ".env" echo HOST=127.0.0.1
  >> ".env" echo SQLITE_PATH=data/xianyu_workbench.db
)
for /f "tokens=2 delims==" %%a in ('findstr /B /C:"PORT=" .env') do set "APP_PORT=%%a"
for /f "tokens=2 delims==" %%a in ('findstr /B /C:"HOST=" .env') do set "APP_HOST=%%a"
set "APP_PORT=%APP_PORT: =%"
set "APP_HOST=%APP_HOST: =%"
if "%APP_HOST%"=="0.0.0.0" (set "CHKHOST=127.0.0.1") else set "CHKHOST=%APP_HOST%"

rem ---------- 命令行模式：start.bat start|stop|restart|status|diag|port|resetpw ----------
if not "%~1"=="" set "INTERACTIVE=0"
if /I "%~1"=="start" goto do_start
if /I "%~1"=="stop" goto do_stop
if /I "%~1"=="restart" goto do_restart
if /I "%~1"=="status" goto do_status
if /I "%~1"=="diag" goto do_diag
if /I "%~1"=="port" goto do_port
if /I "%~1"=="resetpw" goto do_resetpw
if not "%~1"=="" (
  echo 用法: start.bat [start^|stop^|restart^|status^|diag^|port^|resetpw]  不带参数进入交互菜单
  goto after_done
)
set "INTERACTIVE=1"

rem ================= 交互菜单 =================
:menu
cls
call :status
echo.
echo  ============================================================
echo    闲鱼自动化工作台 - 服务管理
echo    目录: %~dp0
echo    状态: %STATUS_TEXT%
echo    地址: http://%APP_HOST%:%APP_PORT%
echo  ============================================================
echo.
echo    [1] 启动服务
echo    [2] 停止服务
echo    [3] 重启服务
echo    [4] 查看诊断
echo    [5] 修改端口
echo    [6] 重置登录密码
echo    [7] 前台调试模式（本窗口直接运行，Ctrl+C 停止）
echo    [0] 退出
echo.
set "CHOICE="
set /p CHOICE=  请输入编号后回车:
if "%CHOICE%"=="1" (call :do_start & goto after_action)
if "%CHOICE%"=="2" (call :do_stop & goto after_action)
if "%CHOICE%"=="3" (call :do_restart & goto after_action)
if "%CHOICE%"=="4" (call :do_diag & goto after_action)
if "%CHOICE%"=="5" (call :do_port & goto after_action)
if "%CHOICE%"=="6" (call :do_resetpw & goto after_action)
if "%CHOICE%"=="7" (call :do_foreground & goto after_action)
if "%CHOICE%"=="0" exit /b 0
goto menu

:after_action
echo.
pause
goto menu

rem ================= 动作入口 =================

:do_start
call :startsvc
goto after_done

:do_stop
echo.
call :stopsvc
goto after_done

:do_restart
echo.
echo 正在重启服务...
call :stopsvc
call :startsvc
goto after_done

:do_status
echo.
call :status
echo 服务状态: %STATUS_TEXT%
goto after_done

:do_diag
cls
echo.
echo  =====================  诊  断  =====================
echo.
echo [1/6] Node.js 版本
where node >nul 2>&1
if errorlevel 1 (echo   [FAIL] 未找到 node，请安装 Node.js 22.5+ 并加入 PATH) else (node -v)
echo.
echo [2/6] 运行环境检查
if exist "src\db.js" (echo   [OK] 零外部依赖：数据库为 Node 内置 node:sqlite，无需安装任何包) else (echo   [FAIL] 缺少 src\db.js，项目文件不完整)
echo.
echo [3/6] 运行状态与端口
call :status
echo   %STATUS_TEXT%
netstat -ano | findstr /R /C:":%APP_PORT% " | findstr /I "LISTENING" >nul 2>&1
if errorlevel 1 (echo   端口 %APP_PORT%: 空闲) else (echo   端口 %APP_PORT%: 监听中)
echo.
echo [4/6] 深度检查（健康检查 + 数据库连通性 + 最近系统日志）
where node >nul 2>&1
if errorlevel 1 (echo   [跳过] 未找到 node) else (node scripts\doctor.js)
echo.
echo [5/6] 最近运行日志（logs\app-*.log 最后 15 行）
powershell -NoProfile -Command "$f = Get-ChildItem -Path '%~dp0logs' -Filter 'app-*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if ($f) { Get-Content -Path $f.FullName -Tail 15 -Encoding UTF8 } else { Write-Output '  （暂无运行日志）' }"
echo.
echo [6/6] 后台错误输出（logs\service-err.log 最后 15 行）
powershell -NoProfile -Command "$p='%~dp0logs\service-err.log'; if (Test-Path $p) { Get-Content -Path $p -Tail 15 -Encoding UTF8 } else { Write-Output '  （暂无错误输出）' }"
echo.
echo  ==================  诊断结束  ======================
goto after_done

:do_port
echo.
echo 当前端口: %APP_PORT%（对应 .env 的 PORT=）
set "NEWPORT="
set /p NEWPORT=请输入新端口（1-65535，直接回车取消）:
if not defined NEWPORT goto port_cancel
rem 去掉可能的空格（手输或粘贴带空格时仍可用）
set "NEWPORT=%NEWPORT: =%"
if not defined NEWPORT goto port_cancel
powershell -NoProfile -Command "$v='%NEWPORT%'.Trim(); if ($v -notmatch '^[0-9]{1,5}$' -or [int]$v -lt 1 -or [int]$v -gt 65535) { Write-Output 'INVALID' } else { $p='%~dp0.env'; $t=[System.IO.File]::ReadAllText($p,[System.Text.Encoding]::UTF8); $t=[regex]::Replace($t,'(?m)^PORT\s*=.*$','PORT='+[int]$v); [System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false))); Write-Output ('OK' + [int]$v) }" > "%TEMP%\xy_port_result.txt"
set "PRTRESULT="
set /p PRTRESULT=<"%TEMP%\xy_port_result.txt"
del /q "%TEMP%\xy_port_result.txt" >nul 2>&1
if not defined PRTRESULT (
  echo [错误] 写入 .env 失败，请检查文件权限。
  goto after_done
)
if "%PRTRESULT%"=="INVALID" (
  echo [错误] 端口无效，请输入 1-65535 的数字。
  goto after_done
)
set "APP_PORT=%PRTRESULT:~2%"
echo [完成] 已将 .env 的 PORT 修改为 %APP_PORT%
call :status
if not "%RUNNING%"=="1" goto port_no_restart
echo.
set "RESTARTNOW="
set /p RESTARTNOW=服务正在运行，立即重启以生效? (Y/N):
if /I "%RESTARTNOW%"=="Y" (
  call :stopsvc
  call :startsvc
) else (
  echo 稍后请通过菜单 [3] 重启服务使新端口生效。
)
goto after_done
:port_no_restart
echo 服务当前未运行，下次启动将使用新端口。
goto after_done
:port_cancel
echo 已取消。
goto after_done

:do_resetpw
echo.
echo 即将重置工作台登录密码（用户表 xy_users，scrypt 加密，与 src/auth.js 一致）。
where node >nul 2>&1 || (echo [错误] 未找到 node，无法执行重置 & goto after_done)
node scripts\reset-password.js
goto after_done

:do_foreground
echo.
call :status
if "%RUNNING%"=="1" (
  echo [提示] 后台服务正在运行（%STATUS_TEXT%），请先停止再使用前台模式。
  goto after_done
)
echo 即将在本窗口前台运行服务，按 Ctrl+C 停止，关闭窗口即结束服务。
echo.
node src/index.js
echo.
echo 服务已退出。
goto after_done

rem ================= 底层子过程 =================

rem --- 状态检测：RUNNING=1/0，RUNPID，STATUS_TEXT（快速：pid 文件 + 端口探测） ---
:status
set "RUNNING=0"
set "RUNPID="
set "STATUS_TEXT=未运行"
if exist "logs\app.pid" set /p RUNPID=<"logs\app.pid"
if defined RUNPID tasklist /FI "PID eq %RUNPID%" 2>nul | find /I "node.exe" >nul 2>&1 && goto status_alive
set "RUNPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%APP_PORT% " ^| findstr /I "LISTENING"') do if not defined RUNPID set "RUNPID=%%p"
if not defined RUNPID goto :eof
set "OTHERIMG=未知进程"
for /f "usebackq tokens=1 delims=," %%n in (`tasklist /FI "PID eq %RUNPID%" /FO CSV /NH 2^>nul`) do set "OTHERIMG=%%~n"
tasklist /FI "PID eq %RUNPID%" 2>nul | find /I "node.exe" >nul 2>&1 && goto status_alive
set "STATUS_TEXT=端口 %APP_PORT% 被 %OTHERIMG% 占用（PID %RUNPID%），本服务未运行"
goto :eof
:status_alive
set "RUNNING=1"
set "STATUS_TEXT=运行中（PID %RUNPID%）"
goto :eof

rem --- 健康探测：HEALTH_OK=1/0 ---
:healthprobe
set "HEALTH_OK=0"
curl.exe -s -f -m 2 -o NUL "http://%CHKHOST%:%APP_PORT%/health" >nul 2>&1 && set "HEALTH_OK=1"
goto :eof

rem --- 启动服务 ---
:startsvc
echo.
call :status
if "%RUNNING%"=="1" (
  echo [提示] 服务已在运行（%STATUS_TEXT%），如需重启请选 [3]。
  goto :eof
)
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 node 命令，请先安装 Node.js 22.5+ 并加入 PATH。
  goto :eof
)
if not exist "sql\schema.sql" (
  echo [错误] 缺少 sql\schema.sql，请确认项目文件完整。
  goto :eof
)
if not exist "logs" mkdir "logs"
echo 正在启动服务（隐藏后台窗口）...
powershell -NoProfile -Command "$p = Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden -RedirectStandardOutput '%~dp0logs\service-out.log' -RedirectStandardError '%~dp0logs\service-err.log' -PassThru; Set-Content -Path '%~dp0logs\app.pid' -Value $p.Id -Encoding ascii"
echo 等待健康检查通过...
set "TRIES=0"
:start_wait
timeout /t 1 /nobreak >nul 2>&1
call :healthprobe
if "%HEALTH_OK%"=="1" goto start_ok
set /a TRIES+=1
if %TRIES% lss 12 goto start_wait
echo.
echo [失败] 12 秒内健康检查未通过，服务可能启动失败（如端口被占用、数据库文件损坏等）。
echo        请选 [4] 查看诊断，重点看 [6/6] service-err.log 的报错。
goto :eof
:start_ok
echo.
echo [成功] 服务已启动: http://%APP_HOST%:%APP_PORT%  （默认账号 admin/admin123，登录后请及时修改）
start "" "http://%APP_HOST%:%APP_PORT%"
goto :eof

rem --- 停止服务 ---
:stopsvc
call :status
if "%RUNNING%"=="1" (
  if defined RUNPID taskkill /PID %RUNPID% /T /F >nul 2>&1
)
rem 双保险：按命令行特征清理残留的本服务 node 进程（覆盖 pid 文件丢失或前台模式启动的情况）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[/\\]index\.js' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }"
del /q "logs\app.pid" >nul 2>&1
timeout /t 1 /nobreak >nul 2>&1
call :status
if "%RUNNING%"=="1" (
  echo [警告] 端口 %APP_PORT% 仍被 PID %RUNPID% 占用（非本服务进程），请手动处理。
) else (
  echo [完成] 服务已停止。
)
goto :eof

rem ================= 公共出口：交互模式暂停后回菜单，命令行模式直接结束 =================
:after_done
if "%INTERACTIVE%"=="1" (
  echo.
  pause
  goto menu
)
goto :eof
