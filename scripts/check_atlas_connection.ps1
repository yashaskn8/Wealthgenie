<#
.SYNOPSIS
  Read-only Windows PowerShell 5.1 preflight for the effective backend MongoDB.
.DESCRIPTION
  Uses the backend's own environment precedence and MongoDB driver. Optional
  Atlas access-list inspection needs an authenticated Atlas CLI. Never writes
  database records or changes Atlas network access.
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[A-Fa-f0-9]{24}$')]
  [string]$ProjectId,
  [ValidateRange(1, 3)]
  [int]$Attempts = 2
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'atlas_ip_access_common.ps1')
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$diagnostic = Join-Path $repoRoot 'server/scripts/diagnoseMongoConnectivity.js'
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required for the backend MongoDB preflight.' }

$result = $null
for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
  $raw = & $node.Source $diagnostic 2>&1
  try { $result = ConvertFrom-Json -InputObject ($raw -join "`n") -ErrorAction Stop }
  catch { throw 'MongoDB diagnostic failed without a safe machine-readable result. No backend was started.' }
  if ($result.status -eq 'READY') {
    if ($result.endpointType -eq 'LOOPBACK') {
      Write-Warning 'MongoDB is reachable on loopback, but this Atlas startup workflow requires the configured remote database.'
      exit 1
    }
    Write-Host "MongoDB READY: $($result.endpointType), database $($result.database), replica set $($result.replicaSet)."
    exit 0
  }
  if ($result.code -in @('MONGODB_AUTHENTICATION_FAILED', 'MONGODB_TLS_FAILED',
    'MONGODB_DATABASE_IDENTITY_MISMATCH', 'MONGODB_TRANSACTIONS_REQUIRED',
    'MONGODB_URI_INVALID', 'MONGODB_EXPECTED_DATABASE_REQUIRED',
    'MONGODB_EXPECTED_DATABASE_PLACEHOLDER', 'MONGODB_EXPECTED_DATABASE_INVALID')) { break }
  if ($attempt -lt $Attempts) { Start-Sleep -Seconds 2 }
}

Write-Warning "MongoDB unavailable: $($result.code). $($result.message)"
if ($result.endpointType -eq 'LOOPBACK') {
  Write-Warning 'The effective backend URI is local loopback, not Atlas. Check server/.env and the intended database before retrying.'
} elseif ($ProjectId -and $result.endpointType -in @('REMOTE', 'REMOTE_SRV') -and
    $result.code -in @('MONGODB_NETWORK_UNAVAILABLE', 'MONGODB_SERVER_SELECTION_FAILED')) {
  $atlasCli = Get-Command atlas -ErrorAction SilentlyContinue
  if (-not $atlasCli) {
    Write-Warning 'Atlas CLI is unavailable; the access list could not be checked. Do not assume the IP list is the cause.'
  } else {
    try {
      $currentIp = Get-WealthGeniePublicIPv4
      $entries = Get-WealthGenieAtlasEntries -AtlasCli $atlasCli.Source -ProjectId $ProjectId
      $covered = @($entries | Where-Object {
        (Test-WealthGenieIpInEntry -Ip $currentIp -Entry $_) -and
        (Test-WealthGenieEntryActive -Entry $_)
      })
      if ($covered.Count -eq 0) {
        Write-Warning 'The public IP seen by the IP-check service is not covered by an active Atlas entry. An IP restriction is likely, but VPN/split routing can change the Atlas egress IP.'
        Write-Host "Review temporary /32 access: .\scripts\allow_atlas_current_ip.ps1 -ProjectId $ProjectId"
      } else {
        Write-Warning 'The observed public IP is allowlisted. Check cluster health, route, DNS, and TLS; an IP change is not established as the cause.'
      }
    } catch {
      Write-Warning 'Current IP or Atlas access list could not be verified. No Atlas change was made.'
    }
  }
}
exit 1
