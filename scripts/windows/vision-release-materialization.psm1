Set-StrictMode -Version Latest

function Assert-VisionMaterializationPath([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00-\x1f]') {
    throw "Vision materialization failed: $Label is required"
  }
}

function Get-VisionSafeArchivePath([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -match '^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)|(^|[\\/])[^\\/]*:|[\x00-\x1f]') {
    throw "Vision materialization failed: archive contains an unsafe path"
  }
  $segments = $Name -split '[\\/]'
  if ($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_.EndsWith(".") -or $_.EndsWith(" ") -or $_ -match '^(?i:(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9]))(?:\..*)?$' }) {
    throw "Vision materialization failed: archive contains an unsafe or reserved device path"
  }
  return ($segments -join [IO.Path]::DirectorySeparatorChar)
}

function Get-VisionVerifiedCandidateStream {
  param([string]$CandidatePath, [string]$ExpectedDigest, [object]$Descriptor)

  Assert-VisionMaterializationPath $CandidatePath "candidate path"
  if ($ExpectedDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $ExpectedDigest -cne [string]$Descriptor.bundle.digest) {
    throw "Vision materialization failed: expected digest does not match descriptor"
  }
  $item = Get-Item -LiteralPath $CandidatePath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Vision materialization failed: candidate must be a regular non-reparse file"
  }
  if ($item.Length -ne [Int64]$Descriptor.bundle.bytes) {
    throw "Vision materialization failed: candidate byte count does not match descriptor"
  }
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $buffer = [byte[]]::new(1048576); $readTotal = [Int64]0
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $hash.TransformBlock($buffer, 0, $count, $null, 0) | Out-Null; $readTotal += $count
    }
    $hash.TransformFinalBlock([byte[]]::new(0), 0, 0) | Out-Null
    $actual = "sha256:" + ([BitConverter]::ToString($hash.Hash)).Replace("-", "").ToLowerInvariant()
    if ($readTotal -ne $item.Length -or $actual -cne $ExpectedDigest) {
      throw "Vision materialization failed: candidate exact bytes do not match expected digest"
    }
    $stream.Position = 0
    return $stream
  } catch { $stream.Dispose(); throw } finally { $hash.Dispose() }
}

function Invoke-VisionReleaseMaterialization {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$ExpectedDigest,
    [Parameter(Mandatory = $true)][object]$Descriptor,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][hashtable]$ExtractionPolicy
  )

  foreach ($name in @("MaxArchiveEntries", "MaxExpandedBytes", "MaxExpansionRatio")) {
    if (-not $ExtractionPolicy.ContainsKey($name) -or [Int64]$ExtractionPolicy[$name] -lt 1) {
      throw "Vision materialization failed: extraction policy $name is invalid"
    }
  }
  Assert-VisionMaterializationPath $Destination "destination"
  if (Test-Path -LiteralPath $Destination) { throw "Vision materialization failed: destination already exists" }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $stream = Get-VisionVerifiedCandidateStream $CandidatePath $ExpectedDigest $Descriptor
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt [Int64]$ExtractionPolicy.MaxArchiveEntries) {
      throw "Vision materialization failed: archive entry count is unsafe"
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expanded = [Int64]0; $compressed = [Int64]0
    foreach ($entry in $archive.Entries) {
      $relative = Get-VisionSafeArchivePath $entry.FullName
      if ($entry.FullName.EndsWith("/")) { continue }
      if (-not $seen.Add($relative)) { throw "Vision materialization failed: archive has case-colliding paths" }
      if ($entry.Length -lt 0 -or $entry.CompressedLength -lt 0) { throw "Vision materialization failed: archive lengths are invalid" }
      $expanded += $entry.Length; $compressed += $entry.CompressedLength
      if ($expanded -gt [Int64]$ExtractionPolicy.MaxExpandedBytes -or ($compressed -gt 0 -and $expanded -gt ($compressed * [Int64]$ExtractionPolicy.MaxExpansionRatio))) {
        throw "Vision materialization failed: archive expansion budget is unsafe"
      }
    }
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith("/")) { continue }
      $target = Join-Path $Destination (Get-VisionSafeArchivePath $entry.FullName)
      $parent = Split-Path -Parent $target; New-Item -ItemType Directory -Path $parent -Force | Out-Null
      $input = $entry.Open(); $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      if ((Get-Item -LiteralPath $target -Force).Length -ne $entry.Length) { throw "Vision materialization failed: archive entry was extracted incompletely" }
    }
    return [pscustomobject]@{ bundleDigest=$ExpectedDigest; destination=$Destination; files=@($archive.Entries | Where-Object { -not $_.FullName.EndsWith("/") } | ForEach-Object { $_.FullName }) }
  } catch {
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    throw
  } finally { $archive.Dispose(); $stream.Dispose() }
}

Export-ModuleMember -Function Invoke-VisionReleaseMaterialization
