<#
  install.ps1 — Hivemind Stack Switcher for OpenCode v2 (Windows)

  What you get in the composer after installing:
    /stack                    -> show the active stack
    /stack/chatgpt-deepseek   -> pick a stack from the list (descriptions shown)
    /stack/claude-hybrid
    /stack/claude-native
    /stack/argon-deepseek
    /stack/opencode-go-max

  Installs:
    %USERPROFILE%\.config\hivemind\profiles\*.json
    %USERPROFILE%\.config\opencode\AGENTS.md, agents\, commands\, skills\
    %USERPROFILE%\.config\opencode\commands\stack.md + commands\stack\*.md
    %USERPROFILE%\.local\bin\hive-switch.cmd + hive-switch.ps1

  Safe by default:
    - existing profiles and opencode.json are backed up (.bak.<timestamp>)
    - existing agent prompts, AGENTS.md, swarm/audit-diff are left alone
    - opencode.json is NOT rewritten unless you pass -Activate <profile>

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Activate chatgpt-deepseek
    powershell -ExecutionPolicy Bypass -File install.ps1 -Force   # overwrite prompt files
#>
[CmdletBinding()]
param(
  [string]$Activate = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSCommandPath
$HomeDir = $env:USERPROFILE
$HmHome  = Join-Path $HomeDir '.config\hivemind'
$OcDir   = Join-Path $HomeDir '.config\opencode'
$BinDir  = Join-Path $HomeDir '.local\bin'
$stamp   = Get-Date -Format 'yyyyMMdd_HHmmss'

function Say  ($m) { Write-Host $m }
function Ok   ($m) { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Keep ($m) { Write-Host "  [keep] $m" -ForegroundColor DarkGray }
function Warn ($m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }

function Backup-IfExists([string]$Path) {
  if (Test-Path $Path) { Copy-Item $Path "$Path.bak.$stamp" -Force }
}

function Install-File([string]$Source, [string]$Dest, [switch]$KeepExisting) {
  if ($KeepExisting -and (Test-Path $Dest) -and -not $Force) { Keep (Split-Path $Dest -Leaf); return }
  Backup-IfExists $Dest
  Copy-Item $Source $Dest -Force
  Ok (Split-Path $Dest -Leaf)
}

Say ""
Say "=================================================================="
Say "  HIVEMIND STACK SWITCHER -> OpenCode v2 (Windows)"
Say "=================================================================="

$oc = Get-Command opencode -ErrorAction SilentlyContinue
if ($oc) { Ok "opencode found: $($oc.Source)" }
else { Warn "opencode not on PATH. Install OpenCode v2 (Desktop + CLI 2.2.x+) first." }

foreach ($d in @((Join-Path $HmHome 'profiles'), (Join-Path $OcDir 'agents'), (Join-Path $OcDir 'commands'),
                 (Join-Path $OcDir 'commands\stack'), (Join-Path $OcDir 'skills\token-discipline'), $BinDir)) {
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

Say ""
Say "Profiles -> $HmHome\profiles"
Get-ChildItem (Join-Path $Root 'profiles\*.json') | ForEach-Object {
  Install-File $_.FullName (Join-Path (Join-Path $HmHome 'profiles') $_.Name)
}

Say ""
Say "OpenCode config -> $OcDir"
Install-File (Join-Path $Root 'opencode\AGENTS.md') (Join-Path $OcDir 'AGENTS.md') -KeepExisting
Get-ChildItem (Join-Path $Root 'opencode\agents\*.md') | ForEach-Object {
  Install-File $_.FullName (Join-Path (Join-Path $OcDir 'agents') $_.Name) -KeepExisting
}
Get-ChildItem (Join-Path $Root 'opencode\commands\*.md') | ForEach-Object {
  Install-File $_.FullName (Join-Path (Join-Path $OcDir 'commands') $_.Name) -KeepExisting
}
Get-ChildItem (Join-Path $Root 'opencode\commands\stack\*.md') | ForEach-Object {
  Install-File $_.FullName (Join-Path (Join-Path $OcDir 'commands\stack') $_.Name) -KeepExisting
}
Install-File (Join-Path $Root 'opencode\skills\token-discipline\SKILL.md') `
             (Join-Path $OcDir 'skills\token-discipline\SKILL.md') -KeepExisting

Say ""
Say "Switcher -> $BinDir"
Install-File (Join-Path $Root 'bin\hive-switch.ps1') (Join-Path $BinDir 'hive-switch.ps1')
Install-File (Join-Path $Root 'bin\hive-switch.ps1') (Join-Path $HmHome 'hive-switch.ps1')
Install-File (Join-Path $Root 'bin\hive-switch.cmd') (Join-Path $BinDir 'hive-switch.cmd')

# --- point the /stack commands at this machine's switcher ---------------
# Invoke powershell explicitly: a bare "quoted\path.cmd" argument is a PARSE
# ERROR in PowerShell, while this form parses in both PowerShell and cmd.exe.
$ps1Path   = Join-Path $BinDir 'hive-switch.ps1'
$switchCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $ps1Path + '"'
$rendered  = 0
$targets = @(Join-Path $OcDir 'commands\stack.md') + @(Get-ChildItem (Join-Path $OcDir 'commands\stack\*.md') | ForEach-Object { $_.FullName })
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { continue }
  $text = Get-Content $t -Raw
  if ($text.Contains('{{HIVE_SWITCH_CMD}}')) {
    Set-Content -Path $t -Value $text.Replace('{{HIVE_SWITCH_CMD}}', $switchCmd) -Encoding UTF8
    $rendered++
  }
}
Say ""
Say "Commands -> $OcDir\commands"
Ok "$rendered command file(s) wired to $ps1Path"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  $newPath = if ([string]::IsNullOrWhiteSpace($userPath)) { $BinDir } else { "$userPath;$BinDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Warn "$BinDir added to User PATH (applies to new terminals)"
} else { Ok "$BinDir already on PATH" }

Say ""
if ($Activate) {
  Backup-IfExists (Join-Path $OcDir 'opencode.json')
  & (Join-Path $BinDir 'hive-switch.cmd') $Activate
} else {
  Say "Next steps:"
  Say "  1. Activate a stack:  hive-switch chatgpt-deepseek"
  Say "  2. Restart OpenCode Desktop once, then type /stack in the composer."
}

Say ""
Say "=================================================================="
Say "  DONE"
Say "=================================================================="
Say "  /stack                  show the active stack"
Say "  /stack/claude-hybrid    switch stack (pick any from the /stack list)"
Say "  OpenCode watches the config directory and reloads automatically."
Say "=================================================================="
