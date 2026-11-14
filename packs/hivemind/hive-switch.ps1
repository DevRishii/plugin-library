# Hivemind Swarm v2.5 stack + topology switcher.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
param(
    [Parameter(Position=0)][string]$Command = "status",
    [Parameter(Position=1)][string]$Target = ""
)

$ErrorActionPreference = "Stop"
$HivemindHome = if ($env:HIVEMIND_HOME) { $env:HIVEMIND_HOME } else { Join-Path $HOME ".config\hivemind" }
$OpenCodeDir  = if ($env:OPENCODE_DIR)  { $env:OPENCODE_DIR }  else { Join-Path $HOME ".config\opencode" }
$ProfilesDir  = Join-Path $HivemindHome "profiles"
$ActiveFile   = Join-Path $HivemindHome "active_profile"
$Utf8NoBom    = New-Object System.Text.UTF8Encoding($false)
$MarkBegin    = "<!-- HIVEMIND:TOPOLOGY:BEGIN -->"
$MarkEnd      = "<!-- HIVEMIND:TOPOLOGY:END -->"

function Read-Text([string]$Path) { [System.IO.File]::ReadAllText($Path, $Utf8NoBom) }
function Write-Text([string]$Path, [string]$Text) { [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom) }
function Fail([string]$Message) { [Console]::Error.WriteLine("[hive-switch] ERROR: $Message"); exit 1 }

# Stack-independent configuration (openai provider options, plugins) lives in
# base-opencode.json and is deep-merged under each profile's opencode_config.
# Profile values win on conflict, so a profile can override any base key.
function Test-ConfigObject($Value) { return ($null -ne $Value -and $Value -is [System.Management.Automation.PSCustomObject]) }

function Merge-Config($Base, $Override) {
    if (-not (Test-ConfigObject $Base)) { return $Override }
    if (-not (Test-ConfigObject $Override)) { return $Override }
    $Out = New-Object System.Management.Automation.PSObject
    foreach ($Prop in $Base.PSObject.Properties) {
        $Out | Add-Member -MemberType NoteProperty -Name $Prop.Name -Value $Prop.Value
    }
    foreach ($Prop in $Override.PSObject.Properties) {
        $Existing = $null
        if ($Out.PSObject.Properties[$Prop.Name]) { $Existing = $Out.PSObject.Properties[$Prop.Name].Value }
        $Merged = Merge-Config $Existing $Prop.Value
        if ($Out.PSObject.Properties[$Prop.Name]) {
            $Out.PSObject.Properties[$Prop.Name].Value = $Merged
        } else {
            $Out | Add-Member -MemberType NoteProperty -Name $Prop.Name -Value $Merged
        }
    }
    return $Out
}

function Get-BaseConfig {
    $Path = Join-Path $HivemindHome "base-opencode.json"
    if (-not (Test-Path $Path)) { return $null }
    try {
        return (Read-Text $Path | ConvertFrom-Json)
    } catch {
        Fail "base-opencode.json is not valid JSON: $($_.Exception.Message)"
    }
}

function Get-ProfileNames {
    Get-ChildItem $ProfilesDir -Filter *.json | Sort-Object Name | ForEach-Object { $_.BaseName }
}

function Get-HiveProfile([string]$Name) {
    $Path = Join-Path $ProfilesDir "$Name.json"
    if (-not (Test-Path $Path)) { Fail "Unknown profile '$Name'. Run 'hive-switch list'." }
    $Data = Read-Text $Path | ConvertFrom-Json
    foreach ($Key in "agent_models", "opencode_config", "topology") {
        if (-not $Data.PSObject.Properties[$Key]) { Fail "Profile '$Name' is missing required key '$Key'." }
    }
    foreach ($Key in "name", "max_parallel_subagents", "verification_gate", "directive") {
        if (-not $Data.topology.PSObject.Properties[$Key]) { Fail "Profile '$Name' topology is missing '$Key'." }
    }
    $Max = $Data.topology.max_parallel_subagents
    if ($Max -isnot [int] -and $Max -isnot [long]) { Fail "Profile '$Name': max_parallel_subagents must be an integer." }
    if ($Max -lt 1 -or $Max -gt 12) { Fail "Profile '$Name': max_parallel_subagents must be 1..12 (got $Max)." }
    $Data
}

function Get-ActiveName {
    if (Test-Path $ActiveFile) { (Read-Text $ActiveFile).Trim() } else { "" }
}

function Format-Summary($Data) {
    $Topo = $Data.topology
    "{0} | Topology: {1} | MAX_PARALLEL_SUBAGENTS={2} | Gate: {3}" -f $Data.profile_id, $Topo.name, $Topo.max_parallel_subagents, (($Topo.verification_gate | ForEach-Object { "@$_" }) -join " + ")
}

# Patch `model:` / `steps:` inside the YAML frontmatter only (never the prompt body).
function Set-AgentFrontmatter([string]$Path, [string]$Model, $Steps) {
    $Text = Read-Text $Path
    $Fm = [regex]::Match($Text, "\A---\r?\n([\s\S]*?)\r?\n---")
    if (-not $Fm.Success) { Fail "No YAML frontmatter in $Path" }
    $Front = $Fm.Groups[1].Value
    $ModelRx = [regex]"(?m)^model:[^\r\n]*"
    if (-not $ModelRx.IsMatch($Front)) { Fail "No 'model:' line in frontmatter of $Path" }
    $Front = $ModelRx.Replace($Front, [System.Text.RegularExpressions.MatchEvaluator]{ param($x) "model: $Model" }, 1)
    if ($null -ne $Steps) {
        # 'maxSteps' is deprecated in the OpenCode schema; normalise to 'steps'.
        $Front = [regex]::Replace($Front, "(?m)^maxSteps:[^\r\n]*\r?\n?", "")
        $StepsRx = [regex]"(?m)^steps:[^\r\n]*"
        if ($StepsRx.IsMatch($Front)) {
            $Front = $StepsRx.Replace($Front, [System.Text.RegularExpressions.MatchEvaluator]{ param($x) "steps: $Steps" }, 1)
        } else {
            $Front = $ModelRx.Replace($Front, [System.Text.RegularExpressions.MatchEvaluator]{ param($x) $x.Value + "`nsteps: $Steps" }, 1)
        }
    }
    $Grp = $Fm.Groups[1]
    Write-Text $Path ($Text.Substring(0, $Grp.Index) + $Front + $Text.Substring($Grp.Index + $Grp.Length))
}

function Build-TopologyBlock($Data) {
    $Topo = $Data.topology
    $Gate = ($Topo.verification_gate | ForEach-Object { "@$_" }) -join ", "
    $Models = ($Data.agent_models.PSObject.Properties | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }) -join "; "
    $Lines = @(
        $MarkBegin,
        "## ACTIVE STACK TOPOLOGY",
        "Generated by hive-switch. Do not edit by hand; edit profiles/$($Data.profile_id).json instead.",
        "",
        "- Stack: ``$($Data.profile_id)``",
        "- Topology: **$($Topo.name)**",
        "- MAX_PARALLEL_SUBAGENTS=$($Topo.max_parallel_subagents) (hard cap on subagent calls per single-message batch)",
        "- Verification gate (spawn concurrently in ONE batch): $Gate"
    )
    if ($Topo.PSObject.Properties["agent_steps"]) {
        $StepList = ($Topo.agent_steps.PSObject.Properties | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }) -join ", "
        if ($StepList) { $Lines += "- Step budgets: $StepList" }
    }
    $Lines += "- Models: $Models"
    $Lines += ""
    $Lines += "### Stack directive for hivemind-architect"
    $Lines += $Topo.directive
    $Lines += $MarkEnd
    $Lines -join "`n"
}

function Update-AgentsMd($Data) {
    $Path = Join-Path $OpenCodeDir "AGENTS.md"
    if (-not (Test-Path $Path)) { Fail "Missing $Path" }
    $Text = Read-Text $Path
    $Block = Build-TopologyBlock $Data
    $B = $Text.IndexOf($MarkBegin)
    $E = $Text.IndexOf($MarkEnd)
    if ($B -ge 0 -and $E -gt $B) {
        $Text = $Text.Substring(0, $B) + $Block + $Text.Substring($E + $MarkEnd.Length)
    } elseif ($B -lt 0 -and $E -lt 0) {
        $Text = $Text.TrimEnd() + "`n`n" + $Block + "`n"
    } else {
        Fail "AGENTS.md topology markers are unbalanced; fix $Path by hand."
    }
    Write-Text $Path $Text
}

# Keep ~/.config/hivemind/opencode as a mirror of the live roster.
function Sync-Mirror {
    $Mirror = Join-Path $HivemindHome "opencode"
    New-Item -ItemType Directory -Force $Mirror | Out-Null
    foreach ($Sub in "agents", "commands") {
        $Src = Join-Path $OpenCodeDir $Sub
        $Dst = Join-Path $Mirror $Sub
        if (Test-Path $Src) {
            if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
            Copy-Item $Src $Dst -Recurse
        }
    }
    Copy-Item (Join-Path $OpenCodeDir "AGENTS.md") (Join-Path $Mirror "AGENTS.md") -Force
}

function Invoke-Validate([string]$Which) {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) { Fail "opencode CLI not found on PATH; cannot validate model IDs." }
    $ErrorActionPreference = "Continue"
    $Known = @(& opencode models 2>$null | ForEach-Object { "$_".Trim() } | Where-Object { $_ -match "^[^\s/]+/\S+$" })
    $ErrorActionPreference = "Stop"
    if ($Known.Count -eq 0) { Fail "'opencode models' returned no models." }
    $Names = if ($Which -eq "all") { @(Get-ProfileNames) } elseif ($Which) { @($Which) } else { @(Get-ActiveName) }
    $Bad = 0
    foreach ($Name in $Names) {
        $Data = Get-HiveProfile $Name
        $Ids = @($Data.agent_models.PSObject.Properties | ForEach-Object { $_.Value })
        $Ids += $Data.opencode_config.model
        $Ids += $Data.opencode_config.small_model
        $Missing = @($Ids | Sort-Object -Unique | Where-Object { $_ -and ($Known -notcontains $_) })
        if ($Missing.Count -eq 0) {
            Write-Host "[OK]   $Name - all model IDs resolve"
        } else {
            $Bad++
            Write-Host "[WARN] $Name - not in 'opencode models' (provider not authenticated?): $($Missing -join ', ')"
        }
    }
    if ($Bad -gt 0) { exit 2 }
    exit 0
}

if ($Command -in @("help", "--help", "-h")) {
    Write-Host "Usage: hive-switch <profile> | status | list | validate [profile|all]"
    Write-Host "  <profile>  write opencode.json, patch agent models + step budgets, and regenerate"
    Write-Host "             the ACTIVE STACK TOPOLOGY block in AGENTS.md"
    Write-Host "  validate   check a profile's model IDs against 'opencode models'"
    exit 0
}

if ($Command -eq "list") {
    $Active = Get-ActiveName
    foreach ($Name in Get-ProfileNames) {
        $Mark = if ($Name -eq $Active) { "*" } else { " " }
        Write-Host ("{0} {1}" -f $Mark, (Format-Summary (Get-HiveProfile $Name)))
    }
    exit 0
}

if ($Command -eq "status") {
    $Active = Get-ActiveName
    if (-not $Active) { Write-Host "Active Hivemind stack: (not set)"; exit 0 }
    Write-Host ("Active Hivemind stack: " + (Format-Summary (Get-HiveProfile $Active)))
    exit 0
}

if ($Command -eq "validate") { Invoke-Validate $Target }

# ---- switch ---------------------------------------------------------------
$Data = Get-HiveProfile $Command
$AgentsDir = Join-Path $OpenCodeDir "agents"

# Check everything up front so a bad profile cannot leave a half-switched config.
foreach ($Prop in $Data.agent_models.PSObject.Properties) {
    if (-not (Test-Path (Join-Path $AgentsDir "$($Prop.Name).md"))) {
        Fail "Profile '$Command' maps agent '$($Prop.Name)' but $AgentsDir\$($Prop.Name).md does not exist."
    }
}
foreach ($Member in $Data.topology.verification_gate) {
    if (-not $Data.agent_models.PSObject.Properties[$Member]) { Fail "verification_gate names unknown agent '$Member'." }
}
# Baseline step budgets, re-applied on every switch so a profile override never
# leaks into the next stack. Profiles override via topology.agent_steps.
$StepMap = @{ builder = 25; researcher = 12; scout = 8; surgeon = 15; verifier = 12; auditor = 10; oracle = 6; "spec-architect" = 12 }
foreach ($Name in @($StepMap.Keys)) {
    if (-not $Data.agent_models.PSObject.Properties[$Name]) { $StepMap.Remove($Name) }
}
if ($Data.topology.PSObject.Properties["agent_steps"]) {
    foreach ($Prop in $Data.topology.agent_steps.PSObject.Properties) {
        if (-not $Data.agent_models.PSObject.Properties[$Prop.Name]) { Fail "agent_steps names unknown agent '$($Prop.Name)'." }
        if ([int]$Prop.Value -lt 1) { Fail "agent_steps.$($Prop.Name) must be >= 1." }
        $StepMap[$Prop.Name] = [int]$Prop.Value
    }
}

$BaseConfig = Get-BaseConfig
$EffectiveConfig = if ($null -ne $BaseConfig) { Merge-Config $BaseConfig $Data.opencode_config } else { $Data.opencode_config }
Write-Text (Join-Path $OpenCodeDir "opencode.json") (($EffectiveConfig | ConvertTo-Json -Depth 20) + "`n")

foreach ($Prop in $Data.agent_models.PSObject.Properties) {
    $Steps = if ($StepMap.ContainsKey($Prop.Name)) { $StepMap[$Prop.Name] } else { $null }
    Set-AgentFrontmatter (Join-Path $AgentsDir "$($Prop.Name).md") $Prop.Value $Steps
}

Update-AgentsMd $Data
Sync-Mirror
Write-Text $ActiveFile "$Command`n"
Write-Host ("[OK] Hivemind stack: " + (Format-Summary $Data))
