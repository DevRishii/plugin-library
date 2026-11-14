@echo off
rem Resolve the existing portable Node runtime without downloading anything.
rem Installed only when no working `node` is already on PATH.
if not defined USERPROFILE set "USERPROFILE=%HOMEDRIVE%%HOMEPATH%"
set "HIVEMIND_NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%HIVEMIND_NODE_EXE%" (
  echo [node.cmd] Portable Node runtime not found: "%HIVEMIND_NODE_EXE%" 1>&2
  exit /b 127
)
"%HIVEMIND_NODE_EXE%" %*
exit /b %errorlevel%
