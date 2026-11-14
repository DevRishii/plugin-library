<#
  install.ps1 — Hivemind Stack Switcher for OpenCode v2 (Windows)

  What you get in the composer after installing:
    /stack                    -> show the active stack + topology
    /stack/chatgpt-deepseek   -> pick a stack from the list (descriptions shown)
    /stack/claude-hybrid
    /stack/claude-native
    /stack/argon-deepseek
    /stack/opencode-go-max
    /swarm <task>             -> adaptive DAG swarm
    /brainstorm <dump>        -> compile the dump to .opencode/SPEC.md
    /pr-review <pr-link>      -> multi-angle PR review swarm (parallel lenses + intent gate)

  Installs:
    %USERPROFILE%\.config\hivemind\profiles\*.json
    %USERPROFILE%\.config\hivemind\base-opencode.json
    %USERPROFILE%\.config\hivemind\hive-switch.ps1
    %USERPROFILE%\.config\opencode\AGENTS.md, agents\, commands\, skills\
    %USERPROFILE%\.config\opencode\skills\token-discipline\ and skills\pr-review\ (incl. lenses\)
    %USERPROFILE%\.config\opencode\skills\pr-review\engine\ (bin\, src\, package.json, README.md)
    %USERPROFILE%\.config\opencode\commands\stack.md + commands\stack\*.md
    %USERPROFILE%\.local\bin\hive-switch.cmd + hive-switch.ps1 (forwarder)

  Safe by default:
    - existing profiles and opencode.json are backed up (.bak.<timestamp>)
    - existing agent prompts, AGENTS.md, /swarm, /brainstorm, /pr-review and /audit-diff are left alone
    - opencode.json is NOT rewritten unless you pass -Activate <profile>

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Activate chatgpt-deepseek
    powershell -ExecutionPolicy Bypass -File install.ps1 -Force   # overwrite prompt files
    powershell -ExecutionPolicy Bypass -File install.ps1 -ReinstallPRReview
        # refresh ONLY the PR-review command, agent, skill, lenses, and engine;
        # leaves profiles, AGENTS.md, opencode.json, other commands/agents, and PATH untouched
#>
[CmdletBinding()]
param(
  [string]$Activate = '',
  [switch]$Force,
  [switch]$ReinstallPRReview
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

function Install-DirFiles([string]$SourceDir, [string]$DestDir, [switch]$KeepExisting) {
  if (-not (Test-Path $SourceDir)) { return }
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  Get-ChildItem $SourceDir -File | ForEach-Object {
    Install-File $_.FullName (Join-Path $DestDir $_.Name) -KeepExisting:$KeepExisting
  }
}

# The engine lives with the installed skill so the command never depends on a
# repository checkout: ~/.config/opencode/skills/pr-review/engine/{bin,src}.
function Install-PRReviewEngine([switch]$KeepExisting) {
  $engineSrc = Join-Path (Split-Path -Parent (Split-Path -Parent $Root)) 'plugins\pr-review'
  if (-not (Test-Path $engineSrc)) { Warn "pr-review engine source not found: $engineSrc"; return }
  $engineDst = Join-Path $OcDir 'skills\pr-review\engine'
  Install-DirFiles (Join-Path $engineSrc 'bin') (Join-Path $engineDst 'bin') -KeepExisting:$KeepExisting
  Install-DirFiles (Join-Path $engineSrc 'src') (Join-Path $engineDst 'src') -KeepExisting:$KeepExisting
  Install-File (Join-Path $engineSrc 'package.json') (Join-Path $engineDst 'package.json') -KeepExisting:$KeepExisting
  Install-File (Join-Path $engineSrc 'README.md') (Join-Path $engineDst 'README.md') -KeepExisting:$KeepExisting
}

function Install-PRReviewAssets([switch]$Overwrite) {
  $keep = -not $Overwrite
  Install-File (Join-Path $Root 'opencode\commands\pr-review.md') (Join-Path $OcDir 'commands\pr-review.md') -KeepExisting:$keep
  Install-File (Join-Path $Root 'opencode\agents\pr-reviewer.md') (Join-Path $OcDir 'agents\pr-reviewer.md') -KeepExisting:$keep
  Install-File (Join-Path $Root 'opencode\skills\pr-review\SKILL.md') (Join-Path $OcDir 'skills\pr-review\SKILL.md') -KeepExisting:$keep
  $srcLenses = Join-Path $Root 'opencode\skills\pr-review\lenses'
  if (Test-Path $srcLenses) {
    New-Item -ItemType Directory -Path (Join-Path $OcDir 'skills\pr-review\lenses') -Force | Out-Null
    Get-ChildItem (Join-Path $srcLenses '*.md') | ForEach-Object {
      Install-File $_.FullName (Join-Path (Join-Path $OcDir 'skills\pr-review\lenses') $_.Name) -KeepExisting:$keep
    }
  }
  Install-PRReviewEngine -KeepExisting:$keep
}

Say ""
Say "=================================================================="
Say "  HIVEMIND STACK SWITCHER -> OpenCode v2 (Windows)"
Say "=================================================================="

$oc = Get-Command opencode -ErrorAction SilentlyContinue
if ($oc) { Ok "opencode found: $($oc.Source)" }
else { Warn "opencode not on PATH. Install OpenCode v2 (Desktop + CLI 2.2.x+) first." }

foreach ($d in @((Join-Path $HmHome 'profiles'), (Join-Path $OcDir 'agents'), (Join-Path $OcDir 'commands'),
                 (Join-Path $OcDir 'commands\stack'), (Join-Path $OcDir 'skills\token-discipline'),
                 (Join-Path $OcDir 'skills\pr-review\lenses'), $BinDir)) {
  New-Item -ItemType Directory -Path $d -Force | Out-Null
}

if ($ReinstallPRReview) {
  Say ""
  Say "Focused reinstall -> PR-review assets only"
  Install-PRReviewAssets -Overwrite
  Say ""
  Say "Done. Profiles, AGENTS.md, opencode.json, other commands/agents, and PATH were not touched."
  Say "Restart OpenCode Desktop once to reload the refreshed PR-review assets."
  exit 0
}

Say ""
Say "Profiles -> $HmHome\profiles"
Get-ChildItem (Join-Path $Root 'profiles\*.json') | ForEach-Object {
  Install-File $_.FullName (Join-Path (Join-Path $HmHome 'profiles') $_.Name)
}
Install-File (Join-Path $Root 'base-opencode.json') (Join-Path $HmHome 'base-opencode.json')

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
foreach ($skill in 'token-discipline', 'pr-review') {
  $srcSkill = Join-Path $Root (Join-Path 'opencode\skills' $skill)
  $dstSkill = Join-Path $OcDir (Join-Path 'skills' $skill)
  Install-File (Join-Path $srcSkill 'SKILL.md') (Join-Path $dstSkill 'SKILL.md') -KeepExisting
  $srcLenses = Join-Path $srcSkill 'lenses'
  if (Test-Path $srcLenses) {
    New-Item -ItemType Directory -Path (Join-Path $dstSkill 'lenses') -Force | Out-Null
    Get-ChildItem (Join-Path $srcLenses '*.md') | ForEach-Object {
      Install-File $_.FullName (Join-Path (Join-Path $dstSkill 'lenses') $_.Name) -KeepExisting
    }
  }
}
Install-PRReviewEngine -KeepExisting

Say ""
Say "Switcher -> $HmHome + $BinDir"
Install-File (Join-Path $Root 'hive-switch.ps1') (Join-Path $HmHome 'hive-switch.ps1')
Install-File (Join-Path $Root 'bin\hive-switch.ps1') (Join-Path $BinDir 'hive-switch.ps1')
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
Say "  /pr-review <pr-link>    multi-angle PR review swarm"
Say "  OpenCode watches the config directory and reloads automatically."
Say "=================================================================="
