[CmdletBinding()]
param([ValidateSet("archive", "bytes", "first-install", "acl", "task", "process-record", "launcher", "protocol", "rollback", "orphan", "mutex", "reinstall", "runtime-verifier")][string]$Case = "archive")

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vision-release-materialization.psm1") -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot "vision-diagnostic-redaction.psm1") -Force -ErrorAction Stop

function Assert-Throws([scriptblock]$Action, [string]$Label) {
  try { & $Action } catch { return }
  throw "expected rejection: $Label"
}

function Assert-ThrowsMessage([scriptblock]$Action, [string]$Pattern, [string]$Label) {
  try { & $Action } catch {
    if ($_.Exception.Message -match $Pattern) { return }
    throw "unexpected rejection for ${Label}: $($_.Exception.Message)"
  }
  throw "expected rejection: $Label"
}

function New-Zip([string]$Path, [object[]]$Entries) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($pair in $Entries) {
        $entry = $archive.CreateEntry([string]$pair[0])
        if ($pair.Count -gt 2) { $entry.ExternalAttributes = [int]$pair[2] }
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write([string]$pair[1]) } finally { $writer.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

function Import-InstallerFunctions {
  $installerPath = Join-Path $PSScriptRoot "install-vision-release.ps1"
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -ne 0) { throw "production installer does not parse" }
  foreach ($functionAst in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false))) {
    Invoke-Expression ($functionAst.Extent.Text.Replace(("function " + $functionAst.Name), ("function global:" + $functionAst.Name)))
  }
}

# Portable cases exercise function bodies extracted from the actual installer
# entry point.  This is intentionally not an installer -Library mode: release
# mutation remains available only through the production entry script.
Import-InstallerFunctions

function Test-SourceBoundary([string[]]$Needles) {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "install-vision-release.ps1") -Raw -Encoding UTF8
  foreach ($needle in $Needles) {
    if (-not $source.Contains($needle)) { throw "missing fixture boundary: $needle" }
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-installer-fixture-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  if ($Case -eq "archive") {
    foreach ($attack in @(@(,@("../escape.exe", "x")), @(,@("/absolute.exe", "x")), @(,@("runtime.exe:stream", "x")), @(@("Runtime.EXE", "a"), @("runtime.exe", "b")), @(,@("unix-link", "target", -1610612736)), @(,@("windows-reparse", "target", 0x00000400)), @(,@("unix-link-dir/", "target", -1610612736)), @(,@("windows-reparse-dir/", "target", 0x00000400)))) {
      $bundle = Join-Path $root ([guid]::NewGuid().ToString("N") + ".zip")
      $target = Join-Path $root ([guid]::NewGuid().ToString("N"))
      New-Zip $bundle $attack
      $bytes = [IO.File]::ReadAllBytes($bundle)
      $digest = "sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))).ToLowerInvariant()
      $descriptor = [pscustomobject]@{ bundle=[pscustomobject]@{ digest=$digest; bytes=[Int64]$bytes.Length } }
      Assert-Throws { Invoke-VisionReleaseMaterialization -CandidatePath $bundle -ExpectedDigest $digest -Descriptor $descriptor -Destination $target -ExtractionPolicy @{ MaxArchiveEntries=16; MaxExpandedBytes=4096; MaxExpansionRatio=20 } } "unsafe archive"
    }
    $bundle = Join-Path $root "safe.zip"
    New-Zip $bundle @(,@("bin/runtime.exe", "safe runtime"))
    $bytes = [IO.File]::ReadAllBytes($bundle)
    $digest = "sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))).ToLowerInvariant()
    $descriptor = [pscustomobject]@{ bundle=[pscustomobject]@{ digest=$digest; bytes=[Int64]$bytes.Length } }
    $safeTarget = Join-Path $root "safe-materialization"
    Invoke-VisionReleaseMaterialization -CandidatePath $bundle -ExpectedDigest $digest -Descriptor $descriptor -Destination $safeTarget -ExtractionPolicy @{ MaxArchiveEntries=16; MaxExpandedBytes=4096; MaxExpansionRatio=20 } | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $safeTarget "bin/runtime.exe") -PathType Leaf)) { throw "safe archive was not materialized" }
    $guarded = Join-Path $root "guarded\nested"; $outside = Join-Path $root "outside"
    New-Item -ItemType Directory -Path $guarded,$outside -Force | Out-Null
    $reparse = Join-Path $guarded "redirect"
    try {
      New-Item -ItemType SymbolicLink -Path $reparse -Target $outside | Out-Null
      Assert-ThrowsMessage {
        Invoke-VisionReleaseMaterialization -CandidatePath $bundle -ExpectedDigest $digest -Descriptor $descriptor -Destination (Join-Path $reparse "materialization") -ExtractionPolicy @{ MaxArchiveEntries=16; MaxExpandedBytes=4096; MaxExpansionRatio=20 }
      } "destination must not traverse a reparse point" "destination ancestor reparse"
    } catch [System.UnauthorizedAccessException] { Write-Output "destination reparse fixture skipped by host policy" }
    Write-Output "archive fixtures passed"
  } elseif ($Case -eq "bytes") {
    $file = Join-Path $root "record.json"; [IO.File]::WriteAllText($file, '{"ok":true}', [Text.UTF8Encoding]::new($false))
    $bytes = Get-ExactFileBytes $file "fixture"; if ((Get-Digest $bytes) -notmatch '^sha256:') { throw "exact digest missing" }
    $link = Join-Path $root "reparse.json"
    try { New-Item -ItemType SymbolicLink -Path $link -Target $file | Out-Null; Assert-Throws { Get-ExactFileBytes $link "reparse" } "reparse file" } catch [System.UnauthorizedAccessException] { Write-Output "symlink fixture skipped by host policy" }
    $redacted = Sanitize "failed at C:\\VEM\\vision token=super-secret"
    if ($redacted -match 'super-secret|C:\\VEM') { throw "failure was not sanitized" }
    Write-Output "bytes fixtures passed"
  } elseif ($Case -eq "first-install") {
    $delivery = Join-Path $root "factory\vision-release"; New-Item -ItemType Directory -Path $delivery -Force | Out-Null
    foreach ($name in @("bundle.bin", "descriptor.json", "attestation.json", "sbom.json", "provenance.json", "conformance.json", "approval.json", "factory-manifest.json")) { [IO.File]::WriteAllText((Join-Path $delivery $name), "fixture", [Text.UTF8Encoding]::new($false)) }
    Assert-NonReparsePath $delivery "first install delivery"
    $outside = Join-Path $root "outside-delivery"; New-Item -ItemType Directory -Path $outside -Force | Out-Null
    $redirect = Join-Path $delivery "redirect"
    try {
      New-Item -ItemType SymbolicLink -Path $redirect -Target $outside | Out-Null
      Assert-Throws { Assert-NonReparsePath (Join-Path $redirect "descriptor.json") "first install delivery" } "installer delivery ancestor reparse"
      Assert-Throws { Get-CanonicalContainedPath $delivery (Join-Path $redirect "descriptor.json") "installer delivery file" } "installer delivery contained reparse"
    } catch [System.UnauthorizedAccessException] { Write-Output "installer reparse fixture skipped by host policy" }
    Test-SourceBoundary @('$FactoryTrustRoot', "Get-FactoryTrustPolicy", "Set-SystemInstallerAcl", "Assert-ReleaseContracts")
    Write-Output "first-install fixtures passed"
  } elseif ($Case -eq "acl") {
    $protected = Join-Path $root "protected"; New-Item -ItemType Directory -Path $protected | Out-Null
    Set-SystemInstallerAcl $protected $false
    Assert-NonReparsePath $protected "fixture ACL root"
    Test-SourceBoundary @("SetAccessRuleProtection", "SYSTEM", "BUILTIN\\Administrators", "VEMKiosk")
    Write-Output "acl fixtures passed"
  } elseif ($Case -eq "task") {
    $script:registeredTask = $null
    function Get-ScheduledTask { return $null }
    function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{ execute=$Execute; argument=$Argument; workingDirectory=$WorkingDirectory } }
    function New-ScheduledTaskTrigger { param($User) return [pscustomobject]@{ user=$User } }
    function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return [pscustomobject]@{ user=$UserId; logon=$LogonType; runLevel=$RunLevel } }
    function Register-ScheduledTask { param($TaskName,$TaskPath,$Action,$Trigger,$Principal) $script:registeredTask = [pscustomobject]@{ name=$TaskName; path=$TaskPath; action=$Action; trigger=$Trigger; principal=$Principal } }
    Ensure-VisionTask
    if ($null -eq $script:registeredTask -or $script:registeredTask.name -cne "StartVisionServer" -or $script:registeredTask.path -cne "\VEM\") { throw "interactive Vision task was not registered" }
    Write-Output "task fixtures passed"
  } elseif ($Case -eq "process-record") {
    $releaseRoot = Join-Path $root "releases"; $processStateRoot = Join-Path $root "process-state"; $processPath = Join-Path $processStateRoot "active-process.json"; $selectionPath = Join-Path $root "current.json"
    New-Item -ItemType Directory -Path $releaseRoot,$processStateRoot -Force | Out-Null
    $approvedPath = Join-Path $releaseRoot "approved.exe"; $victimPath = Join-Path $root "victim.exe"; [IO.File]::WriteAllText($approvedPath, "approved", [Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText($victimPath, "victim", [Text.UTF8Encoding]::new($false))
    $approvedDigest = "sha256:" + (Get-FileHash -LiteralPath $approvedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selection = [pscustomobject]@{ revision="revision-1"; bundleDigest=("sha256:" + "a" * 64) }
    $startTime = [datetime]"2026-01-01T00:00:00Z"
    [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=4242; creationTimeUtcTicks=$startTime.Ticks; executablePath=$victimPath; executableDigest="sha256:" + "b" * 64; selectionRevision=$selection.revision } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $script:stoppedProcess = $null
    function Stop-ScheduledTask {}
    function Resolve-ApprovedVisionExecution { return [pscustomobject]@{ revision=$selection.revision; bundleDigest=$selection.bundleDigest; executablePath=$approvedPath; executableDigest=$approvedDigest } }
    $script:fixtureProcess = [pscustomobject]@{ Id=4242; Path=$victimPath; StartTime=$startTime }
    function Get-Process { return $script:fixtureProcess }
    Stop-RecordedVision $selection
    if ($null -ne $script:stoppedProcess) { throw "kiosk process record stopped an arbitrary process" }
    [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=4242; creationTimeUtc=$startTime.ToString("o"); executablePath=$victimPath; executableDigest="sha256:" + "b" * 64; selectionRevision=$selection.revision } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsMessage { Stop-RecordedVision $selection } "unsupported legacy creationTimeUtc identity; hard migration requires creationTimeUtcTicks" "legacy process record migration diagnostic"
    [IO.File]::WriteAllText($processPath, "", [Text.UTF8Encoding]::new($false))
    Assert-ThrowsMessage { Stop-RecordedVision $selection } "Vision process record size is invalid" "empty process record normal diagnostic"
    [IO.File]::WriteAllText($processPath, "{", [Text.UTF8Encoding]::new($false))
    Assert-ThrowsMessage { Stop-RecordedVision $selection } "Vision process record is not valid UTF-8 JSON" "corrupt process record normal diagnostic"
    [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=4242; creationTimeUtc=$startTime.ToString("o"); executablePath=$victimPath; executableDigest="sha256:" + "b" * 64; selectionRevision=$selection.revision; unknown="unexpected" } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsMessage { Stop-RecordedVision $selection } "Vision process record has unknown or missing fields" "unknown-key process record normal diagnostic"
    [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=4242; creationTimeUtcTicks=$startTime.Ticks; executablePath=$approvedPath; executableDigest=$approvedDigest; selectionRevision=$selection.revision } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    function Get-Process { return $null }
    Stop-RecordedVision $selection
    if (Test-Path -LiteralPath $processPath -PathType Leaf) { throw "stale trusted process record was not removed" }
    if ($env:OS -eq "Windows_NT") {
      $fakeWindir = Join-Path $root "fake-windir"; $fakeSystem32 = Join-Path $fakeWindir "System32"; New-Item -ItemType Directory -Force -Path $fakeSystem32 | Out-Null
      $fakeTaskKill = Join-Path $fakeSystem32 "taskkill.exe"; $fakeTaskKillSource = Join-Path $root "FakeTaskKill.cs"
      [IO.File]::WriteAllText($fakeTaskKillSource, 'public static class FakeTaskKill { public static int Main() { return 23; } }', [Text.UTF8Encoding]::new($false))
      $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
      & $csc /nologo /target:exe ("/out:{0}" -f $fakeTaskKill) $fakeTaskKillSource
      if ($LASTEXITCODE -ne 0) { throw "taskkill failure fixture compilation failed" }
      & $fakeTaskKill /PID "1" /T /F | Out-Null
      if ($LASTEXITCODE -ne 23) { throw "taskkill failure fixture did not produce exit code 23" }

      $previousWindir = $env:WINDIR; $runtime = $null; $exitedRuntime = $null
      try {
        $env:WINDIR = $fakeWindir
        $pwshPath = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
        $runtime = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru
        $script:fixtureProcess = $runtime
        $script:fixtureExecutionPath = [IO.Path]::GetFullPath($runtime.Path)
        $script:fixtureExecutionDigest = "sha256:" + (Get-FileHash -LiteralPath $script:fixtureExecutionPath -Algorithm SHA256).Hash.ToLowerInvariant()
        function Get-Process { param([int]$Id) return Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop }
        function Resolve-ApprovedVisionExecution { return [pscustomobject]@{ revision=$selection.revision; bundleDigest=$selection.bundleDigest; executablePath=$script:fixtureExecutionPath; executableDigest=$script:fixtureExecutionDigest } }
        function Get-CanonicalContainedPath { param([string]$BasePath, [string]$CandidatePath, [string]$Label) return [IO.Path]::GetFullPath($CandidatePath) }
        [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=$runtime.Id; creationTimeUtcTicks=$runtime.StartTime.ToUniversalTime().Ticks; executablePath=$script:fixtureExecutionPath; executableDigest=$script:fixtureExecutionDigest; selectionRevision=$selection.revision } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        Assert-ThrowsMessage { Stop-RecordedVision $selection } "tree cleanup failed: taskkill /T /F exited with code" "taskkill failure preserves a live verified process record"
        if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) { throw "taskkill failure removed the verified process record" }
        if ($runtime.HasExited) { throw "taskkill failure stopped the verified runtime" }

        $exitedRuntime = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru
        $exitedRuntime.Kill(); $exitedRuntime.WaitForExit(5000) | Out-Null
        Assert-ThrowsMessage { Stop-VerifiedProcessTree $exitedRuntime } "tree cleanup failed: taskkill /T /F exited with code" "taskkill failure is not hidden after the root process exits"
      } finally {
        $env:WINDIR = $previousWindir
        foreach ($tracked in @($runtime, $exitedRuntime)) {
          if ($null -eq $tracked) { continue }
          try { if (-not $tracked.HasExited) { $tracked.Kill(); $tracked.WaitForExit(5000) | Out-Null } } finally { $tracked.Dispose() }
        }
      }
    }
    Test-SourceBoundary @('Resolve-ApprovedVisionExecution $Selection', '$legacyKeys = @("bundleDigest", "processId", "creationTimeUtc", "executablePath", "executableDigest", "selectionRevision")', '$isExpectedLegacyRecord =', 'unsupported legacy creationTimeUtc identity; hard migration requires creationTimeUtcTicks', 'Assert-Keys $record @("bundleDigest", "processId", "creationTimeUtcTicks", "executablePath", "executableDigest", "selectionRevision") "Vision process record"', 'if ($null -eq $process) {', '$process -isnot [Diagnostics.Process]', '$process.StartTime.ToUniversalTime().Ticks -ne $record.creationTimeUtcTicks', '$actualPath -cne $approved.executablePath', '$approved.executableDigest', 'function Stop-VerifiedProcessTree', 'Stop-VerifiedProcessTree $process', 'taskkill.exe', 'taskkill /T /F exited with code', '$process.WaitForExit(5000)', '$process.Dispose()')
    Write-Output "process-record fixtures passed"
  } elseif ($Case -eq "launcher") {
    $script:launcherPath = Join-Path $root "start_vision.bat"
    $script:launcherScriptPath = Join-Path $root "launch-vision-release.ps1"
    function Set-SystemInstallerAcl {}
    Write-VisionLauncher
    $launcher = Get-Content -LiteralPath $script:launcherScriptPath -Raw -Encoding UTF8
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($script:launcherScriptPath, [ref]$tokens, [ref]$errors) | Out-Null
    if (@($errors).Count -ne 0) { throw "generated launcher did not parse: $($errors[0])" }
    if ($env:OS -eq "Windows_NT") {
      $windowsPowerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
      if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw "Windows PowerShell 5.1 is missing" }
    }
    if ($launcher.Contains("ArgumentList") -or $launcher.Contains("Kill(`$true)") -or $launcher.Contains("ConvertFrom-Json -Depth")) { throw "generated launcher uses APIs unavailable in Windows PowerShell/.NET Framework" }
    if (-not $launcher.Contains("ConvertTo-WindowsCommandLineArgument") -or -not $launcher.Contains("CreateProcessW") -or -not $launcher.Contains("CREATE_SUSPENDED") -or -not $launcher.Contains("VemVisionLauncher.KillOnCloseJob")) { throw "generated launcher is missing Win32 suspended launch or Job Object cleanup" }
    if (-not $launcher.Contains("`$recordCommitted = `$false") -or -not $launcher.Contains("`$job.Assign(`$nativeProcess.ProcessHandle)") -or -not $launcher.Contains("`$nativeProcess.Resume()") -or -not $launcher.Contains("[Diagnostics.Process]::GetProcessById([int]`$nativeProcess.ProcessId)") -or -not $launcher.Contains("`$job.Terminate()") -or -not $launcher.Contains("TerminateJobObject") -or -not $launcher.Contains("[AggregateException]::new")) { throw "generated launcher does not retain failures while atomically cleaning native process and Job Object handles" }
    $quoteFunctionStart = $launcher.IndexOf("function ConvertTo-WindowsCommandLineArgument")
    $quoteFunctionEnd = $launcher.IndexOf('$commandLine =', $quoteFunctionStart)
    if ($quoteFunctionStart -lt 0 -or $quoteFunctionEnd -lt 0) { throw "generated launcher quote function is incomplete" }
    Invoke-Expression $launcher.Substring($quoteFunctionStart, $quoteFunctionEnd - $quoteFunctionStart)
    $quoted = @("plain", "space value", 'quote"value', 'trailing\' | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join "|"
    if ($quoted -cne '"plain"|"space value"|"quote\"value"|"trailing\\"') { throw "generated launcher did not safely quote command-line arguments: $quoted" }
    if ($env:OS -eq "Windows_NT") {
      $fixtureStateRoot = Join-Path $root "launcher-state"
      $fixtureProcessState = Join-Path $fixtureStateRoot "process-state"
      $fixtureRuntimePath = Join-Path $root "launcher-fixture-runtime.exe"
      $fixtureRuntimeSourcePath = Join-Path $root "LauncherFixtureRuntime.cs"
      $fixtureConfigurationPath = Join-Path $fixtureStateRoot "fixture.json"
      $fixtureSelectionPath = Join-Path $fixtureStateRoot "current.json"
      $fixtureLauncherPath = Join-Path $root "launch-vision-release-fixture.ps1"
      $fixtureDescendantIdentityPath = Join-Path $root "launcher-fixture-descendant.pid"
      $escapedFixtureDescendantIdentityPath = $fixtureDescendantIdentityPath.Replace("'", "''")
      $fixtureRuntimeSource = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
public static class LauncherFixtureRuntime {
  public static void Main(string[] args) {
    var child = Array.IndexOf(args, "--fixture-descendant") >= 0;
    var identityIndex = Array.IndexOf(args, "--fixture-descendant-identity");
    var identityPath = identityIndex >= 0 && identityIndex + 1 < args.Length ? args[identityIndex + 1] : null;
    if (!child) {
      var childStart = new ProcessStartInfo();
      childStart.FileName = Process.GetCurrentProcess().MainModule.FileName;
      childStart.UseShellExecute = false;
      childStart.Arguments = "--fixture-descendant";
      var descendant = Process.Start(childStart);
      if (descendant == null) { Environment.Exit(3); }
      try {
        if (!String.IsNullOrEmpty(identityPath)) { File.WriteAllText(identityPath, Process.GetCurrentProcess().Id.ToString() + "," + descendant.Id.ToString()); }
      } finally {
        descendant.Dispose();
      }
    }
    Thread.Sleep(60000);
  }
}
"@
      [IO.File]::WriteAllText($fixtureRuntimeSourcePath, $fixtureRuntimeSource, [Text.UTF8Encoding]::new($false))
      $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
      if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "C# compiler missing for Windows PowerShell launcher fixture" }
      & $csc /nologo /target:exe ("/out:{0}" -f $fixtureRuntimePath) $fixtureRuntimeSourcePath
      if ($LASTEXITCODE -ne 0) { throw "launcher fixture runtime compilation failed" }
      New-Item -ItemType Directory -Path $fixtureProcessState -Force | Out-Null
      [IO.File]::WriteAllText($fixtureConfigurationPath, "{}", [Text.UTF8Encoding]::new($false))
      $fixtureSelection = [ordered]@{ revision="fixture-revision"; bundleDigest=("sha256:" + ("a" * 64)); installDirectory=$root; entrypoint=(Split-Path -Leaf $fixtureRuntimePath); arguments=@("--fixture-descendant-identity", $fixtureDescendantIdentityPath); configurationArgument="--config"; configurationPath=$fixtureConfigurationPath }

      function New-FixturePostStartFailure {
        return @"
function Wait-FixtureRuntimeIdentities {
  `$identityPath = '$escapedFixtureDescendantIdentityPath'
  `$deadlineUtc = [DateTime]::UtcNow.AddSeconds(5)
  `$lastIdentity = "<missing>"
  [int]`$parentId = 0
  [int]`$descendantId = 0
  do {
    if (Test-Path -LiteralPath `$identityPath -PathType Leaf) {
      try {
        `$lastIdentity = (Get-Content -LiteralPath `$identityPath -Raw -Encoding UTF8).Trim()
        `$parts = `$lastIdentity.Split(',')
        if (`$parts.Count -eq 2 -and [int]::TryParse(`$parts[0], [ref]`$parentId) -and `$parentId -gt 0 -and [int]::TryParse(`$parts[1], [ref]`$descendantId) -and `$descendantId -gt 0 -and `$parentId -ne `$descendantId) {
          return [pscustomobject]@{ parentId=`$parentId; descendantId=`$descendantId }
        }
      } catch {
        `$lastIdentity = "<read failed: `$(`$_.Exception.Message)>"
      }
    }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt `$deadlineUtc)
  throw "launcher fixture identity wait timed out: fixture runtime did not record parent and child process identities; identityPath=`$identityPath lastIdentity=`$lastIdentity"
}
"@
      }

      function Get-FixturePostStartFailureMessage([string]$Failure) {
        if ($Failure -in @("selection-reread", "selection-reread-and-cleanup", "selection-reread-job-terminated-native-race")) { return "injected selection reread failure" }
        if ($Failure -eq "hash") { return "injected hash failure" }
        if ($Failure -eq "record-write") { return "injected record write failure" }
        throw "unknown post-start fixture failure: $Failure"
      }

      function Add-FixturePostStartFailure([string]$ExecutionLauncher, [string]$Failure) {
        $functionAnchor = '$launchFailure = $null'
        if (-not $ExecutionLauncher.Contains($functionAnchor)) { throw "generated launcher fixture did not retain the post-start failure function boundary" }
        $executionWithIdentityWait = $ExecutionLauncher.Replace($functionAnchor, ((New-FixturePostStartFailure) + "`n" + $functionAnchor))
        $message = Get-FixturePostStartFailureMessage $Failure

        if ($Failure -in @("selection-reread", "selection-reread-and-cleanup", "selection-reread-job-terminated-native-race")) {
          $needle = '  $current = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json'
          $replacement = "  Wait-FixtureRuntimeIdentities`n  throw `"$message`""
        } elseif ($Failure -eq "hash") {
          $handshakeNeedle = '  $record = [ordered]@{'
          $handshakeReplacement = "  Wait-FixtureRuntimeIdentities`n" + $handshakeNeedle
          if (-not $executionWithIdentityWait.Contains($handshakeNeedle)) { throw "generated launcher fixture did not retain the hash identity handshake boundary" }
          $executionWithIdentityWait = $executionWithIdentityWait.Replace($handshakeNeedle, $handshakeReplacement)
          $needle = 'Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256'
          $replacement = '$(' + ('throw "{0}"' -f $message) + ')'
        } elseif ($Failure -eq "record-write") {
          $needle = '[IO.File]::WriteAllText($temporary,'
          $replacement = "Wait-FixtureRuntimeIdentities`n  throw `"$message`"`n  [IO.File]::WriteAllText(`$temporary,"
        }

        if (-not $executionWithIdentityWait.Contains($needle)) { throw "generated launcher fixture did not retain the $Failure failure boundary" }
        return $executionWithIdentityWait.Replace($needle, $replacement)
      }

      function Write-LauncherExecutionFixture([string]$Failure) {
        Remove-Item -LiteralPath $fixtureDescendantIdentityPath -Force -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($fixtureSelectionPath, ($fixtureSelection | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        $executionLauncher = $launcher.Replace('$stateRoot = "C:\ProgramData\VEM\vision"', ("`$stateRoot = '{0}'" -f $fixtureStateRoot.Replace("'", "''")))
        if ($Failure -in @("selection-reread", "hash", "record-write", "selection-reread-and-cleanup", "selection-reread-job-terminated-native-race")) {
          $executionLauncher = Add-FixturePostStartFailure $executionLauncher $Failure
        }
        if ($Failure -in @("selection-reread-and-cleanup", "selection-reread-job-terminated-native-race")) {
          $terminationFailureEnvironmentVariable = "VEM_VISION_LAUNCHER_FIXTURE_FORCE_TERMINATE_FAILURE"
          $nativeTerminationRaceEnvironmentVariable = "VEM_VISION_LAUNCHER_FIXTURE_FORCE_NATIVE_TERMINATE_FALSE"
          $nativeTerminationStub = @"
    private const uint FIXTURE_TERMINATE_PROCESS_ERROR = 5;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void SetLastError(uint dwErrCode);

    private static bool TerminateProcessForFixture(IntPtr processHandle, uint exitCode) {
      if (Environment.GetEnvironmentVariable("$terminationFailureEnvironmentVariable") == "1" || Environment.GetEnvironmentVariable("$nativeTerminationRaceEnvironmentVariable") == "1") {
        SetLastError(FIXTURE_TERMINATE_PROCESS_ERROR);
        return false;
      }
      return TerminateProcess(processHandle, exitCode);
    }

"@
          $waitForSingleObjectPInvoke = @'
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
'@
          $waitForSingleObjectFixtureReplacement = @"
    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "WaitForSingleObject")]
    private static extern uint WaitForSingleObjectNativeForFixture(IntPtr handle, uint milliseconds);

    private static uint WaitForSingleObject(IntPtr handle, uint milliseconds) {
      if (Environment.GetEnvironmentVariable("$nativeTerminationRaceEnvironmentVariable") == "1" && milliseconds == 0) {
        return WAIT_TIMEOUT;
      }
      return WaitForSingleObjectNativeForFixture(handle, milliseconds);
    }

"@
          $jobTerminationStub = @"
    private const uint FIXTURE_TERMINATE_JOB_ERROR = 87;

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetLastError")]
    private static extern void SetLastErrorForFixture(uint dwErrCode);

    private static bool TerminateJobObjectForFixture(IntPtr job, uint exitCode) {
      if (Environment.GetEnvironmentVariable("$terminationFailureEnvironmentVariable") == "1") {
        SetLastErrorForFixture(FIXTURE_TERMINATE_JOB_ERROR);
        return false;
      }
      return TerminateJobObject(job, exitCode);
    }

"@
          $nativeTerminationMethod = @'
    public void Terminate() {
      if (processHandle == IntPtr.Zero) { return; }
      if (TerminateProcess(processHandle, 1)) { return; }
'@
          $jobTerminationMethod = @'
    public void Terminate() {
      if (handle == IntPtr.Zero) { return; }
      if (TerminateJobObject(handle, 1)) { return; }
'@
          if (-not $executionLauncher.Contains($nativeTerminationMethod)) { throw "generated launcher fixture did not retain the native termination path" }
          $executionLauncher = $executionLauncher.Replace($nativeTerminationMethod, ($nativeTerminationStub + $nativeTerminationMethod.Replace('TerminateProcess(processHandle, 1)', 'TerminateProcessForFixture(processHandle, 1)')))
          if (-not $executionLauncher.Contains($waitForSingleObjectPInvoke)) { throw "generated launcher fixture did not retain the WaitForSingleObject P/Invoke boundary" }
          $executionLauncher = $executionLauncher.Replace($waitForSingleObjectPInvoke, $waitForSingleObjectFixtureReplacement)
          if ($executionLauncher.Contains($waitForSingleObjectPInvoke) -or -not $executionLauncher.Contains('WaitForSingleObjectNativeForFixture') -or -not $executionLauncher.Contains('private static uint WaitForSingleObject(IntPtr handle, uint milliseconds)')) { throw "generated launcher fixture did not intercept the WaitForSingleObject P/Invoke call" }
          if ($Failure -eq "selection-reread-and-cleanup") {
            if (-not $executionLauncher.Contains($jobTerminationMethod)) { throw "generated launcher fixture did not retain the Job Object termination path" }
            $executionLauncher = $executionLauncher.Replace($jobTerminationMethod, ($jobTerminationStub + $jobTerminationMethod.Replace('TerminateJobObject(handle, 1)', 'TerminateJobObjectForFixture(handle, 1)')))
          }
          foreach ($stub in @("TerminateProcessForFixture", "SetLastError(FIXTURE_TERMINATE_PROCESS_ERROR)", "WaitForSingleObjectNativeForFixture", $nativeTerminationRaceEnvironmentVariable)) {
            if (-not $executionLauncher.Contains($stub)) { throw "generated launcher fixture did not inject runtime native termination failure: $stub" }
          }
          if ($Failure -eq "selection-reread-and-cleanup") {
            foreach ($stub in @("TerminateJobObjectForFixture", "SetLastErrorForFixture(FIXTURE_TERMINATE_JOB_ERROR)", $terminationFailureEnvironmentVariable)) {
              if (-not $executionLauncher.Contains($stub)) { throw "generated launcher fixture did not inject runtime native termination failure: $stub" }
            }
          }
        }
        if ($executionLauncher -ceq $launcher) { throw "launcher execution fixture did not inject $Failure" }
        [IO.File]::WriteAllText($fixtureLauncherPath, $executionLauncher, [Text.UTF8Encoding]::new($false))
        Assert-WindowsPowerShellFixtureParses $fixtureLauncherPath ("launcher-$Failure")
      }

      function Get-FixtureRuntimeProcesses {
        return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
          try { $_.Path -ceq $fixtureRuntimePath } catch { $false }
        })
      }

      function Assert-FixtureRuntimeStopped([string]$Failure) {
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
          if (@(Get-FixtureRuntimeProcesses).Count -eq 0) { return }
          Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)
        throw "launcher $Failure failure left its started process running"
      }

      function Wait-FixtureRuntimeIdentities([string]$Failure) {
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        $lastIdentity = "<missing>"
        do {
          if (Test-Path -LiteralPath $fixtureDescendantIdentityPath -PathType Leaf) {
            try {
              $lastIdentity = (Get-Content -LiteralPath $fixtureDescendantIdentityPath -Raw -Encoding UTF8).Trim()
              $parts = $lastIdentity.Split(',')
              [int]$parentId = 0
              [int]$descendantId = 0
              if ($parts.Count -eq 2 -and [int]::TryParse($parts[0], [ref]$parentId) -and $parentId -gt 0 -and [int]::TryParse($parts[1], [ref]$descendantId) -and $descendantId -gt 0 -and $parentId -ne $descendantId) {
                return [pscustomobject]@{ parentId=$parentId; descendantId=$descendantId }
              }
            } catch {
              $lastIdentity = "<read failed: $($_.Exception.Message)>"
            }
          }
          Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $deadline)
        throw "launcher fixture identity wait timed out: fixture runtime did not record parent and child process identities for $Failure; identityPath=$fixtureDescendantIdentityPath lastIdentity=$lastIdentity"
      }

      function Assert-FixtureRuntimeIdentitiesStopped([string]$Failure, [object]$Identities) {
        foreach ($identity in @(
          [pscustomobject]@{ role="parent"; processId=[int]$Identities.parentId },
          [pscustomobject]@{ role="descendant"; processId=[int]$Identities.descendantId }
        )) {
          $fixtureProcess = Get-Process -Id $identity.processId -ErrorAction SilentlyContinue
          if ($null -ne $fixtureProcess) {
            try { throw "launcher $Failure failure left tracked $($identity.role) process $($identity.processId) running" } finally { $fixtureProcess.Dispose() }
          }
        }
      }

      function Get-FixtureCapturedText([object[]]$CapturedOutput) {
        $text = ((@($CapturedOutput) | Out-String -Width 4096).Trim())
        if ([string]::IsNullOrWhiteSpace($text)) { return "<no output>" }
        return $text
      }

      $fixtureParserPath = Join-Path $root "assert-windows-powershell-parser.ps1"
      [IO.File]::WriteAllText($fixtureParserPath, @'
param([Parameter(Mandatory=$true)][string]$Path)
$tokens = $null
$errors = $null
[Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors) | Out-Null
if (@($errors).Count -ne 0) {
  foreach ($parseError in @($errors)) {
    Write-Output ("parser=error line={0} column={1} message={2}" -f $parseError.Extent.StartLineNumber, $parseError.Extent.StartColumnNumber, $parseError.Message)
  }
  exit 1
}
Write-Output "parser=accepted errors=0"
'@, [Text.UTF8Encoding]::new($false))

      function Assert-WindowsPowerShellFixtureParses([string]$Path, [string]$Label) {
        $parserOutput = @(& $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $fixtureParserPath -Path $Path 2>&1)
        $parserText = Get-FixtureCapturedText $parserOutput
        if ($LASTEXITCODE -ne 0) { throw "launcher fixture PS5.1 parser rejected $Label; diagnostic:`n$parserText" }
        Write-Output ("launcher fixture PS5.1 parser passed: {0}; diagnostic={1}" -f $Label, $parserText)
      }

      try {
        Write-LauncherExecutionFixture "success"
        & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureLauncherPath
        if ($LASTEXITCODE -ne 0) { throw "generated launcher did not execute in Windows PowerShell 5.1" }
        $fixtureRecordPath = Join-Path $fixtureProcessState "active-process.json"
        if (-not (Test-Path -LiteralPath $fixtureRecordPath -PathType Leaf)) { throw "generated launcher did not record its started process" }
        $fixtureRecord = Get-Content -LiteralPath $fixtureRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $fixtureProcess = Get-Process -Id $fixtureRecord.processId -ErrorAction Stop
        if ($fixtureProcess.Path -cne $fixtureRuntimePath) { throw "generated launcher recorded the wrong process" }
        $fixtureRuntimeIdentities = Wait-FixtureRuntimeIdentities "success"
        if ($fixtureRuntimeIdentities.parentId -ne $fixtureRecord.processId) { throw "generated launcher descendant record identified the wrong parent process" }
        $fixtureDescendant = Get-Process -Id $fixtureRuntimeIdentities.descendantId -ErrorAction Stop
        try {
          if ($fixtureDescendant.Path -cne $fixtureRuntimePath) { throw "generated launcher descendant used the wrong executable" }
          if ($fixtureProcess.HasExited -or $fixtureDescendant.HasExited) { throw "successful launcher fixture did not detach its Job Object" }
          $fixtureDescendant.Kill()
          if (-not $fixtureDescendant.WaitForExit(5000)) { throw "successful launcher fixture descendant did not exit" }
          $fixtureProcess.Kill()
          if (-not $fixtureProcess.WaitForExit(5000)) { throw "successful launcher fixture process did not exit" }
        } finally {
          $fixtureDescendant.Dispose()
          $fixtureProcess.Dispose()
        }

        $fixtureFailureRunnerPath = Join-Path $root "launch-vision-release-failure-fixture.ps1"
        $escapedFixtureLauncherPath = $fixtureLauncherPath.Replace("'", "''")
        foreach ($failure in @("selection-reread", "hash", "record-write")) {
          Remove-Item -LiteralPath $fixtureRecordPath -Force -ErrorAction SilentlyContinue
          Write-LauncherExecutionFixture $failure
          $expectedFailureMessage = Get-FixturePostStartFailureMessage $failure
          $escapedExpectedFailureMessage = $expectedFailureMessage.Replace("'", "''")
          [IO.File]::WriteAllText($fixtureFailureRunnerPath, @"
`$ErrorActionPreference = "Stop"
try {
  & '$escapedFixtureLauncherPath'
  throw "launcher failure fixture did not throw"
} catch {
  `$failure = `$_.Exception
  if (`$failure -isnot [Management.Automation.RuntimeException] -or `$failure.Message -cne '$escapedExpectedFailureMessage') {
    throw ("launcher failure fixture did not preserve the injected $expectedFailureMessage failure: type={0}; message={1}" -f `$failure.GetType().FullName, `$failure.Message)
  }
  Write-Output ("launcher failure fixture passed: {0}" -f `$failure.Message)
}
"@, [Text.UTF8Encoding]::new($false))
          Assert-WindowsPowerShellFixtureParses $fixtureFailureRunnerPath ("$failure-failure-runner")
          $fixtureFailureOutput = @(& $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureFailureRunnerPath 2>&1)
          $fixtureFailureText = Get-FixtureCapturedText $fixtureFailureOutput
          if ($LASTEXITCODE -ne 0) { throw "generated launcher failure fixture runner failed for injected $failure failure; captured output:`n$fixtureFailureText" }
          $expectedFailureReport = "launcher failure fixture passed: $expectedFailureMessage"
          if ($fixtureFailureText -notmatch [regex]::Escape($expectedFailureReport)) { throw "launcher failure fixture runner did not report the injected $failure failure; captured output:`n$fixtureFailureText" }
          $fixtureRuntimeIdentities = Wait-FixtureRuntimeIdentities $failure
          Assert-FixtureRuntimeStopped $failure
          Assert-FixtureRuntimeIdentitiesStopped $failure $fixtureRuntimeIdentities
          if (Test-Path -LiteralPath $fixtureRecordPath -PathType Leaf) { throw "launcher $failure failure committed a process record" }
        }

        Remove-Item -LiteralPath $fixtureRecordPath -Force -ErrorAction SilentlyContinue
        Write-LauncherExecutionFixture "selection-reread-job-terminated-native-race"
        [IO.File]::WriteAllText($fixtureFailureRunnerPath, @"
`$ErrorActionPreference = "Stop"
`$env:VEM_VISION_LAUNCHER_FIXTURE_FORCE_NATIVE_TERMINATE_FALSE = "1"
`$fixtureIdentityPath = '$escapedFixtureDescendantIdentityPath'
`$fixtureRuntimeIdentities = `$null
try {
  & '$escapedFixtureLauncherPath'
  throw "launcher race fixture did not throw"
} catch {
  `$identity = (Get-Content -LiteralPath `$fixtureIdentityPath -Raw -Encoding UTF8).Trim().Split(',')
  [int]`$parentId = 0
  [int]`$descendantId = 0
  if (`$identity.Count -ne 2 -or -not [int]::TryParse(`$identity[0], [ref]`$parentId) -or `$parentId -lt 1 -or -not [int]::TryParse(`$identity[1], [ref]`$descendantId) -or `$descendantId -lt 1 -or `$parentId -eq `$descendantId) { throw "launcher race fixture runner did not collect parent and child process identities" }
  `$fixtureRuntimeIdentities = [pscustomobject]@{ parentId=`$parentId; descendantId=`$descendantId }
  `$failure = `$_.Exception
  if (`$failure -is [AggregateException]) { throw "launcher race fixture unexpectedly reported cleanup failure: `$(`$failure.Message)" }
  if (`$failure -isnot [Management.Automation.RuntimeException] -or `$failure.Message -ne "injected selection reread failure") { throw ("launcher race fixture did not preserve the injected selection reread failure: type={0}; message={1}" -f `$failure.GetType().FullName, `$failure.Message) }
}
if (`$null -eq `$fixtureRuntimeIdentities) { throw "launcher race fixture runner did not collect runtime process identities" }
Write-Output ("launcher race fixture passed parentId={0} descendantId={1}" -f `$fixtureRuntimeIdentities.parentId, `$fixtureRuntimeIdentities.descendantId)
"@, [Text.UTF8Encoding]::new($false))
        Assert-WindowsPowerShellFixtureParses $fixtureFailureRunnerPath "selection-reread-job-terminated-native-race-failure-runner"
        $fixtureFailureOutput = @(& $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureFailureRunnerPath 2>&1)
        $fixtureFailureText = Get-FixtureCapturedText $fixtureFailureOutput
        if ($LASTEXITCODE -ne 0) { throw "launcher race fixture runner failed; captured output:`n$fixtureFailureText" }
        if ($fixtureFailureText -notmatch "launcher race fixture passed") { throw "launcher race fixture did not report success; captured output:`n$fixtureFailureText" }
        $fixtureRuntimeIdentities = Wait-FixtureRuntimeIdentities "selection-reread-job-terminated-native-race"
        $expectedFixtureIdentityReport = "launcher race fixture passed parentId={0} descendantId={1}" -f $fixtureRuntimeIdentities.parentId, $fixtureRuntimeIdentities.descendantId
        if ($fixtureFailureText -notmatch [regex]::Escape($expectedFixtureIdentityReport)) { throw "launcher race fixture runner did not report the collected parent and child process identities; captured output:`n$fixtureFailureText" }
        Assert-FixtureRuntimeStopped "selection-reread-job-terminated-native-race"
        Assert-FixtureRuntimeIdentitiesStopped "selection-reread-job-terminated-native-race" $fixtureRuntimeIdentities
        if (Test-Path -LiteralPath $fixtureRecordPath -PathType Leaf) { throw "launcher race fixture committed a process record" }

        Remove-Item -LiteralPath $fixtureRecordPath -Force -ErrorAction SilentlyContinue
        Write-LauncherExecutionFixture "selection-reread-and-cleanup"
        [IO.File]::WriteAllText($fixtureFailureRunnerPath, @"
`$ErrorActionPreference = "Stop"
`$env:VEM_VISION_LAUNCHER_FIXTURE_FORCE_TERMINATE_FAILURE = "1"
`$fixtureIdentityPath = '$escapedFixtureDescendantIdentityPath'
`$fixtureRuntimeIdentities = `$null
try {
  & '$escapedFixtureLauncherPath'
  throw "aggregate failure fixture did not throw"
} catch {
  function Get-CleanupFailureDiagnostic([Exception]`$cleanupFailure, [int]`$index) {
    `$wrapperType = "<missing>"
    `$wrapperMessage = "<missing>"
    `$rootType = "<missing>"
    `$rootMessage = "<missing>"
    `$rootNativeErrorCode = "<not an exact Win32Exception>"
    `$root = `$null
    if (`$null -ne `$cleanupFailure) {
      `$wrapperType = `$cleanupFailure.GetType().FullName
      `$wrapperMessage = `$cleanupFailure.Message
      `$root = `$cleanupFailure.InnerException
    }
    if (`$null -ne `$root) {
      `$rootType = `$root.GetType().FullName
      `$rootMessage = `$root.Message
      if (`$root.GetType() -eq [ComponentModel.Win32Exception]) { `$rootNativeErrorCode = [string]`$root.NativeErrorCode }
    }
    "cleanup failure index=`$index; wrapper type=`$wrapperType; wrapper message=`$wrapperMessage; root type=`$rootType; root NativeErrorCode=`$rootNativeErrorCode; root message=`$rootMessage"
  }

  function Unwrap-CleanupFailureWin32Exception([Exception]`$cleanupFailure, [int]`$index) {
    `$diagnostic = Get-CleanupFailureDiagnostic `$cleanupFailure `$index
    if (`$null -eq `$cleanupFailure) { throw "aggregate failure fixture cleanup failure is missing; `$diagnostic" }
    if (`$cleanupFailure.GetType() -ne [Management.Automation.MethodInvocationException]) { throw "aggregate failure fixture cleanup failure has unexpected wrapper; `$diagnostic" }
    `$root = `$cleanupFailure.InnerException
    if (`$null -eq `$root) { throw "aggregate failure fixture cleanup failure is missing the allowed MethodInvocationException InnerException; `$diagnostic" }
    if (`$root.GetType() -ne [ComponentModel.Win32Exception]) { throw "aggregate failure fixture cleanup failure root is not an exact Win32Exception; `$diagnostic" }
    if (`$null -ne `$root.InnerException) { throw "aggregate failure fixture cleanup failure has unexpected nested cleanup failure wrapper; `$diagnostic" }
    [pscustomobject]@{ Root=`$root; Diagnostic=`$diagnostic }
  }

  `$identity = (Get-Content -LiteralPath `$fixtureIdentityPath -Raw -Encoding UTF8).Trim().Split(',')
  [int]`$parentId = 0
  [int]`$descendantId = 0
  if (`$identity.Count -ne 2 -or -not [int]::TryParse(`$identity[0], [ref]`$parentId) -or `$parentId -lt 1 -or -not [int]::TryParse(`$identity[1], [ref]`$descendantId) -or `$descendantId -lt 1 -or `$parentId -eq `$descendantId) { throw "aggregate failure fixture runner did not collect parent and child process identities" }
  `$fixtureRuntimeIdentities = [pscustomobject]@{ parentId=`$parentId; descendantId=`$descendantId }
  `$failure = `$_.Exception
  if (`$failure -isnot [AggregateException] -or `$failure.Message -notlike "Vision launcher failed and cleanup failed*") { throw "aggregate failure fixture did not preserve the outer AggregateException" }
  `$outerFailures = @(`$failure.InnerExceptions)
  if (`$outerFailures.Count -ne 2) { throw "aggregate failure fixture did not preserve both primary and cleanup failures" }
  if (`$outerFailures[0] -isnot [Management.Automation.RuntimeException] -or `$outerFailures[0].Message -ne "injected selection reread failure") { throw "aggregate failure fixture did not preserve the primary post-start failure" }
  if (`$outerFailures[1] -isnot [AggregateException] -or `$outerFailures[1].Message -notlike "Vision launcher cleanup failed*") { throw "aggregate failure fixture did not preserve the cleanup aggregate" }
  `$cleanupFailures = @(`$outerFailures[1].InnerExceptions)
  `$cleanupFailureDiagnostics = @(
    "cleanup failure count=`$(`$cleanupFailures.Count)"
    for (`$index = 0; `$index -lt `$cleanupFailures.Count; `$index++) { Get-CleanupFailureDiagnostic `$cleanupFailures[`$index] `$index }
  ) -join [Environment]::NewLine
  if (`$cleanupFailures.Count -ne 2) { throw "aggregate failure fixture did not preserve both cleanup failures; `$cleanupFailureDiagnostics" }
  `$unwrappedCleanupFailures = @(for (`$index = 0; `$index -lt `$cleanupFailures.Count; `$index++) { Unwrap-CleanupFailureWin32Exception `$cleanupFailures[`$index] `$index })
  `$jobCleanupFailures = @(`$unwrappedCleanupFailures | Where-Object { `$_.Root.Message -ceq "TerminateJobObject failed" -and `$_.Root.NativeErrorCode -eq 87 })
  if (`$jobCleanupFailures.Count -ne 1) { throw "aggregate failure fixture did not preserve exactly one TerminateJobObject failed error with NativeErrorCode 87; `$cleanupFailureDiagnostics" }
  `$processCleanupFailures = @(`$unwrappedCleanupFailures | Where-Object { `$_.Root.Message -ceq "TerminateProcess failed" -and `$_.Root.NativeErrorCode -eq 5 })
  if (`$processCleanupFailures.Count -ne 1) { throw "aggregate failure fixture did not preserve exactly one TerminateProcess failed error with NativeErrorCode 5; `$cleanupFailureDiagnostics" }
}
if (`$null -eq `$fixtureRuntimeIdentities) { throw "aggregate failure fixture runner did not collect runtime process identities" }
Write-Output ("aggregate failure fixture passed parentId={0} descendantId={1}" -f `$fixtureRuntimeIdentities.parentId, `$fixtureRuntimeIdentities.descendantId)
"@, [Text.UTF8Encoding]::new($false))
        Assert-WindowsPowerShellFixtureParses $fixtureFailureRunnerPath "selection-reread-and-cleanup-failure-runner"
        $fixtureFailureOutput = @(& $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureFailureRunnerPath 2>&1)
        $fixtureFailureText = Get-FixtureCapturedText $fixtureFailureOutput
        if ($LASTEXITCODE -ne 0) { throw "aggregate failure fixture runner failed; captured output:`n$fixtureFailureText" }
        if ($fixtureFailureText -match 'CS0162|unreachable code') { throw "aggregate failure fixture compiled unreachable C# code; captured output:`n$fixtureFailureText" }
        if ($fixtureFailureText -notmatch "aggregate failure fixture passed") { throw "aggregate failure fixture did not report success; captured output:`n$fixtureFailureText" }
        $fixtureRuntimeIdentities = Wait-FixtureRuntimeIdentities "selection-reread-and-cleanup"
        $expectedFixtureIdentityReport = "aggregate failure fixture passed parentId={0} descendantId={1}" -f $fixtureRuntimeIdentities.parentId, $fixtureRuntimeIdentities.descendantId
        if ($fixtureFailureText -notmatch [regex]::Escape($expectedFixtureIdentityReport)) { throw "aggregate failure fixture runner did not report the collected parent and child process identities; captured output:`n$fixtureFailureText" }
        Assert-FixtureRuntimeStopped "selection-reread-and-cleanup"
        Assert-FixtureRuntimeIdentitiesStopped "selection-reread-and-cleanup" $fixtureRuntimeIdentities
        if (Test-Path -LiteralPath $fixtureRecordPath -PathType Leaf) { throw "launcher aggregate failure fixture committed a process record" }
      } finally {
        foreach ($fixtureProcess in @(Get-FixtureRuntimeProcesses)) {
          try {
            if (-not $fixtureProcess.HasExited) { $fixtureProcess.Kill() }
            $fixtureProcess.WaitForExit(5000) | Out-Null
          } finally {
            $fixtureProcess.Dispose()
          }
        }
      }
    }
    Write-Output "launcher fixtures passed"
  } elseif ($Case -eq "protocol") {
    Test-SourceBoundary @("vision.hello", "vision.ready", "ClientWebSocket", "mockScenario", "modelReady", "Descriptor.releaseVersion")
    Add-Type -TypeDefinition @'
using System.IO;
using System.Text;
using System.Threading;
public static class VisionFixtureDelayedFile {
  public static Thread Write(string path, string content, int delayMilliseconds) {
    var thread = new Thread(() => {
      Thread.Sleep(delayMilliseconds);
      File.WriteAllText(path, content, new UTF8Encoding(false));
    });
    thread.IsBackground = true;
    thread.Start();
    return thread;
  }
}
'@
    $processStateRoot = Join-Path $root "process-state"; New-Item -ItemType Directory -Path $processStateRoot | Out-Null
    $processPath = Join-Path $processStateRoot "active-process.json"
    $fixtureProcess = Microsoft.PowerShell.Management\Get-Process -Id $PID
    try {
      $entrypoint = [IO.Path]::GetFullPath($fixtureProcess.Path)
      $selection = [pscustomobject]@{ revision="revision-1"; bundleDigest=("sha256:" + "a" * 64); installDirectory=(Split-Path -Parent $entrypoint); entrypoint=(Split-Path -Leaf $entrypoint) }
      $descriptor = [pscustomobject]@{ health=[pscustomobject]@{ timeoutMs=1500; port=1; path="/health" }; protocol=[pscustomobject]@{ version="vem.vision.v1"; webSocketPath="/ws" }; releaseVersion="fixture" }
      $record = @{ bundleDigest=$selection.bundleDigest; processId=$fixtureProcess.Id; creationTimeUtcTicks=$fixtureProcess.StartTime.ToUniversalTime().Ticks; executablePath=$entrypoint; executableDigest=("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()); selectionRevision=$selection.revision } | ConvertTo-Json -Compress
      function Invoke-RestMethod { throw "fixture health unavailable" }
      $writer = [VisionFixtureDelayedFile]::Write($processPath, $record, 500)
      $stopwatch = [Diagnostics.Stopwatch]::StartNew()
      try {
        Assert-ThrowsMessage { Test-VisionProtocol $selection $descriptor } "Vision health did not bind to launched approved process" "delayed process record"
      } finally {
        $stopwatch.Stop(); $writer.Join()
      }
      if ($stopwatch.ElapsedMilliseconds -lt 1250 -or $stopwatch.ElapsedMilliseconds -gt 1800) { throw "Vision protocol did not share one deadline across process-record and health waits: $($stopwatch.ElapsedMilliseconds)ms" }

      Remove-Item -LiteralPath $processPath -Force
      $descriptor.health.timeoutMs = 300
      $stopwatch.Restart()
      try {
        Assert-ThrowsMessage { Test-VisionProtocol $selection $descriptor } "Vision launcher did not commit its process record" "missing process record"
      } finally {
        $stopwatch.Stop()
      }
      if ($stopwatch.ElapsedMilliseconds -lt 200 -or $stopwatch.ElapsedMilliseconds -gt 800) { throw "Vision process-record timeout did not honor its deadline: $($stopwatch.ElapsedMilliseconds)ms" }
    } finally {
      $fixtureProcess.Dispose()
    }
    Write-Output "protocol fixtures passed"
  } elseif ($Case -eq "rollback") {
    Test-SourceBoundary @('Rollback-PreviousRelease', 'Assert-InstalledRelease $metadata $Previous', 'Test-VisionProtocol $Previous')
    Write-Output "rollback fixtures passed"
  } elseif ($Case -eq "orphan") {
    $StateRoot = Join-Path $root "state"; $releaseRoot = Join-Path $root "releases"; $orphan = Join-Path $releaseRoot "1.0.0-aaaaaaaaaaaaaaaa"; New-Item -ItemType Directory -Path $orphan -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $orphan "runtime.exe"), "orphan", [Text.UTF8Encoding]::new($false))
    Quarantine-UntrustedReleaseDirectory $orphan "1.0.0-aaaaaaaaaaaaaaaa"
    if (Test-Path -LiteralPath $orphan) { throw "orphaned release was not quarantined" }
    if (@(Get-ChildItem -LiteralPath (Join-Path $StateRoot "quarantine") -Directory).Count -ne 1) { throw "quarantine record missing" }
    Write-Output "orphan fixtures passed"
  } elseif ($Case -eq "mutex") {
    $first = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstallerFixture")
    try { if (-not $first.WaitOne([TimeSpan]::FromSeconds(1))) { throw "fixture mutex was not acquired" } } finally { $first.ReleaseMutex(); $first.Dispose() }
    Write-Output "mutex fixtures passed"
  } elseif ($Case -eq "reinstall") {
    $releaseRoot = Join-Path $root "releases"; $install = Join-Path $releaseRoot "1.0.0-aaaaaaaaaaaaaaaa"; New-Item -ItemType Directory -Path $install -Force | Out-Null
    $entrypoint = Join-Path $install "runtime.exe"; [IO.File]::WriteAllText($entrypoint, "approved", [Text.UTF8Encoding]::new($false))
    $digest = "sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()
    $selection = [pscustomobject]@{ bundleDigest=("sha256:" + "a" * 64); descriptorDigest=("sha256:" + "b" * 64); approvalDigest=("sha256:" + "c" * 64); installDirectory=$install; entrypoint="runtime.exe" }
    $record = [pscustomobject]@{ schemaVersion="vem-vision-release-record/v2"; bundleDigest=$selection.bundleDigest; descriptorDigest=$selection.descriptorDigest; approvalDigest=$selection.approvalDigest; installDirectory=$install; entrypoint="runtime.exe"; entrypointDigest=$digest; files=(Get-ExtractedFileManifest $install); descriptor=@{}; attestation=@{}; approval=@{}; documents=@{} }
    $originalDigest = (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash
    [IO.File]::WriteAllText($entrypoint, "tampered", [Text.UTF8Encoding]::new($false))
    if ((Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash -eq $originalDigest) { throw "reinstall file mutation was not observed" }
    Assert-Throws { Assert-InstalledRelease $record $selection } "tampered reinstall"
    Write-Output "reinstall fixtures passed"
  } elseif ($Case -eq "runtime-verifier") {
    $FactoryTrustPolicyPath = Join-Path $root "policy.json"
    $identity = "spki-sha256:" + "a" * 64
    $verification = @{ schemaVersion="vem-vision-release-verification/v1"; kind="vision-release-verification"; verified=$true; identities=@{ descriptor=$identity; attestation=$identity; sbom=$identity; provenance=$identity; conformance=$identity; approval=$identity } } | ConvertTo-Json -Compress
    if ($env:OS -eq "Windows_NT") {
      $FactoryEvidenceVerifierPath = Join-Path $root "fixture-verifier.exe"
      $verifierSourcePath = Join-Path $root "FixtureVerifier.cs"
      $verificationBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($verification))
      $verifierSource = @"
using System;
using System.Text;
public static class FixtureVerifier {
  public static int Main(string[] args) {
    Console.Write(Encoding.UTF8.GetString(Convert.FromBase64String("$verificationBase64")));
    return 0;
  }
}
"@
      [IO.File]::WriteAllText($verifierSourcePath, $verifierSource, [Text.UTF8Encoding]::new($false))
      $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
      & $csc /nologo /target:exe ("/out:{0}" -f $FactoryEvidenceVerifierPath) $verifierSourcePath
      if ($LASTEXITCODE -ne 0) { throw "fixture verifier compilation failed" }
    } else {
      $FactoryEvidenceVerifierPath = Join-Path $root "fixture-verifier.sh"
      [IO.File]::WriteAllText($FactoryEvidenceVerifierPath, ("#!/bin/sh`necho '" + $verification + "'`n"), [Text.UTF8Encoding]::new($false))
      & chmod +x $FactoryEvidenceVerifierPath
    }
    $verifierDigest = "sha256:" + (Get-FileHash -LiteralPath $FactoryEvidenceVerifierPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($FactoryTrustPolicyPath, "{}", [Text.UTF8Encoding]::new($false))
    $policy = [pscustomobject]@{ schemaVersion="vem-vision-release-trust-policy/v1"; kind="vision-release-trust-policy"; verifierDigest=$verifierDigest; approvedIdentities=[pscustomobject]@{ descriptor=@($identity); attestation=@($identity); sbom=@($identity); provenance=@($identity); conformance=@($identity); approval=@($identity) } }
    $documents = @{}; foreach ($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")) { $path=Join-Path $root "$name.json"; [IO.File]::WriteAllText($path, "{}", [Text.UTF8Encoding]::new($false)); $documents[$name]=[pscustomobject]@{ path=$path; digest=(Get-Digest (Get-ExactFileBytes $path $name)); value=@{} } }
    Invoke-ReleaseEvidenceVerifier $policy $documents
    Write-Output "runtime-verifier fixtures passed"
  }
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
