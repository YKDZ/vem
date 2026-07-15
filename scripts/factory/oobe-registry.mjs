function powerShellLiteral(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function factoryOobePrivacySuppressionScript({
  policyPath = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\OOBE",
  statePath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE",
  defaultUserHivePath = "C:\\Users\\Default\\NTUSER.DAT",
  defaultUserHiveName = "VEM_FACTORY_DEFAULT_USER",
} = {}) {
  const defaultUserHiveRegPath = `HKU\\${defaultUserHiveName}`;
  const defaultUserPdePath = `Registry::HKEY_USERS\\${defaultUserHiveName}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CloudExperienceHost\\Intent\\PersonalDataExport`;
  return `$oobePolicyPath = ${powerShellLiteral(policyPath, "OOBE policy path")}
if (-not (Test-Path -LiteralPath $oobePolicyPath -PathType Container)) {
  New-Item -Path $oobePolicyPath -ItemType Directory -Force | Out-Null
}
New-ItemProperty -Path $oobePolicyPath -Name DisablePrivacyExperience -Value 1 -PropertyType DWord -Force | Out-Null
$oobeStatePath = ${powerShellLiteral(statePath, "OOBE state path")}
if (-not (Test-Path -LiteralPath $oobeStatePath -PathType Container)) {
  New-Item -Path $oobeStatePath -ItemType Directory -Force | Out-Null
}
New-ItemProperty -Path $oobeStatePath -Name PrivacyConsentStatus -Value 1 -PropertyType DWord -Force | Out-Null
$defaultUserHivePath = ${powerShellLiteral(
    defaultUserHivePath,
    "Default User hive path",
  )}
$defaultUserHiveRegPath = ${powerShellLiteral(
    defaultUserHiveRegPath,
    "Default User hive registry path",
  )}
$defaultUserPdePath = ${powerShellLiteral(
    defaultUserPdePath,
    "Default User PersonalDataExport path",
  )}
$defaultUserHiveLoaded = $false
try {
  & reg.exe load $defaultUserHiveRegPath $defaultUserHivePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'VEM Factory could not load the Default User registry hive for OOBE suppression' }
  $defaultUserHiveLoaded = $true
  if (-not (Test-Path -LiteralPath $defaultUserPdePath -PathType Container)) {
    New-Item -Path $defaultUserPdePath -ItemType Directory -Force | Out-Null
  }
  New-ItemProperty -Path $defaultUserPdePath -Name PDEShown -Value 1 -PropertyType DWord -Force | Out-Null
} finally {
  if ($defaultUserHiveLoaded) {
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    & reg.exe unload $defaultUserHiveRegPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'VEM Factory could not unload the Default User registry hive after OOBE suppression' }
  }
}`;
}
