function powerShellLiteral(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

export function factoryOobePrivacySuppressionScript({
  policyPath = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\OOBE",
  statePath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\OOBE",
} = {}) {
  return `$oobePolicyPath = ${powerShellLiteral(policyPath, "OOBE policy path")}
if (-not (Test-Path -LiteralPath $oobePolicyPath -PathType Container)) {
  New-Item -Path $oobePolicyPath -ItemType Directory -Force | Out-Null
}
New-ItemProperty -Path $oobePolicyPath -Name DisablePrivacyExperience -Value 1 -PropertyType DWord -Force | Out-Null
$oobeStatePath = ${powerShellLiteral(statePath, "OOBE state path")}
if (-not (Test-Path -LiteralPath $oobeStatePath -PathType Container)) {
  New-Item -Path $oobeStatePath -ItemType Directory -Force | Out-Null
}
New-ItemProperty -Path $oobeStatePath -Name PrivacyConsentStatus -Value 1 -PropertyType DWord -Force | Out-Null`;
}
