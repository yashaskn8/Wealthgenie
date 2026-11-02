<#
.SYNOPSIS
  Request temporary, single-address MongoDB Atlas development access.
.DESCRIPTION
  Dry-run by default. -Apply and -ConfirmDevelopmentProject are both required
  before modifying the selected Atlas project. No database URI is read.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{24}$')]
  [string]$ProjectId,
  [ValidateRange(1, 24)]
  [int]$Hours = 8,
  [switch]$Apply,
  [switch]$ConfirmDevelopmentProject
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'atlas_ip_access_common.ps1')

if ($Apply -and -not $ConfirmDevelopmentProject) {
  throw 'Atlas changes require -ConfirmDevelopmentProject after reviewing the dry run. No Atlas change was made.'
}

$expiryUtc = [DateTime]::UtcNow.AddHours($Hours).ToString('yyyy-MM-ddTHH:mm:ssZ',
  [Globalization.CultureInfo]::InvariantCulture)
if (-not $Apply) {
  Write-Host 'DRY RUN: No MongoDB Atlas access-list change was made.'
  Write-Host "Project: $ProjectId"
  try {
    $previewIp = Get-WealthGeniePublicIPv4
    Write-Host "Requested access: $previewIp/32, temporary for $Hours hour(s)"
  } catch {
    Write-Warning 'The public IPv4 could not be checked for this preview. Apply will refuse if the lookup fails.'
    Write-Host "Requested access: current public IPv4 /32, temporary for $Hours hour(s)"
  }
  Write-Host "Expires no later than: $expiryUtc UTC"
  Write-Host 'To apply to the reviewed development project, add -Apply -ConfirmDevelopmentProject.'
  return
}

$atlasCli = Get-Command atlas -ErrorAction SilentlyContinue
if (-not $atlasCli) {
  throw 'Atlas CLI is unavailable. Use the Atlas UI to add your current IP as a temporary /32 entry; no change was made.'
}

$currentIp = Get-WealthGeniePublicIPv4
$entries = Get-WealthGenieAtlasEntries -AtlasCli $atlasCli.Source -ProjectId $ProjectId
$matching = @($entries | Where-Object { (Test-WealthGenieIpInEntry -Ip $currentIp -Entry $_) -and
  (Test-WealthGenieEntryActive -Entry $_) })
if ($matching.Count -gt 0) {
  Write-Host 'The current public IP is already covered by an active Atlas access entry. No change was made.'
  return
}

$cidr = "$currentIp/32"
$arguments = @('accessLists', 'create', $cidr, '--type', 'cidrBlock',
  '--projectId', $ProjectId, '--deleteAfter', $expiryUtc,
  '--comment', 'Temporary WealthGenie development IP; expires automatically', '--output', 'json')
$null = & $atlasCli.Source @arguments 2>&1
if ($LASTEXITCODE -ne 0) {
  # A concurrent developer may have created the exact entry. Recheck once;
  # never delete, widen, or extend an existing entry automatically.
  $entries = Get-WealthGenieAtlasEntries -AtlasCli $atlasCli.Source -ProjectId $ProjectId
  $race = @($entries | Where-Object {
    ($_.cidrBlock -eq $cidr -or $_.ipAddress -eq $currentIp) -and (Test-WealthGenieEntryActive -Entry $_)
  })
  if ($race.Count -gt 0) {
    Write-Host 'The current /32 was added concurrently or already existed. No further change was made.'
    return
  }
  throw 'Atlas rejected the temporary /32 request. Check CLI authorization, project selection, access-list limits, and network availability.'
}

$entries = Get-WealthGenieAtlasEntries -AtlasCli $atlasCli.Source -ProjectId $ProjectId
$verified = @($entries | Where-Object {
  if ($_.cidrBlock -ne $cidr -or -not $_.deleteAfterDate -or
      -not (Test-WealthGenieEntryActive -Entry $_)) { return $false }
  $recordedExpiry = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$_.deleteAfterDate, [ref]$recordedExpiry)) { return $false }
  return $recordedExpiry.UtcDateTime -le ([DateTime]::Parse($expiryUtc).ToUniversalTime().AddMinutes(2))
})
if ($verified.Count -eq 0) {
  throw 'Atlas reported success, but a temporary /32 entry could not be verified. Review the project access list before retrying.'
}
$currentIpAfter = Get-WealthGeniePublicIPv4
if ($currentIpAfter -ne $currentIp) {
  throw 'The public IP changed during the request. The old /32 may be active; run the read-only preflight again for the new network.'
}
Write-Host "Verified temporary Atlas development access for $cidr. Existing entries were not changed."
