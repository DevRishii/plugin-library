param(
    [Parameter(Position=0)]
    [string]$Command = "status"
)

$HivemindHome = if ($env:HIVEMIND_HOME) { $env:HIVEMIND_HOME } else { Join-Path $HOME ".config\hivemind" }
$OpenCodeDir  = if ($env:OPENCODE_DIR)  { $env:OPENCODE_DIR }  else { Join-Path $HOME ".config\opencode" }

if ($Command -in @("list", "help", "--help", "-h")) {
    Write-Host "=================================================================="
    Write-Host "  HIVEMIND SWARM PROFILE SWITCHER (Windows PowerShell)"
    Write-Host "=================================================================="
    Write-Host "Usage: hive-switch <profile-name> | status | list"
    Write-Host ""
    Write-Host "Profiles: chatgpt-deepseek | claude-hybrid | claude-native | argon-deepseek | opencode-go-max"
    exit 0
}

if ($Command -eq "status") {
    $ActiveFile = Join-Path $HivemindHome "active_profile"
    if (Test-Path $ActiveFile) {
        Write-Host "Active Hivemind Profile: $(Get-Content $ActiveFile -Raw)".Trim()
    } else {
        Write-Host "Active Hivemind Profile: (not set)"
    }
    exit 0
}

$ProfilePath = Join-Path $HivemindHome "profiles\$Command.json"
if (-not (Test-Path $ProfilePath)) {
    Write-Error "Unknown profile '$Command'. Run 'hive-switch list'."
    exit 1
}

$Data = Get-Content $ProfilePath -Raw | ConvertFrom-Json
$TargetCfg = Join-Path $OpenCodeDir "opencode.json"
$Data.opencode_config | ConvertTo-Json -Depth 10 | Set-Content -Path $TargetCfg -Encoding UTF8

foreach ($Prop in $Data.agent_models.PSObject.Properties) {
    $AgentFile = Join-Path $OpenCodeDir "agents\$($Prop.Name).md"
    if (Test-Path $AgentFile) {
        $Content = Get-Content $AgentFile -Raw
        $Updated = $Content -replace "(?m)^model:\s*.*$", "model: $($Prop.Value)"
        Set-Content -Path $AgentFile -Value $Updated -Encoding UTF8
    }
}

Set-Content -Path (Join-Path $HivemindHome "active_profile") -Value $Command -Encoding UTF8
Write-Host "[OK] Switched Hivemind profile to: $Command"
