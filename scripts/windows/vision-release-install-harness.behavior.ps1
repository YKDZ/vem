[CmdletBinding()]
param(
  [string]$HarnessPath = (Join-Path $PSScriptRoot "vision-release-install.windows-harness.ps1"),
  [ValidateRange(30, 120)][int]$DeadlineSeconds = 60,
  [ValidateRange(60, 180)][int]$HardDeadlineSeconds = 90
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-BeforeDeadline {
  if ([DateTime]::UtcNow.Ticks -ge $script:deadlineUtc.Ticks) {
    throw "vision installer harness behavior test exceeded its global deadline"
  }
}

function Get-RunningProcess([int]$ProcessId) {
  try {
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    if ($process.HasExited) {
      $process.Dispose()
      return $null
    }
    return $process
  } catch [ArgumentException] {
    return $null
  }
}

function Assert-ExactCertificateCleanup([string]$CertificateSubject) {
  foreach ($storePath in "Cert:\CurrentUser\My", "Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher") {
    $remaining = @(Get-ChildItem -Path $storePath -ErrorAction Stop | Where-Object { $_.Subject -eq $CertificateSubject })
    Assert-True ($remaining.Count -eq 0) "fixture certificate remained after cleanup in $storePath"
  }
}

function Stop-TrackedProcess([object]$Identity) {
  if ($null -eq $Identity) { return }

  [int]$processId = 0
  [Int64]$creationTimeUtcTicks = 0
  if (-not [int]::TryParse([string]$Identity.processId, [ref]$processId) -or $processId -lt 1 -or -not [Int64]::TryParse([string]$Identity.creationTimeUtcTicks, [ref]$creationTimeUtcTicks) -or $creationTimeUtcTicks -lt 1 -or [string]::IsNullOrWhiteSpace([string]$Identity.executablePath)) {
    throw "tracked descendant identity is invalid"
  }

  $process = Get-RunningProcess -ProcessId $processId
  if ($null -eq $process) { return }
  try {
    if ($process.StartTime.ToUniversalTime().Ticks -ne $creationTimeUtcTicks -or [IO.Path]::GetFullPath($process.Path) -cne [IO.Path]::GetFullPath([string]$Identity.executablePath)) {
      throw "tracked descendant process identity no longer matches process $processId"
    }
    if (-not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit(5000) | Out-Null
    }
  } finally {
    $process.Dispose()
  }
}

if ($HardDeadlineSeconds -le $DeadlineSeconds) { throw "HardDeadlineSeconds must leave time for cleanup after DeadlineSeconds" }
. $HarnessPath -Library
Initialize-HarnessNativeTypes
$deadlineStartUtc = [DateTime]::UtcNow
$deadlineUtc = $deadlineStartUtc.AddSeconds($DeadlineSeconds)
$hardDeadlineUtc = $deadlineStartUtc.AddSeconds($HardDeadlineSeconds)
$watchdogMessage = "vision installer harness behavior test exceeded its $HardDeadlineSeconds-second hard deadline"
$watchdog = Arm-HarnessFailFastWatchdog -Message $watchdogMessage -DeadlineUtc $hardDeadlineUtc
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-harness-behavior-" + [guid]::NewGuid().ToString("N"))
$contextPath = Join-Path $root "context.json"
$certificateSubject = "CN=VEM Vision Harness Behavior " + [guid]::NewGuid().ToString("N")
$unrelated = $null
$descendantIdentity = $null

try {
  Assert-BeforeDeadline
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $layoutJob = New-HarnessKillOnCloseJob
  try {
    [VemVisionHarness.KillOnCloseJob]::AssertNativeLayout()
  } finally {
    $layoutJob.Dispose()
  }
  $pwshPath = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
  $context = [ordered]@{ root=$root; stateRoot=(Join-Path $root "state"); bundleDigest="sha256:behavior" }
  Write-Json $contextPath $context

  $unrelated = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $root "unrelated.stdout.log") -RedirectStandardError (Join-Path $root "unrelated.stderr.log")
  Assert-True ($unrelated -is [Diagnostics.Process]) "unrelated process did not retain a .NET process handle"

  Assert-BeforeDeadline
  $transcriptPath = Join-Path $root "telemetry.log"
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  try {
    $discarded = Invoke-BoundedPowerShell -Stage "behavior.telemetry" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody 'Write-Output child-output' | Out-Null
  } finally {
    Stop-Transcript | Out-Null
  }
  Assert-True ($null -eq $discarded) "Out-Null did not suppress the bounded result object"
  $telemetry = Get-Content -LiteralPath $transcriptPath -Raw
  Assert-True ($telemetry -match "stage=behavior.telemetry status=started") "bounded invocation did not emit start telemetry"
  Assert-True ($telemetry -match "stage=behavior.telemetry status=completed") "bounded invocation did not emit completion telemetry"
  $returned = Invoke-BoundedPowerShell -Stage "behavior.object" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody '& $env:COMSPEC /d /c ''echo child-output & echo child-error 1>&2'''
  Assert-True (@($returned).Count -eq 1) "bounded invocation returned more than one result object"
  Assert-True ($returned.stdout.Trim() -ceq "child-output") "bounded invocation did not retain child stdout"
  Assert-True ($returned.stderr.Trim() -ceq "child-error") "bounded invocation did not retain child stderr"
  Assert-True (Test-Path -LiteralPath (Join-Path $returned.diagnosticsPath "stdout.log") -PathType Leaf) "bounded invocation did not write a stdout log"
  Assert-True (Test-Path -LiteralPath (Join-Path $returned.diagnosticsPath "stderr.log") -PathType Leaf) "bounded invocation did not write a stderr log"
  Assert-True (($returned.PSObject.Properties.Name -join ",") -ceq "stdout,stderr,diagnosticsPath") "bounded invocation result shape changed"

  Assert-BeforeDeadline
  $verifiedRuntime = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $root "verified-runtime.stdout.log") -RedirectStandardError (Join-Path $root "verified-runtime.stderr.log")
  try {
    Assert-True ($verifiedRuntime -is [Diagnostics.Process]) "verified runtime did not retain a .NET process handle"
    $metadataPath = Join-Path $root "verified-runtime-metadata.json"
    $processStateRoot = Join-Path $context.stateRoot "process-state"
    $expectedPath = [IO.Path]::GetFullPath($verifiedRuntime.Path)
    $expectedDigest = Get-Digest $verifiedRuntime.Path
    Write-Json $metadataPath @{ entrypointDigest=$expectedDigest }
    Write-Json (Join-Path $context.stateRoot "current.json") @{ schemaVersion="vem-vision-selection/v1"; bundleDigest=$context.bundleDigest; revision="verified-runtime"; metadataPath=$metadataPath; installDirectory=(Split-Path -Parent $expectedPath); entrypoint=(Split-Path -Leaf $expectedPath) }
    Write-Json (Join-Path $processStateRoot "active-process.json") @{ bundleDigest=$context.bundleDigest; selectionRevision="verified-runtime"; processId=$verifiedRuntime.Id; creationTimeUtcTicks=$verifiedRuntime.StartTime.ToUniversalTime().Ticks; executablePath=$expectedPath; executableDigest=$expectedDigest }
    Assert-True (Stop-HarnessFixtureRuntime -Context $context) "verified runtime cleanup rejected a valid selection and process record"
    Assert-True ($verifiedRuntime.HasExited) "verified runtime cleanup did not stop the selected process"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $processStateRoot "active-process.json"))) "verified runtime cleanup left its process record"
  } finally {
    if (-not $verifiedRuntime.HasExited) { $verifiedRuntime.Kill(); $verifiedRuntime.WaitForExit(5000) | Out-Null }
    $verifiedRuntime.Dispose()
  }

  Assert-BeforeDeadline
  $descendantIdentityPath = Join-Path $root "descendant.identity.json"
  $timeoutBody = @'
$pwshPath = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$descendant = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $context.root "descendant.stdout.log") -RedirectStandardError (Join-Path $context.root "descendant.stderr.log")
try {
  if ($descendant -isnot [Diagnostics.Process]) { throw "descendant did not retain a .NET process handle" }
  Write-Json (Join-Path $context.root "descendant.identity.json") @{ processId=$descendant.Id; creationTimeUtcTicks=$descendant.StartTime.ToUniversalTime().Ticks; executablePath=[IO.Path]::GetFullPath($descendant.Path) }
  Start-Sleep -Milliseconds 2100
} finally {
  $descendant.Dispose()
}
'@
  $timeoutTranscriptPath = Join-Path $root "timeout-telemetry.log"
  Start-Transcript -Path $timeoutTranscriptPath -Force | Out-Null
  try {
    Invoke-BoundedPowerShell -Stage "behavior.parent-exits-near-timeout" -TimeoutSeconds 2 -TerminationWaitSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody $timeoutBody | Out-Null
    throw "timed-out bounded invocation did not throw"
  } catch {
    if ($_.Exception.Message -notmatch "exceeded") { throw }
  } finally {
    Stop-Transcript | Out-Null
  }
  Assert-True ((Get-Content -LiteralPath $timeoutTranscriptPath -Raw) -match "stage=behavior.parent-exits-near-timeout status=timed-out detail=timeoutSeconds=2 termination=job-object") "timed-out bounded invocation did not emit precise Job Object timeout telemetry"
  Assert-True (Test-Path -LiteralPath $descendantIdentityPath -PathType Leaf) "timed-out child did not record its descendant identity"
  $descendantIdentity = Get-Content -LiteralPath $descendantIdentityPath -Raw | ConvertFrom-Json
  $descendant = Get-RunningProcess -ProcessId ([int]$descendantIdentity.processId)
  try {
    Assert-True ($null -eq $descendant) "timed-out bounded invocation left its descendant alive"
  } finally {
    if ($null -ne $descendant) { $descendant.Dispose() }
  }
  Assert-True (-not $unrelated.HasExited) "timed-out bounded invocation stopped an unrelated retained process"

  Assert-BeforeDeadline
  $certificate = $null
  try {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certificateSubject -KeyUsage DigitalSignature -HashAlgorithm SHA256 -CertStoreLocation "Cert:\CurrentUser\My"
    $certificatePath = Join-Path $root "certificate.cer"
    Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
    Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null
    foreach ($storePath in "Cert:\CurrentUser\My", "Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher") {
      Assert-True (@(Get-ChildItem -Path $storePath | Where-Object { $_.Subject -eq $certificateSubject }).Count -eq 1) "fixture certificate mutation was incomplete in $storePath"
    }

    New-Item -ItemType Directory -Force -Path $context.stateRoot | Out-Null
    Write-Json (Join-Path $context.stateRoot "current.json") @{}
    Write-Json (Join-Path $root "fixture-certificate-cleanup.json") @{ certificateSubject=$certificateSubject }
    $serialized = Invoke-BoundedPowerShell -Stage "behavior.serialized-cleanup" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody @'
try {
  Invoke-HarnessFixtureCleanup -Context $context
  throw "serialized cleanup did not report the invalid runtime selection"
} catch {
  if ($_.Exception.Message -notmatch "fixture runtime cleanup could not verify") { throw }
  Write-HarnessStage "behavior.serialized-cleanup" "completed" "runtime failure still cleaned certificates"
}
'@
    Assert-True ($serialized.stdout -match "stage=behavior.serialized-cleanup status=completed") "serialized cleanup did not execute its dependency chain"
    Assert-ExactCertificateCleanup $certificateSubject
  } finally {
    Remove-HarnessFixtureCertificates -CertificateSubject $certificateSubject
    Assert-ExactCertificateCleanup $certificateSubject
  }

  Write-Host "vision release installer harness behavior checks passed"
} finally {
  try {
    if ($null -eq $descendantIdentity -and (Test-Path -LiteralPath (Join-Path $root "descendant.identity.json") -PathType Leaf)) {
      $descendantIdentity = Get-Content -LiteralPath (Join-Path $root "descendant.identity.json") -Raw | ConvertFrom-Json
    }
    Stop-TrackedProcess -Identity $descendantIdentity
  } finally {
    if ($null -ne $unrelated) {
      try {
        if (-not $unrelated.HasExited) {
          $unrelated.Kill()
          $unrelated.WaitForExit(5000) | Out-Null
        }
      } finally {
        $unrelated.Dispose()
      }
    }
    $watchdog.Dispose()
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
