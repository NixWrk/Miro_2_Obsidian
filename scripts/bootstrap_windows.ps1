[CmdletBinding()]
param(
    [switch]$RuntimeOnly,
    [switch]$SkipBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$virtualEnvPython = Join-Path $repositoryRoot ".venv\Scripts\python.exe"

function Invoke-VenvPython {
    param([Parameter(Mandatory)][string[]]$Arguments)

    & $virtualEnvPython @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
}

Push-Location $repositoryRoot
try {
    if (-not (Test-Path -LiteralPath $virtualEnvPython)) {
        $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            & py -3.13 -m venv .venv
        }
        else {
            & python -m venv .venv
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Could not create .venv. Install Python 3.13 and retry."
        }
    }

    Invoke-VenvPython @("-c", "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) else 'Python 3.13 is required')")

    if ($RuntimeOnly) {
        Invoke-VenvPython @("-m", "pip", "install", "-e", ".")
    }
    else {
        Invoke-VenvPython @("-m", "pip", "install", "-r", "requirements-dev.txt")
        Invoke-VenvPython @("-m", "pip", "install", "--no-deps", "-e", ".")
        if (-not $SkipBrowser) {
            Invoke-VenvPython @("-m", "playwright", "install", "chromium")
        }
    }
}
finally {
    Pop-Location
}

Write-Host "Environment ready: $virtualEnvPython"
Write-Host "CLI check: .\.venv\Scripts\miro2obsidian.exe --help"
