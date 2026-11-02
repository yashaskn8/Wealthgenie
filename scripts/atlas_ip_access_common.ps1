# Shared read-only network helpers. Compatible with Windows PowerShell 5.1.
function Get-WealthGeniePublicIPv4 {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri 'https://api.ipify.org?format=json' -UseBasicParsing -TimeoutSec 6
      $value = (ConvertFrom-Json -InputObject $response.Content -ErrorAction Stop).ip
      $address = $null
      if ([Net.IPAddress]::TryParse([string]$value, [ref]$address) -and
          $address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
        return $address.ToString()
      }
    } catch { }
    if ($attempt -lt 3) { Start-Sleep -Milliseconds 500 }
  }
  throw 'The public-IP service did not return a valid IPv4 address after three attempts.'
}

function Get-WealthGenieAtlasEntries {
  param([string]$AtlasCli, [string]$ProjectId)
  $all = [System.Collections.Generic.List[object]]::new()
  for ($page = 1; $page -le 20; $page++) {
    $raw = $null
    $exitCode = 1
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      try {
        $raw = & $AtlasCli accessLists list --projectId $ProjectId --output json --limit 500 --page $page 2>&1
        $exitCode = $LASTEXITCODE
      } catch { $exitCode = 1 }
      if ($exitCode -eq 0) { break }
      if ($attempt -lt 2) { Start-Sleep -Milliseconds 500 }
    }
    if ($exitCode -ne 0) {
      throw 'Atlas access-list read failed. Check CLI authentication, project permissions, and network access.'
    }
    try { $parsed = ConvertFrom-Json -InputObject ($raw -join "`n") -ErrorAction Stop }
    catch { throw 'Atlas access-list response was not valid JSON. No Atlas change was made.' }
    $pageEntries = if ($parsed -is [array]) { @($parsed) } elseif ($null -ne $parsed.results) { @($parsed.results) } else {
      throw 'Atlas access-list response has an unknown shape. No Atlas change was made.'
    }
    foreach ($entry in $pageEntries) { $all.Add($entry) }
    if ($pageEntries.Count -lt 500) { return @($all.ToArray()) }
  }
  throw 'Atlas access list exceeded the bounded 20-page audit. No Atlas change was made.'
}

function Test-WealthGenieIpInEntry {
  param([string]$Ip, [object]$Entry)
  $source = $null
  if (-not [Net.IPAddress]::TryParse($Ip, [ref]$source) -or
      $source.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  if ($Entry.ipAddress) { return $Entry.ipAddress -eq $Ip }
  if (-not $Entry.cidrBlock) { return $false }
  $parts = ([string]$Entry.cidrBlock).Split('/')
  if ($parts.Count -ne 2) { return $false }
  $network = $null
  $prefix = 0
  if (-not [Net.IPAddress]::TryParse($parts[0], [ref]$network) -or
      $network.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
      -not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 0 -or $prefix -gt 32) { return $false }
  $actual = $source.GetAddressBytes()
  $expected = $network.GetAddressBytes()
  for ($index = 0; $index -lt 4; $index++) {
    $bits = [Math]::Min(8, [Math]::Max(0, $prefix - 8 * $index))
    if ($bits -eq 0) { continue }
    $mask = (255 -shl (8 - $bits)) -band 255
    if (($actual[$index] -band $mask) -ne ($expected[$index] -band $mask)) { return $false }
  }
  return $true
}

function Test-WealthGenieEntryActive {
  param([object]$Entry, [DateTime]$NowUtc = [DateTime]::UtcNow)
  if (-not $Entry.deleteAfterDate) { return $true }
  $expiry = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string]$Entry.deleteAfterDate, [ref]$expiry)) { return $false }
  return $expiry.UtcDateTime -gt $NowUtc
}
