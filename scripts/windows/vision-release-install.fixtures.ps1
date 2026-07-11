[CmdletBinding()]
param([ValidateSet("archive", "bytes", "first-install", "acl", "task", "process-record", "launcher", "protocol", "rollback", "orphan", "mutex", "reinstall", "runtime-verifier")][string]$Case = "archive")

$ErrorActionPreference = "Stop"
$libraryRoot = Join-Path ([IO.Path]::GetTempPath()) "vem-vision-installer-library"
. (Join-Path $PSScriptRoot "install-vision-release.ps1") -Library -VisionRoot $libraryRoot -StateRoot (Join-Path $libraryRoot "state")

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
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write([string]$pair[1]) } finally { $writer.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

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
    foreach ($attack in @(@(,@("../escape.exe", "x")), @(,@("/absolute.exe", "x")), @(,@("runtime.exe:stream", "x")), @(@("Runtime.EXE", "a"), @("runtime.exe", "b")))) {
      $bundle = Join-Path $root ([guid]::NewGuid().ToString("N") + ".zip")
      $target = Join-Path $root ([guid]::NewGuid().ToString("N"))
      New-Zip $bundle $attack
      $stream = [IO.File]::OpenRead($bundle)
      try { Assert-Throws { Expand-ZipSafely $stream $target ([pscustomobject]@{}) } "unsafe archive" } finally { $stream.Dispose() }
    }
    Assert-Throws { Get-SafeArchivePath "folder/../escape.exe" } "traversal"
    Assert-Throws { Get-SafeArchivePath "C:\\escape.exe" } "drive path"
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
    Test-SourceBoundary @("FactoryVisionDeliveryRoot", "Get-FactoryTrustPolicy", "Set-SystemInstallerAcl", "Assert-ReleaseContracts")
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
    Test-SourceBoundary @('Resolve-ApprovedVisionExecution $Selection', '$legacyKeys = @("bundleDigest", "processId", "creationTimeUtc", "executablePath", "executableDigest", "selectionRevision")', '$isExpectedLegacyRecord =', 'unsupported legacy creationTimeUtc identity; hard migration requires creationTimeUtcTicks', 'Assert-Keys $record @("bundleDigest", "processId", "creationTimeUtcTicks", "executablePath", "executableDigest", "selectionRevision") "Vision process record"', '$process -isnot [Diagnostics.Process]', '$process.StartTime.ToUniversalTime().Ticks -ne $record.creationTimeUtcTicks', '$actualPath -cne $approved.executablePath', '$approved.executableDigest', '$process.Kill($true)', '$process.WaitForExit(5000)', '$process.Dispose()')
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

      function Write-LauncherExecutionFixture([string]$Failure) {
        Remove-Item -LiteralPath $fixtureDescendantIdentityPath -Force -ErrorAction SilentlyContinue
        [IO.File]::WriteAllText($fixtureSelectionPath, ($fixtureSelection | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        $executionLauncher = $launcher.Replace('$stateRoot = "C:\ProgramData\VEM\vision"', ("`$stateRoot = '{0}'" -f $fixtureStateRoot.Replace("'", "''")))
        if ($Failure -eq "selection-reread") {
          $needle = '  $current = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json'
          $executionLauncher = $executionLauncher.Replace($needle, '  throw "injected selection reread failure"')
        } elseif ($Failure -eq "hash") {
          $executionLauncher = $executionLauncher.Replace('Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256', '(throw "injected hash failure")')
        } elseif ($Failure -eq "record-write") {
          $executionLauncher = $executionLauncher.Replace('[IO.File]::WriteAllText($temporary,', 'throw "injected record write failure"; [IO.File]::WriteAllText($temporary,')
        } elseif ($Failure -eq "selection-reread-and-cleanup") {
          $needle = '  $current = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json'
          $executionLauncher = $executionLauncher.Replace($needle, '  throw "injected selection reread failure"')
          $terminationOverrides = @'
[VemVisionLauncher.KillOnCloseJob]::TerminateJobObjectOverride = [Func[IntPtr,uint32,bool]] { param($job, $exitCode) return $false }
[VemVisionLauncher.NativeProcess]::TerminateProcessOverride = [Func[IntPtr,uint32,bool]] { param($process, $exitCode) return $false }
'@
          $executionLauncher = $executionLauncher.Replace('$commandLine = ', ($terminationOverrides + '$commandLine = '))
        }
        if ($executionLauncher -ceq $launcher) { throw "launcher execution fixture did not inject $Failure" }
        [IO.File]::WriteAllText($fixtureLauncherPath, $executionLauncher, [Text.UTF8Encoding]::new($false))
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

      function Get-FixtureRuntimeIdentities {
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
          if (Test-Path -LiteralPath $fixtureDescendantIdentityPath -PathType Leaf) {
            $parts = (Get-Content -LiteralPath $fixtureDescendantIdentityPath -Raw).Trim().Split(',')
            [int]$parentId = 0
            [int]$descendantId = 0
            if ($parts.Count -eq 2 -and [int]::TryParse($parts[0], [ref]$parentId) -and $parentId -gt 0 -and [int]::TryParse($parts[1], [ref]$descendantId) -and $descendantId -gt 0) {
              return [pscustomobject]@{ parentId=$parentId; descendantId=$descendantId }
            }
          }
          Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $deadline)
        throw "launcher fixture runtime did not record its descendant process"
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
        $fixtureRuntimeIdentities = Get-FixtureRuntimeIdentities
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

        foreach ($failure in @("selection-reread", "hash", "record-write")) {
          Remove-Item -LiteralPath $fixtureRecordPath -Force -ErrorAction SilentlyContinue
          Write-LauncherExecutionFixture $failure
          & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureLauncherPath 2>$null | Out-Null
          if ($LASTEXITCODE -eq 0) { throw "generated launcher accepted injected $failure failure" }
          $fixtureRuntimeIdentities = Get-FixtureRuntimeIdentities
          Assert-FixtureRuntimeStopped $failure
          foreach ($processId in @($fixtureRuntimeIdentities.parentId, $fixtureRuntimeIdentities.descendantId)) {
            $fixtureProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($null -ne $fixtureProcess) {
              try { throw "launcher $failure failure left tracked process $processId running" } finally { $fixtureProcess.Dispose() }
            }
          }
          if (Test-Path -LiteralPath $fixtureRecordPath -PathType Leaf) { throw "launcher $failure failure committed a process record" }
        }

        Remove-Item -LiteralPath $fixtureRecordPath -Force -ErrorAction SilentlyContinue
        Write-LauncherExecutionFixture "selection-reread-and-cleanup"
        $fixtureFailureRunnerPath = Join-Path $root "launch-vision-release-failure-fixture.ps1"
        $escapedFixtureLauncherPath = $fixtureLauncherPath.Replace("'", "''")
        [IO.File]::WriteAllText($fixtureFailureRunnerPath, @"
`$ErrorActionPreference = "Stop"
try {
  & '$escapedFixtureLauncherPath'
  throw "aggregate failure fixture did not throw"
} catch {
  `$failure = `$_.Exception
  if (`$failure -isnot [AggregateException] -or `$failure.Message -ne "Vision launcher failed and cleanup failed") { throw "aggregate failure fixture did not preserve the outer AggregateException" }
  `$outerFailures = @(`$failure.InnerExceptions)
  if (`$outerFailures.Count -ne 2) { throw "aggregate failure fixture did not preserve both primary and cleanup failures" }
  if (`$outerFailures[0] -isnot [Management.Automation.RuntimeException] -or `$outerFailures[0].Message -ne "injected selection reread failure") { throw "aggregate failure fixture did not preserve the primary post-start failure" }
  if (`$outerFailures[1] -isnot [AggregateException] -or `$outerFailures[1].Message -ne "Vision launcher cleanup failed") { throw "aggregate failure fixture did not preserve the cleanup aggregate" }
  `$cleanupFailures = @(`$outerFailures[1].InnerExceptions)
  if (`$cleanupFailures.Count -ne 2) { throw "aggregate failure fixture did not preserve both cleanup failures" }
  if (`$cleanupFailures[0] -isnot [ComponentModel.Win32Exception] -or `$cleanupFailures[0].Message -notmatch "TerminateJobObject failed") { throw "aggregate failure fixture did not preserve the false Job Object return" }
  if (`$cleanupFailures[1] -isnot [ComponentModel.Win32Exception] -or `$cleanupFailures[1].Message -notmatch "TerminateProcess failed") { throw "aggregate failure fixture did not preserve the false process return" }
}
Write-Output "aggregate failure fixture passed"
"@, [Text.UTF8Encoding]::new($false))
        $fixtureFailureOutput = & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $fixtureFailureRunnerPath 2>$null
        if ($LASTEXITCODE -ne 0) { throw "aggregate failure fixture did not execute successfully" }
        if ((@($fixtureFailureOutput) -join "`n") -notmatch "aggregate failure fixture passed") { throw "aggregate failure fixture did not report success" }
        Assert-FixtureRuntimeStopped "selection-reread-and-cleanup"
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
    Test-SourceBoundary @("vision.hello", "vision.ready", "ClientWebSocket", "vem-machine-vision-health/v1")
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
