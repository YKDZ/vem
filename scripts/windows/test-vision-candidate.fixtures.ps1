[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot "vision-diagnostic-redaction.psm1") -Force -ErrorAction Stop

function Import-CandidateFunction([string]$Name) {
  $candidatePath = Join-Path $PSScriptRoot "test-vision-candidate.ps1"
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($candidatePath, [ref]$tokens, [ref]$errors)
  if (@($errors).Count -ne 0) { throw "candidate preapproval source does not parse" }
  $functionAst = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name }, $false))[0]
  if ($null -eq $functionAst) { throw "candidate preapproval function is missing: $Name" }
  Invoke-Expression ($functionAst.Extent.Text.Replace(("function " + $Name), ("function global:" + $Name)))
}

function Assert-Throws([scriptblock]$Action, [string]$Label) {
  try { & $Action } catch { return }
  throw "expected rejection: $Label"
}

foreach ($functionName in @("Assert-CandidateNonReparsePath", "Read-StrictJson", "Resolve-CandidateEntrypoint", "Get-VerifiedPreviousVisionRuntime", "Restore-VerifiedPreviousVisionRuntime", "Sanitize", "ConvertTo-CanonicalVisionJson", "Assert-PreapprovalDeliveryManifest")) {
  Import-CandidateFunction $functionName
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-candidate-fixture-" + [guid]::NewGuid().ToString("N"))
try {
  $staging = Join-Path $root "staging"
  New-Item -ItemType Directory -Path (Join-Path $staging "bin") -Force | Out-Null
  $entrypoint = Join-Path $staging "bin\runtime.exe"
  [IO.File]::WriteAllText($entrypoint, "approved", [Text.UTF8Encoding]::new($false))
  if ((Resolve-CandidateEntrypoint $staging "bin/runtime.exe") -cne [IO.Path]::GetFullPath($entrypoint)) { throw "safe candidate entrypoint was not resolved" }

  $outside = Join-Path $root "outside"; New-Item -ItemType Directory -Path $outside -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $outside "runtime.exe"), "outside", [Text.UTF8Encoding]::new($false))
  $redirect = Join-Path $staging "redirect"
  try {
    New-Item -ItemType SymbolicLink -Path $redirect -Target $outside | Out-Null
    Assert-Throws { Resolve-CandidateEntrypoint $staging "redirect/runtime.exe" } "candidate entrypoint reparse traversal"
  } catch [UnauthorizedAccessException] { Write-Output "candidate reparse fixture skipped by host policy" }

  $secret = "https://operator:password-should-not-persist@example.test/api?token=token-should-not-persist path=C:\\VEM\\vision"
  $reportPath = Join-Path $root "candidate-report.json"
  [IO.File]::WriteAllText($reportPath, (@{ failure=(Sanitize $secret) } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $written = [IO.File]::ReadAllText($reportPath, [Text.UTF8Encoding]::new($false))
  if ($written -match 'password-should-not-persist|token-should-not-persist|https://|C:\\VEM') { throw "candidate report persisted dynamic diagnostic material" }
  if ($written -notmatch 'Vision candidate preapproval failed; inspect protected local diagnostics') { throw "candidate report did not use shared structured redaction" }

  $delivery = Join-Path $root "preapproval"; New-Item -ItemType Directory -Path $delivery | Out-Null
  $bundle = Join-Path $delivery "bundle.bin"; [IO.File]::WriteAllText($bundle, "bundle", [Text.UTF8Encoding]::new($false))
  $descriptor = Join-Path $delivery "vision-release-descriptor.json"; [IO.File]::WriteAllText($descriptor, "{}", [Text.UTF8Encoding]::new($false))
  foreach ($name in @("test-vision-candidate.ps1", "vision-release-materialization.psm1", "vision-diagnostic-redaction.psm1")) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $delivery $name) }
  $deliveryFiles = [ordered]@{}
  foreach ($name in @("bundle.bin", "vision-release-descriptor.json", "test-vision-candidate.ps1", "vision-release-materialization.psm1", "vision-diagnostic-redaction.psm1")) { $deliveryFiles[$name] = "sha256:" + (Get-FileHash -LiteralPath (Join-Path $delivery $name) -Algorithm SHA256).Hash.ToLowerInvariant() }
  $unsigned = [ordered]@{ schemaVersion="vem-vision-preapproval-delivery/v1"; kind="vision-preapproval-delivery"; expectedDigest=$deliveryFiles["bundle.bin"]; descriptorDigest=$deliveryFiles["vision-release-descriptor.json"]; files=$deliveryFiles }
  $identityBytes = [Text.UTF8Encoding]::new($false).GetBytes(((ConvertTo-CanonicalVisionJson $unsigned) + [char]10))
  $manifest = [ordered]@{ schemaVersion=$unsigned.schemaVersion; kind=$unsigned.kind; expectedDigest=$unsigned.expectedDigest; descriptorDigest=$unsigned.descriptorDigest; files=$deliveryFiles; identity=("sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identityBytes))).ToLowerInvariant()) }
  $manifestPath = Join-Path $delivery "preapproval-manifest.json"; [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
  Assert-PreapprovalDeliveryManifest -Path $manifestPath -Expected $unsigned.expectedDigest -Bundle $bundle -Descriptor $descriptor -EntryScriptPath (Join-Path $delivery "test-vision-candidate.ps1") -MaterializerPath (Join-Path $delivery "vision-release-materialization.psm1") -RedactorPath (Join-Path $delivery "vision-diagnostic-redaction.psm1")
  $manifest.expectedDigest = "sha256:" + ("0" * 64); [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
  Assert-Throws { Assert-PreapprovalDeliveryManifest -Path $manifestPath -Expected $unsigned.expectedDigest -Bundle $bundle -Descriptor $descriptor -EntryScriptPath (Join-Path $delivery "test-vision-candidate.ps1") -MaterializerPath (Join-Path $delivery "vision-release-materialization.psm1") -RedactorPath (Join-Path $delivery "vision-diagnostic-redaction.psm1") } "ExpectedDigest mismatch"

  $active = Get-Process -Id $PID -ErrorAction Stop
  try {
    $activePath = [IO.Path]::GetFullPath($active.Path); $activeRoot = Split-Path -Parent $activePath; $activeLeaf = Split-Path -Leaf $activePath
    $activeDigest = "sha256:" + (Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selectionPath = Join-Path $root "current.json"; $processPath = Join-Path $root "active-process.json"
    $selection = [ordered]@{ revision="fixture-revision"; bundleDigest=("sha256:" + ("a" * 64)); installDirectory=$activeRoot; entrypoint=$activeLeaf }
    $record = [ordered]@{ selectionRevision=$selection.revision; bundleDigest=$selection.bundleDigest; processId=$active.Id; creationTimeUtcTicks=$active.StartTime.ToUniversalTime().Ticks; executablePath=$activePath; executableDigest=$activeDigest }
    [IO.File]::WriteAllText($selectionPath, ($selection | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText($processPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $runtime = Get-VerifiedPreviousVisionRuntime $selectionPath $processPath
    if ($null -eq $runtime -or -not $runtime.active) { throw "active previous Vision runtime was not identity-bound" }
    function global:Start-ScheduledTask { param($TaskName,$TaskPath) }
    if (-not (Restore-VerifiedPreviousVisionRuntime $runtime $selectionPath $processPath)) { throw "verified previous Vision runtime was not restored" }
    $record.executableDigest = "sha256:" + ("b" * 64); [IO.File]::WriteAllText($processPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Assert-Throws { Get-VerifiedPreviousVisionRuntime $selectionPath $processPath } "mismatched previous runtime digest"
  } finally { $active.Dispose(); Remove-Item -LiteralPath Function:global:Start-ScheduledTask -Force -ErrorAction SilentlyContinue }
  Write-Output "candidate fixtures passed"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
