[CmdletBinding()]
param(
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$skillName = "maintain-miro-2-obsidian"
$source = Join-Path $repositoryRoot ".agents\skills\$skillName"

if (-not (Test-Path -LiteralPath (Join-Path $source "SKILL.md"))) {
    throw "Repository skill is missing: $source"
}

if (-not $Destination) {
    $codexRoot = [Environment]::GetEnvironmentVariable("CODEX_HOME")
    if (-not $codexRoot) {
        $codexRoot = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex"
    }
    $Destination = Join-Path $codexRoot "skills\$skillName"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item -Path (Join-Path $source "*") -Destination $Destination -Recurse -Force

Write-Host "Installed $skillName to $Destination"
Write-Host "Invoke it as: `$maintain-miro-2-obsidian"
