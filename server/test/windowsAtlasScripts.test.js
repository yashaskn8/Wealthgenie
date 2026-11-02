import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = path.join(root, 'scripts');
const onWindows = process.platform === 'win32';
const run = args => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {
  cwd: root, encoding: 'utf8', timeout: 15000,
});

test('Windows Atlas helper defaults to dry run and refuses writes without development-project approval',
  { skip: !onWindows }, () => {
    const script = path.join(scripts, 'allow_atlas_current_ip.ps1');
    const project = '0123456789abcdef01234567';
    // Stub public-IP lookup: this safety regression must not depend on live
    // Wi-Fi, Atlas credentials, or an external service.
    const escapedScript = script.replaceAll("'", "''");
    const dryCommand = [
      "function Invoke-WebRequest { param([string]$Uri,[switch]$UseBasicParsing,[int]$TimeoutSec) [pscustomobject]@{Content='{\"ip\":\"198.51.100.4\"}'} }",
      `& '${escapedScript}' -ProjectId '${project}'`,
    ].join('; ');
    const dryRun = run(['-EncodedCommand', Buffer.from(dryCommand, 'utf16le').toString('base64')]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /DRY RUN.*No MongoDB Atlas access-list change/i);
    assert.match(dryRun.stdout, /\/32/);
    const denied = run(['-File', script, '-ProjectId', project, '-Apply']);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /ConfirmDevelopmentProject/);
    assert.doesNotMatch(denied.stdout, /Verified temporary Atlas/);
  });

test('Windows Atlas common logic distinguishes covered, uncovered, and expired IPv4 entries',
  { skip: !onWindows }, () => {
    const common = path.join(scripts, 'atlas_ip_access_common.ps1').replaceAll("'", "''");
    const command = [
      `$ErrorActionPreference='Stop'; . '${common}'`,
      "$active=[pscustomobject]@{cidrBlock='198.51.100.0/24';deleteAfterDate='2099-01-01T00:00:00Z'}",
      "$expired=[pscustomobject]@{ipAddress='198.51.100.4';deleteAfterDate='2000-01-01T00:00:00Z'}",
      "if(-not (Test-WealthGenieIpInEntry -Ip '198.51.100.4' -Entry $active)){exit 1}",
      "if(Test-WealthGenieIpInEntry -Ip '198.51.101.4' -Entry $active){exit 2}",
      'if(-not (Test-WealthGenieEntryActive -Entry $active)){exit 3}',
      'if(Test-WealthGenieEntryActive -Entry $expired){exit 4}',
      "Write-Output 'PASS'",
    ].join('; ');
    const result = run(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });

test('Windows Atlas scripts parse under PowerShell 5.1', { skip: !onWindows }, () => {
  const files = ['atlas_ip_access_common.ps1', 'allow_atlas_current_ip.ps1',
    'check_atlas_connection.ps1', 'start_backend_atlas.ps1'];
  for (const filename of files) {
    const target = path.join(scripts, filename).replaceAll("'", "''");
    const command = `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${target}',[ref]$tokens,[ref]$errors); if($errors.Count){Write-Error $errors[0].Message;exit 1}`;
    const result = run(['-Command', command]);
    assert.equal(result.status, 0, `${filename}: ${result.stderr}`);
  }
});

test('Windows Atlas list reader accepts bounded JSON results without any write command',
  { skip: !onWindows }, () => {
    const common = path.join(scripts, 'atlas_ip_access_common.ps1').replaceAll("'", "''");
    const command = [
      `$ErrorActionPreference='Stop'; . '${common}'`,
      "function MockAtlas { $global:LASTEXITCODE=0; Write-Output '{\"results\":[{\"cidrBlock\":\"198.51.100.4/32\",\"deleteAfterDate\":\"2099-01-01T00:00:00Z\"}]}' }",
      "$entries=@(Get-WealthGenieAtlasEntries -AtlasCli 'MockAtlas' -ProjectId '0123456789abcdef01234567')",
      'if($entries.Count -ne 1){exit 1}',
      "if(-not (Test-WealthGenieIpInEntry -Ip '198.51.100.4' -Entry $entries[0])){exit 2}",
      "Write-Output 'PASS'",
    ].join('; ');
    const result = run(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });

test('Windows Atlas read-only lookups retry transient failures without widening access',
  { skip: !onWindows }, () => {
    const common = path.join(scripts, 'atlas_ip_access_common.ps1').replaceAll("'", "''");
    const command = [
      `$ErrorActionPreference='Stop'; . '${common}'`,
      "$script:ipAttempts=0; function Invoke-WebRequest { $script:ipAttempts++; if($script:ipAttempts -eq 1){throw 'offline'}; [pscustomobject]@{Content='{\"ip\":\"198.51.100.4\"}'} }",
      "if((Get-WealthGeniePublicIPv4) -ne '198.51.100.4' -or $script:ipAttempts -ne 2){exit 1}",
      "$script:listAttempts=0; function MockAtlas { $script:listAttempts++; if($script:listAttempts -eq 1){$global:LASTEXITCODE=1; return}; $global:LASTEXITCODE=0; Write-Output '{\"results\":[]}' }",
      "$entries=@(Get-WealthGenieAtlasEntries -AtlasCli 'MockAtlas' -ProjectId '0123456789abcdef01234567')",
      'if($entries.Count -ne 0 -or $script:listAttempts -ne 2){exit 2}',
      "Write-Output 'PASS'",
    ].join('; ');
    const result = run(['-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });
