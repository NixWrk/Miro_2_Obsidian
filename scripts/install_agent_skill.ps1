[CmdletBinding()]
param(
    # Which repository skill to install: the maintenance skill, or the board
    # format skill (miro-canvas-format) for agents that read and edit boards.
    [string]$Name = "maintain-miro-2-obsidian",
    # Which agent's skill folder receives it.
    [ValidateSet("codex", "claude")]
    [string]$Agent = "codex",
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $repositoryRoot ".agents\skills\$Name"

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    throw "Repository skill is missing: $source"
}

if (-not $Destination) {
    if ($Agent -eq "claude") {
        $agentRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".claude"
    }
    else {
        $agentRoot = [Environment]::GetEnvironmentVariable("CODEX_HOME")
        if (-not $agentRoot) {
            $agentRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex"
        }
    }
    $Destination = Join-Path $agentRoot "skills\$Name"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $Destination -Recurse -Force

Write-Host "Installed $Name to $Destination"
Write-Host "Invoke it as: `$$Name"
