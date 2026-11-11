@echo off
setlocal
if "%~1"=="" (
  echo Uso: aggiorna-listini-awin.cmd ID_PUBLISHER
  exit /b 1
)
pushd "%~dp0" || exit /b 1
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $tmp=Join-Path (Get-Location) ('scarica-listini-awin.' + [guid]::NewGuid().ToString('N') + '.cjs'); $result=0; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/davimarz/archivioscarpe/refs/heads/tools/awin-playwright/tools/awin/scarica-listini-awin.cjs' -OutFile $tmp; node --check $tmp; if ($LASTEXITCODE -ne 0) { throw 'Script non valido' }; Move-Item -LiteralPath $tmp -Destination 'scarica-listini-awin.cjs' -Force } catch { [Console]::Error.WriteLine($_.Exception.Message); $result=1 } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue } }; exit $result"
if errorlevel 1 (
  echo Aggiornamento non riuscito. Nessun download Awin avviato.
  popd
  exit /b 1
)
node ".\scarica-listini-awin.cjs" "%~1"
set "AWIN_RESULT=%ERRORLEVEL%"
popd
exit /b %AWIN_RESULT%
