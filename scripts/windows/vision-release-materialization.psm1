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
  # Directory entries are permitted, but their type is checked before callers
  # skip extraction.  Leave a second trailing separator invalid instead of
  # silently normalizing an empty archive path segment.
  if ($Name -match '[\\/]$') { $Name = $Name.Substring(0, $Name.Length - 1) }
  $segments = $Name -split '[\\/]'
  if ($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_.EndsWith(".") -or $_.EndsWith(" ") -or $_ -match '^(?i:(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9]))(?:\..*)?$' }) {
    throw "Vision materialization failed: archive contains an unsafe or reserved device path"
  }
  return ($segments -join [IO.Path]::DirectorySeparatorChar)
}

function Assert-VisionRegularArchiveEntry([object]$Entry) {
  # ZIP stores Unix type bits in the upper word and DOS file attributes in the
  # lower word.  Never materialize a link/reparse entry as a regular file.
  $attributes = [Int64]$Entry.ExternalAttributes
  $unixType = (($attributes -shr 16) -band 0xF000)
  $dosAttributes = ($attributes -band 0xFFFF)
  if ($unixType -eq 0xA000 -or (($dosAttributes -band 0x0400) -ne 0)) {
    throw "Vision materialization failed: archive contains a symlink or reparse entry"
  }
}

function Assert-VisionNoReparseTraversal([string]$Path, [string]$Label) {
  Assert-VisionMaterializationPath $Path $Label
  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Vision materialization failed: $Label must not traverse a reparse point"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  return [IO.Path]::GetFullPath($Path)
}

function Assert-VisionContainedPath([string]$Root, [string]$Candidate, [string]$Label) {
  $canonicalRoot = (Assert-VisionNoReparseTraversal $Root "$Label root").TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ([string]::IsNullOrWhiteSpace($canonicalRoot)) { $canonicalRoot = [IO.Path]::GetFullPath($Root) }
  $canonicalCandidate = Assert-VisionNoReparseTraversal $Candidate $Label
  $prefix = $canonicalRoot + [IO.Path]::DirectorySeparatorChar
  if ($canonicalCandidate -cne $canonicalRoot -and -not $canonicalCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Vision materialization failed: $Label escapes the materialization destination"
  }
  return $canonicalCandidate
}

function New-VisionSafeDirectoryTree([string]$Path, [string]$Label, [string]$ContainmentRoot) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  if (-not [string]::IsNullOrWhiteSpace($ContainmentRoot)) {
    [void](Assert-VisionContainedPath $ContainmentRoot $fullPath $Label)
  } else {
    [void](Assert-VisionNoReparseTraversal $fullPath $Label)
  }
  $pending = [Collections.Generic.List[string]]::new()
  $cursor = $fullPath
  while (-not (Test-Path -LiteralPath $cursor)) {
    $pending.Add($cursor)
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) {
      throw "Vision materialization failed: $Label has no existing trusted ancestor"
    }
    $cursor = $parent
  }
  $existing = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
  if (-not $existing.PSIsContainer) { throw "Vision materialization failed: $Label ancestor is not a directory" }
  [void](Assert-VisionNoReparseTraversal $cursor $Label)
  for ($index = $pending.Count - 1; $index -ge 0; $index--) {
    $directory = $pending[$index]
    if (-not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    }
    $created = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $created.PSIsContainer) { throw "Vision materialization failed: $Label is not a directory" }
    [void](Assert-VisionNoReparseTraversal $directory $Label)
    if (-not [string]::IsNullOrWhiteSpace($ContainmentRoot)) {
      [void](Assert-VisionContainedPath $ContainmentRoot $directory $Label)
    }
  }
  return $fullPath
}

function Remove-VisionMaterializationDestination([string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination)) { return }
  try {
    [void](Assert-VisionNoReparseTraversal $Destination "materialization cleanup destination")
    Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction Stop
  } catch {
    # A failed extraction must never follow a substituted destination while
    # attempting best-effort cleanup.  The original failure remains primary.
  }
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
  [void](Assert-VisionNoReparseTraversal $Destination "destination")
  if (Test-Path -LiteralPath $Destination) { throw "Vision materialization failed: destination already exists" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = $null
  $archive = $null
  try {
    $stream = Get-VisionVerifiedCandidateStream $CandidatePath $ExpectedDigest $Descriptor
    [void](New-VisionSafeDirectoryTree $Destination "destination" $null)
    [void](Assert-VisionNoReparseTraversal $Destination "destination")
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt [Int64]$ExtractionPolicy.MaxArchiveEntries) {
      throw "Vision materialization failed: archive entry count is unsafe"
    }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $expanded = [Int64]0; $compressed = [Int64]0
    foreach ($entry in $archive.Entries) {
      $relative = Get-VisionSafeArchivePath $entry.FullName
      Assert-VisionRegularArchiveEntry $entry
      if ($entry.FullName.EndsWith("/")) { continue }
      if (-not $seen.Add($relative)) { throw "Vision materialization failed: archive has case-colliding paths" }
      if ($entry.Length -lt 0 -or $entry.CompressedLength -lt 0) { throw "Vision materialization failed: archive lengths are invalid" }
      $expanded += $entry.Length; $compressed += $entry.CompressedLength
      if ($expanded -gt [Int64]$ExtractionPolicy.MaxExpandedBytes -or ($compressed -gt 0 -and $expanded -gt ($compressed * [Int64]$ExtractionPolicy.MaxExpansionRatio))) {
        throw "Vision materialization failed: archive expansion budget is unsafe"
      }
    }
    foreach ($entry in $archive.Entries) {
      $relative = Get-VisionSafeArchivePath $entry.FullName
      Assert-VisionRegularArchiveEntry $entry
      if ($entry.FullName.EndsWith("/")) { continue }
      $target = Assert-VisionContainedPath $Destination (Join-Path $Destination $relative) "archive entry target"
      $parent = Split-Path -Parent $target
      [void](New-VisionSafeDirectoryTree $parent "archive entry parent" $Destination)
      [void](Assert-VisionContainedPath $Destination $target "archive entry target")
      $input = $entry.Open(); $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      $written = Get-Item -LiteralPath $target -Force -ErrorAction Stop
      if (($written.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $written.PSIsContainer -or $written.Length -ne $entry.Length) { throw "Vision materialization failed: archive entry was extracted incompletely" }
      [void](Assert-VisionContainedPath $Destination $target "archive entry target")
    }
    return [pscustomobject]@{ bundleDigest=$ExpectedDigest; destination=$Destination; files=@($archive.Entries | Where-Object { -not $_.FullName.EndsWith("/") } | ForEach-Object { $_.FullName }) }
  } catch {
    Remove-VisionMaterializationDestination $Destination
    throw
  } finally {
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

Export-ModuleMember -Function Invoke-VisionReleaseMaterialization
