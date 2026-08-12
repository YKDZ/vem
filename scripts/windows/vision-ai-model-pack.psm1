Set-StrictMode -Version 2.0

function Get-VemRegularDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute directory: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse directory: $Path"
  }
  return [IO.Path]::GetFullPath($item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-VemDirectoryContained([string]$Path, [string]$Authority, [string]$Label) {
  $normalizedAuthority = Get-VemRegularDirectory $Authority "$Label authority root"
  $normalizedPath = Get-VemRegularDirectory $Path $Label
  $prefix = $normalizedAuthority + [IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by $normalizedAuthority"
  }
  $cursor = $normalizedAuthority
  foreach ($component in $normalizedPath.Substring($prefix.Length).Split([IO.Path]::DirectorySeparatorChar)) {
    $cursor = Join-Path $cursor $component
    [void](Get-VemRegularDirectory $cursor $Label)
  }
  return $normalizedPath
}

function Assert-VemOfficialAiModelPack {
  param(
    [Parameter(Mandatory = $true)][string]$ModelRoot,
    [Parameter(Mandatory = $true)][string]$VisionAppDirectory,
    [Parameter(Mandatory = $true)][string]$VisionDataDirectory
  )
  $normalizedRoot = Assert-VemDirectoryContained $ModelRoot (Join-Path $VisionDataDirectory "ai-model-packs\packs") "Vision AI model pack root"
  $descriptorPath = Join-Path $VisionAppDirectory "_internal\official-ai-model-pack-descriptor.json"
  if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { throw "bundled official AI model descriptor is missing: $descriptorPath" }
  $manifestPath = Join-Path $normalizedRoot "ai-model-manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "AI model manifest is missing: $manifestPath" }
  foreach ($path in @($descriptorPath, $manifestPath)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "AI model descriptor must be a regular non-reparse file: $path" }
  }
  $descriptorBytes = [IO.File]::ReadAllBytes($descriptorPath)
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
  $matches = $descriptorBytes.Length -eq $manifestBytes.Length
  for ($index = 0; $matches -and $index -lt $descriptorBytes.Length; $index += 1) {
    if ($descriptorBytes[$index] -ne $manifestBytes[$index]) { $matches = $false }
  }
  if (-not $matches) { throw "AI model manifest does not match the bundled official descriptor" }
  try { $descriptor = [Text.Encoding]::UTF8.GetString($descriptorBytes) | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "bundled official AI model descriptor is not valid JSON: $($_.Exception.Message)" }
  if ([string]$descriptor.schemaVersion -cne "vem-official-ai-model-pack-descriptor/v2" -or
      $descriptor.totalByteSize -isnot [long] -or [long]$descriptor.totalByteSize -lt 1 -or @($descriptor.files).Count -lt 1) {
    throw "bundled official AI model descriptor has an unsupported identity"
  }
  $expectedPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $files = New-Object Collections.Generic.List[object]
  $totalBytes = [long]0
  foreach ($file in @($descriptor.files)) {
    $relativePath = [string]$file.path
    if ([string]::IsNullOrWhiteSpace($relativePath) -or [IO.Path]::IsPathRooted($relativePath) -or
        $relativePath.Contains("\") -or $relativePath.Contains(":") -or
        @($relativePath.Split("/") | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0 -or
        -not $expectedPaths.Add($relativePath)) {
      throw "bundled official AI model descriptor contains an unsafe or duplicate path"
    }
    $candidatePath = Join-Path $normalizedRoot ($relativePath.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $candidate = Get-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
    if ($candidate.PSIsContainer -or (($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "AI model file must be regular and non-reparse: $relativePath" }
    $expectedSize = [long]$file.byteSize
    if ($file.byteSize -isnot [long] -or $expectedSize -lt 1 -or [long]$candidate.Length -ne $expectedSize) { throw "AI model file size mismatch: $relativePath" }
    $expectedSha = [string]$file.sha256
    $actualSha = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    if ($expectedSha -cnotmatch '^[0-9a-f]{64}$' -or $actualSha -cne $expectedSha) { throw "AI model file digest mismatch: $relativePath" }
    $totalBytes += $expectedSize
    $files.Add([pscustomobject]@{ byteSize = $expectedSize; path = $relativePath; sha256 = $actualSha }) | Out-Null
  }
  if ($totalBytes -ne [long]$descriptor.totalByteSize) { throw "AI model descriptor totalByteSize mismatch" }
  $entries = @(Get-ChildItem -LiteralPath $normalizedRoot -Recurse -Force -ErrorAction Stop)
  if (@($entries | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw "AI model pack contains a reparse entry" }
  $actualPaths = @($entries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    $_.FullName.Substring($normalizedRoot.Length + 1).Replace("\", "/")
  } | Where-Object { $_ -cne "ai-model-manifest.json" } | Sort-Object -CaseSensitive)
  $expectedSorted = @($expectedPaths | Sort-Object -CaseSensitive)
  if (($actualPaths -join "`n") -cne ($expectedSorted -join "`n")) { throw "AI model pack file set does not match the bundled official descriptor" }
  return [pscustomobject]@{
    descriptorBytes = $descriptorBytes
    files = @($files | Sort-Object path -CaseSensitive)
    manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    modelRoot = $normalizedRoot
  }
}

Export-ModuleMember -Function Assert-VemOfficialAiModelPack
