[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath
)

# This harness intentionally runs only on a disposable Windows GitHub runner.
# It builds a signed fixture release, provisions it through the same Factory
# media path as production, and lets the production installer launch it.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:OS -ne "Windows_NT" -or $env:CI -ne "true") { throw "Windows CI only" }

function Write-Utf8([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
function Get-Digest([string]$Path) { "sha256:" + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Write-Json([string]$Path, [object]$Value) { Write-Utf8 $Path ($Value | ConvertTo-Json -Depth 32 -Compress) }
function Evidence-Identity([string]$Digest) { "factory-evidence://" + $Digest.Replace(":", "/") }
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }

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
$certificate = $null
$trustedRootCertificate = $null
$trustedPublisherCertificate = $null

try {
  Remove-Item -LiteralPath "C:\VEM", "C:\ProgramData\VEM" -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $delivery, $trust, $installerMedia | Out-Null
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
  & $csc /nologo /target:exe /out:$runtimePath $runtimeSourcePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "fixture runtime compilation failed" }
  $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=VEM Vision CI Fixture" -CertStoreLocation "Cert:\CurrentUser\My"
  $certificateExportPath = Join-Path $root "fixture-signing-root.cer"
  Export-Certificate -Cert $certificate -FilePath $certificateExportPath -Force | Out-Null
  $trustedRootCertificate = Import-Certificate -FilePath $certificateExportPath -CertStoreLocation "Cert:\CurrentUser\Root"
  $trustedPublisherCertificate = Import-Certificate -FilePath $certificateExportPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher"
  $signature = Set-AuthenticodeSignature -FilePath $runtimePath -Certificate $certificate
  $verification = Get-AuthenticodeSignature -FilePath $runtimePath
  Write-Output "fixture Authenticode status: sign=$($signature.Status); verify=$($verification.Status); signerThumbprint=$($certificate.Thumbprint)"
  Assert-True ($signature.Status -eq "Valid") "fixture runtime signing status was $($signature.Status)"
  Assert-True ($verification.Status -eq "Valid") "fixture runtime verification status was $($verification.Status)"

  $release = Join-Path $root "release"
  New-Item -ItemType Directory -Force -Path $release | Out-Null
  Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $release "runtime.exe")
  $bundle = Join-Path $delivery "bundle.bin"
  Compress-Archive -Path (Join-Path $release "*") -DestinationPath $bundle
  $originalBundle = Join-Path $root "approved-bundle.bin"; Copy-Item -LiteralPath $bundle -Destination $originalBundle
  $bundleDigest = Get-Digest $bundle
  Write-Json (Join-Path $delivery "sbom.json") @{ format="spdx"; fixture=$true }
  Write-Json (Join-Path $delivery "provenance.json") @{ predicate="fixture"; fixture=$true }
  $sbomDigest = Get-Digest (Join-Path $delivery "sbom.json")
  $provenanceDigest = Get-Digest (Join-Path $delivery "provenance.json")
  $descriptorIdentity = "sha256:" + ("d" * 64)
  $signer = "spki-sha256:" + ("a" * 64)
  $descriptor = [ordered]@{ schemaVersion="vem-vision-release-descriptor/v1"; kind="vision-release-descriptor"; identity=$descriptorIdentity; releaseVersion="1.0.0"; bundle=[ordered]@{ digest=$bundleDigest; bytes=(Get-Item $bundle).Length; platform=@{os="windows";architecture="x86_64"};format="zip";extractor=@{contractVersion="vem-vision-extractor/v1";handler="zip-safe-v1"} }; entrypoint=@{command="runtime.exe";arguments=@()}; lifecycle=@{requiresInteractiveSession=$true;shutdownTimeoutMs=5000}; configuration=@{format="json";schemaVersion="fixture/v1";argument="--config"}; health=@{port=18992;path="/health";expectedStatus=200;timeoutMs=15000}; protocol=@{version="vem.vision.v1";webSocketPath="/ws"}; sbom=@{identity=(Evidence-Identity $sbomDigest);digest=$sbomDigest;format="spdx-json"}; provenance=@{identity=(Evidence-Identity $provenanceDigest);digest=$provenanceDigest;predicateType="https://slsa.dev/provenance/v1"} }
  Write-Json (Join-Path $delivery "descriptor.json") $descriptor
  $attestation = @{ schemaVersion="vem-vision-artifact-attestation/v1";kind="vision-artifact-attestation";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;sbomDigest=$sbomDigest;provenanceDigest=$provenanceDigest;signerIdentity=$signer }
  Write-Json (Join-Path $delivery "attestation.json") $attestation
  $attestationDigest = Get-Digest (Join-Path $delivery "attestation.json")
  $conformance = @{ schemaVersion="vem-vision-conformance/v1";kind="vision-release-conformance";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;protocolVersion="vem.vision.v1" }
  Write-Json (Join-Path $delivery "conformance.json") $conformance
  $conformanceDigest = Get-Digest (Join-Path $delivery "conformance.json")
  $approval = @{ schemaVersion="vem-vision-release-approval/v1";kind="vision-release-approval";identity=("sha256:" + ("e" * 64));releaseVersion="1.0.0";bundleDigest=$bundleDigest;descriptorDigest=$descriptorIdentity;attestationDigest=$attestationDigest;conformanceEvidenceDigest=$conformanceDigest;approverIdentity="vem-release-approval:ci" }
  Write-Json (Join-Path $delivery "approval.json") $approval
  $approvalDigest = Get-Digest (Join-Path $delivery "approval.json")
  $factoryManifest = @{ assets=@(@{role="vision-release";digest=$bundleDigest;version="1.0.0";release=@{descriptorIdentity=(Evidence-Identity $descriptorIdentity);descriptorDigest=$descriptorIdentity;attestationIdentity=(Evidence-Identity $attestationDigest);attestationDigest=$attestationDigest;approvalIdentity=(Evidence-Identity $approval.identity);approvalDigest=$approvalDigest;conformanceEvidenceIdentity=(Evidence-Identity $conformanceDigest);conformanceEvidenceDigest=$conformanceDigest}}) }
  Write-Json (Join-Path $delivery "factory-manifest.json") $factoryManifest

  $verifierSource = @"
using System; class V { static void Main(){ Console.Write("{\"schemaVersion\":\"vem-vision-release-verification/v1\",\"kind\":\"vision-release-verification\",\"verified\":true,\"identities\":{\"descriptor\":\"$signer\",\"attestation\":\"$signer\",\"sbom\":\"$signer\",\"provenance\":\"$signer\",\"conformance\":\"$signer\",\"approval\":\"$signer\"}}"); }}
"@
  $verifierPath = Join-Path $trust "vision-release-verifier.exe"
  Write-Utf8 (Join-Path $root "Verifier.cs") $verifierSource; & $csc /nologo /target:exe /out:$verifierPath (Join-Path $root "Verifier.cs") | Out-Null
  $verifierDigest = Get-Digest $verifierPath
  $policy = @{ schemaVersion="vem-vision-release-trust-policy/v1";kind="vision-release-trust-policy";verifierDigest=$verifierDigest;approvedIdentities=@{descriptor=@($signer);attestation=@($signer);sbom=@($signer);provenance=@($signer);conformance=@($signer);approval=@($signer)} }
  Write-Json (Join-Path $trust "vision-release-trust-policy.json") $policy
  $policyDigest = Get-Digest (Join-Path $trust "vision-release-trust-policy.json")
  Write-Json (Join-Path $trust "vision-release-trust-anchor.json") @{schemaVersion="vem-factory-vision-trust-anchor/v1";kind="factory-vision-trust-anchor";trustPolicyDigest=$policyDigest;verifierDigest=$verifierDigest}
  Copy-Item -LiteralPath $InstallerPath -Destination (Join-Path $installerMedia "install-vision-release.ps1")
  Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $InstallerPath) "provision-vision-factory-release.ps1") -Destination (Join-Path $installerMedia "provision-vision-factory-release.ps1")
  $files = @{}; Get-ChildItem -LiteralPath (Join-Path $media "VEM") -Recurse -File | ForEach-Object { $relative=$_.FullName.Substring((Join-Path $media "VEM").Length+1).Replace("\\","/"); $files[$relative]=Get-Digest $_.FullName }
  Write-Json (Join-Path $media "VEM\VISION-FACTORY-PROVISIONING.JSON") @{schemaVersion="vem-vision-factory-provisioning/v1";kind="vision-factory-provisioning";files=$files}
  $wrongParentFailed = $false
  try {
    & (Join-Path $installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $media
  } catch {
    $wrongParentFailed = $true
  }
  Assert-True $wrongParentFailed "Vision provisioner accepted the Factory Media parent instead of the VEM root"
  & (Join-Path $installerMedia "provision-vision-factory-release.ps1") -FactoryMediaRoot $visionMediaRoot
  New-Item -ItemType Directory -Force -Path (Join-Path $stateRoot "config") | Out-Null
  Write-Utf8 (Join-Path $stateRoot "config\fixture.json") "{}"
  & "C:\VEM\bringup\install-vision-release.ps1" -ConfigurationPath (Join-Path $stateRoot "config\fixture.json") -EvidencePath $evidencePath -TaskUser $env:USERNAME
  $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
  Assert-True ($evidence.healthOk -and $evidence.webSocketOk -and $evidence.installedDigest -eq $bundleDigest) "first install did not reach approved runtime"
  Assert-True (Test-Path -LiteralPath "C:\ProgramData\VEM\vision\current.json") "selection missing after first install"
  Assert-True ($null -ne (Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue)) "Vision task missing"
  $acl = Get-Acl -LiteralPath "C:\ProgramData\VEM\vision\current.json"
  Assert-True ($acl.AreAccessRulesProtected) "selection ACL is inherited"
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
  Wait-Job -Job $blocked -Timeout 90 | Out-Null
  Receive-Job -Job $blocked -ErrorAction Stop | Out-Null
  Remove-Job -Job $blocked -Force
  & (Join-Path $PSScriptRoot "verify-vem-runtime.ps1") -RequireVisionOnline
  Write-Output "signed production installer harness passed: first-install task acl process-record mutex reinstall protocol runtime-verifier"
} finally {
  Get-Process runtime -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($null -ne $trustedPublisherCertificate) { Remove-Item -LiteralPath $trustedPublisherCertificate.PSPath -Force -ErrorAction SilentlyContinue }
  if ($null -ne $trustedRootCertificate) { Remove-Item -LiteralPath $trustedRootCertificate.PSPath -Force -ErrorAction SilentlyContinue }
  if ($null -ne $certificate) { Remove-Item -LiteralPath $certificate.PSPath -DeleteKey -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
