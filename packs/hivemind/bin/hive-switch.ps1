# Forwarder: the single source of truth is ~/.config/hivemind/hive-switch.ps1
$Real = Join-Path $HOME ".config\hivemind\hive-switch.ps1"
if (-not (Test-Path $Real)) { [Console]::Error.WriteLine("[hive-switch] ERROR: missing $Real"); exit 1 }
& $Real @args
exit $LASTEXITCODE
