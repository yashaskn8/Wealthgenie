<#
.SYNOPSIS
  Temporarily allow this computer's current public IP in a MongoDB Atlas project.
.DESCRIPTION
  Optional local-development repair for a changing ISP/hotspot IP.
  Defaults to a dry run and requires -Apply for any Atlas mutation.
  Requires MongoDB Atlas CLI ('atlas') already authenticated with permission to
  change the project IP access list. No database credentials are read or stored.
  NEVER run automatically at service startup or in a production deployment.
.EXAMPLE
  .\scripts\allow_atlas_current_ip.ps1 -ProjectId 0123456789abcdef01234567
.EXAMPLE
  .\scripts\allow_atlas_current_ip.ps1 -ProjectId 0123456789abcdef01234567 -Hours 8 -Apply
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Fa-f0-9]{24}$')]
  [string]$ProjectId,
  [ValidateRange(1, 24)]
  [int]$Hours = 8,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

# This helper cannot alter production config, issue a blanket CIDR grant,
# write a MongoDB URI, or silently expand a project's network boundary.
$atlasCli = Get-Command atlas -ErrorAction SilentlyContinue
if (-not $atlasCli) {
  throw 'MongoDB Atlas CLI not found. Install it and sign in with "atlas auth login".'
}

$expiresAt = (Get-Date).ToUniversalTime().AddHours($Hours)
$expiryUtc = $expiresAt.ToString("yyyy-MM-ddTHH:mm:ssZ", [System.Globalization.CultureInfo]::InvariantCulture)
$arguments = @(
  'accessLists', 'create', '--currentIp',
  '--projectId', $ProjectId,
  '--deleteAfter', $expiryUtc,
  '--comment', 'Temporary WealthGenie developer IP; automatically expires'
)

if (-not $Apply) {
  Write-Host 'DRY RUN: No MongoDB Atlas access-list changes were made.'
  Write-Host 'Project:' $ProjectId
  Write-Host 'Access type: Only this machine''s current public IP (/32), resolved by Atlas CLI'
  Write-Host 'Expires at (UTC):' $expiryUtc
  Write-Host 'To apply: rerun the same command with -Apply.'
  return
}

Write-Host 'Adding temporary Atlas access for this machine only.'
Write-Host 'Project:' $ProjectId
Write-Host 'Expires at (UTC):' $expiryUtc
& $atlasCli.Source @arguments
if ($LASTEXITCODE -ne 0) {
  throw 'Atlas rejected the IP entry. Check CLI authentication, project role, and network access policies.'
}
Write-Host 'Temporary current-IP access requested. Older IP entries are not automatically removed; review them in Atlas.'
