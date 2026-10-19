[CmdletBinding()]
param(
  [switch]$RequireRedis,
  [switch]$EnablePlanReview,
  [string]$RedisServerPath,
  [ValidateRange(1024, 65535)]
  [int]$BackendPort = 5001,
  [ValidateRange(1024, 65535)]
  [int]$FrontendPort = 5174
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$cacheRoot = Join-Path $repoRoot 'server/node_modules/.cache/wealthgenie-phase15-demo-host-20261009'
$mongoDbPath = Join-Path $cacheRoot 'db'
$mongoLogPath = Join-Path $cacheRoot 'mongod.log'
$emptyEnvPath = Join-Path $repoRoot 'server/node_modules/.cache/wealthgenie-demo-empty.env'
$statePath = Join-Path $repoRoot 'server/node_modules/.cache/wealthgenie-demo-processes.json'
$redisStatePath = Join-Path $repoRoot 'server/node_modules/.cache/wealthgenie-demo-redis.json'
$demoFixtureRoot = Join-Path $cacheRoot 'local-demo-fixtures'
$profileFixturePath = Join-Path $demoFixtureRoot 'profile-completion-synthetic-v1.json'
$taxFixturePath = Join-Path $demoFixtureRoot 'tax-context-synthetic-v1.json'
$expectedDatabase = 'wealthgenie-demo'
$expectedHost = '127.0.0.1'
$expectedPort = 27030
$expectedReplicaSet = 'rs0'
$expectedEnvironmentId = 'f9cca306-e0be-4b82-95db-4c2cf0132d75'
$redisPort = 6380
$backendPort = $BackendPort
$frontendPort = $FrontendPort
# Accept only the active WealthGenie repository, never its archived predecessor.
$expectedOrigins = @(
  'https://github.com/yashaskn8/Wealthgenie.git',
  'https://github.com/yashaskn8/Wealthgenie',
  'git@github.com:yashaskn8/Wealthgenie.git'
)
$backendPid = $null
$frontendPid = $null
$priorProcessState = $null

function Get-DotEnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' -and $Matches[1] -ceq $Name) {
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and $value[0] -eq '"' -and $value[$value.Length - 1] -eq '"') {
        return $value.Substring(1, $value.Length - 2).Replace('\n', "`n").Replace('\r', "`r")
      }
      if ($value.Length -ge 2 -and $value[0] -eq "'" -and $value[$value.Length - 1] -eq "'") {
        return $value.Substring(1, $value.Length - 2)
      }
      return ($value -replace '\s+#.*$', '').Trim()
    }
  }
  return $null
}

function Test-ListeningPort([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-BaseChildEnvironment {
  $base = @{}
  foreach ($name in @('PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($value) { $base[$name] = $value }
  }
  return $base
}

function Get-CheckoutFingerprint {
  $diff = (& git -C $repoRoot diff --binary HEAD -- 2>$null | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'Could not fingerprint the current checkout; no service reuse was attempted.' }
  $parts = [System.Collections.Generic.List[string]]::new()
  $parts.Add($diff)
  $untracked = @(& git -C $repoRoot ls-files --others --exclude-standard 2>$null | Sort-Object)
  if ($LASTEXITCODE -ne 0) { throw 'Could not inventory untracked checkout files; no service reuse was attempted.' }
  foreach ($relativePath in $untracked) {
    $filePath = Join-Path $repoRoot $relativePath
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      throw 'An untracked checkout entry is not a regular file; no service reuse was attempted.'
    }
    $item = Get-Item -LiteralPath $filePath -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'An untracked checkout entry is a reparse point; no service reuse was attempted.'
    }
    $digest = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $parts.Add("$relativePath`n$digest")
  }
  $material = [Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return [Convert]::ToHexString($sha.ComputeHash($material)).ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-DotEnvFileIdentity([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'MISSING' }
  $item = Get-Item -LiteralPath $Path
  return "$($item.Length):$($item.LastWriteTimeUtc.Ticks)"
}

function Test-ProcessExecutable([int]$ProcessId, [string]$ExpectedPath) {
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return [string]::Equals(
      [IO.Path]::GetFullPath([string]$process.Path),
      [IO.Path]::GetFullPath($ExpectedPath),
      [StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

function Start-HiddenProcess([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, [hashtable]$ChildEnvironment, [string]$LogStem) {
  $base = Get-BaseChildEnvironment
  $original = [Environment]::GetEnvironmentVariables('Process')
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutPath = Join-Path $cacheRoot "$LogStem-$timestamp.out.log"
  $stderrPath = Join-Path $cacheRoot "$LogStem-$timestamp.err.log"
  try {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($name in $base.Keys) { [Environment]::SetEnvironmentVariable($name, [string]$base[$name], 'Process') }
    foreach ($name in $ChildEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, [string]$ChildEnvironment[$name], 'Process') }
    return Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  } finally {
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
      [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
    }
    foreach ($name in $original.Keys) { [Environment]::SetEnvironmentVariable([string]$name, [string]$original[$name], 'Process') }
  }
}

function Invoke-MongoIdentityCheck([string]$MongoShellPath) {
  $eval = @'
const expectedDb = 'wealthgenie-demo';
const expectedHost = '127.0.0.1:27030';
const expectedPath = __EXPECTED_PATH__;
const expectedUuid = 'f9cca306-e0be-4b82-95db-4c2cf0132d75';
const admin = db.getSiblingDB('admin');
const options = admin.runCommand({ getCmdLineOpts: 1 }).parsed || {};
const hello = admin.runCommand({ hello: 1 });
const repl = admin.runCommand({ replSetGetStatus: 1 });
const listed = admin.runCommand({ listDatabases: 1, nameOnly: true });
const target = db.getSiblingDB(expectedDb);
const sentinel = target.demo_environment_sentinels.findOne({ _id: 'wealthgenie-phase15-demo' });
let transactionCapable = false;
let session;
try {
  session = db.getMongo().startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' } });
  const read = session.getDatabase(expectedDb).runCommand({
    find: 'demo_environment_sentinels',
    filter: { _id: 'wealthgenie-phase15-demo' },
    limit: 1,
  });
  transactionCapable = read.ok === 1;
  session.abortTransaction();
} catch {
  try { session?.abortTransaction(); } catch {}
} finally {
  try { session?.endSession(); } catch {}
}
const configuredPath = String(options.storage?.dbPath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const bind = options.net?.bindIp;
const bindList = Array.isArray(bind) ? bind : (typeof bind === 'string' ? bind.split(',') : []);
const loopbackOnly = options.net?.bindIpAll !== true && bindList.length === 1 && bindList[0] === '127.0.0.1';
const databaseExists = listed.ok === 1 && listed.databases.some(item => item.name === expectedDb);
const sentinelValid = Boolean(sentinel)
  && Object.keys(sentinel).sort().join(',') === '_id,environmentId,purpose,schemaVersion'
  && sentinel._id === 'wealthgenie-phase15-demo'
  && sentinel.environmentId === expectedUuid
  && sentinel.purpose === 'WEALTHGENIE_PHASE15_DEMO'
  && sentinel.schemaVersion === 1
  && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sentinel.environmentId);
const verified = options.net?.port === 27030
  && configuredPath === expectedPath
  && options.replication?.replSet === 'rs0'
  && loopbackOnly
  && hello.setName === 'rs0'
  && hello.me === expectedHost
  && hello.isWritablePrimary === true
  && repl.set === 'rs0'
  && databaseExists
  && sentinelValid
  && transactionCapable;
print(JSON.stringify({
  verified,
  database: expectedDb,
  host: hello.me || null,
  port: options.net?.port || null,
  replicaSet: hello.setName || null,
  primary: hello.isWritablePrimary === true,
  loopbackOnly,
  existingDataPathMatched: configuredPath === expectedPath,
  sentinelUuid: sentinel?.environmentId || null,
  sentinelValid,
  readOnlySnapshotTransaction: transactionCapable,
}));
if (!verified) quit(1);
'@
  $expectedPathJson = ConvertTo-Json -InputObject ($mongoDbPath.Replace('\', '/').TrimEnd('/').ToLowerInvariant()) -Compress
  $eval = $eval.Replace('__EXPECTED_PATH__', $expectedPathJson)
  $uri = 'mongodb://127.0.0.1:27030/admin?directConnection=true&serverSelectionTimeoutMS=2500'
  $output = @(& $MongoShellPath $uri --quiet --eval $eval 2>$null)
  if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
    throw 'Read-only MongoDB identity verification failed; no database writes were attempted.'
  }
  try { return ($output[-1] | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw 'MongoDB returned an unreadable identity result; no database writes were attempted.' }
}

function Wait-Http([string]$Url, [int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-RestMethod -Uri $Url -TimeoutSec 3 -ErrorAction Stop
    } catch {
      Start-Sleep -Milliseconds 750
    }
  }
  throw "Timed out waiting for local endpoint $Url."
}

function Wait-Frontend([string]$Url, [int]$TimeoutSeconds = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -ErrorAction Stop
      if ($response.StatusCode -eq 200 -and $response.Content -match '<div[^>]+id="root"') {
        return $true
      }
    } catch {
      Start-Sleep -Milliseconds 750
    }
  }
  throw "Timed out waiting for the local frontend document at $Url."
}

if (($backendPort -eq $frontendPort) -or ($backendPort -in @($expectedPort, $redisPort)) -or ($frontendPort -in @($expectedPort, $redisPort))) {
  throw 'Backend and frontend ports must be distinct from each other and from MongoDB/Redis demo ports.'
}

if ((-not (Test-Path -LiteralPath $cacheRoot -PathType Container)) -or (-not (Test-Path -LiteralPath $mongoDbPath -PathType Container))) {
  throw 'The previously verified demo MongoDB data directory is missing; refusing to recreate it.'
}

$remote = (& git -C $repoRoot remote get-url origin 2>$null).Trim()
$branch = (& git -C $repoRoot branch --show-current 2>$null).Trim()
if ($remote -notin $expectedOrigins -or $branch -ne 'main') {
  throw 'The canonical origin or main branch does not match; no service was started.'
}
$head = (& git -C $repoRoot rev-parse HEAD).Trim()
$gitStatus = (& git -C $repoRoot status --porcelain --untracked-files=all | Out-String).Trim()
$checkoutFingerprint = Get-CheckoutFingerprint
$sourceSha = if (-not $gitStatus) { $head } else { $null }

$rootEnvPath = Join-Path $repoRoot '.env'
$serverEnvPath = Join-Path $repoRoot 'server/.env'
$rootEnvIdentity = Get-DotEnvFileIdentity $rootEnvPath
$demoEmail = Get-DotEnvValue $rootEnvPath 'DEMO_EMAIL'
$demoPassword = Get-DotEnvValue $rootEnvPath 'DEMO_PASSWORD'
$serverEmail = Get-DotEnvValue $serverEnvPath 'DEMO_EMAIL'
$serverPassword = Get-DotEnvValue $serverEnvPath 'DEMO_PASSWORD'
$jwtSecret = Get-DotEnvValue $rootEnvPath 'JWT_SECRET'
$nvidiaKey = Get-DotEnvValue $rootEnvPath 'NVIDIA_API_KEY'
$nvidiaModel = Get-DotEnvValue $rootEnvPath 'NVIDIA_NIM_MODEL'

if (-not $demoEmail -or -not $demoPassword -or $demoPassword.Length -lt 8 -or $demoPassword.Length -gt 128) {
  throw 'The selected root .env demo credentials are missing or fail the registration password length contract.'
}
if ($serverEmail -and $serverEmail -cne $demoEmail) {
  throw 'Root and server demo account emails differ; refusing to choose an account implicitly.'
}
if (-not $jwtSecret -or $jwtSecret.Length -lt 32 -or $jwtSecret -match 'CHANGE_ME|default_jwt_secret|super_secret_jwt') {
  throw 'A non-placeholder local JWT secret is required in the selected root .env.'
}

if (-not (Test-Path -LiteralPath $emptyEnvPath -PathType Leaf)) {
  New-Item -ItemType File -Path $emptyEnvPath -Force | Out-Null
}
if ((Get-Item -LiteralPath $emptyEnvPath).Length -ne 0) {
  throw 'The isolated empty dotenv file is not empty; refusing to use it.'
}

if (-not (Test-Path -LiteralPath $demoFixtureRoot -PathType Container)) {
  New-Item -ItemType Directory -Path $demoFixtureRoot -Force | Out-Null
}
$syntheticProfile = [ordered]@{
  monthly_take_home = 100000
  monthly_savings = 30000
  age = 32
  risk_tolerance = 'Moderate'
  sold_property_proceeds = $null
  has_lump_sum = $false
  lump_sum_amount = 0
  liquid_savings = 100000
  emi_burden_pct = $null
  financial_dependents = 1
  emergency_fund_months = 6
  investment_goals = @('Wealth Growth')
  investment_horizon_years = 10
}
$syntheticTaxContext = [ordered]@{
  fiscalYear = 'FY2026-27'
  incomeSource = 'salary'
  annualGrossIncome = 1200000
  regime = 'new'
}
if (-not (Test-Path -LiteralPath $profileFixturePath -PathType Leaf)) {
  [IO.File]::WriteAllText($profileFixturePath, ($syntheticProfile | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
if (-not (Test-Path -LiteralPath $taxFixturePath -PathType Leaf)) {
  [IO.File]::WriteAllText($taxFixturePath, ($syntheticTaxContext | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}

$mongoExe = (Get-Command mongod.exe -ErrorAction SilentlyContinue)?.Source
$mongoShell = (Get-Command mongosh.exe -ErrorAction SilentlyContinue)?.Source
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue)?.Source
if (-not $mongoExe -or -not $mongoShell -or -not $nodeExe) {
  throw 'mongod.exe, mongosh.exe, and node.exe must already be installed; no software will be installed.'
}

if (-not (Test-ListeningPort $expectedPort)) {
  $mongoArgs = '--dbpath "' + $mongoDbPath + '" --port 27030 --bind_ip 127.0.0.1 --replSet rs0 --logpath "' + $mongoLogPath + '" --logappend'
  $mongoProcess = Start-HiddenProcess $mongoExe $mongoArgs $repoRoot @{} 'demo-mongod'
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline -and -not (Test-ListeningPort $expectedPort)) {
    $mongoProcess.Refresh()
    if ($mongoProcess.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-ListeningPort $expectedPort)) {
    throw 'The existing MongoDB data path could not be opened. Its lock and files were left untouched; inspect the MongoDB log before retrying.'
  }
}

$mongoIdentity = Invoke-MongoIdentityCheck $mongoShell
if (-not $mongoIdentity.verified) {
  throw 'The listener does not match the existing verified demo database identity; no backend or frontend was started.'
}
Write-Host "MongoDB VERIFIED: $($mongoIdentity.database), loopback port $($mongoIdentity.port), replica set $($mongoIdentity.replicaSet), read-only transaction PASS."

$redisAvailable = $false
$redisExe = $RedisServerPath
if (-not $redisExe) { $redisExe = (Get-Command redis-server.exe -ErrorAction SilentlyContinue)?.Source }
if (Test-ListeningPort $redisPort) {
  if (-not (Test-Path -LiteralPath $redisStatePath -PathType Leaf)) {
    throw 'Port 6380 is occupied by an unverified Redis process; startup stopped without pinging or modifying it.'
  } else {
    $state = Get-Content -LiteralPath $redisStatePath -Raw | ConvertFrom-Json
    $ownerIds = @(Get-NetTCPConnection -State Listen -LocalPort $redisPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($state.redisPid -and ($ownerIds -contains [int]$state.redisPid)) { $redisAvailable = $true }
    else { throw 'Port 6380 does not belong to the previously recorded local demo Redis process; startup stopped without contacting it.' }
  }
} elseif ($redisExe) {
  $redisExe = (Resolve-Path -LiteralPath $redisExe).Path
  $redisRoot = Join-Path $cacheRoot 'redis'
  New-Item -ItemType Directory -Path $redisRoot -Force | Out-Null
  $redisConfigPath = Join-Path $redisRoot 'redis-demo.conf'
  $redisLogPath = Join-Path $redisRoot 'redis.log'
  $redisConfig = @"
bind 127.0.0.1
protected-mode yes
port $redisPort
save ""
appendonly no
dir "$($redisRoot.Replace('\','/'))"
logfile "$($redisLogPath.Replace('\','/'))"
"@.Trim() + "`n"
  if (Test-Path -LiteralPath $redisConfigPath) {
    if ((Get-Content -LiteralPath $redisConfigPath -Raw) -cne $redisConfig) {
      throw 'An existing local Redis config differs from the isolated demo config; it was not overwritten.'
    }
  } else {
    [IO.File]::WriteAllText($redisConfigPath, $redisConfig, [Text.UTF8Encoding]::new($false))
  }
  $redisProcess = Start-HiddenProcess $redisExe ('"' + $redisConfigPath + '"') $redisRoot @{} 'demo-redis'
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and -not (Test-ListeningPort $redisPort)) {
    $redisProcess.Refresh()
    if ($redisProcess.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Test-ListeningPort $redisPort) {
    $redisAvailable = $true
    $state = [pscustomobject]@{ redisPid = $redisProcess.Id; redisConfig = $redisConfigPath }
    $state | ConvertTo-Json | Set-Content -LiteralPath $redisStatePath -Encoding utf8
  }
}
if ($RequireRedis -and -not $redisAvailable) {
  throw 'Redis-backed precomputation was requested, but no authorized isolated Redis server is available. The external REDIS_URL was not used.'
}
if ($redisAvailable) {
  $pingSource = "const {createClient}=require('redis'); const c=createClient({url:'redis://127.0.0.1:6380',socket:{connectTimeout:1500}}); try { await c.connect(); const r=await c.ping(); await c.quit(); process.stdout.write(r==='PONG'?'PONG':'BAD'); } catch { process.stdout.write('UNAVAILABLE'); process.exitCode=1; }"
  $ping = & $nodeExe -e $pingSource 2>$null
  if ($LASTEXITCODE -ne 0 -or (($ping -join '').Trim() -ne 'PONG')) {
    throw 'The isolated local Redis instance failed its bounded PING; backend startup stopped.'
  }
  Write-Host 'Redis VERIFIED: isolated loopback demo instance on port 6380; PING PASS.'
} else {
  Write-Host 'Redis NOT VERIFIED: no local Redis server is installed; the external REDIS_URL was ignored and precompute remains unavailable.'
}
$redisUrl = if ($redisAvailable) { 'redis://127.0.0.1:6380' } else { 'redis://127.0.0.1:1' }

$commonEnv = @{
  DOTENV_CONFIG_PATH = $emptyEnvPath
  NODE_ENV = 'development'
  MONGODB_URI = 'mongodb://127.0.0.1:27030/wealthgenie-demo?replicaSet=rs0'
  MONGODB_FLAVOR = 'mongodb'
  MONGODB_AUTO_INDEX = 'false'
  MONGODB_SERVER_SELECTION_TIMEOUT_MS = '5000'
  REDIS_URL = $redisUrl
  REQUIRE_REDIS = $(if ($redisAvailable) { 'true' } else { 'false' })
  DEMO_EXPECTED_MONGODB_DATABASE = $expectedDatabase
  DEMO_EXPECTED_MONGODB_HOST = $expectedHost
  DEMO_EXPECTED_MONGODB_PORT = [string]$expectedPort
  DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID = $expectedEnvironmentId
  DEMO_LIVE_PREFLIGHT = '1'
  DEMO_API_BASE_URL = "http://127.0.0.1:$backendPort/api"
  DEMO_FRONTEND_URL = "http://127.0.0.1:$frontendPort"
  DEMO_PROFILE_COMPLETION_FILE = $profileFixturePath
  DEMO_TAX_CONTEXT_FILE = $taxFixturePath
  DEMO_COMPLETION_IDEMPOTENCY_KEY = 'wealthgenie-local-demo-profile-v1'
  MARKET_DATA_PRIMARY_PROVIDER = 'NSE'
  MARKET_DATA_REFRESH_ENABLED = 'false'
  # Keep the isolated demo deterministic unless the operator explicitly opts
  # into durable Plan Review with previously provisioned MongoDB indexes.
  AGENTIC_PLAN_REVIEW_ENABLED = $(if ($EnablePlanReview) { 'true' } else { 'false' })
  AGENT_WORKER_ENABLED = $(if ($EnablePlanReview) { 'true' } else { 'false' })
  AGENT_WORKER_MODE = 'embedded'
  MCP_ENABLED = 'false'
  MCP_REMOTE_ENABLED = 'false'
  MCP_LEGACY_SSE_ENABLED = 'false'
  AGENT_VERIFIABLE_ACTIONS_ENABLED = 'false'
  AGENT_WEBAUTHN_APPROVAL_ENABLED = 'false'
  AGENT_AP2_RESEARCH_ENABLED = 'false'
  JWT_SECRET = $jwtSecret
  JWT_EXPIRES_IN = '7d'
  PORT = [string]$backendPort
  CORS_ORIGINS = "http://127.0.0.1:$frontendPort"
  NVIDIA_API_KEY = $nvidiaKey
  LLM_PRIMARY_PROVIDER = 'NVIDIA_NIM'
}
if ($nvidiaModel) { $commonEnv.NVIDIA_NIM_MODEL = $nvidiaModel }
if ($sourceSha) { $commonEnv.APP_BUILD_SHA = $sourceSha }

if (Test-ListeningPort $backendPort) {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "Backend port $backendPort is occupied without a matching prior startup record; it was not contacted or stopped."
  }
  $priorProcessState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $backendOwners = @(Get-NetTCPConnection -State Listen -LocalPort $backendPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  $backendMatches = ($priorProcessState.repository -eq $repoRoot) -and ($priorProcessState.branch -eq 'main') `
    -and ($priorProcessState.head -eq $head) -and ($priorProcessState.checkoutFingerprint -eq $checkoutFingerprint) `
    -and ($priorProcessState.rootEnvIdentity -eq $rootEnvIdentity) -and $priorProcessState.backendPid `
    -and ($backendOwners -contains [int]$priorProcessState.backendPid) `
    -and (Test-ProcessExecutable ([int]$priorProcessState.backendPid) $nodeExe)
  if (-not $backendMatches) {
    throw "Backend port $backendPort is not the recorded Node process for this exact source/configuration; it was not contacted or stopped."
  }
  $backendPid = [int]$priorProcessState.backendPid
  $live = Wait-Http "http://127.0.0.1:$backendPort/health/live" 8
  if ($sourceSha -and $live.buildSha -ne $sourceSha) { throw "Backend port $backendPort is occupied by a backend with a different build identity; it was not stopped." }
  if ($live.status -ne 'ALIVE') { throw "Backend port $backendPort is occupied by an unverified backend; it was not stopped." }
} else {
  $serverProcess = Start-HiddenProcess $nodeExe 'server.js' (Join-Path $repoRoot 'server') $commonEnv 'demo-backend'
  $backendPid = $serverProcess.Id
}
$live = Wait-Http "http://127.0.0.1:$backendPort/health/live"
$ready = Wait-Http "http://127.0.0.1:$backendPort/health/ready"
if ($live.status -ne 'ALIVE' -or ($sourceSha -and $live.buildSha -ne $sourceSha) -or $ready.status -ne 'READY') {
  throw 'The local backend did not pass its build/readiness checks; no data was repaired or migrated.'
}
$verification = Invoke-RestMethod -Uri "http://127.0.0.1:$backendPort/health/verification" -Headers @{
  'X-Demo-Expected-Mongodb-Database' = $expectedDatabase
  'X-Demo-Expected-Mongodb-Host' = $expectedHost
  'X-Demo-Expected-Mongodb-Port' = [string]$expectedPort
  'X-Demo-Expected-Mongodb-Environment-Id' = $expectedEnvironmentId
} -TimeoutSec 5
if (($verification.status -ne 'DEMO_DATABASE_VERIFIED') -or ($verification.mongo.environmentSentinelVerified -ne $true) -or ($verification.mongo.transactionCapable -ne $true)) {
  throw 'Backend database identity verification failed; no account or profile mutations were performed.'
}
if (($RequireRedis -or $redisAvailable) -and (($verification.redis.required -ne $true) -or ($verification.redis.connected -ne $true))) {
  throw 'The running backend is not configured for the verified isolated Redis instance; use an unused backend port so it starts with the required Redis policy.'
}

$frontendEnv = @{
  VITE_API_URL = "http://127.0.0.1:$backendPort/api"
  VITE_DEV_API_TARGET = "http://127.0.0.1:$backendPort"
  HOST = '127.0.0.1'
  PORT = [string]$frontendPort
}
if ($sourceSha) { $frontendEnv.VITE_BUILD_SHA = $sourceSha }
if (-not (Test-ListeningPort $frontendPort)) {
  $vitePath = Join-Path $repoRoot 'reactapp/node_modules/vite/bin/vite.js'
  if (-not (Test-Path -LiteralPath $vitePath -PathType Leaf)) { throw 'The installed Vite runtime is unavailable; no dependency installation was attempted.' }
  $viteArgs = '"' + $vitePath + '" --host 127.0.0.1 --port ' + $frontendPort + ' --strictPort'
  $frontendProcess = Start-HiddenProcess $nodeExe $viteArgs (Join-Path $repoRoot 'reactapp') $frontendEnv 'demo-frontend'
  $frontendPid = $frontendProcess.Id
} else {
  if (-not $priorProcessState) {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
      throw "Frontend port $frontendPort is occupied without a matching prior startup record; it was not contacted or stopped."
    }
    $priorProcessState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  }
  $frontendOwners = @(Get-NetTCPConnection -State Listen -LocalPort $frontendPort -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  $frontendMatches = ($priorProcessState.repository -eq $repoRoot) -and ($priorProcessState.branch -eq 'main') `
    -and ($priorProcessState.head -eq $head) -and ($priorProcessState.checkoutFingerprint -eq $checkoutFingerprint) `
    -and ($priorProcessState.rootEnvIdentity -eq $rootEnvIdentity) -and $priorProcessState.frontendPid `
    -and ($frontendOwners -contains [int]$priorProcessState.frontendPid) `
    -and (Test-ProcessExecutable ([int]$priorProcessState.frontendPid) $nodeExe)
  if (-not $frontendMatches) {
    throw "Frontend port $frontendPort is not the recorded Node process for this exact source/configuration; it was not contacted or stopped."
  }
  $frontendPid = [int]$priorProcessState.frontendPid
}
$frontendVerified = Wait-Frontend "http://127.0.0.1:$frontendPort/login"
if (-not $frontendVerified) { throw 'The local frontend did not become reachable.' }

$processState = [pscustomobject]@{
  repository = $repoRoot
  branch = $branch
  head = $head
  checkoutFingerprint = $checkoutFingerprint
  rootEnvIdentity = $rootEnvIdentity
  worktreeClean = [bool](-not $gitStatus)
  mongoPort = $expectedPort
  mongoDbPath = $mongoDbPath
  redisPort = $(if ($redisAvailable) { $redisPort } else { $null })
  redisUrl = $redisUrl
  redisRequired = [bool]$redisAvailable
  backendPort = $backendPort
  frontendPort = $frontendPort
  sourceShaPublished = [bool]$sourceSha
  backendPid = $backendPid
  frontendPid = $frontendPid
}
$processState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
Write-Host "Backend VERIFIED: loopback port $backendPort, READY, connected to the existing demo sentinel and transaction-capable replica set."
Write-Host "Frontend VERIFIED: loopback port $frontendPort, login document returned HTTP 200 with the React root element."
Write-Host 'Credentials source: project-root .env only; server/.env was not loaded. Credential values were not printed.'
if ($serverPassword -and $serverPassword -cne $demoPassword) {
  Write-Host 'Environment note: root/server demo passwords differ; the verified root .env value was selected without changing either file.'
}
if (-not $sourceSha) {
  Write-Host 'Build identity: unavailable because the worktree is dirty; no commit SHA was published as a build claim.'
}
Write-Host 'No registration, database migration, index creation, scheduled market refresh, or profile mutation was performed by this startup script.'
