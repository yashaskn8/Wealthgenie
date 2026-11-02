<#
.SYNOPSIS
  Start the existing Atlas-backed WealthGenie server after a read-only preflight.
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Fa-f0-9]{24}$')]
  [string]$ProjectId
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$preflight = Join-Path $PSScriptRoot 'check_atlas_connection.ps1'
$arguments = @('-NoProfile', '-File', $preflight)
if ($ProjectId) { $arguments += @('-ProjectId', $ProjectId) }
& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) {
  throw 'MongoDB preflight failed. Backend startup was stopped; no Atlas access-list change was made.'
}

Push-Location (Join-Path $repoRoot 'server')
try { & node.exe server.js }
finally { Pop-Location }
