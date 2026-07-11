[CmdletBinding()]
param(
  [string]$InstallerPath,
  [switch]$Library
)

# This harness intentionally runs only on a disposable Windows GitHub runner.
# It builds a signed fixture release, provisions it through the same Factory
# media path as production, and lets the production installer launch it.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Utf8([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Get-Digest([string]$Path) { "sha256:" + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, [object]$Value) { Write-Utf8 $Path ($Value | ConvertTo-Json -Depth 32 -Compress) }
function Evidence-Identity([string]$Digest) { "factory-evidence://" + $Digest.Replace(":", "/") }
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Write-HarnessStage([string]$Stage, [string]$Status, [string]$Detail = $null) {
  $message = "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=$Stage status=$Status"
  if (-not [string]::IsNullOrWhiteSpace($Detail)) { $message += " detail=$Detail" }
  Write-Host $message
}
function Remove-HarnessFixtureCertificates {
  param([Parameter(Mandatory = $true)][string]$CertificateSubject)

  foreach ($storePath in @("Cert:\CurrentUser\My", "Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher")) {
    $certificates = @(Get-ChildItem -Path $storePath -ErrorAction Stop | Where-Object { $_.Subject -eq $CertificateSubject })
    foreach ($certificate in $certificates) {
      try {
        if ($storePath -eq "Cert:\CurrentUser\My") {
          Remove-Item -LiteralPath $certificate.PSPath -DeleteKey -Force -ErrorAction Stop
        } else {
          Remove-Item -LiteralPath $certificate.PSPath -Force -ErrorAction Stop
        }
        Write-Host "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=fixture.cleanup-certificates status=removed store=$storePath thumbprint=$($certificate.Thumbprint)"
      } catch {
        Write-Host "[vision-installer-harness] timestamp=$([DateTime]::UtcNow.ToString("o")) stage=fixture.cleanup-certificates status=failed store=$storePath thumbprint=$($certificate.Thumbprint) detail=$($_.Exception.Message)"
        throw
      }
    }
  }
}
function Stop-HarnessFixtureRuntime {
  param([Parameter(Mandatory = $true)][object]$Context)

  $selectionPath = Join-Path $Context.stateRoot "current.json"
  $processPath = Join-Path $Context.stateRoot "process-state\active-process.json"
  if (-not (Test-Path -LiteralPath $selectionPath -PathType Leaf)) { return $true }

  try {
    $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
    if ([string]$selection.schemaVersion -cne "vem-vision-selection/v1" -or [string]$selection.bundleDigest -cne [string]$Context.bundleDigest) { return $false }
    if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) {
      Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
      return $true
    }

    $record = Get-Content -LiteralPath $processPath -Raw | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath ([string]$selection.metadataPath) -Raw | ConvertFrom-Json
    [int]$processId = 0
    if ([string]$record.bundleDigest -cne [string]$selection.bundleDigest -or [string]$record.selectionRevision -cne [string]$selection.revision -or -not [int]::TryParse([string]$record.processId, [ref]$processId) -or $processId -lt 1) { return $false }
    $expectedPath = [IO.Path]::GetFullPath((Join-Path ([string]$selection.installDirectory) ([string]$selection.entrypoint)))
    $expectedDigest = [string]$metadata.entrypointDigest
    if ([string]::IsNullOrWhiteSpace($expectedDigest) -or [IO.Path]::GetFullPath([string]$record.executablePath) -cne $expectedPath -or [string]$record.executableDigest -cne $expectedDigest) { return $false }

    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
      return $true
    }
    if ($process -isnot [Diagnostics.Process]) { return $false }
    $recordCreationTimeUtc = if ($record.creationTimeUtc -is [DateTime]) { $record.creationTimeUtc.ToUniversalTime().ToString("o") } else { [string]$record.creationTimeUtc }
    if ($process.StartTime.ToUniversalTime().ToString("o") -cne $recordCreationTimeUtc -or -not (Test-Path -LiteralPath $process.Path -PathType Leaf)) { return $false }
    if ([IO.Path]::GetFullPath([string]$process.Path) -cne $expectedPath -or (Get-Digest $process.Path) -cne $expectedDigest) { return $false }

    $verifiedProcessId = $process.Id
    Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
    try {
      if (-not $process.HasExited) {
        try {
          $process.Kill($true)
        } catch {
          if (-not $process.HasExited) { throw }
        }
      }
      if (-not $process.WaitForExit(5000) -and -not $process.HasExited) { return $false }
    } finally {
      $process.Dispose()
    }
    Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
    Write-HarnessStage "fixture.cleanup-runtime" "terminated" "processId=$verifiedProcessId"
    return $true
  } catch {
    Write-HarnessStage "fixture.cleanup-runtime" "skipped" $_.Exception.Message
    return $false
  }
}
function Invoke-HarnessFixtureCleanup {
  param([Parameter(Mandatory = $true)][object]$Context)

  $runtimeCleaned = $false
  try {
    $runtimeCleaned = Stop-HarnessFixtureRuntime -Context $Context
  } finally {
    $marker = Get-Content -LiteralPath (Join-Path $Context.root "fixture-certificate-cleanup.json") -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$marker.certificateSubject)) { throw "fixture certificate cleanup marker has no subject" }
    Remove-HarnessFixtureCertificates -CertificateSubject ([string]$marker.certificateSubject)
  }
  if (-not $runtimeCleaned) { throw "fixture runtime cleanup could not verify and terminate the selected process" }
}
function Invoke-BoundedPowerShell {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$ScriptBody,
    [Parameter(Mandatory = $true)][string]$HarnessRoot,
    [Parameter(Mandatory = $true)][string]$HarnessContextPath,
    [Parameter(Mandatory = $true)][string]$ChildPowerShellPath,
    [Parameter(Mandatory = $true)][DateTime]$HarnessDeadlineUtc,
    [int]$CleanupReserveSeconds = 0,
    [int]$TimeoutSeconds = 30,
    [int]$TerminationWaitSeconds = 10
  )

  $remainingSeconds = [Math]::Floor(($HarnessDeadlineUtc - [DateTime]::UtcNow).TotalSeconds) - $CleanupReserveSeconds
  $effectiveTimeoutSeconds = [Math]::Min($TimeoutSeconds, $remainingSeconds)
  if ($effectiveTimeoutSeconds -le 0) {
    throw "fixture stage '$Stage' cannot start before the harness deadline while reserving $CleanupReserveSeconds seconds for cleanup"
  }

  $safeStage = $Stage -replace '[^A-Za-z0-9._-]', "-"
  $stageRoot = Join-Path $HarnessRoot ("diagnostics\\" + $safeStage)
  New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
  $scriptPath = Join-Path $stageRoot "operation.ps1"
  $stdoutPath = Join-Path $stageRoot "stdout.log"
  $stderrPath = Join-Path $stageRoot "stderr.log"
  $escapedContextPath = $HarnessContextPath.Replace("'", "''")
  $writeHarnessStageFunction = ${function:Write-HarnessStage}.ToString()
  $cleanupFunction = ${function:Remove-HarnessFixtureCertificates}.ToString()
  $runtimeCleanupFunction = ${function:Stop-HarnessFixtureRuntime}.ToString()
  $cleanupInvocationFunction = ${function:Invoke-HarnessFixtureCleanup}.ToString()
  Write-Utf8 $scriptPath @"
`$ErrorActionPreference = "Stop"
function Write-Utf8([string]`$Path, [string]`$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$Path) | Out-Null
  [IO.File]::WriteAllText(`$Path, `$Text, [Text.UTF8Encoding]::new(`$false))
}
function Get-Digest([string]`$Path) { "sha256:" + (Get-FileHash -LiteralPath `$Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]`$Path, [object]`$Value) { Write-Utf8 `$Path (`$Value | ConvertTo-Json -Depth 32 -Compress) }
function Evidence-Identity([string]`$Digest) { "factory-evidence://" + `$Digest.Replace(":", "/") }
function Assert-True([bool]`$Value, [string]`$Message) { if (-not `$Value) { throw `$Message } }
function Write-HarnessStage {
$writeHarnessStageFunction
}
function Remove-HarnessFixtureCertificates {
$cleanupFunction
}
function Stop-HarnessFixtureRuntime {
$runtimeCleanupFunction
}
function Invoke-HarnessFixtureCleanup {
$cleanupInvocationFunction
}
`$context = Get-Content -LiteralPath '$escapedContextPath' -Raw | ConvertFrom-Json
$ScriptBody
"@

  Write-HarnessStage $Stage "started" "timeoutSeconds=$effectiveTimeoutSeconds"
  $process = Start-Process -FilePath $ChildPowerShellPath -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ('"{0}"' -f $scriptPath)) -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  try {
    $timeoutMilliseconds = [int]($effectiveTimeoutSeconds * 1000)
    $terminationWaitMilliseconds = [int]($TerminationWaitSeconds * 1000)
    if (-not $process.WaitForExit($timeoutMilliseconds)) {
      Write-HarnessStage $Stage "timed-out" "timeoutSeconds=$effectiveTimeoutSeconds"
      if (-not $process.HasExited) {
        try {
          $process.Kill($true)
        } catch {
          if (-not $process.HasExited) { throw }
        }
      }
      if (-not $process.WaitForExit($terminationWaitMilliseconds) -or -not $process.HasExited) {
        Write-HarnessStage $Stage "termination-failed" "waitSeconds=$TerminationWaitSeconds"
        throw "fixture stage '$Stage' exceeded $effectiveTimeoutSeconds seconds and its child process tree did not exit"
      }
      throw "fixture stage '$Stage' exceeded $effectiveTimeoutSeconds seconds; child process tree was terminated"
    }
    if (-not $process.HasExited) {
      throw "fixture stage '$Stage' returned from WaitForExit without exiting"
    }

    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    if ($process.ExitCode -ne 0) {
      Write-HarnessStage $Stage "failed" "exitCode=$($process.ExitCode)"
      throw "fixture stage '$Stage' failed with exit code $($process.ExitCode): $stderr$stdout"
    }
    Write-HarnessStage $Stage "completed"
    return [pscustomobject]@{ stdout=$stdout; stderr=$stderr; diagnosticsPath=$stageRoot }
  } finally {
    $process.Dispose()
  }
}

if ($Library) { return }
if ($env:OS -ne "Windows_NT" -or $env:CI -ne "true") { throw "Windows CI only" }
if ([string]::IsNullOrWhiteSpace($InstallerPath)) { throw "InstallerPath is required" }

$root = Join-Path $env:RUNNER_TEMP ("vem-vision-installer-" + [guid]::NewGuid().ToString("N"))
$media = Join-Path $root "media"
$visionMediaRoot = Join-Path $media "VEM"
$delivery = Join-Path $media "VEM\VISION-RELEASE"
$trust = Join-Path $media "VEM\VISION-TRUST"
$installerMedia = Join-Path $media "VEM\VISION-INSTALLER"
$factoryRoot = "C:\ProgramData\VEM\factory"
$stateRoot = "C:\ProgramData\VEM\vision"
$evidencePath = "C:\ProgramData\VEM\evidence\vision-release-install.json"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$childPwsh = (Get-Command pwsh -ErrorAction Stop).Source
$harnessContextPath = Join-Path $root "harness-context.json"
$certificateCleanupMarkerPath = Join-Path $root "fixture-certificate-cleanup.json"
$certificateSubject = "CN=VEM Vision CI Fixture " + [guid]::NewGuid().ToString("N")
$HarnessDeadlineSeconds = 480
$CleanupReserveSeconds = 75
$harnessDeadlineUtc = [DateTime]::UtcNow.AddSeconds($HarnessDeadlineSeconds)
$harnessContext = [ordered]@{
  root = $root
  media = $media
  visionMediaRoot = $visionMediaRoot
  delivery = $delivery
  trust = $trust
  installerMedia = $installerMedia
  factoryRoot = $factoryRoot
  stateRoot = $stateRoot
  evidencePath = $evidencePath
  harnessScriptRoot = $PSScriptRoot
  installerPath = [IO.Path]::GetFullPath($InstallerPath)
  runtimePath = $null
  certificateSubject = $certificateSubject
  certificateThumbprint = $null
  certificateExportPath = $null
}

try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Write-Json $certificateCleanupMarkerPath @{ schemaVersion="vem-vision-harness-certificate-cleanup/v1"; certificateSubject=$certificateSubject; certificateThumbprint=$null }
  Write-Json $harnessContextPath $harnessContext
  Write-HarnessStage "harness" "started"
  Invoke-BoundedPowerShell -Stage "fixture.cleanup" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
Remove-Item -LiteralPath "C:\VEM", "C:\ProgramData\VEM" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $context.delivery, $context.trust, $context.installerMedia | Out-Null
'@ | Out-Null
  Assert-True (Test-Path -LiteralPath $csc -PathType Leaf) "C# compiler missing from Windows runner"

  $runtimeSource = @'
using System; using System.IO; using System.Net; using System.Net.WebSockets; using System.Diagnostics; using System.Security.Cryptography; using System.Text; using System.Threading;
class VisionFixture {
 static string Field(string text,string name) { var key="\""+name+"\":\""; var start=text.IndexOf(key)+key.Length; return start<key.Length?"":text.Substring(start,text.IndexOf("\"",start)-start); }
 static string Hash(string p) { using(var s=SHA256.Create()) using(var f=File.OpenRead(p)) return "sha256:"+BitConverter.ToString(s.ComputeHash(f)).Replace("-","").ToLowerInvariant(); }
 static void Main() { var listener=new HttpListener(); listener.Prefixes.Add("http://127.0.0.1:18992/"); listener.Start(); for (;;) { var c=listener.GetContext(); if(c.Request.IsWebSocketRequest) { var ws=c.AcceptWebSocketAsync(null).Result.WebSocket; var b=new byte[8192]; ws.ReceiveAsync(new ArraySegment<byte>(b),CancellationToken.None).Wait(); var ready="{\"protocol\":\"vem.vision.v1\",\"type\":\"vision.ready\",\"messageId\":\"fixture-ready\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"payload\":{\"serverName\":\"signed-fixture\",\"serverVersion\":\"1.0.0\",\"cameraReady\":true,\"modelReady\":true,\"capabilities\":[]}}"; var rb=Encoding.UTF8.GetBytes(ready); ws.SendAsync(new ArraySegment<byte>(rb),WebSocketMessageType.Text,true,CancellationToken.None).Wait(); ws.Dispose(); continue; } var state=File.ReadAllText(@"C:\ProgramData\VEM\vision\current.json"); var body="{\"schemaVersion\":\"vem-machine-vision-health/v1\",\"pid\":"+Process.GetCurrentProcess().Id+",\"bundleDigest\":\""+Field(state,"bundleDigest")+"\",\"executableDigest\":\""+Hash(Process.GetCurrentProcess().MainModule.FileName)+"\",\"protocolVersion\":\"vem.vision.v1\"}"; var bytes=Encoding.UTF8.GetBytes(body); c.Response.StatusCode=200; c.Response.OutputStream.Write(bytes,0,bytes.Length); c.Response.Close(); } }
}
'@
  $runtimeSourcePath = Join-Path $root "VisionFixture.cs"
  $runtimePath = Join-Path $root "runtime.exe"
  Write-Utf8 $runtimeSourcePath $runtimeSource
  $certificateExportPath = Join-Path $root "fixture-signing-root.cer"
  $harnessContext.runtimePath = $runtimePath
  $harnessContext.certificateExportPath = $certificateExportPath
  Write-Json $harnessContextPath $harnessContext
  Invoke-BoundedPowerShell -Stage "fixture.compile-runtime" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe ("/out:{0}" -f $context.runtimePath) (Join-Path $context.root "VisionFixture.cs")
if ($LASTEXITCODE -ne 0) { throw "fixture runtime compilation failed" }
'@ | Out-Null
  $certificateResultPath = Join-Path $root "certificate.json"
  Invoke-BoundedPowerShell -Stage "fixture.create-certificate" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $context.certificateSubject -KeyUsage DigitalSignature -HashAlgorithm SHA256 -CertStoreLocation "Cert:\CurrentUser\My"
[IO.File]::WriteAllText((Join-Path $context.root "certificate.json"), (@{thumbprint=$certificate.Thumbprint;psPath=$certificate.PSPath}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $certificate = Get-Content -LiteralPath $certificateResultPath -Raw | ConvertFrom-Json
  Assert-True (-not [string]::IsNullOrWhiteSpace([string]$certificate.thumbprint)) "fixture certificate creation returned no thumbprint"
  $harnessContext.certificateThumbprint = [string]$certificate.thumbprint
  Write-Json $certificateCleanupMarkerPath @{ schemaVersion="vem-vision-harness-certificate-cleanup/v1"; certificateSubject=$certificateSubject; certificateThumbprint=[string]$certificate.thumbprint }
  Write-Json $harnessContextPath $harnessContext
  Invoke-BoundedPowerShell -Stage "fixture.export-certificate" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\{0}" -f $context.certificateThumbprint)
Export-Certificate -Cert $certificate -FilePath $context.certificateExportPath -Force | Out-Null
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.trust-root" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
Import-Certificate -FilePath $context.certificateExportPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.trust-publisher" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
Import-Certificate -FilePath $context.certificateExportPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null
'@ | Out-Null
  $signatureResultPath = Join-Path $root "signature.json"
  Invoke-BoundedPowerShell -Stage "fixture.sign-runtime" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\{0}" -f $context.certificateThumbprint)
$signature = Set-AuthenticodeSignature -FilePath $context.runtimePath -Certificate $certificate -HashAlgorithm SHA256
[IO.File]::WriteAllText((Join-Path $context.root "signature.json"), (@{status=[string]$signature.Status;statusMessage=[string]$signature.StatusMessage}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $signature = Get-Content -LiteralPath $signatureResultPath -Raw | ConvertFrom-Json
  $verificationResultPath = Join-Path $root "verification.json"
  Invoke-BoundedPowerShell -Stage "fixture.verify-authenticode" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$verification = Get-AuthenticodeSignature -FilePath $context.runtimePath
$chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
$localChainValid = $null -ne $verification.SignerCertificate -and $chain.Build($verification.SignerCertificate)
[IO.File]::WriteAllText((Join-Path $context.root "verification.json"), (@{status=[string]$verification.Status;statusMessage=[string]$verification.StatusMessage;localChainValid=$localChainValid}|ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
'@ | Out-Null
  $verification = Get-Content -LiteralPath $verificationResultPath -Raw | ConvertFrom-Json
  Write-Host "fixture Authenticode status: sign=$($signature.status); verify=$($verification.status); signerThumbprint=$($certificate.thumbprint)"
  Assert-True ($signature.status -eq "Valid") "fixture runtime signing status was $($signature.status): $($signature.statusMessage)"
  Assert-True ($verification.status -eq "Valid") "fixture runtime verification status was $($verification.status): $($verification.statusMessage)"
  Assert-True ($verification.localChainValid -eq $true) "fixture runtime certificate chain did not validate from local trust"

  Invoke-BoundedPowerShell -Stage "fixture.assemble-release" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$release = Join-Path $context.root "release"
New-Item -ItemType Directory -Force -Path $release | Out-Null
Copy-Item -LiteralPath $context.runtimePath -Destination (Join-Path $release "runtime.exe")
$bundle = Join-Path $context.delivery "bundle.bin"
Compress-Archive -Path (Join-Path $release "*") -DestinationPath $bundle
Copy-Item -LiteralPath $bundle -Destination (Join-Path $context.root "approved-bundle.bin")
$bundleDigest = Get-Digest $bundle
Write-Json (Join-Path $context.delivery "sbom.json") @{ format="spdx"; fixture=$true }
Write-Json (Join-Path $context.delivery "provenance.json") @{ predicate="fixture"; fixture=$true }
$sbomDigest = Get-Digest (Join-Path $context.delivery "sbom.json")
$provenanceDigest = Get-Digest (Join-Path $context.delivery "provenance.json")
$descriptorIdentity = "sha256:" + ("d" * 64)
$signer = "spki-sha256:" + ("a" * 64)
$descriptor = [ordered]@{ schemaVersion="vem-vision-release-descriptor/v1"; kind="vision-release-descriptor"; identity=$descriptorIdentity; releaseVersion="1.0.0"; bundle=[ordered]@{ digest=$bundleDigest; bytes=(Get-Item $bundle).Length; platform=@{os="windows";architecture="x86_64"};format="zip";extractor=@{contractVersion="vem-vision-extractor/v1";handler="zip-safe-v1"} }; entrypoint=@{command="runtime.exe";arguments=@()}; lifecycle=@{requiresInteractiveSession=$true;shutdownTimeoutMs=5000}; configuration=@{format="json";schemaVersion="fixture/v1";argument="--config"}; health=@{port=18992;path="/health";expectedStatus=200;timeoutMs=15000}; protocol=@{version="vem.vision.v1";webSocketPath="/ws"}; sbom=@{identity=(Evidence-Identity $sbomDigest);digest=$sbomDigest;format="spdx-json"}; provenance=@{identity=(Evidence-Identity $provenanceDigest);digest=$provenanceDigest;predicateType="https://slsa.dev/provenance/v1"} }
Write-Json (Join-Path $context.delivery "descriptor.json") $descriptor
$attestation = @{ schemaVersion="vem-vision-artifact-attestation/v1";kind="vision-artifact-attestation";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;sbomDigest=$sbomDigest;provenanceDigest=$provenanceDigest;signerIdentity=$signer }
Write-Json (Join-Path $context.delivery "attestation.json") $attestation
$attestationDigest = Get-Digest (Join-Path $context.delivery "attestation.json")
$conformance = @{ schemaVersion="vem-vision-conformance/v1";kind="vision-release-conformance";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;protocolVersion="vem.vision.v1" }
Write-Json (Join-Path $context.delivery "conformance.json") $conformance
$conformanceDigest = Get-Digest (Join-Path $context.delivery "conformance.json")
$approval = @{ schemaVersion="vem-vision-release-approval/v1";kind="vision-release-approval";identity=("sha256:" + ("e" * 64));releaseVersion="1.0.0";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;attestationDigest=$attestationDigest;conformanceEvidenceDigest=$conformanceDigest;approverIdentity="vem-release-approval:ci" }
Write-Json (Join-Path $context.delivery "approval.json") $approval
$approvalDigest = Get-Digest (Join-Path $context.delivery "approval.json")
$factoryManifest = @{ assets=@(@{role="vision-release";digest=$bundleDigest;version="1.0.0";release=@{descriptorIdentity=(Evidence-Identity $descriptorIdentity);descriptorDigest=$descriptorIdentity;attestationIdentity=(Evidence-Identity $attestationDigest);attestationDigest=$attestationDigest;approvalIdentity=(Evidence-Identity $approval.identity);approvalDigest=$approvalDigest;conformanceEvidenceIdentity=(Evidence-Identity $conformanceDigest);conformanceEvidenceDigest=$conformanceDigest}}) }
Write-Json (Join-Path $context.delivery "factory-manifest.json") $factoryManifest
Write-Json (Join-Path $context.root "release-context.json") @{ bundleDigest=$bundleDigest; signer=$signer }
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.compile-verifier" -TimeoutSeconds 30 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$releaseContext = Get-Content -LiteralPath (Join-Path $context.root "release-context.json") -Raw | ConvertFrom-Json
$signer = [string]$releaseContext.signer
$verifierSource = @"
using System; class V { static void Main(){ Console.Write("{\"schemaVersion\":\"vem-vision-release-verification/v1\",\"kind\":\"vision-release-verification\",\"verified\":true,\"identities\":{\"descriptor\":\"$signer\",\"attestation\":\"$signer\",\"sbom\":\"$signer\",\"provenance\":\"$signer\",\"conformance\":\"$signer\",\"approval\":\"$signer\"}}"); }}
"@
$verifierPath = Join-Path $context.trust "vision-release-verifier.exe"
Write-Utf8 (Join-Path $context.root "Verifier.cs") $verifierSource
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe ("/out:{0}" -f $verifierPath) (Join-Path $context.root "Verifier.cs")
if ($LASTEXITCODE -ne 0) { throw "fixture verifier compilation failed" }
$verifierDigest = Get-Digest $verifierPath
$policy = @{ schemaVersion="vem-vision-release-trust-policy/v1";kind="vision-release-trust-policy";verifierDigest=$verifierDigest;approvedIdentities=@{descriptor=@($signer);attestation=@($signer);sbom=@($signer);provenance=@($signer);conformance=@($signer);approval=@($signer)} }
Write-Json (Join-Path $context.trust "vision-release-trust-policy.json") $policy
$policyDigest = Get-Digest (Join-Path $context.trust "vision-release-trust-policy.json")
Write-Json (Join-Path $context.trust "vision-release-trust-anchor.json") @{schemaVersion="vem-factory-vision-trust-anchor/v1";kind="factory-vision-trust-anchor";trustPolicyDigest=$policyDigest;verifierDigest=$verifierDigest}
'@ | Out-Null
  $bundleDigest = (Get-Content -LiteralPath (Join-Path $root "release-context.json") -Raw | ConvertFrom-Json).bundleDigest
  $harnessContext.bundleDigest = $bundleDigest
  Write-Json $harnessContextPath $harnessContext
  Invoke-BoundedPowerShell -Stage "fixture.provision-and-first-install" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
Copy-Item -LiteralPath $context.installerPath -Destination (Join-Path $context.installerMedia "install-vision-release.ps1")
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $context.installerPath) "provision-vision-factory-release.ps1") -Destination (Join-Path $context.installerMedia "provision-vision-factory-release.ps1")
$files = @{}; Get-ChildItem -LiteralPath (Join-Path $context.media "VEM") -Recurse -File | ForEach-Object { $relative=$_.FullName.Substring((Join-Path $context.media "VEM").Length+1).Replace("\\","/"); $files[$relative]=Get-Digest $_.FullName }
Write-Json (Join-Path $context.media "VEM\VISION-FACTORY-PROVISIONING.JSON") @{schemaVersion="vem-vision-factory-provisioning/v1";kind="vision-factory-provisioning";files=$files}
  $wrongParentFailed = $false
  try {
  & (Join-Path $context.installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $context.media
  } catch {
    $wrongParentFailed = $true
  }
  Assert-True $wrongParentFailed "Vision provisioner accepted the Factory Media parent instead of the VEM root"
& (Join-Path $context.installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $context.visionMediaRoot
New-Item -ItemType Directory -Force -Path (Join-Path $context.stateRoot "config") | Out-Null
Write-Utf8 (Join-Path $context.stateRoot "config\fixture.json") "{}"
& "C:\VEM\bringup\install-vision-release.ps1" -ConfigurationPath (Join-Path $context.stateRoot "config\fixture.json") -EvidencePath $context.evidencePath -TaskUser $env:USERNAME
$evidence = Get-Content -LiteralPath $context.evidencePath -Raw | ConvertFrom-Json
Assert-True ($evidence.healthOk -and $evidence.webSocketOk -and $evidence.installedDigest -eq $context.bundleDigest) "first install did not reach approved runtime"
  Assert-True (Test-Path -LiteralPath "C:\ProgramData\VEM\vision\current.json") "selection missing after first install"
  Assert-True ($null -ne (Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue)) "Vision task missing"
  $acl = Get-Acl -LiteralPath "C:\ProgramData\VEM\vision\current.json"
  Assert-True ($acl.AreAccessRulesProtected) "selection ACL is inherited"
'@ | Out-Null
  Invoke-BoundedPowerShell -Stage "fixture.activation-regressions" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
$factoryRoot = $context.factoryRoot
$stateRoot = $context.stateRoot
$evidencePath = $context.evidencePath
$bundleDigest = $context.bundleDigest
$descriptor = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\descriptor.json") -Raw | ConvertFrom-Json
$attestation = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\attestation.json") -Raw | ConvertFrom-Json
$conformance = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\conformance.json") -Raw | ConvertFrom-Json
$approval = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\approval.json") -Raw | ConvertFrom-Json
$factoryManifest = Get-Content -LiteralPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -Raw | ConvertFrom-Json
$originalBundle = Join-Path $context.root "approved-bundle.bin"
  # A newly staged release with a bad health endpoint must roll back to the
  # prior approved selection, rather than leaving the machine unbound.
  $badDescriptor = $descriptor | ConvertTo-Json -Depth 32 | ConvertFrom-Json
  $badDescriptor.releaseVersion = "1.0.1"; $badDescriptor.identity = "sha256:" + ("f" * 64); $badDescriptor.health.port = 18993
  $badAttestation = $attestation | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badAttestation.descriptorDigest = $badDescriptor.identity
  $badConformance = $conformance | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badConformance.descriptorDigest = $badDescriptor.identity
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $badDescriptor
  Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $badAttestation
  Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $badConformance
  $badAttestationDigest = Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json")
  $badConformanceDigest = Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json")
  $badApproval = $approval | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $badApproval.releaseVersion = "1.0.1"; $badApproval.descriptorDigest = $badDescriptor.identity; $badApproval.attestationDigest = $badAttestationDigest; $badApproval.conformanceEvidenceDigest = $badConformanceDigest
  Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $badApproval
  $badApprovalDigest = Get-Digest (Join-Path $factoryRoot "vision-release\approval.json")
  Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") @{ assets=@(@{role="vision-release";digest=$bundleDigest;version="1.0.1";release=@{descriptorIdentity=(Evidence-Identity $badDescriptor.identity);descriptorDigest=$badDescriptor.identity;attestationIdentity=(Evidence-Identity $badAttestationDigest);attestationDigest=$badAttestationDigest;approvalIdentity=(Evidence-Identity $badApproval.identity);approvalDigest=$badApprovalDigest;conformanceEvidenceIdentity=(Evidence-Identity $badConformanceDigest);conformanceEvidenceDigest=$badConformanceDigest}}) }
  $rollbackFailed = $false
  try { & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME } catch { $rollbackFailed = $true }
  $rollbackEvidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
  Assert-True ($rollbackFailed -and $rollbackEvidence.rollbackAttempted -and $rollbackEvidence.rollbackOk) "failed activation did not roll back"
  Assert-True (((Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json).bundleDigest -eq $bundleDigest)) "rollback did not restore prior selection"
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $descriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $attestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $conformance; Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $approval; Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") $factoryManifest
  # An orphan directory for a newly selected digest is quarantined before the
  # installer can activate it. The intentionally malformed bundle is safe here:
  # orphan rejection must happen before extraction.
  $orphanBundle = Join-Path $factoryRoot "vision-release\bundle.bin"; Copy-Item -LiteralPath $originalBundle -Destination $orphanBundle -Force; $append = [IO.File]::Open($orphanBundle, [IO.FileMode]::Append); try { $append.WriteByte(0) } finally { $append.Dispose() }
  $orphanDigest = Get-Digest $orphanBundle; $orphanDescriptor = $descriptor | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanDescriptor.releaseVersion="1.0.2"; $orphanDescriptor.identity="sha256:" + ("c" * 64); $orphanDescriptor.bundle.digest=$orphanDigest; $orphanDescriptor.bundle.bytes=(Get-Item $orphanBundle).Length
  $orphanAttestation = $attestation | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanAttestation.bundleDigest=$orphanDigest; $orphanAttestation.descriptorDigest=$orphanDescriptor.identity; $orphanConformance = $conformance | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanConformance.bundleDigest=$orphanDigest; $orphanConformance.descriptorDigest=$orphanDescriptor.identity
  Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $orphanDescriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $orphanAttestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $orphanConformance
  $orphanApproval = $approval | ConvertTo-Json -Depth 32 | ConvertFrom-Json; $orphanApproval.releaseVersion="1.0.2"; $orphanApproval.bundleDigest=$orphanDigest; $orphanApproval.descriptorDigest=$orphanDescriptor.identity; $orphanApproval.attestationDigest=Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json"); $orphanApproval.conformanceEvidenceDigest=Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json"); Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $orphanApproval; $orphanApprovalDigest=Get-Digest (Join-Path $factoryRoot "vision-release\approval.json")
  Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") @{ assets=@(@{role="vision-release";digest=$orphanDigest;version="1.0.2";release=@{descriptorIdentity=(Evidence-Identity $orphanDescriptor.identity);descriptorDigest=$orphanDescriptor.identity;attestationIdentity=(Evidence-Identity (Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json")));attestationDigest=(Get-Digest (Join-Path $factoryRoot "vision-release\attestation.json"));approvalIdentity=(Evidence-Identity $orphanApproval.identity);approvalDigest=$orphanApprovalDigest;conformanceEvidenceIdentity=(Evidence-Identity (Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json")));conformanceEvidenceDigest=(Get-Digest (Join-Path $factoryRoot "vision-release\conformance.json"))}}) }
  $orphanPath = Join-Path "C:\VEM\vision\releases" ("1.0.2-" + $orphanDigest.Substring(7,16)); New-Item -ItemType Directory -Force -Path $orphanPath | Out-Null; Write-Utf8 (Join-Path $orphanPath "runtime.exe") "orphan"
  $orphanRejected=$false; try { & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath $orphanBundle -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME } catch { $orphanRejected=$true }
  Assert-True ($orphanRejected -and -not (Test-Path -LiteralPath $orphanPath) -and (Test-Path -LiteralPath (Join-Path $stateRoot "quarantine"))) "orphan release was not quarantined"
  Copy-Item -LiteralPath $originalBundle -Destination $orphanBundle -Force; Write-Json (Join-Path $factoryRoot "vision-release\descriptor.json") $descriptor; Write-Json (Join-Path $factoryRoot "vision-release\attestation.json") $attestation; Write-Json (Join-Path $factoryRoot "vision-release\conformance.json") $conformance; Write-Json (Join-Path $factoryRoot "vision-release\approval.json") $approval; Write-Json (Join-Path $factoryRoot "vision-release\factory-manifest.json") $factoryManifest
  # Idempotent reinstall must preserve the approved immutable release and keep
  # the task-managed runtime healthy.
  & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME
  $reinstalled = Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json
  Assert-True ($reinstalled.bundleDigest -eq $bundleDigest) "idempotent reinstall changed the selected digest"
'@ | Out-Null

  Invoke-BoundedPowerShell -Stage "fixture.process-mutex-runtime" -TimeoutSeconds 45 -CleanupReserveSeconds $CleanupReserveSeconds -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody @'
  $factoryRoot = $context.factoryRoot
  $stateRoot = $context.stateRoot
  $evidencePath = $context.evidencePath
  $bundleDigest = $context.bundleDigest
  $reinstalled = Get-Content -LiteralPath "C:\ProgramData\VEM\vision\current.json" -Raw | ConvertFrom-Json
  # A kiosk-writable process record must never authorize stopping an unrelated
  # process. The production installer ignores it and completes its reinstall.
  $victim = Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" -ArgumentList "/c", "timeout /t 60 /nobreak" -PassThru
  $forged = @{ bundleDigest=$bundleDigest; processId=$victim.Id; creationTimeUtc=$victim.StartTime.ToUniversalTime().ToString("o"); executablePath=$victim.Path; executableDigest=("sha256:" + ("0" * 64)); selectionRevision=$reinstalled.revision }
  Write-Json (Join-Path $stateRoot "process-state\active-process.json") $forged
  & "C:\VEM\bringup\install-vision-release.ps1" -BundlePath (Join-Path $factoryRoot "vision-release\bundle.bin") -DescriptorPath (Join-Path $factoryRoot "vision-release\descriptor.json") -AttestationPath (Join-Path $factoryRoot "vision-release\attestation.json") -SbomPath (Join-Path $factoryRoot "vision-release\sbom.json") -ProvenancePath (Join-Path $factoryRoot "vision-release\provenance.json") -ConformanceEvidencePath (Join-Path $factoryRoot "vision-release\conformance.json") -ApprovalPath (Join-Path $factoryRoot "vision-release\approval.json") -FactoryManifestPath (Join-Path $factoryRoot "vision-release\factory-manifest.json") -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME
  Assert-True (-not $victim.HasExited) "forged process record stopped an unrelated process"
  $victim | Stop-Process -Force

  # Hold the named mutex from a second process long enough to prove that a
  # concurrent production installation waits rather than racing activation.
  $mutex = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstaller")
  try {
    Assert-True ($mutex.WaitOne([TimeSpan]::FromSeconds(5))) "could not acquire installer mutex"
    $blocked = Start-Job -ScriptBlock { param($script,$config,$evidence,$user) & $script -ConfigurationPath $config -EvidencePath $evidence -TaskUser $user } -ArgumentList "C:\VEM\bringup\install-vision-release.ps1", (Join-Path $stateRoot "config\fixture.json"), $evidencePath, $env:USERNAME
    Start-Sleep -Seconds 2
    Assert-True ($blocked.State -eq "Running") "concurrent installer did not wait on mutex"
  } finally {
    if ($mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() }
  }
  Wait-Job -Job $blocked -Timeout 30 | Out-Null
  Receive-Job -Job $blocked -ErrorAction Stop | Out-Null
  Remove-Job -Job $blocked -Force
  & (Join-Path $context.harnessScriptRoot "verify-vem-runtime.ps1") -RequireVisionOnline
'@ | Out-Null
  Write-HarnessStage "harness" "completed" "first-install task acl process-record mutex reinstall protocol runtime-verifier"
} finally {
  $cleanupFailure = $null
  if (Test-Path -LiteralPath $certificateCleanupMarkerPath) {
    try {
      Invoke-BoundedPowerShell -Stage "fixture.cleanup-certificates" -TimeoutSeconds 30 -HarnessRoot $root -HarnessContextPath $harnessContextPath -ChildPowerShellPath $childPwsh -HarnessDeadlineUtc $harnessDeadlineUtc -ScriptBody 'Invoke-HarnessFixtureCleanup -Context $context' | Out-Null
    } catch {
      Write-HarnessStage "fixture.cleanup-certificates" "failed" $_.Exception.Message
      $cleanupFailure = $_
    }
  }
  try {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
  } catch {
    Write-HarnessStage "fixture.cleanup-files" "failed" $_.Exception.Message
    if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
  }
  if ($null -ne $cleanupFailure) { throw $cleanupFailure }
}
