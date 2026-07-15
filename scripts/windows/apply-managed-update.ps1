# VEM Managed Machine Update
#
# Applies daemon and/or machine UI artifacts from a local manifest or direct
# single-component parameters. This is the normal first-pilot update path on
# the Windows host; SSH remains emergency access for recovery and evidence
# collection.
#
# Manifest example:
# {
#   "updateId": "2026-06-27-local",
#   "sourceCommit": "replace-with-full-40-hex-git-commit",
#   "components": [
#     {
#       "component": "daemon",
#       "artifactPath": "C:\\VEM\\updates\\vending-daemon.exe",
#       "sha256": "...",
#       "targetPath": "C:\\VEM\\bringup\\vending-daemon.exe"
#     },
#     {
#       "component": "ui",
#       "artifactPath": "C:\\VEM\\updates\\machine.exe",
#       "sha256": "...",
#       "targetPath": "C:\\VEM\\bringup\\machine.exe",
#       "sidecars": [
#         {
#           "artifactPath": "C:\\VEM\\updates\\WebView2Loader.dll",
#           "sha256": "...",
#           "targetPath": "C:\\VEM\\bringup\\WebView2Loader.dll"
#         }
#       ]
#     }
#   ]
# }

[CmdletBinding()]
param(
  [string]$ManifestPath,
  [ValidateSet("daemon", "ui")]
  [string]$Component,
  [string]$ArtifactPath,
  [string]$Sha256,
  [string]$TargetPath,

  [string]$EvidencePath,
  [string]$BackupRoot = "C:\VEM\bringup\managed-update-backups",
  [string]$DaemonServiceName = "VemVendingDaemon",
  [string]$MachineUiTaskName = "VEMMachineUI",
  [ValidateSet("auto", "scheduledTask", "directProcess")]
  [string]$UiLaunchMode = "auto",
  [string]$DaemonReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [int]$HealthTimeoutSeconds = 30,
  [int]$HealthPollSeconds = 2
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
  }
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Normalize-Sha256 {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "sha256 is required"
  }
  $normalized = $Value.Trim().ToLowerInvariant()
  if ($normalized -notmatch "^[0-9a-f]{64}$") {
    throw "sha256 must be 64 hex characters"
  }
  return $normalized
}

function Assert-NoPlatformPaymentSecretBytes {
  param(
    [byte[]]$Bytes,
    [string]$Label
  )

  $maxInputBytes = 256MB
  $maxExpandedBytes = 16MB
  if ($Bytes.Length -gt $maxInputBytes) {
    throw "artifact exceeds bounded platform private-key scan budget: $Label"
  }
  $scan = {
    param([byte[]]$Bytes, [string]$Label, [int]$Depth, [hashtable]$State)

    if ($Depth -gt 3 -or $Bytes.Length -gt $maxInputBytes) {
      throw "artifact exceeds bounded platform private-key scan budget: $Label"
    }
    if ($Depth -gt 0) {
      $State.DecodedBytes = [long]$State.DecodedBytes + $Bytes.Length
      if ($State.DecodedBytes -gt $maxExpandedBytes) {
        throw "artifact exceeds bounded platform private-key scan budget: $Label"
      }
    }
    $texts = @(
      [Text.Encoding]::UTF8.GetString($Bytes),
      [Text.Encoding]::Unicode.GetString($Bytes)
    )
    foreach ($text in $texts) {
      if ($text -match '(?im)(?:^|[,\x7b;\r\n])\s*["'']?(?:privateKeyPem|appCertPem|alipayPublicCertPem|alipayRootCertPem|apiV[23]Key|merchantApiCertPem|merchantApiKeyPem|platformCertificatePem|platformPublicKeyPem|paymentProviderCredentials)["'']?\s*[:=]') {
        throw "artifact contains provider credential field: $Label"
      }
      if ($text -match 'BEGIN\s+(?:(?:RSA|EC)\s+|ENCRYPTED\s+)?PRIVATE\s+KEY') {
        throw "artifact contains platform private-key material: $Label"
      }
    }

    $readDerElement = {
      param([int]$Offset, [int]$Limit)
      if ($Offset + 2 -gt $Limit) { return $null }
      $tag = $Bytes[$Offset]
      if (($tag -band 0x1f) -eq 0x1f) { return $null }
      $firstLength = $Bytes[$Offset + 1]
      $headerBytes = 2
      [long]$length = $firstLength
      if (($firstLength -band 0x80) -ne 0) {
        $lengthBytes = $firstLength -band 0x7f
        if (
          $lengthBytes -eq 0 -or
          $lengthBytes -gt 4 -or
          $Offset + 2 + $lengthBytes -gt $Limit -or
          $Bytes[$Offset + 2] -eq 0
        ) {
          return $null
        }
        $length = 0
        for ($index = 0; $index -lt $lengthBytes; $index += 1) {
          $length = $length * 256 + $Bytes[$Offset + 2 + $index]
        }
        if ($length -lt 128) { return $null }
        $headerBytes += $lengthBytes
      }
      [long]$contentStart = $Offset + $headerBytes
      [long]$end = $contentStart + $length
      if ($end -gt $Limit -or $end -gt [int]::MaxValue) { return $null }
      return [pscustomobject]@{
        tag = $tag
        contentStart = [int]$contentStart
        end = [int]$end
        next = [int]$end
      }
    }
    $isValidDerOid = {
      param([int]$Start, [int]$End)
      if ($Start -ge $End) { return $false }
      $atSubidentifierStart = $true
      for ($index = $Start; $index -lt $End; $index += 1) {
        if ($atSubidentifierStart -and $Bytes[$index] -eq 0x80) { return $false }
        $atSubidentifierStart = ($Bytes[$index] -band 0x80) -eq 0
      }
      return $atSubidentifierStart
    }
    $isEncryptedPrivateKeyInfo = {
      $outer = & $readDerElement 0 $Bytes.Length
      if ($null -eq $outer -or $outer.tag -ne 0x30 -or $outer.end -ne $Bytes.Length) {
        return $false
      }
      $algorithm = & $readDerElement $outer.contentStart $outer.end
      if ($null -eq $algorithm -or $algorithm.tag -ne 0x30) { return $false }
      $oid = & $readDerElement $algorithm.contentStart $algorithm.end
      if (
        $null -eq $oid -or
        $oid.tag -ne 0x06 -or
        -not (& $isValidDerOid $oid.contentStart $oid.end)
      ) {
        return $false
      }
      if ($oid.next -lt $algorithm.end) {
        $parameters = & $readDerElement $oid.next $algorithm.end
        if ($null -eq $parameters -or $parameters.next -ne $algorithm.end) {
          return $false
        }
      } elseif ($oid.next -ne $algorithm.end) {
        return $false
      }
      $encryptedData = & $readDerElement $algorithm.next $outer.end
      return (
        $null -ne $encryptedData -and
        $encryptedData.tag -eq 0x04 -and
        $encryptedData.end -gt $encryptedData.contentStart -and
        $encryptedData.next -eq $outer.end
      )
    }
    if (& $isEncryptedPrivateKeyInfo) {
      throw "artifact contains platform private-key material: $Label"
    }

    $privateBagOidValues = @(
      '2A864886F70D010C0A0101',
      '2A864886F70D010C0A0102'
    )
    $derState = @{ Visited = 0 }
    $walkStructuredDer = $null
    $walkStructuredDer = {
      param([int]$Start, [int]$End, [int]$DerDepth)
      if ($DerDepth -gt 16) {
        return [pscustomobject]@{ valid = $false; found = $false }
      }
      $offset = $Start
      while ($offset -lt $End) {
        $derState.Visited = [int]$derState.Visited + 1
        if ($derState.Visited -gt 4096) {
          return [pscustomobject]@{ valid = $false; found = $false }
        }
        $element = & $readDerElement $offset $End
        if ($null -eq $element) {
          return [pscustomobject]@{ valid = $false; found = $false }
        }
        if (
          $element.tag -eq 0x06 -and
          (& $isValidDerOid $element.contentStart $element.end)
        ) {
          [byte[]]$oidValue = $Bytes[$element.contentStart..($element.end - 1)]
          if ($privateBagOidValues -contains [Convert]::ToHexString($oidValue)) {
            return [pscustomobject]@{ valid = $true; found = $true }
          }
        }
        if (($element.tag -band 0x20) -ne 0) {
          $nested = & $walkStructuredDer $element.contentStart $element.end ($DerDepth + 1)
          if ($nested.found) { return $nested }
          if (-not $nested.valid) { return $nested }
        } elseif (
          $element.tag -eq 0x04 -and
          $element.end - $element.contentStart -ge 2 -and
          $Bytes[$element.contentStart] -eq 0x30
        ) {
          $nested = & $walkStructuredDer $element.contentStart $element.end ($DerDepth + 1)
          if ($nested.found) { return $nested }
        }
        $offset = $element.next
      }
      return [pscustomobject]@{ valid = $offset -eq $End; found = $false }
    }
    $privateBagScan = & $walkStructuredDer 0 $Bytes.Length 0
    if ($privateBagScan.valid -and $privateBagScan.found) {
      throw "artifact contains platform private-key material: $Label"
    }

    $privateKeyDetected = $false
    foreach ($kind in @('pkcs8', 'pkcs1')) {
      $rsa = [Security.Cryptography.RSA]::Create()
      try {
        $read = 0
        if ($kind -eq 'pkcs8') {
          $rsa.ImportPkcs8PrivateKey($Bytes, [ref]$read)
        } else {
          $rsa.ImportRSAPrivateKey($Bytes, [ref]$read)
        }
        if ($read -eq $Bytes.Length) { $privateKeyDetected = $true }
      } catch {
        # Not this DER private-key encoding.
      } finally {
        $rsa.Dispose()
      }
    }
    $ec = [Security.Cryptography.ECDsa]::Create()
    try {
      $read = 0
      $ec.ImportECPrivateKey($Bytes, [ref]$read)
      if ($read -eq $Bytes.Length) { $privateKeyDetected = $true }
    } catch {
      # Not an EC private-key encoding.
    } finally {
      $ec.Dispose()
    }
    if ($privateKeyDetected) {
      throw "artifact contains platform private-key material: $Label"
    }

    $invalidArchive = { throw "artifact contains an invalid archive structure: $Label" }
    $startsWithLocalHeader =
      $Bytes.Length -ge 4 -and
      [BitConverter]::ToUInt32($Bytes, 0) -eq 0x04034b50
    $findPriorZipSignature = {
      param([uint32]$Signature, [int]$Before)
      $signatureSearchFrom = $Before
      while ($signatureSearchFrom -ge 0) {
        $signatureOffset =
          [Array]::LastIndexOf($Bytes, [byte]0x50, $signatureSearchFrom)
        if ($signatureOffset -lt 0) { return -1 }
        if (
          $signatureOffset + 4 -le $Bytes.Length -and
          [BitConverter]::ToUInt32($Bytes, $signatureOffset) -eq $Signature
        ) {
          return $signatureOffset
        }
        $signatureSearchFrom = $signatureOffset - 1
      }
      return -1
    }
    $hasPlausibleLocalBefore = {
      param([int]$CentralOffset)
      $localSearchFrom = $CentralOffset - 1
      for ($checked = 0; $checked -le 256; $checked += 1) {
        $localOffset =
          & $findPriorZipSignature 0x04034b50 $localSearchFrom
        if ($localOffset -lt 0) { return $false }
        $localSearchFrom = $localOffset - 1
        if ($localOffset + 30 -gt $CentralOffset) { continue }
        $localNameLength = [BitConverter]::ToUInt16($Bytes, $localOffset + 26)
        $localExtraLength = [BitConverter]::ToUInt16($Bytes, $localOffset + 28)
        if (
          $localOffset + 30 + $localNameLength + $localExtraLength -le
          $CentralOffset
        ) {
          return $true
        }
      }
      return $true
    }
    $findPhysicalZipShape = {
      param([int]$CentralPhysicalEnd)
      $centralSearchFrom = $CentralPhysicalEnd - 1
      $completeBest = $null
      $partialBest = $null
      $lastCentralStart = -1
      for ($checked = 0; $checked -le 257; $checked += 1) {
        $centralStart =
          & $findPriorZipSignature 0x02014b50 $centralSearchFrom
        if ($centralStart -lt 0) {
          if ($null -ne $completeBest) { return $completeBest }
          return $partialBest
        }
        $lastCentralStart = $centralStart
        $centralSearchFrom = $centralStart - 1
        if ($centralStart + 46 -gt $CentralPhysicalEnd) { continue }

        $centralOffset = [long]$centralStart
        $physicalEntries = 0
        while (
          $centralOffset + 46 -le $CentralPhysicalEnd -and
          [BitConverter]::ToUInt32($Bytes, [int]$centralOffset) -eq 0x02014b50 -and
          $physicalEntries -le 256
        ) {
          $nameLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 28)
          $extraLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 30)
          $commentLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 32)
          $nextOffset =
            $centralOffset + 46 + $nameLength + $extraLength + $commentLength
          if ($nextOffset -gt $CentralPhysicalEnd) { break }
          $centralOffset = $nextOffset
          $physicalEntries += 1
        }
        if (
          $physicalEntries -gt 0 -and
          (& $hasPlausibleLocalBefore $centralStart)
        ) {
          $shape = [pscustomobject]@{
            centralStart = $centralStart
            centralEnd = $centralOffset
            entryCount = $physicalEntries
            ambiguous = $physicalEntries -gt 256
          }
          if ($centralOffset -eq $CentralPhysicalEnd) {
            $completeBest = $shape
          } else {
            $partialBest = $shape
          }
        }
      }
      $best = if ($null -ne $completeBest) { $completeBest } else { $partialBest }
      if ($null -ne $best) { $best.ambiguous = $true }
      if ($null -ne $best) { return $best }
      if (
        $lastCentralStart -ge 0 -and
        (& $hasPlausibleLocalBefore $lastCentralStart)
      ) {
        return [pscustomobject]@{
          centralStart = $lastCentralStart
          centralEnd = -1L
          entryCount = -1
          ambiguous = $true
        }
      }
      return $null
    }
    $findRecognizableZipContainer = {
      $searchFrom = $Bytes.Length - 4
      while ($searchFrom -ge 0) {
        $candidate = [Array]::LastIndexOf($Bytes, [byte]0x50, $searchFrom)
        if ($candidate -lt 0) { return $null }
        $searchFrom = $candidate - 1
        if (
          $candidate + 22 -gt $Bytes.Length -or
          [BitConverter]::ToUInt32($Bytes, $candidate) -ne 0x06054b50
        ) {
          continue
        }
        $archiveEnd =
          $candidate + 22 + [BitConverter]::ToUInt16($Bytes, $candidate + 20)
        if ($archiveEnd -gt $Bytes.Length) { continue }
        $detectedDisk = [BitConverter]::ToUInt16($Bytes, $candidate + 4)
        $detectedCentralDisk = [BitConverter]::ToUInt16($Bytes, $candidate + 6)
        $detectedDiskEntries = [BitConverter]::ToUInt16($Bytes, $candidate + 8)
        $detectedEntries = [BitConverter]::ToUInt16($Bytes, $candidate + 10)
        $detectedCentralSize = [BitConverter]::ToUInt32($Bytes, $candidate + 12)
        $detectedCentralStart = [BitConverter]::ToUInt32($Bytes, $candidate + 16)
        $detectedCentralPhysicalEnd = [long]$candidate
        $shape =
          & $findPhysicalZipShape ([int]$detectedCentralPhysicalEnd)
        if ($null -eq $shape) { continue }

        $finiteCentralMetadata =
          $detectedCentralSize -ne 0xffffffff -and
          $detectedCentralStart -ne 0xffffffff
        $detectedPrefixBias = if ($finiteCentralMetadata) {
          [long]$candidate - $detectedCentralSize - $detectedCentralStart
        } else {
          -1L
        }
        $metadataCentralAbsoluteStart = if ($detectedPrefixBias -ge 0) {
          $detectedPrefixBias + $detectedCentralStart
        } else {
          -1L
        }
        return [pscustomobject]@{
          archiveEnd = $archiveEnd
          invalidMetadata =
            $shape.ambiguous -or
            $detectedDisk -ne 0 -or
            $detectedCentralDisk -ne 0 -or
            $detectedDiskEntries -ne $detectedEntries -or
            $detectedEntries -eq 0xffff -or
            -not $finiteCentralMetadata -or
            $metadataCentralAbsoluteStart -ne $shape.centralStart -or
            $shape.centralEnd -ne $detectedCentralPhysicalEnd -or
            $shape.entryCount -ne $detectedEntries
        }
      }
      return $null
    }
    $recognizableZipContainer = & $findRecognizableZipContainer
    if (
      $null -ne $recognizableZipContainer -and
      (
        $recognizableZipContainer.invalidMetadata -or
        -not $startsWithLocalHeader -or
        $recognizableZipContainer.archiveEnd -ne $Bytes.Length
      )
    ) {
      & $invalidArchive
    }

    if ($startsWithLocalHeader) {
      $assertExtraFields = {
        param([long]$Start, [long]$Length)
        $extraOffset = $Start
        $extraEnd = $Start + $Length
        while ($extraOffset -lt $extraEnd) {
          if ($extraOffset + 4 -gt $extraEnd) { & $invalidArchive }
          $extraId = [BitConverter]::ToUInt16($Bytes, [int]$extraOffset)
          $extraSize = [BitConverter]::ToUInt16($Bytes, [int]$extraOffset + 2)
          $extraOffset += 4
          if ($extraId -eq 0x0001 -or $extraOffset + $extraSize -gt $extraEnd) {
            & $invalidArchive
          }
          $extraOffset += $extraSize
        }
      }
      $bytesEqual = {
        param([long]$Left, [long]$Right, [long]$Length)
        for ($byteIndex = 0; $byteIndex -lt $Length; $byteIndex += 1) {
          if ($Bytes[$Left + $byteIndex] -ne $Bytes[$Right + $byteIndex]) { return $false }
        }
        return $true
      }
      $endOffset = -1
      $minimumEndOffset = [Math]::Max(0, $Bytes.Length - 65557)
      for ($offset = $Bytes.Length - 22; $offset -ge $minimumEndOffset; $offset -= 1) {
        if (
          [BitConverter]::ToUInt32($Bytes, $offset) -eq 0x06054b50 -and
          $offset + 22 + [BitConverter]::ToUInt16($Bytes, $offset + 20) -eq $Bytes.Length
        ) {
          $endOffset = $offset
          break
        }
      }
      if ($endOffset -lt 0) { & $invalidArchive }

      $diskNumber = [BitConverter]::ToUInt16($Bytes, $endOffset + 4)
      $centralDisk = [BitConverter]::ToUInt16($Bytes, $endOffset + 6)
      $diskEntryCount = [BitConverter]::ToUInt16($Bytes, $endOffset + 8)
      $entryCount = [BitConverter]::ToUInt16($Bytes, $endOffset + 10)
      $centralSize = [BitConverter]::ToUInt32($Bytes, $endOffset + 12)
      $centralStart = [BitConverter]::ToUInt32($Bytes, $endOffset + 16)
      if (
        $diskNumber -ne 0 -or
        $centralDisk -ne 0 -or
        $diskEntryCount -ne $entryCount -or
        $entryCount -eq 0xffff -or
        $centralSize -eq 0xffffffff -or
        $centralStart -eq 0xffffffff -or
        [long]$centralStart + $centralSize -ne $endOffset
      ) {
        & $invalidArchive
      }
      if ($entryCount -gt 256) {
        throw "artifact exceeds bounded platform private-key scan budget: $Label"
      }
      for ($commentOffset = $endOffset + 22; $commentOffset + 4 -le $Bytes.Length; $commentOffset += 1) {
        if ([BitConverter]::ToUInt32($Bytes, $commentOffset) -eq 0x04034b50) {
          & $invalidArchive
        }
      }

      $centralEntries = @{}
      $centralOffset = [long]$centralStart
      for ($index = 0; $index -lt $entryCount; $index += 1) {
        if (
          $centralOffset + 46 -gt $endOffset -or
          [BitConverter]::ToUInt32($Bytes, [int]$centralOffset) -ne 0x02014b50
        ) {
          & $invalidArchive
        }
        $flags = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 8)
        $method = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 10)
        $crc = [BitConverter]::ToUInt32($Bytes, [int]$centralOffset + 16)
        $compressedSize = [BitConverter]::ToUInt32($Bytes, [int]$centralOffset + 20)
        $uncompressedSize = [BitConverter]::ToUInt32($Bytes, [int]$centralOffset + 24)
        $nameLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 28)
        $extraLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 30)
        $commentLength = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 32)
        $entryDisk = [BitConverter]::ToUInt16($Bytes, [int]$centralOffset + 34)
        $localOffset = [BitConverter]::ToUInt32($Bytes, [int]$centralOffset + 42)
        $centralEnd = $centralOffset + 46 + $nameLength + $extraLength + $commentLength
        $localKey = $localOffset.ToString([Globalization.CultureInfo]::InvariantCulture)
        if (
          $centralEnd -gt $endOffset -or
          $entryDisk -ne 0 -or
          $compressedSize -eq 0xffffffff -or
          $uncompressedSize -eq 0xffffffff -or
          $localOffset -eq 0xffffffff -or
          $localOffset -ge $centralStart -or
          $centralEntries.ContainsKey($localKey) -or
          $method -notin @(0, 8)
        ) {
          & $invalidArchive
        }
        if (($flags -band 0x41) -ne 0) {
          throw "artifact contains an encrypted archive entry: $Label"
        }
        if (($flags -band 0x08) -ne 0) {
          throw "artifact uses an unsupported archive form for bounded scanning: $Label"
        }
        & $assertExtraFields ($centralOffset + 46 + $nameLength) $extraLength
        $centralEntries[$localKey] = [pscustomobject]@{
          flags = $flags
          method = $method
          crc = $crc
          compressedSize = $compressedSize
          uncompressedSize = $uncompressedSize
          nameOffset = $centralOffset + 46
          nameLength = $nameLength
        }
        $centralOffset = $centralEnd
      }
      if ($centralOffset -ne $endOffset) { & $invalidArchive }

      $localOffset = 0L
      $localEntryCount = 0
      $declaredExpanded = 0L
      $validatedEntries = [Collections.Generic.List[object]]::new()
      while ($localOffset -lt $centralStart) {
        if (
          $localOffset + 30 -gt $centralStart -or
          [BitConverter]::ToUInt32($Bytes, [int]$localOffset) -ne 0x04034b50
        ) {
          & $invalidArchive
        }
        $localKey = $localOffset.ToString([Globalization.CultureInfo]::InvariantCulture)
        if (-not $centralEntries.ContainsKey($localKey)) { & $invalidArchive }
        $central = $centralEntries[$localKey]
        $localFlags = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 6)
        $localMethod = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 8)
        $localCrc = [BitConverter]::ToUInt32($Bytes, [int]$localOffset + 14)
        $localCompressedSize = [BitConverter]::ToUInt32($Bytes, [int]$localOffset + 18)
        $localUncompressedSize = [BitConverter]::ToUInt32($Bytes, [int]$localOffset + 22)
        $localNameLength = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 26)
        $localExtraLength = [BitConverter]::ToUInt16($Bytes, [int]$localOffset + 28)
        $dataStart = $localOffset + 30 + $localNameLength + $localExtraLength
        $dataEnd = $dataStart + $localCompressedSize
        if (
          $dataStart -gt $centralStart -or
          $dataEnd -gt $centralStart -or
          $localCompressedSize -eq 0xffffffff -or
          $localUncompressedSize -eq 0xffffffff -or
          $localFlags -ne $central.flags -or
          $localMethod -ne $central.method -or
          $localCrc -ne $central.crc -or
          $localCompressedSize -ne $central.compressedSize -or
          $localUncompressedSize -ne $central.uncompressedSize -or
          $localNameLength -ne $central.nameLength -or
          -not (& $bytesEqual ($localOffset + 30) $central.nameOffset $localNameLength)
        ) {
          & $invalidArchive
        }
        if (($localFlags -band 0x41) -ne 0) {
          throw "artifact contains an encrypted archive entry: $Label"
        }
        if (($localFlags -band 0x08) -ne 0) {
          throw "artifact uses an unsupported archive form for bounded scanning: $Label"
        }
        & $assertExtraFields ($localOffset + 30 + $localNameLength) $localExtraLength
        $declaredExpanded += $localUncompressedSize
        if (
          $localUncompressedSize -gt $maxExpandedBytes -or
          $declaredExpanded -gt $maxExpandedBytes -or
          ($localCompressedSize -gt 0 -and ($localUncompressedSize / $localCompressedSize) -gt 200)
        ) {
          throw "artifact exceeds bounded platform private-key scan budget: $Label"
        }
        $validatedEntries.Add([pscustomobject]@{
          method = $localMethod
          crc = $localCrc
          compressedSize = $localCompressedSize
          uncompressedSize = $localUncompressedSize
          dataStart = $dataStart
          name = [Text.Encoding]::UTF8.GetString(
            $Bytes,
            [int]$central.nameOffset,
            [int]$central.nameLength
          )
        })
        $centralEntries.Remove($localKey)
        $localEntryCount += 1
        $localOffset = $dataEnd
      }
      if (
        $localOffset -ne $centralStart -or
        $localEntryCount -ne $entryCount -or
        $centralEntries.Count -ne 0
      ) {
        & $invalidArchive
      }
      Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
      if ($null -eq ('Vem.Security.ExactDeflateInputStream' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;

namespace Vem.Security {
  public sealed class ExactDeflateInputStream : Stream {
    private readonly Stream inner;

    public ExactDeflateInputStream(Stream inner) {
      if (inner == null) throw new ArgumentNullException("inner");
      this.inner = inner;
    }

    public long BytesRead { get; private set; }
    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return false; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return inner.Length; } }
    public override long Position {
      get { return BytesRead; }
      set { throw new NotSupportedException(); }
    }

    public override int Read(byte[] buffer, int offset, int count) {
      if (count <= 0) return 0;
      var read = inner.Read(buffer, offset, 1);
      BytesRead += read;
      return read;
    }

    public override int ReadByte() {
      var value = inner.ReadByte();
      if (value >= 0) BytesRead += 1;
      return value;
    }

    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) {
      throw new NotSupportedException();
    }
    public override void SetLength(long value) {
      throw new NotSupportedException();
    }
    public override void Write(byte[] buffer, int offset, int count) {
      throw new NotSupportedException();
    }
  }
 }
'@ -ErrorAction Stop
      }
      $crcTable = [uint32[]]::new(256)
      for ($crcTableIndex = 0; $crcTableIndex -lt $crcTable.Length; $crcTableIndex += 1) {
        $crcTableValue = [uint32]$crcTableIndex
        for ($crcTableBit = 0; $crcTableBit -lt 8; $crcTableBit += 1) {
          if (($crcTableValue -band 1) -ne 0) {
            $crcTableValue = [uint32](
              ($crcTableValue -shr 1) -bxor [uint32]3988292384
            )
          } else {
            $crcTableValue = [uint32]($crcTableValue -shr 1)
          }
        }
        $crcTable[$crcTableIndex] = $crcTableValue
      }
      $updateCrc32 = {
        param([uint32]$Crc, [byte[]]$Buffer, [int]$Count)
        $current = $Crc
        for ($crcIndex = 0; $crcIndex -lt $Count; $crcIndex += 1) {
          $tableIndex = [int](($current -bxor [uint32]$Buffer[$crcIndex]) -band 0xff)
          $current = [uint32](($current -shr 8) -bxor $crcTable[$tableIndex])
        }
        return $current
      }
      foreach ($entry in $validatedEntries) {
        $rawStream = [IO.MemoryStream]::new(
          $Bytes,
          [int]$entry.dataStart,
          [int]$entry.compressedSize,
          $false,
          $true
        )
        $decodedStream = $rawStream
        $exactDeflateInput = $null
        $entryBytes = [IO.MemoryStream]::new()
        try {
          if ($entry.method -eq 8) {
            $exactDeflateInput = [Vem.Security.ExactDeflateInputStream]::new(
              $rawStream
            )
            $decodedStream = [IO.Compression.DeflateStream]::new(
              $exactDeflateInput,
              [IO.Compression.CompressionMode]::Decompress,
              $true
            )
          }
          $buffer = [byte[]]::new(64KB)
          $actualLength = 0L
          $actualCrc = [uint32]::MaxValue
          while (($read = $decodedStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $actualLength += $read
            if (
              $actualLength -gt $maxExpandedBytes -or
              ([long]$State.DecodedBytes + $actualLength) -gt $maxExpandedBytes
            ) {
              throw "artifact exceeds bounded platform private-key scan budget: $Label/$($entry.name)"
            }
            $actualCrc = & $updateCrc32 $actualCrc $buffer $read
            $entryBytes.Write($buffer, 0, $read)
          }
          if (
            $entry.method -eq 8 -and
            $exactDeflateInput.BytesRead -ne $entry.compressedSize
          ) {
            & $invalidArchive
          }
          $actualCrc = [uint32]($actualCrc -bxor [uint32]::MaxValue)
          if (
            $actualLength -ne $entry.uncompressedSize -or
            $actualCrc -ne $entry.crc
          ) {
            & $invalidArchive
          }
          if (
            $entry.compressedSize -gt 0 -and
            ($actualLength / $entry.compressedSize) -gt 200
          ) {
            throw "artifact exceeds bounded platform private-key scan budget: $Label/$($entry.name)"
          }
          & $scan $entryBytes.ToArray() "$Label/$($entry.name)" ($Depth + 1) $State
        } catch {
          if ($_.Exception.Message -match 'platform private-key|bounded platform private-key') { throw }
          throw "artifact archive cannot be scanned safely: $Label"
        } finally {
          if ($decodedStream -ne $rawStream) { $decodedStream.Dispose() }
          if ($null -ne $exactDeflateInput) { $exactDeflateInput.Dispose() }
          $entryBytes.Dispose()
          $rawStream.Dispose()
        }
      }
    }

    foreach ($text in $texts) {
      foreach ($match in [regex]::Matches($text, '(?:[A-Za-z0-9+/]{4}){10,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?')) {
        if ($match.Value.Length -gt 2MB) { continue }
        try {
          $decoded = [Convert]::FromBase64String($match.Value)
        } catch {
          continue
        }
        if ($decoded.Length -ge 24 -and $decoded.Length -le 1MB) {
          & $scan $decoded "$Label (base64)" ($Depth + 1) $State
        }
      }
    }
  }
  & $scan $Bytes $Label 0 @{ DecodedBytes = [long]0 }
}

function Assert-NoPlatformPaymentSecrets {
  param(
    [object]$Value,
    [string]$Path = "manifest"
  )

  if ($null -eq $Value) { return }
  if ($Value -is [string]) {
    Assert-NoPlatformPaymentSecretBytes -Bytes ([Text.Encoding]::UTF8.GetBytes($Value)) -Label $Path
    return
  }
  if ($Value -is [byte[]]) {
    Assert-NoPlatformPaymentSecretBytes -Bytes $Value -Label $Path
    return
  }
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [pscustomobject]) {
    $index = 0
    foreach ($item in $Value) {
      Assert-NoPlatformPaymentSecrets -Value $item -Path "$Path[$index]"
      $index += 1
    }
    return
  }
  foreach ($property in @($Value.PSObject.Properties)) {
    if ($property.Name -match '^(?:privateKeyPem|appCertPem|alipayPublicCertPem|alipayRootCertPem|apiV[23]Key|merchantApiCertPem|merchantApiKeyPem|platformCertificatePem|platformPublicKeyPem|paymentProviderCredentials)$') {
      throw "$Path.$($property.Name) is platform-only payment secret material"
    }
    Assert-NoPlatformPaymentSecrets -Value $property.Value -Path "$Path.$($property.Name)"
  }
}

function Assert-NoPlatformPaymentSecretFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "artifact not found: $Path"
  }
  $file = Get-Item -LiteralPath $Path
  if ($file.Length -gt 256MB) {
    throw "artifact exceeds bounded platform private-key scan budget: $Path"
  }
  Assert-NoPlatformPaymentSecretBytes -Bytes ([IO.File]::ReadAllBytes($Path)) -Label $Path
}

function Get-DefaultTargetPath {
  param([string]$Component)

  if ($Component -eq "daemon") {
    return "C:\VEM\bringup\vending-daemon.exe"
  }
  if ($Component -eq "ui") {
    return "C:\VEM\bringup\machine.exe"
  }
  throw "component must be daemon or ui"
}

function Get-UiSidecarTargetPath {
  return "C:\VEM\bringup\WebView2Loader.dll"
}

function Normalize-WindowsPath {
  param([string]$Path)
  return $Path.Trim().TrimEnd("\").ToLowerInvariant()
}

function Assert-AllowedTargetPath {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  $allowed = Get-DefaultTargetPath -Component $Component
  $normalizedTarget = Normalize-WindowsPath -Path $TargetPath
  $normalizedAllowed = Normalize-WindowsPath -Path $allowed
  if ($normalizedTarget -ne $normalizedAllowed) {
    if ($Component -eq "daemon") {
      throw "targetPath for daemon must be C:\VEM\bringup\vending-daemon.exe"
    }
    throw "targetPath for ui must be C:\VEM\bringup\machine.exe"
  }
  return $allowed
}

function Assert-AllowedUiSidecarTargetPath {
  param([string]$TargetPath)

  $allowed = Get-UiSidecarTargetPath
  if ((Normalize-WindowsPath -Path $TargetPath) -ne (Normalize-WindowsPath -Path $allowed)) {
    throw "targetPath for ui sidecar must be C:\VEM\bringup\WebView2Loader.dll"
  }
  return $allowed
}

function Assert-Sha256 {
  param(
    [string]$Path,
    [string]$ExpectedSha256
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "artifact not found: $Path"
  }
  $expected = Normalize-Sha256 -Value $ExpectedSha256
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "hash mismatch for $Path; expected $expected got $actual"
  }
  return $actual
}

function New-BackupPath {
  param(
    [string]$Component,
    [string]$TargetPath,
    [string]$BackupRoot
  )

  Ensure-Directory -Path $BackupRoot
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $leaf = Split-Path -Leaf $TargetPath
  return Join-Path $BackupRoot "$Component-$timestamp-$leaf.bak"
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "file not found: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-ReadyEndpointUrl {
  param(
    $Ready,
    [string]$PropertyName
  )

  $endpoint = [string]$Ready.$PropertyName
  if ([string]::IsNullOrWhiteSpace($endpoint)) {
    throw "$PropertyName missing from ready file"
  }
  if (-not [System.Uri]::IsWellFormedUriString($endpoint, [System.UriKind]::Absolute)) {
    throw "invalid $PropertyName`: $endpoint"
  }
  return $endpoint
}

function Test-DaemonHealth {
  param(
    [string]$ReadyFile,
    [int]$TimeoutSeconds,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $ready = Read-JsonFile -Path $ReadyFile
      $healthzUrl = Get-ReadyEndpointUrl -Ready $ready -PropertyName "healthzUrl"
      $readyzUrl = Get-ReadyEndpointUrl -Ready $ready -PropertyName "readyzUrl"
      $headers = @{ Authorization = ("Bearer " + $ready.ipcToken) }
      $health = Invoke-RestMethod -Method Get -Uri $healthzUrl -Headers $headers -TimeoutSec 5
      $readyz = Invoke-RestMethod -Method Get -Uri $readyzUrl -Headers $headers -TimeoutSec 5
      return [pscustomobject]@{
        ok = $true
        readyFile = $ReadyFile
        healthzUrl = $healthzUrl
        readyzUrl = $readyzUrl
        healthzOk = $true
        readyzOk = $true
        status = $health.status
        mode = $readyz.mode
        blockingCodes = @($readyz.blockingCodes)
        readyzStatus = $readyz.status
        backendOnline = $health.backendOnline
        mqttConnected = $health.mqttConnected
        hardwareOnline = $health.hardwareOnline
        scannerOnline = $health.scannerOnline
      }
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds $PollSeconds
    }
  } while ((Get-Date) -lt $deadline)

  return [pscustomobject]@{
    ok = $false
    readyFile = $ReadyFile
    healthzOk = $false
    readyzOk = $false
    error = $lastError
  }
}

function Get-ExactMachineProcess {
  param([string]$TargetPath)

  $normalizedTarget = Normalize-WindowsPath -Path $TargetPath
  return Get-Process machine -ErrorAction SilentlyContinue |
    Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.Path) -and
      (Normalize-WindowsPath -Path $_.Path) -eq $normalizedTarget
    }
}

function Get-MachineUiTask {
  try {
    return Get-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction Stop
  } catch {
    return $null
  }
}

function Resolve-UiLaunchMode {
  if ($UiLaunchMode -eq "scheduledTask") {
    if ($null -eq (Get-MachineUiTask)) {
      throw "VEMMachineUI scheduled task not found and -UiLaunchMode scheduledTask was requested"
    }
    return "scheduledTask"
  }
  if ($UiLaunchMode -eq "directProcess") {
    return "directProcess"
  }
  if ($null -ne (Get-MachineUiTask)) {
    return "scheduledTask"
  }
  return "directProcess"
}

function Test-UiHealth {
  param(
    [string]$TargetPath,
    [string]$ExpectedSha256,
    [object[]]$Sidecars = @(),
    [string]$LaunchMode,
    [int]$TimeoutSeconds,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $targetSha256 = Assert-Sha256 -Path $TargetPath -ExpectedSha256 $ExpectedSha256
      $sidecarEvidence = @()
      foreach ($sidecar in @($Sidecars)) {
        $sidecarSha256 = Assert-Sha256 -Path $sidecar.targetPath -ExpectedSha256 $sidecar.sha256
        $sidecarEvidence += [pscustomobject]@{
          targetPath = $sidecar.targetPath
          targetSha256 = $sidecarSha256
        }
      }
      $process = Get-ExactMachineProcess -TargetPath $TargetPath | Select-Object -First 1
      if ($null -ne $process) {
        return [pscustomobject]@{
          ok = $true
          launchMode = $LaunchMode
          processId = $process.Id
          processName = $process.ProcessName
          path = $process.Path
          targetPath = $TargetPath
          targetSha256 = $targetSha256
          sidecars = $sidecarEvidence
        }
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds $PollSeconds
  } while ((Get-Date) -lt $deadline)

  return [pscustomobject]@{
    ok = $false
    launchMode = $LaunchMode
    targetPath = $TargetPath
    targetSha256 = if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
      (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
      $null
    }
    error = if ([string]::IsNullOrWhiteSpace($lastError)) { "machine.exe process for $TargetPath not observed after UI restart" } else { $lastError }
  }
}

function Stop-ComponentForReplace {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  if ($Component -eq "daemon") {
    Stop-Service -Name $DaemonServiceName -Force -ErrorAction Stop
    return
  }

  Stop-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction SilentlyContinue
  Get-ExactMachineProcess -TargetPath $TargetPath | Stop-Process -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcess = Get-ExactMachineProcess -TargetPath $TargetPath |
      Select-Object -First 1
    if ($null -eq $runningProcess) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "machine.exe still running after stop request: $TargetPath"
}

function Restart-DaemonComponent {
  Restart-Service -Name $DaemonServiceName -Force -ErrorAction Stop
}

function Restart-UiComponent {
  param([string]$TargetPath)

  $launchMode = Resolve-UiLaunchMode
  Stop-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction SilentlyContinue
  Get-ExactMachineProcess -TargetPath $TargetPath | Stop-Process -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcess = Get-ExactMachineProcess -TargetPath $TargetPath |
      Select-Object -First 1
    if ($null -eq $runningProcess) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if ($launchMode -eq "scheduledTask") {
    Start-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction Stop
  } else {
    Start-Process -FilePath $TargetPath -WorkingDirectory (Split-Path -Parent $TargetPath) | Out-Null
  }

  return [pscustomobject]@{
    launchMode = $launchMode
    targetPath = $TargetPath
  }
}

function Restart-Component {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  if ($Component -eq "daemon") {
    Restart-DaemonComponent
    return [pscustomobject]@{
      launchMode = "service"
      serviceName = $DaemonServiceName
    }
  } else {
    return Restart-UiComponent -TargetPath $TargetPath
  }
}

function Test-ComponentHealth {
  param(
    [string]$Component,
    [string]$TargetPath,
    [string]$ExpectedSha256,
    [object[]]$Sidecars = @(),
    [string]$LaunchMode
  )

  if ($Component -eq "daemon") {
    return Test-DaemonHealth -ReadyFile $DaemonReadyFile -TimeoutSeconds $HealthTimeoutSeconds -PollSeconds $HealthPollSeconds
  }
  return Test-UiHealth -TargetPath $TargetPath -ExpectedSha256 $ExpectedSha256 -Sidecars $Sidecars -LaunchMode $LaunchMode -TimeoutSeconds $HealthTimeoutSeconds -PollSeconds $HealthPollSeconds
}

function Restore-ComponentBackups {
  param(
    $Spec,
    [string]$PrimaryBackupPath,
    [object[]]$SidecarStates
  )

  if (-not (Test-Path -LiteralPath $PrimaryBackupPath -PathType Leaf)) {
    throw "backup missing, cannot rollback: $PrimaryBackupPath"
  }
  foreach ($sidecarState in @($SidecarStates)) {
    if (-not (Test-Path -LiteralPath $sidecarState.backupPath -PathType Leaf)) {
      throw "backup missing, cannot rollback: $($sidecarState.backupPath)"
    }
  }

  Stop-ComponentForReplace -Component $Spec.component -TargetPath $Spec.targetPath
  Copy-Item -LiteralPath $PrimaryBackupPath -Destination $Spec.targetPath -Force
  Assert-Sha256 -Path $Spec.targetPath -ExpectedSha256 $Spec.originalSha256 | Out-Null
  foreach ($sidecarState in @($SidecarStates)) {
    Copy-Item -LiteralPath $sidecarState.backupPath -Destination $sidecarState.targetPath -Force
    Assert-Sha256 -Path $sidecarState.targetPath -ExpectedSha256 $sidecarState.originalSha256 | Out-Null
  }
  return Restart-Component -Component $Spec.component -TargetPath $Spec.targetPath
}

function ConvertTo-UiSidecarSpec {
  param($Item)

  if ([string]::IsNullOrWhiteSpace([string]$Item.artifactPath)) {
    throw "artifactPath is required for ui sidecar"
  }
  $requestedTargetPath = [string]$Item.targetPath
  if ([string]::IsNullOrWhiteSpace($requestedTargetPath)) {
    $requestedTargetPath = Get-UiSidecarTargetPath
  }

  return [pscustomobject]@{
    artifactPath = [string]$Item.artifactPath
    sha256 = Normalize-Sha256 -Value ([string]$Item.sha256)
    targetPath = Assert-AllowedUiSidecarTargetPath -TargetPath $requestedTargetPath
  }
}

function ConvertTo-ComponentSpec {
  param($Item)

  $componentName = [string]$Item.component
  if ($componentName -ne "daemon" -and $componentName -ne "ui") {
    throw "component must be daemon or ui"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Item.artifactPath)) {
    throw "artifactPath is required for $componentName"
  }
  $requestedTargetPath = [string]$Item.targetPath
  if ([string]::IsNullOrWhiteSpace($requestedTargetPath)) {
    $requestedTargetPath = Get-DefaultTargetPath -Component $componentName
  }
  $targetPath = Assert-AllowedTargetPath -Component $componentName -TargetPath $requestedTargetPath
  $normalizedSha256 = Normalize-Sha256 -Value ([string]$Item.sha256)
  $sidecars = @()
  if ($null -ne $Item.sidecars) {
    if ($componentName -ne "ui") {
      throw "sidecars are supported only for ui"
    }
    if (@($Item.sidecars).Count -gt 1) {
      throw "ui supports only the WebView2Loader.dll sidecar"
    }
    foreach ($sidecar in @($Item.sidecars)) {
      $sidecars += ConvertTo-UiSidecarSpec -Item $sidecar
    }
  }

  return [pscustomobject]@{
    component = $componentName
    artifactPath = [string]$Item.artifactPath
    sha256 = $normalizedSha256
    targetPath = $targetPath
    sidecars = $sidecars
  }
}

function Get-RequestedComponents {
  param([object]$ParsedManifest)

  if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $manifest = $ParsedManifest
    if ($null -eq $manifest) {
      throw "parsed manifest is required for manifest updates"
    }
    if ($null -eq $manifest.components) {
      throw "manifest must contain components array"
    }
    if (@($manifest.components).Count -eq 0) {
      throw "manifest components array must not be empty"
    }
    $specs = @()
    foreach ($component in @($manifest.components)) {
      $specs += ConvertTo-ComponentSpec -Item $component
    }
    return $specs
  }

  if (
    [string]::IsNullOrWhiteSpace($Component) -or
    [string]::IsNullOrWhiteSpace($ArtifactPath) -or
    [string]::IsNullOrWhiteSpace($Sha256)
  ) {
    throw "provide -ManifestPath or direct -Component -ArtifactPath -Sha256"
  }

  return @(
    ConvertTo-ComponentSpec -Item ([pscustomobject]@{
        component = $Component
        artifactPath = $ArtifactPath
        sha256 = $Sha256
        targetPath = $TargetPath
      })
  )
}

function New-ManifestSourceBinding {
  param(
    [string]$Path,
    [object]$Manifest,
    [object[]]$Components
  )

  $sourceCommit = ([string]$Manifest.sourceCommit).Trim().ToLowerInvariant()
  if ($sourceCommit -notmatch "^[0-9a-f]{40}$") {
    throw "manifest sourceCommit must be a full Git commit"
  }
  $boundComponents = @()
  foreach ($spec in @($Components)) {
    $boundSidecars = @()
    foreach ($sidecar in @($spec.sidecars)) {
      $boundSidecars += [pscustomobject][ordered]@{
        targetPath = $sidecar.targetPath
        sha256 = $sidecar.sha256
      }
    }
    $boundComponents += [pscustomobject][ordered]@{
      component = $spec.component
      targetPath = $spec.targetPath
      sha256 = $spec.sha256
      sidecars = $boundSidecars
    }
  }

  return [pscustomobject][ordered]@{
    schemaVersion = "managed-update-source-binding/v1"
    manifestSha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    sourceCommit = $sourceCommit
    updateId = [string]$Manifest.updateId
    components = $boundComponents
  }
}

function Write-Evidence {
  param(
    [string]$Path,
    [object]$Evidence
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Join-Path $env:TEMP ("vem-managed-update-evidence-{0}.json" -f (Get-Date -Format "yyyyMMddHHmmss"))
  }
  Ensure-Directory -Path (Split-Path -Parent $Path)
  $Evidence | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
  return $Path
}

function Install-Component {
  param($Spec)

  $startedAt = (Get-Date).ToUniversalTime().ToString("o")
  $replacementStarted = $false
  $result = [ordered]@{
    component = $Spec.component
    artifactPath = $Spec.artifactPath
    targetPath = $Spec.targetPath
    expectedSha256 = $Spec.sha256
    originalSha256 = $null
    startedAt = $startedAt
    backupPath = $null
    sidecars = @()
    installedSha256 = $null
    restart = $null
    healthCheck = $null
    rollbackAttempted = $false
    rollbackOk = $null
    ok = $false
    error = $null
  }

  foreach ($sidecar in @($Spec.sidecars)) {
    $result.sidecars += [pscustomobject][ordered]@{
      artifactPath = $sidecar.artifactPath
      targetPath = $sidecar.targetPath
      expectedSha256 = $sidecar.sha256
      originalSha256 = $null
      backupPath = $null
      installedSha256 = $null
    }
  }

  try {
    Assert-NoPlatformPaymentSecretFile -Path $Spec.artifactPath
    Assert-Sha256 -Path $Spec.artifactPath -ExpectedSha256 $Spec.sha256 | Out-Null
    if (-not (Test-Path -LiteralPath $Spec.targetPath -PathType Leaf)) {
      throw "target executable not found: $($Spec.targetPath)"
    }
    $result.originalSha256 = (Get-FileHash -LiteralPath $Spec.targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $Spec | Add-Member -NotePropertyName originalSha256 -NotePropertyValue $result.originalSha256 -Force

    for ($index = 0; $index -lt @($Spec.sidecars).Count; $index += 1) {
      $sidecar = @($Spec.sidecars)[$index]
      Assert-NoPlatformPaymentSecretFile -Path $sidecar.artifactPath
      Assert-Sha256 -Path $sidecar.artifactPath -ExpectedSha256 $sidecar.sha256 | Out-Null
      if (-not (Test-Path -LiteralPath $sidecar.targetPath -PathType Leaf)) {
        throw "target sidecar not found: $($sidecar.targetPath)"
      }
      $result.sidecars[$index].originalSha256 = (Get-FileHash -LiteralPath $sidecar.targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $backupPath = New-BackupPath -Component $Spec.component -TargetPath $Spec.targetPath -BackupRoot $BackupRoot
    Copy-Item -LiteralPath $Spec.targetPath -Destination $backupPath -Force
    $result.backupPath = $backupPath
    for ($index = 0; $index -lt @($Spec.sidecars).Count; $index += 1) {
      $sidecar = @($Spec.sidecars)[$index]
      $sidecarBackupPath = New-BackupPath -Component $Spec.component -TargetPath $sidecar.targetPath -BackupRoot $BackupRoot
      Copy-Item -LiteralPath $sidecar.targetPath -Destination $sidecarBackupPath -Force
      $result.sidecars[$index].backupPath = $sidecarBackupPath
    }

    $replacementStarted = $true
    Stop-ComponentForReplace -Component $Spec.component -TargetPath $Spec.targetPath
    Copy-Item -LiteralPath $Spec.artifactPath -Destination $Spec.targetPath -Force
    $installedSha256 = Assert-Sha256 -Path $Spec.targetPath -ExpectedSha256 $Spec.sha256
    $result.installedSha256 = $installedSha256
    for ($index = 0; $index -lt @($Spec.sidecars).Count; $index += 1) {
      $sidecar = @($Spec.sidecars)[$index]
      Copy-Item -LiteralPath $sidecar.artifactPath -Destination $sidecar.targetPath -Force
      $result.sidecars[$index].installedSha256 = Assert-Sha256 -Path $sidecar.targetPath -ExpectedSha256 $sidecar.sha256
    }

    $restart = Restart-Component -Component $Spec.component -TargetPath $Spec.targetPath
    $result.restart = $restart
    $health = Test-ComponentHealth -Component $Spec.component -TargetPath $Spec.targetPath -ExpectedSha256 $Spec.sha256 -Sidecars $Spec.sidecars -LaunchMode $restart.launchMode
    $result.healthCheck = $health
    if (-not [bool]$health.ok) {
      throw "post-update health check failed for $($Spec.component)"
    }

    $result.ok = $true
  } catch {
    $result.error = $_.Exception.Message
    if ($replacementStarted -and $null -ne $result.backupPath) {
      $result.rollbackAttempted = $true
      try {
        $rollbackSidecars = @()
        foreach ($sidecarState in @($result.sidecars)) {
          $rollbackSidecars += [pscustomobject]@{
            targetPath = $sidecarState.targetPath
            backupPath = $sidecarState.backupPath
            originalSha256 = $sidecarState.originalSha256
          }
        }
        $rollbackRestart = Restore-ComponentBackups -Spec $Spec -PrimaryBackupPath $result.backupPath -SidecarStates $rollbackSidecars
        $result.rollbackRestart = $rollbackRestart
        $rollbackHealthSidecars = @()
        foreach ($sidecarState in @($result.sidecars)) {
          $rollbackHealthSidecars += [pscustomobject]@{
            targetPath = $sidecarState.targetPath
            sha256 = $sidecarState.originalSha256
          }
        }
        $rollbackHealth = Test-ComponentHealth -Component $Spec.component -TargetPath $Spec.targetPath -ExpectedSha256 $result.originalSha256 -Sidecars $rollbackHealthSidecars -LaunchMode $rollbackRestart.launchMode
        $result.rollbackOk = [bool]$rollbackHealth.ok
        $result.rollbackHealthCheck = $rollbackHealth
      } catch {
        $result.rollbackOk = $false
        $result.rollbackError = $_.Exception.Message
      }
    }
  } finally {
    $result.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  return [pscustomobject]$result
}

Assert-Administrator

$manifestUpdateId = "direct-input"
$manifestForEvidence = $null
if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
  Assert-NoPlatformPaymentSecretFile -Path $ManifestPath
  $manifestForEvidence = Read-JsonFile -Path $ManifestPath
  Assert-NoPlatformPaymentSecrets -Value $manifestForEvidence -Path manifest
  if ([string]::IsNullOrWhiteSpace([string]$manifestForEvidence.updateId)) {
    throw "manifest updateId is required"
  }
  $manifestUpdateId = [string]$manifestForEvidence.updateId
}

$components = Get-RequestedComponents -ParsedManifest $manifestForEvidence
$sourceBinding = $null
if ($null -ne $manifestForEvidence) {
  $sourceBinding = New-ManifestSourceBinding -Path $ManifestPath -Manifest $manifestForEvidence -Components $components
}
$evidence = [ordered]@{
  ok = $false
  updateId = $manifestUpdateId
  manifestPath = $ManifestPath
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  sourceBinding = $sourceBinding
  components = @()
  evidencePath = $null
}

foreach ($spec in $components) {
  $componentResult = Install-Component -Spec $spec
  $evidence.components += $componentResult
  if (-not [bool]$componentResult.ok) {
    break
  }
}

$failedComponents = @($evidence.components | Where-Object { -not [bool]$_.ok })
$evidence.ok = @($evidence.components).Count -eq @($components).Count -and $failedComponents.Count -eq 0
$evidence.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
$writtenEvidencePath = Write-Evidence -Path $EvidencePath -Evidence ([pscustomobject]$evidence)
$evidence.evidencePath = $writtenEvidencePath
Write-Evidence -Path $writtenEvidencePath -Evidence ([pscustomobject]$evidence) | Out-Null

[pscustomobject]$evidence | ConvertTo-Json -Depth 30
if (-not [bool]$evidence.ok) {
  exit 1
}
