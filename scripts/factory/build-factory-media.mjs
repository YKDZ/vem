import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { canonicalJson, validateFactoryManifest } from "./factory-manifest.mjs";
import {
  verifyAssetEvidence,
  verifyAuthenticodeSignature,
} from "./verify-asset-evidence.mjs";
import {
  validateVisionReleaseTrustPolicy,
  verifySignedVisionReleaseEvidence,
} from "./vision-release.mjs";

const run = promisify(execFile);
const FIXED_EPOCH_SECONDS = 315_532_800;
const SECTOR_BYTES = 2048;
const UDF_VOLUME_SET_ID = "VEM_FACTORY_SET";
const ISO_BUILDER_LOCK = join(tmpdir(), "vem-factory-iso-builder.lock");
const WINDOWS_SERVICED_ISO = "windows-serviced-iso";
const FACTORY_MEDIA_DIRECTORY = "VEM/Factory";
const PREPARE_FACTORY_RUNTIME_PARAMETERS = [
  "DaemonArtifactPath",
  "DaemonSha256",
  "MachineUiArtifactPath",
  "MachineUiSha256",
  "EnvironmentName",
  "ProvisioningEndpoint",
  "MqttUrl",
  "HardwareMode",
  "HardwareModel",
  "TopologyIdentity",
  "TopologyVersion",
  "ExpectedDisplayWidth",
  "ExpectedDisplayHeight",
  "ExpectedDisplayOrientation",
  "ExpectedKioskUser",
  "ExpectedMaintenanceUser",
  "ExpectedAutoLogonUser",
  "ExpectedKioskShell",
  "TargetLayoutVersion",
  "FactoryProfile",
  "PersonalizationMediaPath",
  "FactoryMediaRoot",
  "VisionConfigurationSourcePath",
  "OpenSshPackagePath",
  "OpenSshPackageSource",
  "OpenSshPackageVersion",
  "OpenSshPackageSha256",
  "OpenSshApprovedSignerThumbprint",
  "OpenSshApprovedRootThumbprint",
  "WireGuardPackagePath",
  "WireGuardPackageSource",
  "WireGuardPackageVersion",
  "WireGuardPackageSha256",
  "WireGuardApprovedSignerThumbprint",
  "WireGuardApprovedRootThumbprint",
  "MaintenanceSshCaPublicKeyPath",
  "MaintenanceSshCaPublicKeySha256",
  "MaintenanceRunnerSourceAllowlist",
  "MaintenanceMaintainerSourceAllowlist",
  "MaintenanceWireGuardInterfaceAlias",
  "MaintenanceWireGuardListenAddress",
  "ResetExistingVemState",
];
const EFFECTIVE_REPOSITORY_INPUT_ROLES = [
  "repo-module:factory/build-factory-media.mjs",
  "repo-module:factory/content-addressed-store.mjs",
  "repo-module:factory/factory-manifest.mjs",
  "repo-module:factory/verify-asset-evidence.mjs",
  "repo-module:factory/vision-release.mjs",
  "repo-schema:public/factory-manifest-v1.schema.json",
].sort();
const EFFECTIVE_IMPLEMENTATION_FILES = [
  "prepare-factory-runtime.ps1",
  "verify-factory-runtime.ps1",
  "setup-scheduled-tasks.ps1",
  "verify-kiosk-lockdown.ps1",
  "verify-vem-runtime.ps1",
  "apply-managed-update.ps1",
  "provision-vision-factory-release.ps1",
  "install-vision-release.ps1",
];
const VISION_DOCUMENT_ROLES = [
  "descriptor",
  "attestation",
  "sbom",
  "provenance",
  "conformance",
  "approval",
];

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function collectImportedModuleInputs(entry) {
  const inputs = new Map();
  async function visit(url) {
    const bytes = await readFile(url);
    const relative = url.pathname.split("/scripts/")[1];
    if (inputs.has(relative)) return;
    inputs.set(relative, {
      role: `repo-module:${relative}`,
      digest: hashBytes(bytes),
    });
    const source = bytes.toString("utf8");
    const imports = [...source.matchAll(/from\s+["'](\.[^"']+\.mjs)["']/g)].map(
      (match) => match[1],
    );
    for (const specifier of imports) await visit(new URL(specifier, url));
  }
  await visit(entry);
  const schemaBytes = await readFile(
    new URL("../../public/factory-manifest-v1.schema.json", import.meta.url),
  );
  inputs.set("public/factory-manifest-v1.schema.json", {
    role: "repo-schema:public/factory-manifest-v1.schema.json",
    digest: hashBytes(schemaBytes),
  });
  return [...inputs.values()];
}

function assetReferences(manifest) {
  return [manifest.source.windowsMedia, ...manifest.assets].sort(
    (left, right) => left.role.localeCompare(right.role),
  );
}

export function expectedFactoryEffectiveInputRoles(manifest) {
  return [
    "manifest:factory-manifest",
    ...assetReferences(manifest).map((asset) => `asset:${asset.role}`),
    "tool:builder-image",
    "tool:iso-builder",
    "tool:wimlib",
    ...EFFECTIVE_REPOSITORY_INPUT_ROLES,
    ...EFFECTIVE_IMPLEMENTATION_FILES.map((name) => `repo-script:${name}`),
    "vision-verifier",
    "vision-repository-trust",
    "vision-factory-trust",
    ...VISION_DOCUMENT_ROLES.map((role) => `vision-document:${role}`),
    ...VISION_DOCUMENT_ROLES.map((role) => `vision-signature:${role}`),
  ].sort();
}

function outputName(manifest) {
  return manifest.outputPolicy.isoFileName.replace(
    "{manifestId}",
    manifest.manifestId.slice("sha256:".length),
  );
}

function findVisionReleaseAsset(manifest) {
  const assets = manifest.assets.filter(
    ({ role }) => role === "vision-release",
  );
  if (assets.length !== 1) {
    throw new Error(
      "Factory Manifest must contain exactly one Vision release asset",
    );
  }
  return assets[0];
}

function approvedVisionIdentities({
  repositoryTrustedRoots,
  factoryTrustedRoots,
}) {
  if (!repositoryTrustedRoots || !factoryTrustedRoots) {
    throw new Error(
      "Vision release verification requires repository and factory trusted roots",
    );
  }
  const roles = [
    "descriptor",
    "attestation",
    "sbom",
    "provenance",
    "conformance",
    "approval",
  ];
  return Object.fromEntries(
    roles.map((role) => {
      const repository = repositoryTrustedRoots[role];
      const factory = factoryTrustedRoots[role];
      if (
        !Array.isArray(repository) ||
        repository.length === 0 ||
        !Array.isArray(factory) ||
        factory.length === 0
      ) {
        throw new Error(
          `repository and factory trusted roots must approve Vision ${role}`,
        );
      }
      const jointlyApproved = repository.filter((identity) =>
        factory.includes(identity),
      );
      if (jointlyApproved.length === 0) {
        throw new Error(
          `repository and factory trusted roots have no common Vision ${role} identity`,
        );
      }
      return [role, [...new Set(jointlyApproved)]];
    }),
  );
}

export function verifyManifestVisionReleaseEvidence({
  manifest,
  deliveryUnit,
  repositoryTrustedRoots,
  factoryTrustedRoots,
}) {
  if (!deliveryUnit || typeof deliveryUnit !== "object") {
    throw new Error("Vision release evidence delivery unit is required");
  }
  const selectedAsset = findVisionReleaseAsset(manifest);
  return verifySignedVisionReleaseEvidence({
    manifestAsset: {
      role: selectedAsset.role,
      digest: selectedAsset.digest,
      version: selectedAsset.version,
      release: selectedAsset.release,
    },
    documents: deliveryUnit.documents,
    signatures: deliveryUnit.signatures,
    approvedIdentities: approvedVisionIdentities({
      repositoryTrustedRoots,
      factoryTrustedRoots,
    }),
  });
}

async function readPinnedExecutable(path, tool) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error("ISO builder must not be a symlink");
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || (fileStat.mode & 0o111) === 0) {
      throw new Error("ISO builder must be an executable regular file");
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      throw new Error("ISO builder read was incomplete");
    const digest = hashBytes(bytes);
    if (digest !== tool.digest) {
      throw new Error(
        `executed ISO builder digest mismatch: expected ${tool.digest}, got ${digest}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readPinnedVisionVerifier(path) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("Vision evidence verifier must not be a symlink");
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      (fileStat.mode & 0o111) === 0 ||
      fileStat.size < 1
    ) {
      throw new Error(
        "Vision evidence verifier must be an executable regular file",
      );
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) {
      throw new Error("Vision evidence verifier read was incomplete");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function createVisionFactoryTrustMaterial({
  repositoryTrustedRoots,
  factoryTrustedRoots,
  verifierBytes,
}) {
  const approvedIdentities = approvedVisionIdentities({
    repositoryTrustedRoots,
    factoryTrustedRoots,
  });
  const policy = validateVisionReleaseTrustPolicy({
    schemaVersion: "vem-vision-release-trust-policy/v1",
    kind: "vision-release-trust-policy",
    verifierDigest: hashBytes(verifierBytes),
    approvedIdentities,
  });
  const policyBytes = Buffer.from(canonicalJson(policy));
  const anchor = {
    schemaVersion: "vem-factory-vision-trust-anchor/v1",
    kind: "factory-vision-trust-anchor",
    trustPolicyDigest: hashBytes(policyBytes),
    verifierDigest: policy.verifierDigest,
  };
  return {
    anchorBytes: Buffer.from(canonicalJson(anchor)),
    policyBytes,
    verifierBytes,
  };
}

function visionFactoryProvisioningManifest(files) {
  return {
    schemaVersion: "vem-vision-factory-provisioning/v1",
    kind: "vision-factory-provisioning",
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, bytes]) => [path, hashBytes(bytes)]),
    ),
  };
}

function bootImageBytes() {
  const bytes = Buffer.alloc(2048);
  bytes.set([0xfa, 0xeb, 0xfd], 0);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

async function hashFile(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

export async function assertWimMagic(path, label) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const magic = Buffer.alloc(8);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (
      bytesRead !== magic.length ||
      !magic.equals(Buffer.from([0x4d, 0x53, 0x57, 0x49, 0x4d, 0, 0, 0]))
    ) {
      throw new Error(`${label} is not a WIM image`);
    }
  } finally {
    await handle.close();
  }
}

function wimXmlValue(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

function decodeWimXml(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])))
    return bytes.subarray(2).toString("utf16le");
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

async function inspectSelectedWindowsImage({
  executable,
  imagePath,
  expected,
  workDirectory,
}) {
  await assertWimMagic(imagePath, "Windows install image");
  const result = await run(
    executable,
    ["info", imagePath, String(expected.index), "--xml"],
    {
      cwd: workDirectory,
      env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const xml = `${decodeWimXml(result.stdout)}\n${decodeWimXml(result.stderr)}`;
  const index = Number(/<IMAGE\s+INDEX="(\d+)"/i.exec(xml)?.[1]);
  const edition = wimXmlValue(xml, "EDITIONID") ?? wimXmlValue(xml, "NAME");
  const digest = await hashFile(imagePath);
  if (index !== expected.index)
    throw new Error(
      `selected Windows image index ${expected.index} does not exist`,
    );
  if (edition !== expected.edition)
    throw new Error(
      `selected Windows image edition mismatch: expected ${expected.edition}, got ${edition ?? "missing"}`,
    );
  if (digest !== expected.digest)
    throw new Error(
      `selected Windows image digest mismatch: expected ${expected.digest}, got ${digest}`,
    );
  return { index, edition, digest };
}

function factoryAccountForProfile(profile) {
  return profile === "production" ? "Admin" : "YKDZ";
}

function autounattendXml(profile, imageIndex) {
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration><Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition><CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Size>57344</Size></CreatePartition><CreatePartition wcm:action="add"><Order>4</Order><Type>Primary</Type><Extend>true</Extend><TypeID>DE94BBA4-06D1-4D40-A16A-BFD50179D6AC</TypeID></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition><ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>4</PartitionID><Format>NTFS</Format><Label>Recovery</Label></ModifyPartition></ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Key>/IMAGE/INDEX</Key><Value>${imageIndex}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous><RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><Path>${specializeBootstrapCommand()}</Path><Description>Register VEM Factory SYSTEM bootstrap</Description></RunSynchronousCommand></RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideLocalAccountScreen>true</HideLocalAccountScreen><ProtectYourPC>3</ProtectYourPC></OOBE>
      <RegisteredOwner>VEM Factory</RegisteredOwner>
      <RegisteredOrganization>VEM</RegisteredOrganization>
      <TimeZone>UTC</TimeZone>
      <FirstLogonCommands><SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><CommandLine>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\Factory\\bootstrap-factory-runtime.ps1 -MediaRoot C:\\VEM\\Factory</CommandLine><Description>VEM Factory bootstrap fallback</Description></SynchronousCommand></FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}

function specializeBootstrapCommand() {
  return "cmd.exe /c C:\\VEM\\Factory\\register-factory-bootstrap.cmd";
}

function registerBootstrapCmd() {
  return '@echo off\r\nschtasks.exe /Create /TN VemFactoryBootstrap /RU SYSTEM /SC ONSTART /RL HIGHEST /F /TR "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\Factory\\bootstrap-factory-runtime.ps1 -MediaRoot C:\\VEM\\Factory"\r\nif errorlevel 1 exit /b 1\r\nexit /b 0\r\n';
}

function factoryPreparationDescriptor(manifest, resolvedAssets) {
  const asset = (role) => {
    const reference = resolvedAssets.find(
      (entry) => entry.reference.role === role,
    )?.reference;
    if (!reference) throw new Error(`Factory preparation is missing ${role}`);
    return {
      path: `assets/${reference.mediaFileName}`,
      sha256: reference.digest.slice(7),
    };
  };
  const preparation = manifest.factoryPreparation;
  return {
    schemaVersion: "vem-factory-preparation-descriptor/v1",
    kind: "factory-preparation-descriptor",
    profile: manifest.profile,
    parameters: {
      environmentName: preparation.environmentName,
      provisioningEndpoint: preparation.provisioningEndpoint,
      mqttUrl: preparation.mqttUrl,
      hardware: preparation.hardware,
      display: preparation.display,
      accounts: preparation.accounts,
      expectedKioskShell: preparation.expectedKioskShell,
      targetLayoutVersion: preparation.targetLayoutVersion,
      maintenance: preparation.maintenance,
    },
    assets: {
      daemon: asset("vem-daemon"),
      machineUi: asset("vem-machine-ui"),
      webview2Loader: asset("webview2-loader"),
      openSsh: asset("openssh-installer"),
      wireGuard: asset("wireguard-installer"),
      maintenanceSshCa: asset("maintenance-ssh-ca-public-key"),
      visionConfiguration: asset("vision-configuration"),
    },
  };
}

export function factoryPreparationSplat(
  descriptor,
  mediaRoot,
  personalizationPath,
) {
  const path = (asset) =>
    `${mediaRoot}\\${descriptor.assets[asset].path.replaceAll("/", "\\")}`;
  const parameters = descriptor.parameters;
  return {
    DaemonArtifactPath: path("daemon"),
    DaemonSha256: descriptor.assets.daemon.sha256,
    MachineUiArtifactPath: path("machineUi"),
    MachineUiSha256: descriptor.assets.machineUi.sha256,
    EnvironmentName: parameters.environmentName,
    ProvisioningEndpoint: parameters.provisioningEndpoint,
    MqttUrl: parameters.mqttUrl,
    HardwareMode: parameters.hardware.mode,
    HardwareModel: parameters.hardware.model,
    TopologyIdentity: parameters.hardware.topologyIdentity,
    TopologyVersion: parameters.hardware.topologyVersion,
    ExpectedDisplayWidth: parameters.display.width,
    ExpectedDisplayHeight: parameters.display.height,
    ExpectedDisplayOrientation: parameters.display.orientation,
    ExpectedKioskUser: parameters.accounts.kioskUser,
    ExpectedMaintenanceUser: parameters.accounts.maintenanceUser,
    ExpectedAutoLogonUser: parameters.accounts.autoLogonUser,
    ExpectedKioskShell: parameters.expectedKioskShell,
    TargetLayoutVersion: parameters.targetLayoutVersion,
    FactoryProfile: descriptor.profile,
    PersonalizationMediaPath: personalizationPath,
    FactoryMediaRoot: mediaRoot,
    VisionConfigurationSourcePath: path("visionConfiguration"),
    OpenSshPackagePath: path("openSsh"),
    OpenSshPackageSource: "local-pinned",
    OpenSshPackageVersion: parameters.maintenance.openSsh.version,
    OpenSshPackageSha256: descriptor.assets.openSsh.sha256,
    OpenSshApprovedSignerThumbprint:
      parameters.maintenance.openSsh.approvedSignerThumbprint,
    OpenSshApprovedRootThumbprint:
      parameters.maintenance.openSsh.approvedRootThumbprint,
    WireGuardPackagePath: path("wireGuard"),
    WireGuardPackageSource: "local-pinned",
    WireGuardPackageVersion: parameters.maintenance.wireGuard.version,
    WireGuardPackageSha256: descriptor.assets.wireGuard.sha256,
    WireGuardApprovedSignerThumbprint:
      parameters.maintenance.wireGuard.approvedSignerThumbprint,
    WireGuardApprovedRootThumbprint:
      parameters.maintenance.wireGuard.approvedRootThumbprint,
    MaintenanceSshCaPublicKeyPath: path("maintenanceSshCa"),
    MaintenanceSshCaPublicKeySha256: descriptor.assets.maintenanceSshCa.sha256,
    MaintenanceRunnerSourceAllowlist:
      parameters.maintenance.runnerSourceAllowlist,
    MaintenanceMaintainerSourceAllowlist:
      parameters.maintenance.maintainerSourceAllowlist,
    MaintenanceWireGuardInterfaceAlias:
      parameters.maintenance.wireGuardInterfaceAlias,
    MaintenanceWireGuardListenAddress:
      parameters.maintenance.wireGuardListenAddress,
    ResetExistingVemState: true,
  };
}

function factoryBootstrapScript(profile) {
  return `param([Parameter(Mandatory = $true)][string]$MediaRoot)
$ErrorActionPreference = 'Stop'
$statusPath = 'C:\\ProgramData\\VEM\\factory\\bootstrap-status.json'
$personalizationPath = 'C:\\ProgramData\\VEM\\factory\\one-time-personalization.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statusPath) | Out-Null
function Write-Status([string]$State, [string]$Reason) {
  [IO.File]::WriteAllText($statusPath, (@{ schemaVersion = 'vem-factory-bootstrap/v1'; state = $State; reason = $Reason; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}
try {
  if (-not (Test-Path -LiteralPath $personalizationPath -PathType Leaf)) { throw 'one-time host personalization channel is unavailable' }
  $descriptorPath = Join-Path $MediaRoot 'factory-preparation.json'
  $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
  function Assert-ExactProperties($Value, [string[]]$Expected, [string]$Label) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $actual $wanted)) { throw "$Label has an invalid shape" }
  }
  Assert-ExactProperties $descriptor @('schemaVersion','kind','profile','parameters','assets') 'Factory preparation descriptor'
  if ($descriptor.schemaVersion -cne 'vem-factory-preparation-descriptor/v1' -or $descriptor.kind -cne 'factory-preparation-descriptor' -or $descriptor.profile -cne '${profile}') { throw 'Factory preparation descriptor profile is invalid' }
  Assert-ExactProperties $descriptor.parameters @('environmentName','provisioningEndpoint','mqttUrl','hardware','display','accounts','expectedKioskShell','targetLayoutVersion','maintenance') 'Factory preparation parameters'
  Assert-ExactProperties $descriptor.parameters.hardware @('mode','model','topologyIdentity','topologyVersion') 'Factory preparation hardware'
  Assert-ExactProperties $descriptor.parameters.display @('width','height','orientation') 'Factory preparation display'
  Assert-ExactProperties $descriptor.parameters.accounts @('kioskUser','maintenanceUser','autoLogonUser') 'Factory preparation accounts'
  Assert-ExactProperties $descriptor.parameters.maintenance @('wireGuardInterfaceAlias','wireGuardListenAddress','runnerSourceAllowlist','maintainerSourceAllowlist','openSsh','wireGuard') 'Factory preparation maintenance'
  Assert-ExactProperties $descriptor.parameters.maintenance.openSsh @('version','approvedSignerThumbprint','approvedRootThumbprint') 'Factory OpenSSH trust'
  Assert-ExactProperties $descriptor.parameters.maintenance.wireGuard @('version','approvedSignerThumbprint','approvedRootThumbprint') 'Factory WireGuard trust'
  Assert-ExactProperties $descriptor.assets @('daemon','machineUi','webview2Loader','openSsh','wireGuard','maintenanceSshCa','visionConfiguration') 'Factory preparation assets'
  foreach ($assetName in @('daemon','machineUi','webview2Loader','openSsh','wireGuard','maintenanceSshCa','visionConfiguration')) {
    $asset = $descriptor.assets.$assetName
    Assert-ExactProperties $asset @('path','sha256') "Factory asset $assetName"
    $assetPath = Join-Path $MediaRoot ([string]$asset.path)
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) { throw "Factory asset $assetName is missing" }
    if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$asset.sha256) { throw "Factory asset $assetName hash mismatch" }
  }
  Write-Status 'running' 'host personalization accepted'
  & (Join-Path $MediaRoot 'install-factory-baseline.ps1') -MediaRoot $MediaRoot
  $prepare = @{
    DaemonArtifactPath = Join-Path $MediaRoot $descriptor.assets.daemon.path; DaemonSha256 = $descriptor.assets.daemon.sha256
    MachineUiArtifactPath = Join-Path $MediaRoot $descriptor.assets.machineUi.path; MachineUiSha256 = $descriptor.assets.machineUi.sha256
    EnvironmentName = $descriptor.parameters.environmentName; ProvisioningEndpoint = $descriptor.parameters.provisioningEndpoint; MqttUrl = $descriptor.parameters.mqttUrl
    HardwareMode = $descriptor.parameters.hardware.mode; HardwareModel = $descriptor.parameters.hardware.model; TopologyIdentity = $descriptor.parameters.hardware.topologyIdentity; TopologyVersion = $descriptor.parameters.hardware.topologyVersion
    ExpectedDisplayWidth = [int]$descriptor.parameters.display.width; ExpectedDisplayHeight = [int]$descriptor.parameters.display.height; ExpectedDisplayOrientation = $descriptor.parameters.display.orientation
    ExpectedKioskUser = $descriptor.parameters.accounts.kioskUser; ExpectedMaintenanceUser = $descriptor.parameters.accounts.maintenanceUser; ExpectedAutoLogonUser = $descriptor.parameters.accounts.autoLogonUser; ExpectedKioskShell = $descriptor.parameters.expectedKioskShell
    TargetLayoutVersion = $descriptor.parameters.targetLayoutVersion; FactoryProfile = '${profile}'; PersonalizationMediaPath = $personalizationPath; FactoryMediaRoot = $MediaRoot; VisionConfigurationSourcePath = Join-Path $MediaRoot $descriptor.assets.visionConfiguration.path
    OpenSshPackagePath = Join-Path $MediaRoot $descriptor.assets.openSsh.path; OpenSshPackageSource = 'local-pinned'; OpenSshPackageVersion = $descriptor.parameters.maintenance.openSsh.version; OpenSshPackageSha256 = $descriptor.assets.openSsh.sha256; OpenSshApprovedSignerThumbprint = $descriptor.parameters.maintenance.openSsh.approvedSignerThumbprint; OpenSshApprovedRootThumbprint = $descriptor.parameters.maintenance.openSsh.approvedRootThumbprint
    WireGuardPackagePath = Join-Path $MediaRoot $descriptor.assets.wireGuard.path; WireGuardPackageSource = 'local-pinned'; WireGuardPackageVersion = $descriptor.parameters.maintenance.wireGuard.version; WireGuardPackageSha256 = $descriptor.assets.wireGuard.sha256; WireGuardApprovedSignerThumbprint = $descriptor.parameters.maintenance.wireGuard.approvedSignerThumbprint; WireGuardApprovedRootThumbprint = $descriptor.parameters.maintenance.wireGuard.approvedRootThumbprint
    MaintenanceSshCaPublicKeyPath = Join-Path $MediaRoot $descriptor.assets.maintenanceSshCa.path; MaintenanceSshCaPublicKeySha256 = $descriptor.assets.maintenanceSshCa.sha256
    MaintenanceRunnerSourceAllowlist = @($descriptor.parameters.maintenance.runnerSourceAllowlist); MaintenanceMaintainerSourceAllowlist = @($descriptor.parameters.maintenance.maintainerSourceAllowlist)
    MaintenanceWireGuardInterfaceAlias = $descriptor.parameters.maintenance.wireGuardInterfaceAlias; MaintenanceWireGuardListenAddress = $descriptor.parameters.maintenance.wireGuardListenAddress; ResetExistingVemState = $true
  }
  & (Join-Path $MediaRoot 'scripts\\prepare-factory-runtime.ps1') @prepare
  if ($descriptor.profile -ceq 'production') {
    & (Join-Path $MediaRoot 'scripts\\provision-vision-factory-release.ps1') -FactoryMediaRoot (Join-Path $MediaRoot 'VEM')
    & (Join-Path $MediaRoot 'scripts\\install-vision-release.ps1') -ConfigurationPath (Join-Path $MediaRoot $descriptor.assets.visionConfiguration.path) -EvidencePath 'C:\\ProgramData\\VEM\\evidence\\vision-install-bootstrap.json' -TaskUser $descriptor.parameters.accounts.autoLogonUser
  }
  & (Join-Path $MediaRoot 'scripts\\verify-factory-runtime.ps1')
  Write-Status 'succeeded' 'factory runtime verified'
  Unregister-ScheduledTask -TaskName 'VemFactoryBootstrap' -Confirm:$false -ErrorAction SilentlyContinue
} catch {
  Write-Status 'failed' $_.Exception.Message
  Restart-Computer -Force
  exit 1
}
`;
}

function baselineInstallerScript() {
  // This script deliberately has no personalization input. It installs only
  // immutable common media and leaves machine claim, credentials, and peers to
  // the disposable overlay stage.
  return `param([Parameter(Mandatory = $true)][string]$MediaRoot)
$ErrorActionPreference = 'Stop'
  $manifestPath = Join-Path $MediaRoot 'factory-baseline.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
function Assert-Hash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "factory media is missing $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "factory media hash mismatch for $Path" }
}
foreach ($asset in $manifest.assets) { Assert-Hash (Join-Path $MediaRoot $asset.path) $asset.sha256 }
New-Item -ItemType Directory -Force -Path 'C:\\VEM\\bringup', 'C:\\ProgramData\\VEM\\factory', 'C:\\ProgramData\\VEM\\factory-media' | Out-Null
Copy-Item -LiteralPath (Join-Path $MediaRoot 'factory-baseline.json') -Destination 'C:\\ProgramData\\VEM\\factory\\factory-baseline.json' -Force
Copy-Item -LiteralPath (Join-Path $MediaRoot 'scripts\\prepare-factory-runtime.ps1') -Destination 'C:\\VEM\\bringup\\prepare-factory-runtime.ps1' -Force
Copy-Item -LiteralPath (Join-Path $MediaRoot 'scripts\\verify-factory-runtime.ps1') -Destination 'C:\\VEM\\bringup\\verify-factory-runtime.ps1' -Force
foreach ($asset in $manifest.assets) {
  $source = Join-Path $MediaRoot $asset.path
  $destination = Join-Path 'C:\\ProgramData\\VEM\\factory-media' $asset.fileName
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
$packages = @($manifest.assets | Where-Object { $_.role -in @('openssh-installer', 'wireguard-installer') })
foreach ($package in $packages) {
  $path = Join-Path 'C:\\ProgramData\\VEM\\factory-media' $package.fileName
  $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($extension -eq '.msi') { $process = Start-Process msiexec.exe -ArgumentList @('/i', ('"{0}"' -f $path), '/qn', '/norestart') -Wait -PassThru }
  elseif ($extension -eq '.exe') { $process = Start-Process $path -ArgumentList @('/quiet', '/norestart') -Wait -PassThru }
  else { throw "factory installer must be MSI or EXE: $($package.fileName)" }
  if ($process.ExitCode -notin @(0, 3010)) { throw "factory installer failed: $($package.role) exit $($process.ExitCode)" }
}
$ca = $manifest.assets | Where-Object { $_.role -eq 'maintenance-ssh-ca-public-key' } | Select-Object -First 1
Copy-Item -LiteralPath (Join-Path 'C:\\ProgramData\\VEM\\factory-media' $ca.fileName) -Destination 'C:\\ProgramData\\VEM\\factory\\maintenance-ca.pub' -Force
$sshd = 'C:\\ProgramData\\ssh\\sshd_config'
if (Test-Path -LiteralPath $sshd) {
  Add-Content -LiteralPath $sshd -Value @('', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'TrustedUserCAKeys C:\\ProgramData\\VEM\\factory\\maintenance-ca.pub')
  Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
  Restart-Service -Name sshd -Force -ErrorAction Stop
}
$runtime = @{'vem-daemon' = 'vending-daemon.exe'; 'vem-machine-ui' = 'machine.exe'; 'webview2-loader' = 'WebView2Loader.dll'}
foreach ($asset in $manifest.assets) {
  if ($runtime.ContainsKey([string]$asset.role)) { Copy-Item -LiteralPath (Join-Path 'C:\\ProgramData\\VEM\\factory-media' $asset.fileName) -Destination (Join-Path 'C:\\VEM\\bringup' $runtime[[string]$asset.role]) -Force }
}
foreach ($name in @($manifest.accounts.maintenance, $manifest.accounts.kiosk)) {
  $account = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $account) { New-LocalUser -Name $name -NoPassword -AccountNeverExpires | Out-Null }
  Disable-LocalUser -Name $name -ErrorAction SilentlyContinue
}
Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU' -Name NoAutoUpdate -Value 1 -Type DWord -Force
powercfg.exe /hibernate off | Out-Null
  Set-Content -LiteralPath 'C:\\ProgramData\\VEM\\factory\\baseline-complete.json' -Encoding UTF8 -Value (@{ schemaVersion = 'vem-factory-baseline/v1'; profile = $manifest.profile; machineIdentity = $null; completed = $true } | ConvertTo-Json -Compress)
`;
}

function factoryBaselineManifest(manifest, resolvedAssets) {
  const names = {
    "openssh-installer": "openssh-installer.bin",
    "wireguard-installer": "wireguard-installer.bin",
    "vem-daemon": "vending-daemon.exe",
    "vem-machine-ui": "machine.exe",
    "webview2-loader": "WebView2Loader.dll",
    "vision-release": "vision-release.bin",
    "vision-configuration": "vision-config.json",
    "maintenance-ssh-ca-public-key": "maintenance-ca.pub",
  };
  return {
    schemaVersion: "vem-factory-baseline-media/v1",
    profile: manifest.profile,
    accounts: {
      maintenance: factoryAccountForProfile(manifest.profile),
      kiosk: "VEMKiosk",
    },
    assets: resolvedAssets
      .filter(({ reference }) => reference.role !== "windows-source-iso")
      .sort(({ reference: left }, { reference: right }) =>
        left.role.localeCompare(right.role),
      )
      .map(({ reference }) => ({
        role: reference.role,
        fileName: reference.mediaFileName ?? names[reference.role],
        path: `assets/${reference.mediaFileName ?? names[reference.role]}`,
        sha256: reference.digest.slice(7),
      })),
  };
}

async function setFixedTimes(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await setFixedTimes(path);
    await utimes(path, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
  }
  await utimes(root, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

async function writeDeterministicIsoSortFile(root, outputPath) {
  const paths = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      paths.push(relativePath);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      }
    }
  }
  await visit(root);
  await writeFile(
    outputPath,
    paths.map((path, index) => `${paths.length - index} ${path}`).join("\n"),
  );
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc;
}

function writeUdfDstring(target, offset, length, value) {
  target.fill(0, offset, offset + length);
  const encoded = Buffer.from(value, "ascii");
  if (encoded.length + 2 > length) throw new Error("UDF dstring is too long");
  target[offset] = 8;
  encoded.copy(target, offset + 1);
  target[offset + length - 1] = encoded.length + 1;
}

function normalizeUdfTimestamps(target, sectorOffset) {
  const crcLength = target.readUInt16LE(sectorOffset + 10);
  const end = sectorOffset + 16 + crcLength;
  let changed = false;
  for (let offset = sectorOffset + 16; offset + 12 <= end; offset += 1) {
    const year = target.readUInt16LE(offset + 2);
    const month = target[offset + 4];
    const day = target[offset + 5];
    const hour = target[offset + 6];
    const minute = target[offset + 7];
    const second = target[offset + 8];
    if (
      year < 1970 ||
      year > 2200 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 60
    ) {
      continue;
    }
    target.fill(0, offset, offset + 12);
    target.writeUInt16LE(0x1000, offset);
    target.writeUInt16LE(1980, offset + 2);
    target[offset + 4] = 1;
    target[offset + 5] = 1;
    changed = true;
    offset += 11;
  }
  return changed;
}

function updateUdfTag(target, sectorOffset) {
  const crcLength = target.readUInt16LE(sectorOffset + 10);
  const crcStart = sectorOffset + 16;
  if (crcLength < 1 || crcStart + crcLength > sectorOffset + SECTOR_BYTES) {
    throw new Error("invalid UDF descriptor CRC length");
  }
  target.writeUInt16LE(
    crc16(target.subarray(crcStart, crcStart + crcLength)),
    sectorOffset + 8,
  );
  target[sectorOffset + 4] = 0;
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4)
      checksum = (checksum + target[sectorOffset + index]) & 0xff;
  }
  target[sectorOffset + 4] = checksum;
}

export function normalizeUdfForReproducibility(media) {
  const normalized = Buffer.from(media);
  const fixedIsoTimestamp = Buffer.concat([
    Buffer.from("1980010100000000", "ascii"),
    Buffer.from([0]),
  ]);
  for (let sector = 16; sector < 32; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    if (
      [1, 2].includes(normalized[offset]) &&
      normalized.toString("ascii", offset + 1, offset + 6) === "CD001"
    ) {
      for (const timestampOffset of [813, 830, 847, 864]) {
        fixedIsoTimestamp.copy(normalized, offset + timestampOffset);
      }
    }
  }
  let primaryDescriptors = 0;
  for (
    let sector = 32;
    sector * SECTOR_BYTES < normalized.length;
    sector += 1
  ) {
    const offset = sector * SECTOR_BYTES;
    const tagIdentifier = normalized.readUInt16LE(offset);
    const descriptorVersion = normalized.readUInt16LE(offset + 2);
    const tagLocation = normalized.readUInt32LE(offset + 12);
    if (![2, 3].includes(descriptorVersion) || tagLocation !== sector) continue;
    let changed = normalizeUdfTimestamps(normalized, offset);
    if (tagIdentifier === 1) {
      writeUdfDstring(normalized, offset + 72, 128, UDF_VOLUME_SET_ID);
      primaryDescriptors += 1;
      changed = true;
    }
    if (changed) updateUdfTag(normalized, offset);
  }
  if (primaryDescriptors !== 2) {
    throw new Error(
      `expected two UDF primary volume descriptors, found ${primaryDescriptors}`,
    );
  }
  return normalized;
}

function verifyUdfTag(media, sector) {
  const offset = sector * SECTOR_BYTES;
  const expectedChecksum = media[offset + 4];
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) checksum = (checksum + media[offset + index]) & 0xff;
  }
  if (checksum !== expectedChecksum)
    throw new Error("UDF descriptor tag checksum is invalid");
  const crcLength = media.readUInt16LE(offset + 10);
  const actualCrc = crc16(media.subarray(offset + 16, offset + 16 + crcLength));
  if (actualCrc !== media.readUInt16LE(offset + 8)) {
    throw new Error("UDF descriptor CRC is invalid");
  }
}

export function inspectBootableIso(media) {
  if (!Buffer.isBuffer(media) || media.length < 64 * SECTOR_BYTES) {
    throw new Error("Factory media is too small to be ISO9660/UDF");
  }
  const pvd = 16 * SECTOR_BYTES;
  if (
    media[pvd] !== 1 ||
    media.toString("ascii", pvd + 1, pvd + 6) !== "CD001"
  ) {
    throw new Error("ISO9660 primary volume descriptor is missing");
  }
  let bootRecord;
  for (let sector = 16; sector < 32; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    if (
      media[offset] === 0 &&
      media.toString("ascii", offset + 1, offset + 6) === "CD001" &&
      media.toString("ascii", offset + 7, offset + 30).trim() ===
        "EL TORITO SPECIFICATION"
    ) {
      bootRecord = offset;
      break;
    }
  }
  if (bootRecord === undefined)
    throw new Error("El Torito boot record is missing");
  const catalogSector = media.readUInt32LE(bootRecord + 71);
  const catalog = catalogSector * SECTOR_BYTES;
  if (catalog + 96 > media.length)
    throw new Error("El Torito boot catalog is truncated");
  let catalogChecksum = 0;
  for (let offset = 0; offset < 32; offset += 2) {
    catalogChecksum =
      (catalogChecksum + media.readUInt16LE(catalog + offset)) & 0xffff;
  }
  if (
    media[catalog] !== 1 ||
    media[catalog + 30] !== 0x55 ||
    media[catalog + 31] !== 0xaa ||
    catalogChecksum !== 0 ||
    ![0x88, 0].includes(media[catalog + 32]) ||
    media[catalog + 33] !== 0 ||
    media.readUInt16LE(catalog + 38) === 0 ||
    media.readUInt32LE(catalog + 40) === 0
  ) {
    throw new Error("El Torito boot catalog is invalid or not bootable");
  }
  const bootEntries = [
    {
      platform: "BIOS",
      bootable: media[catalog + 32] === 0x88,
      emulation: "none",
      loadSegment: `0x${media
        .readUInt16LE(catalog + 34)
        .toString(16)
        .padStart(4, "0")}`,
      systemType: `0x${media[catalog + 36].toString(16).padStart(2, "0")}`,
      loadSize: media.readUInt16LE(catalog + 38),
    },
  ];
  let entryOffset = catalog + 64;
  while (
    entryOffset + 32 <= media.length &&
    [0x90, 0x91].includes(media[entryOffset])
  ) {
    const platformId = media[entryOffset + 1];
    const count = media.readUInt16LE(entryOffset + 2);
    const platform =
      platformId === 0xef
        ? "UEFI"
        : `platform-0x${platformId.toString(16).padStart(2, "0")}`;
    entryOffset += 32;
    if (count < 1 || entryOffset + count * 32 > media.length)
      throw new Error("El Torito boot catalog section is truncated");
    for (let index = 0; index < count; index += 1) {
      const offset = entryOffset + index * 32;
      if (
        ![0x88, 0].includes(media[offset]) ||
        media[offset + 1] !== 0 ||
        media.readUInt16LE(offset + 6) === 0 ||
        media.readUInt32LE(offset + 8) === 0
      )
        throw new Error("El Torito boot catalog section entry is invalid");
      bootEntries.push({
        platform,
        bootable: media[offset] === 0x88,
        emulation: "none",
        loadSegment: `0x${media
          .readUInt16LE(offset + 2)
          .toString(16)
          .padStart(4, "0")}`,
        systemType: `0x${media[offset + 4].toString(16).padStart(2, "0")}`,
        loadSize: media.readUInt16LE(offset + 6),
      });
    }
    entryOffset += count * 32;
  }
  let udfRecognition = false;
  for (
    let sector = 16;
    sector < Math.min(512, media.length / SECTOR_BYTES);
    sector += 1
  ) {
    const identifier = media.toString(
      "ascii",
      sector * SECTOR_BYTES + 1,
      sector * SECTOR_BYTES + 6,
    );
    if (identifier === "NSR02" || identifier === "NSR03") udfRecognition = true;
  }
  if (!udfRecognition) {
    return {
      iso9660: true,
      udf: false,
      elTorito: true,
      bootable: true,
      bootCatalogSector: catalogSector,
      bootEntries,
    };
  }
  const udfPrimarySectors = [];
  let verifiedUdfDescriptors = 0;
  for (let sector = 32; sector * SECTOR_BYTES < media.length; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    const descriptorVersion = media.readUInt16LE(offset + 2);
    if (
      [2, 3].includes(descriptorVersion) &&
      media.readUInt32LE(offset + 12) === sector
    ) {
      verifyUdfTag(media, sector);
      verifiedUdfDescriptors += 1;
      if (media.readUInt16LE(offset) !== 1) continue;
      udfPrimarySectors.push(sector);
    }
  }
  if (udfPrimarySectors.length !== 2)
    throw new Error("UDF primary descriptors are incomplete");
  if (verifiedUdfDescriptors < 8)
    throw new Error("UDF descriptor sequence is incomplete");
  return {
    iso9660: true,
    udf: true,
    elTorito: true,
    bootable: true,
    bootCatalogSector: catalogSector,
    bootEntries,
  };
}

async function executeIsoBuilder({
  builderBytes,
  stageDirectory,
  outputPath,
  workDirectory,
}) {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await mkdir(ISO_BUILDER_LOCK);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("timed out acquiring deterministic ISO builder lock", {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const executable = join(workDirectory, "iso-builder");
  try {
    await writeFile(executable, builderBytes, { mode: 0o555 });
    const sortFile = join(workDirectory, "iso-sort.txt");
    await writeDeterministicIsoSortFile(stageDirectory, sortFile);
    await run(
      executable,
      [
        "-quiet",
        "-udf",
        "-iso-level",
        "3",
        "-V",
        "VEM_FACTORY",
        "-volset",
        UDF_VOLUME_SET_ID,
        "-A",
        "VEM_FACTORY_ISSUE10",
        "-sysid",
        "VEM",
        "-sort",
        sortFile,
        "-b",
        "BOOT/BOOT.IMG",
        "-c",
        "BOOT/BOOT.CAT",
        "-no-emul-boot",
        "-boot-load-size",
        "4",
        "-o",
        outputPath,
        stageDirectory,
      ],
      {
        cwd: workDirectory,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: workDirectory,
          LC_ALL: "C",
          TZ: "UTC",
          SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
        },
        maxBuffer: 1024 * 1024,
      },
    );
    const normalized = normalizeUdfForReproducibility(
      await readFile(outputPath),
    );
    await writeFile(outputPath, normalized, { mode: 0o444 });
    const structure = inspectBootableIso(normalized);
    return { bytes: normalized, structure };
  } finally {
    await rm(ISO_BUILDER_LOCK, { recursive: true, force: true });
  }
}

async function inspectWindowsSetupTree({
  executable,
  wimlibExecutable,
  isoPath,
  tree,
  workDirectory,
  expectedInstallImage,
}) {
  const files = new Map();
  async function visit(directory, relative = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const key = path.toLocaleLowerCase("en-US");
      if (files.has(key))
        throw new Error(
          `Windows Setup media contains a case-colliding path: ${path}`,
        );
      files.set(key, path);
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
    }
  }
  await visit(tree);
  for (const required of [
    "setup.exe",
    "sources",
    "sources/boot.wim",
    "boot/etfsboot.com",
    "efi/microsoft/boot/efisys.bin",
  ]) {
    if (!files.has(required))
      throw new Error(
        `Windows source ISO is missing required Windows Setup path: ${required}`,
      );
  }
  if (!files.has("sources/install.wim") && !files.has("sources/install.esd")) {
    throw new Error(
      "Windows source ISO is missing sources/install.wim or sources/install.esd",
    );
  }
  await assertWimMagic(
    join(tree, files.get("sources/boot.wim")),
    "Windows boot image",
  );
  const installImage = files.has("sources/install.wim")
    ? "sources/install.wim"
    : "sources/install.esd";
  if (installImage.endsWith(".esd"))
    await assertWimMagic(
      join(tree, files.get(installImage)),
      "Windows install image",
    );
  const selectedImage = await inspectSelectedWindowsImage({
    executable: wimlibExecutable,
    imagePath: join(tree, files.get(installImage)),
    expected: expectedInstallImage,
    workDirectory,
  });
  const report = await run(
    executable,
    ["-indev", isoPath, "-report_el_torito", "plain", "-end"],
    {
      cwd: workDirectory,
      env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const output = `${report.stdout}\n${report.stderr}`;
  const images = output.split(/\r?\n/).flatMap((line) => {
    const match =
      /^El Torito boot img\s*:\s*(\d+)\s+(BIOS|UEFI)\s+([yn])\s+(\S+)\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)\s+(\d+)\s+(\d+)/i.exec(
        line.trim(),
      );
    return match
      ? [
          {
            index: Number(match[1]),
            platform: match[2],
            bootable: match[3] === "y",
            emulation: match[4],
            loadSegment: match[5].toLowerCase(),
            systemType: match[6].toLowerCase(),
            loadSize: Number(match[7]),
          },
        ]
      : [];
  });
  const paths = new Map(
    [...output.matchAll(/El Torito img path\s*:\s*(\d+)\s+(\/\S+)/g)].map(
      (match) => [
        Number(match[1]),
        match[2].slice(1).toLocaleLowerCase("en-US"),
      ],
    ),
  );
  const bootCatalog = images.map((image) => ({
    ...image,
    isoEntry: paths.get(image.index) ?? null,
  }));
  if (
    bootCatalog.length < 2 ||
    !bootCatalog.some(
      (entry) =>
        entry.platform === "BIOS" &&
        entry.isoEntry === "boot/etfsboot.com" &&
        entry.bootable &&
        entry.emulation === "none" &&
        entry.loadSize > 0,
    ) ||
    !bootCatalog.some(
      (entry) =>
        entry.platform === "UEFI" &&
        entry.isoEntry === "efi/microsoft/boot/efisys.bin" &&
        entry.bootable &&
        entry.emulation === "none" &&
        entry.loadSize > 0,
    )
  ) {
    throw new Error(
      "Windows source ISO must provide BIOS etfsboot and UEFI efisys entries in its complete El Torito catalog",
    );
  }
  return {
    paths: [...files.values()].sort((left, right) => left.localeCompare(right)),
    installImage,
    selectedImage,
    bootCatalog,
  };
}

export async function inspectWindowsSetupIso({
  isoPath,
  expectedInstallImage,
  isoBuilderPath,
  isoBuilder,
  wimlibPath,
  wimlib,
}) {
  const [builderBytes, wimlibBytes] = await Promise.all([
    readPinnedExecutable(isoBuilderPath, isoBuilder),
    readPinnedExecutable(wimlibPath, wimlib),
  ]);
  const workDirectory = await mkdtemp(
    join(tmpdir(), "vem-windows-setup-inspect-"),
  );
  try {
    const executable = join(workDirectory, "xorriso");
    const wimlibExecutable = join(workDirectory, "wimlib-imagex");
    await Promise.all([
      writeFile(executable, builderBytes, { mode: 0o555 }),
      writeFile(wimlibExecutable, wimlibBytes, { mode: 0o555 }),
    ]);
    const tree = join(workDirectory, "media");
    await run(
      executable,
      ["-osirrox", "on", "-indev", isoPath, "-extract", "/", tree],
      {
        cwd: workDirectory,
        env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return await inspectWindowsSetupTree({
      executable,
      wimlibExecutable,
      isoPath,
      tree,
      workDirectory,
      expectedInstallImage,
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function inspectWindowsSourceIso({
  sourceIsoPath,
  source,
  isoBuilderPath,
  isoBuilder,
  wimlibPath,
  wimlib,
}) {
  if ((await hashFile(sourceIsoPath)) !== source.windowsMedia.digest)
    throw new Error(
      "Windows source ISO digest does not match the Factory Manifest",
    );
  return inspectWindowsSetupIso({
    isoPath: sourceIsoPath,
    expectedInstallImage: {
      index: source.installImageIndex,
      edition: source.installImageEdition,
      digest: source.installImageDigest,
    },
    isoBuilderPath,
    isoBuilder,
    wimlibPath,
    wimlib,
  });
}

async function overlayMappings(root, sourceTree) {
  const mappings = [];
  async function targetPath(relative) {
    let current = sourceTree;
    let missing = false;
    const result = [];
    for (const segment of relative.split("/")) {
      if (!missing) {
        const entries = await readdir(current, { withFileTypes: true });
        const existing = entries.find(
          (entry) =>
            entry.name.toLocaleLowerCase("en-US") ===
            segment.toLocaleLowerCase("en-US"),
        );
        if (existing) {
          result.push(existing.name);
          current = join(current, existing.name);
          continue;
        }
        missing = true;
      }
      result.push(segment);
    }
    return `/${result.join("/")}`;
  }
  async function visit(directory, relative = "") {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const diskPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(diskPath, path);
      else if (entry.isFile())
        mappings.push(["-map", diskPath, await targetPath(path)]);
      else
        throw new Error(
          `Factory Windows overlay contains a non-regular entry: ${path}`,
        );
    }
  }
  await visit(root);
  return mappings.flat();
}

async function executeWindowsServicedIsoBuilder({
  builderBytes,
  wimlibBytes,
  manifestSource,
  sourceIsoPath,
  builderVersion,
  overlayDirectory,
  outputPath,
  workDirectory,
}) {
  const executable = join(workDirectory, "xorriso");
  const wimlibExecutable = join(workDirectory, "wimlib-imagex");
  await writeFile(executable, builderBytes, { mode: 0o555 });
  await writeFile(wimlibExecutable, wimlibBytes, { mode: 0o555 });
  const version = await run(executable, ["-version"], {
    cwd: workDirectory,
    env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  if (!/xorriso/i.test(`${version.stdout}\n${version.stderr}`)) {
    throw new Error(
      "windows-serviced-iso requires a pinned xorriso-compatible builder",
    );
  }
  if (
    !new RegExp(
      `xorriso version\\s*:\\s*${builderVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(`${version.stdout}\n${version.stderr}`)
  ) {
    throw new Error(
      `executed xorriso version does not match pinned manifest version ${builderVersion}`,
    );
  }
  const wimlibVersion = await run(wimlibExecutable, ["--version"], {
    cwd: workDirectory,
    env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
    maxBuffer: 1024 * 1024,
  });
  if (
    !new RegExp(
      `wimlib-imagex\\s+${manifestSource.wimlibVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(`${wimlibVersion.stdout}\n${wimlibVersion.stderr}`)
  ) {
    throw new Error(
      `executed wimlib version does not match pinned manifest version ${manifestSource.wimlibVersion}`,
    );
  }
  const sourceSnapshot = sourceIsoPath;
  const sourceTree = join(workDirectory, "windows-source");
  await run(
    executable,
    ["-osirrox", "on", "-indev", sourceSnapshot, "-extract", "/", sourceTree],
    {
      cwd: workDirectory,
      env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const expectedInstallImage = {
    index: manifestSource.installImageIndex,
    edition: manifestSource.installImageEdition,
    digest: manifestSource.installImageDigest,
  };
  const sourceCatalog = await inspectWindowsSetupTree({
    executable,
    wimlibExecutable,
    isoPath: sourceSnapshot,
    tree: sourceTree,
    workDirectory,
    expectedInstallImage,
  });
  await setFixedTimes(overlayDirectory);
  const overlays = await overlayMappings(overlayDirectory, sourceTree);
  // Replaying the source system area and complete El Torito catalog with the
  // same pinned xorriso avoids silently dropping UEFI or vendor boot entries.
  await run(
    executable,
    [
      "-indev",
      sourceSnapshot,
      "-outdev",
      outputPath,
      "-compliance",
      "iso_9660_level=3",
      ...overlays,
      "-boot_image",
      "any",
      "replay",
      "-commit",
      "-end",
    ],
    {
      cwd: workDirectory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: workDirectory,
        LC_ALL: "C",
        TZ: "UTC",
        SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const bytes = await readFile(outputPath);
  const outputTree = join(workDirectory, "serviced-windows-output");
  await run(
    executable,
    ["-osirrox", "on", "-indev", outputPath, "-extract", "/", outputTree],
    {
      cwd: workDirectory,
      env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const outputCatalog = await inspectWindowsSetupTree({
    executable,
    wimlibExecutable,
    isoPath: outputPath,
    tree: outputTree,
    workDirectory,
    expectedInstallImage,
  });
  if (
    canonicalJson(sourceCatalog.bootCatalog) !==
    canonicalJson(outputCatalog.bootCatalog)
  ) {
    throw new Error(
      "serviced ISO boot catalog does not exactly replay the verified Windows source catalog",
    );
  }
  await writeFile(outputPath, bytes, { mode: 0o444 });
  return {
    bytes,
    structure: { ...inspectBootableIso(bytes), windowsSetup: outputCatalog },
  };
}

export async function createRedistributableFixtureIso({
  isoBuilderPath,
  isoBuilder,
  outputPath,
}) {
  const builderBytes = await readPinnedExecutable(isoBuilderPath, isoBuilder);
  const workDirectory = await mkdtemp(join(tmpdir(), "vem-iso-fixture-"));
  try {
    const stageDirectory = join(workDirectory, "stage");
    await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
    await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
    await writeFile(
      join(stageDirectory, "README.TXT"),
      "Redistributable VEM Issue10 bootable ISO fixture. Not Windows installation media.\n",
    );
    await setFixedTimes(stageDirectory);
    const built = await executeIsoBuilder({
      builderBytes,
      stageDirectory,
      outputPath: join(workDirectory, "fixture.iso"),
      workDirectory,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, built.bytes, { mode: 0o444 });
    return {
      digest: hashBytes(built.bytes),
      bytes: built.bytes.length,
      structure: built.structure,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function resolveAssets({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
}) {
  const resolved = [];
  for (const reference of assetReferences(manifest)) {
    const sourcePath =
      sourcePaths?.[reference.identity] ??
      (reference.role === "windows-source-iso" && sourceStoreRoot
        ? join(sourceStoreRoot, "sha256", reference.digest.slice(7))
        : undefined);
    const resolution =
      reference.role === "windows-source-iso"
        ? await store.verifyUncached(reference, sourcePath)
        : await store.ensure(reference, sourcePath);
    let authenticodeVerification;
    if (reference.signature.scheme === "authenticode") {
      const verifier = manifest.toolchain.authenticodeVerifier;
      if (!verifier || !authenticodeVerifierPath || !authenticodeCaBundlePath) {
        throw new Error(
          "AuthentiCode assets require a pinned verifier and trusted CA bundle",
        );
      }
      const workDirectory = await mkdtemp(
        join(tmpdir(), "vem-authenticode-input-"),
      );
      try {
        const assetPath = join(workDirectory, "signed-asset.bin");
        if (reference.role === "windows-source-iso") {
          await store.stageUncachedVerified(reference, sourcePath, assetPath);
        } else {
          await store.stageVerified(reference, assetPath);
        }
        authenticodeVerification = await verifyAuthenticodeSignature({
          asset: reference,
          assetPath,
          verifierPath: authenticodeVerifierPath,
          verifierDigest: verifier.digest,
          caBundlePath: authenticodeCaBundlePath,
          approvedSignerIdentities: approvalPolicy.authenticodeSignerIdentities,
        });
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
    const verifiedEvidence = await verifyAssetEvidence({
      asset: reference,
      evidenceStoreRoot,
      approvalPolicy,
      authenticodeVerification,
    });
    resolved.push({ reference, resolution, sourcePath, verifiedEvidence });
  }
  return resolved;
}

async function stageBuildInputs({
  manifest,
  resolvedAssets,
  store,
  stageDirectory,
  visionTrustMaterial,
}) {
  await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
  await mkdir(join(stageDirectory, "VEM", "ASSETS"), { recursive: true });
  await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
  await writeFile(
    join(stageDirectory, "VEM", "MANIFEST.JSON"),
    Buffer.from(canonicalJson(manifest)),
  );
  const visionEvidence = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  )?.visionEvidence;
  if (!visionEvidence) {
    throw new Error(
      "approved Vision release evidence is missing from Factory Media inputs",
    );
  }
  const evidenceRoot = join(stageDirectory, "VEM", "VISION-RELEASE");
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    join(evidenceRoot, "factory-manifest.json"),
    Buffer.from(canonicalJson(manifest)),
  );
  const visionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  await store.stageVerified(
    visionAsset.reference,
    join(evidenceRoot, "bundle.bin"),
  );
  for (const [role, bytes] of Object.entries(
    visionEvidence.deliveryUnit.documents,
  )) {
    await writeFile(join(evidenceRoot, `${role}.json`), bytes);
  }
  for (const [role, signature] of Object.entries(
    visionEvidence.deliveryUnit.signatures,
  )) {
    await writeFile(
      join(evidenceRoot, `${role}.signature.json`),
      Buffer.from(canonicalJson(signature)),
    );
  }
  const trustRoot = join(stageDirectory, "VEM", "VISION-TRUST");
  const installerRoot = join(stageDirectory, "VEM", "VISION-INSTALLER");
  await mkdir(trustRoot, { recursive: true });
  await mkdir(installerRoot, { recursive: true });
  const installerBytes = await readFile(
    new URL("../windows/install-vision-release.ps1", import.meta.url),
  );
  const provisionerBytes = await readFile(
    new URL("../windows/provision-vision-factory-release.ps1", import.meta.url),
  );
  await writeFile(
    join(trustRoot, "vision-release-trust-anchor.json"),
    visionTrustMaterial.anchorBytes,
  );
  await writeFile(
    join(trustRoot, "vision-release-trust-policy.json"),
    visionTrustMaterial.policyBytes,
  );
  await writeFile(
    join(trustRoot, "vision-release-verifier.exe"),
    visionTrustMaterial.verifierBytes,
  );
  await writeFile(
    join(installerRoot, "install-vision-release.ps1"),
    installerBytes,
  );
  await writeFile(
    join(installerRoot, "provision-vision-factory-release.ps1"),
    provisionerBytes,
  );
  const provisioningManifest = visionFactoryProvisioningManifest({
    "VISION-RELEASE/factory-manifest.json": Buffer.from(
      canonicalJson(manifest),
    ),
    "VISION-RELEASE/bundle.bin": await readFile(
      join(evidenceRoot, "bundle.bin"),
    ),
    ...Object.fromEntries(
      Object.entries(visionEvidence.deliveryUnit.documents).map(
        ([role, bytes]) => [`VISION-RELEASE/${role}.json`, bytes],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(visionEvidence.deliveryUnit.signatures).map(
        ([role, value]) => [
          `VISION-RELEASE/${role}.signature.json`,
          Buffer.from(canonicalJson(value)),
        ],
      ),
    ),
    "VISION-TRUST/vision-release-trust-anchor.json":
      visionTrustMaterial.anchorBytes,
    "VISION-TRUST/vision-release-trust-policy.json":
      visionTrustMaterial.policyBytes,
    "VISION-TRUST/vision-release-verifier.exe":
      visionTrustMaterial.verifierBytes,
    "VISION-INSTALLER/install-vision-release.ps1": installerBytes,
    "VISION-INSTALLER/provision-vision-factory-release.ps1": provisionerBytes,
  });
  await writeFile(
    join(stageDirectory, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
    Buffer.from(canonicalJson(provisioningManifest)),
  );
  for (const asset of resolvedAssets) {
    const name =
      asset.reference.role === "windows-source-iso"
        ? "WINDOWS-SOURCE.ISO"
        : `${asset.reference.role.toUpperCase()}.BIN`;
    const destination = join(stageDirectory, "VEM", "ASSETS", name);
    if (asset.reference.role === "windows-source-iso") {
      await store.stageUncachedVerified(
        asset.reference,
        asset.sourcePath,
        destination,
      );
    } else {
      await store.stageVerified(asset.reference, destination);
    }
  }
  await setFixedTimes(stageDirectory);
}

export async function createWindowsFactoryFirstBootMedia({
  manifest,
  resolvedAssets,
  store,
  directory,
  visionTrustMaterial,
  effectiveInputs = [],
}) {
  const oemRoot = join(directory, "sources", "$OEM$");
  const mediaRoot = join(oemRoot, "$1", ...FACTORY_MEDIA_DIRECTORY.split("/"));
  const assetsRoot = join(mediaRoot, "assets");
  const scriptsRoot = join(mediaRoot, "scripts");
  await mkdir(assetsRoot, { recursive: true });
  await mkdir(scriptsRoot, { recursive: true });
  await writeFile(
    join(directory, "Autounattend.xml"),
    autounattendXml(manifest.profile, manifest.source.installImageIndex),
  );
  await writeFile(
    join(mediaRoot, "install-factory-baseline.ps1"),
    baselineInstallerScript(),
  );
  await writeFile(
    join(mediaRoot, "bootstrap-factory-runtime.ps1"),
    factoryBootstrapScript(manifest.profile),
  );
  await writeFile(
    join(mediaRoot, "register-factory-bootstrap.cmd"),
    registerBootstrapCmd(),
  );
  await writeFile(
    join(mediaRoot, "factory-effective-inputs.json"),
    Buffer.from(
      canonicalJson({
        schemaVersion: "vem-factory-effective-inputs/v1",
        inputs: effectiveInputs,
      }),
    ),
  );
  const baseline = factoryBaselineManifest(manifest, resolvedAssets);
  const preparation = factoryPreparationDescriptor(manifest, resolvedAssets);
  await writeFile(
    join(mediaRoot, "factory-preparation.json"),
    Buffer.from(canonicalJson(preparation)),
  );
  await writeFile(
    join(mediaRoot, "factory-baseline.json"),
    Buffer.from(canonicalJson(baseline)),
  );
  const names = new Map(
    baseline.assets.map((asset) => [asset.role, asset.fileName]),
  );
  for (const asset of resolvedAssets) {
    if (asset.reference.role === "windows-source-iso") continue;
    await store.stageVerified(
      asset.reference,
      join(assetsRoot, names.get(asset.reference.role)),
    );
  }
  for (const script of [
    "prepare-factory-runtime.ps1",
    "verify-factory-runtime.ps1",
    "setup-scheduled-tasks.ps1",
    "verify-kiosk-lockdown.ps1",
    "verify-vem-runtime.ps1",
    "apply-managed-update.ps1",
    "provision-vision-factory-release.ps1",
    "install-vision-release.ps1",
  ]) {
    await writeFile(
      join(scriptsRoot, script),
      await readFile(new URL(`../windows/${script}`, import.meta.url)),
    );
  }
  const visionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  if (visionAsset?.visionEvidence && visionTrustMaterial) {
    const evidenceRoot = join(mediaRoot, "VEM", "VISION-RELEASE");
    const trustRoot = join(mediaRoot, "VEM", "VISION-TRUST");
    const installerRoot = join(mediaRoot, "VEM", "VISION-INSTALLER");
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(trustRoot, { recursive: true });
    await mkdir(installerRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "factory-manifest.json"),
      Buffer.from(canonicalJson(manifest)),
    );
    await store.stageVerified(
      visionAsset.reference,
      join(evidenceRoot, "bundle.bin"),
    );
    for (const [role, bytes] of Object.entries(
      visionAsset.visionEvidence.deliveryUnit.documents,
    )) {
      await writeFile(join(evidenceRoot, `${role}.json`), bytes);
    }
    for (const [role, signature] of Object.entries(
      visionAsset.visionEvidence.deliveryUnit.signatures,
    )) {
      await writeFile(
        join(evidenceRoot, `${role}.signature.json`),
        Buffer.from(canonicalJson(signature)),
      );
    }
    await writeFile(
      join(trustRoot, "vision-release-trust-anchor.json"),
      visionTrustMaterial.anchorBytes,
    );
    await writeFile(
      join(trustRoot, "vision-release-trust-policy.json"),
      visionTrustMaterial.policyBytes,
    );
    await writeFile(
      join(trustRoot, "vision-release-verifier.exe"),
      visionTrustMaterial.verifierBytes,
    );
    for (const script of [
      "install-vision-release.ps1",
      "provision-vision-factory-release.ps1",
    ]) {
      await writeFile(
        join(installerRoot, script),
        await readFile(new URL(`../windows/${script}`, import.meta.url)),
      );
    }
    await writeFile(
      join(mediaRoot, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
      Buffer.from(
        canonicalJson(
          visionFactoryProvisioningManifest({
            "VISION-RELEASE/factory-manifest.json": Buffer.from(
              canonicalJson(manifest),
            ),
            "VISION-RELEASE/bundle.bin": await readFile(
              join(evidenceRoot, "bundle.bin"),
            ),
            ...Object.fromEntries(
              Object.entries(
                visionAsset.visionEvidence.deliveryUnit.documents,
              ).map(([role, bytes]) => [`VISION-RELEASE/${role}.json`, bytes]),
            ),
            ...Object.fromEntries(
              Object.entries(
                visionAsset.visionEvidence.deliveryUnit.signatures,
              ).map(([role, value]) => [
                `VISION-RELEASE/${role}.signature.json`,
                Buffer.from(canonicalJson(value)),
              ]),
            ),
            "VISION-TRUST/vision-release-trust-anchor.json":
              visionTrustMaterial.anchorBytes,
            "VISION-TRUST/vision-release-trust-policy.json":
              visionTrustMaterial.policyBytes,
            "VISION-TRUST/vision-release-verifier.exe":
              visionTrustMaterial.verifierBytes,
            "VISION-INSTALLER/install-vision-release.ps1": await readFile(
              join(installerRoot, "install-vision-release.ps1"),
            ),
            "VISION-INSTALLER/provision-vision-factory-release.ps1":
              await readFile(
                join(installerRoot, "provision-vision-factory-release.ps1"),
              ),
          }),
        ),
      ),
    );
  }
  await setFixedTimes(directory);
  return {
    mediaRoot: FACTORY_MEDIA_DIRECTORY,
    firstBoot:
      "specialize/RunSynchronous + FirstLogonCommands + VemFactoryBootstrap(SYSTEM)",
    unattended: "Autounattend.xml",
    baseline,
    preparation,
  };
}

function makeProvenance(
  manifest,
  resolvedAssets,
  output,
  reproducibility,
  structure,
  effectiveInputs,
) {
  const hits = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "hit",
  ).length;
  const misses = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "miss",
  ).length;
  return {
    schemaVersion: "vem-factory-provenance/v1",
    kind: "factory-media-provenance",
    manifest: {
      identity: manifest.manifestId,
      schemaVersion: manifest.schemaVersion,
      profile: manifest.profile,
    },
    inputs: resolvedAssets.map(
      ({ reference, resolution, verifiedEvidence }) => ({
        role: reference.role,
        identity: reference.identity,
        digest: reference.digest,
        version: reference.version,
        signature: verifiedEvidence.signature,
        provenance: verifiedEvidence.provenance,
        resolution: resolution.evidence,
      }),
    ),
    effectiveInputs,
    toolchain: {
      builderImage: { ...manifest.toolchain.builderImage, executed: true },
      isoBuilder: { ...manifest.toolchain.isoBuilder, executed: true },
      wimlib: { ...manifest.toolchain.wimlib, executed: true },
      ...(manifest.toolchain.authenticodeVerifier
        ? {
            authenticodeVerifier: {
              ...manifest.toolchain.authenticodeVerifier,
              executed: resolvedAssets.some(
                ({ reference }) =>
                  reference.signature.scheme === "authenticode",
              ),
            },
          }
        : {}),
    },
    output: {
      identity: output.identity,
      digest: output.digest,
      fileName: output.fileName,
      bytes: output.bytes,
      structure,
      assemblyMode: manifest.outputPolicy.assemblyMode,
      windowsInstallerCustomized: true,
      requiresIssue15CustomizationAssets: false,
    },
    evidence: {
      cache: { hits, misses, entries: hits + misses },
      sourceMedia: { verified: 1, cached: false },
      deterministic: {
        ordering: "role-ascending",
        timestampEpoch: FIXED_EPOCH_SECONDS,
        udfVolumeSetIdentity: UDF_VOLUME_SET_ID,
      },
      policy: {
        sourceWindowsMediaUploaded: false,
        personalizationMediaUploaded: false,
        secretsCached: false,
        privateKeysCached: false,
        hostPathsIncluded: false,
      },
    },
    reproducibility,
  };
}

export async function buildFactoryMedia({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  visionReleaseDeliveryUnit,
  repositoryVisionTrustedRoots,
  factoryVisionTrustedRoots,
  visionEvidenceVerifierPath,
  isoBuilderPath,
  wimlibPath,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
  executedBuilderImage,
  outputDirectory,
  reproducibility = false,
}) {
  const validatedManifest = validateFactoryManifest(manifest);
  if (!(store instanceof ContentAddressedAssetStore)) {
    throw new TypeError(
      "buildFactoryMedia requires a ContentAddressedAssetStore",
    );
  }
  if (
    executedBuilderImage !== validatedManifest.toolchain.builderImage.identity
  ) {
    throw new Error(
      "executed builder image does not exactly match the Factory Manifest",
    );
  }
  const builderBytes = await readPinnedExecutable(
    isoBuilderPath,
    validatedManifest.toolchain.isoBuilder,
  );
  if (!wimlibPath)
    throw new Error(
      "windows-serviced-iso requires a pinned wimlib executable path",
    );
  const wimlibBytes = await readPinnedExecutable(
    wimlibPath,
    validatedManifest.toolchain.wimlib,
  );
  const visionEvidence = verifyManifestVisionReleaseEvidence({
    manifest: validatedManifest,
    deliveryUnit: visionReleaseDeliveryUnit,
    repositoryTrustedRoots: repositoryVisionTrustedRoots,
    factoryTrustedRoots: factoryVisionTrustedRoots,
  });
  const visionTrustMaterial = createVisionFactoryTrustMaterial({
    repositoryTrustedRoots: repositoryVisionTrustedRoots,
    factoryTrustedRoots: factoryVisionTrustedRoots,
    verifierBytes: await readPinnedVisionVerifier(visionEvidenceVerifierPath),
  });
  const implementationFiles = EFFECTIVE_IMPLEMENTATION_FILES;
  const effectiveInputs = [
    {
      role: "manifest:factory-manifest",
      digest: hashBytes(Buffer.from(canonicalJson(validatedManifest))),
    },
    ...assetReferences(validatedManifest).map((asset) => ({
      role: `asset:${asset.role}`,
      digest: asset.digest,
    })),
    {
      role: "tool:builder-image",
      digest: validatedManifest.toolchain.builderImage.digest,
    },
    {
      role: "tool:iso-builder",
      digest: validatedManifest.toolchain.isoBuilder.digest,
    },
    {
      role: "tool:wimlib",
      digest: validatedManifest.toolchain.wimlib.digest,
    },
    ...(await collectImportedModuleInputs(
      new URL("./build-factory-media.mjs", import.meta.url),
    )),
    ...(await Promise.all(
      implementationFiles.map(async (name) => ({
        role: `repo-script:${name}`,
        digest: hashBytes(
          await readFile(new URL(`../windows/${name}`, import.meta.url)),
        ),
      })),
    )),
    {
      role: "vision-verifier",
      digest: hashBytes(visionTrustMaterial.verifierBytes),
    },
    {
      role: "vision-repository-trust",
      digest: hashBytes(
        Buffer.from(canonicalJson(repositoryVisionTrustedRoots)),
      ),
    },
    {
      role: "vision-factory-trust",
      digest: hashBytes(Buffer.from(canonicalJson(factoryVisionTrustedRoots))),
    },
    ...Object.entries(visionReleaseDeliveryUnit.documents).map(
      ([role, bytes]) => ({
        role: `vision-document:${role}`,
        digest: hashBytes(bytes),
      }),
    ),
    ...Object.entries(visionReleaseDeliveryUnit.signatures).map(
      ([role, value]) => ({
        role: `vision-signature:${role}`,
        digest: hashBytes(Buffer.from(canonicalJson(value))),
      }),
    ),
  ].sort((left, right) => left.role.localeCompare(right.role));
  const resolvedAssets = await resolveAssets({
    manifest: validatedManifest,
    store,
    sourcePaths,
    sourceStoreRoot,
    evidenceStoreRoot,
    approvalPolicy,
    authenticodeVerifierPath,
    authenticodeCaBundlePath,
  });
  const selectedVisionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  selectedVisionAsset.visionEvidence = {
    selection: visionEvidence,
    deliveryUnit: visionReleaseDeliveryUnit,
  };
  const buildCount = reproducibility ? 2 : 1;
  const builds = [];
  const sourceWindowsMedia = resolvedAssets.find(
    ({ reference }) => reference.role === "windows-source-iso",
  );
  if (
    validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO &&
    !sourceWindowsMedia?.sourcePath
  ) {
    throw new Error(
      "windows-serviced-iso requires a verified Windows source path",
    );
  }
  if (validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO) {
    for (const role of ["openssh-installer", "wireguard-installer"]) {
      const asset = resolvedAssets.find(
        ({ reference }) => reference.role === role,
      )?.reference;
      if (
        !asset?.mediaFileName ||
        !/\.(?:msi|exe)$/i.test(asset.mediaFileName)
      ) {
        throw new Error(
          `windows-serviced-iso requires ${role}.mediaFileName to name a pinned MSI or EXE`,
        );
      }
    }
  }
  for (let index = 0; index < buildCount; index += 1) {
    const workDirectory = await mkdtemp(
      join(tmpdir(), `vem-factory-build-${index + 1}-`),
    );
    try {
      const outputPath = join(workDirectory, "factory.iso");
      if (
        validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO
      ) {
        const overlayDirectory = join(workDirectory, "windows-overlay");
        const verifiedSourceSnapshot = join(
          workDirectory,
          "verified-windows-source.iso",
        );
        // This is copied from the already-opened, digest-verified source handle.
        // The builder never reopens the restricted source pathname afterwards.
        await store.stageUncachedVerified(
          sourceWindowsMedia.reference,
          sourceWindowsMedia.sourcePath,
          verifiedSourceSnapshot,
        );
        await createWindowsFactoryFirstBootMedia({
          manifest: validatedManifest,
          resolvedAssets,
          store,
          directory: overlayDirectory,
          visionTrustMaterial,
          effectiveInputs,
        });
        builds.push(
          await executeWindowsServicedIsoBuilder({
            builderBytes,
            wimlibBytes,
            manifestSource: {
              ...validatedManifest.source,
              wimlibVersion: validatedManifest.toolchain.wimlib.version,
            },
            sourceIsoPath: verifiedSourceSnapshot,
            builderVersion: validatedManifest.toolchain.isoBuilder.version,
            overlayDirectory,
            outputPath,
            workDirectory,
          }),
        );
      } else {
        const stageDirectory = join(workDirectory, "stage");
        await stageBuildInputs({
          manifest: validatedManifest,
          resolvedAssets,
          store,
          stageDirectory,
          visionTrustMaterial,
        });
        builds.push(
          await executeIsoBuilder({
            builderBytes,
            stageDirectory,
            outputPath,
            workDirectory,
          }),
        );
      }
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
  const firstDigest = hashBytes(builds[0].bytes);
  const identical = builds.every(
    (build) =>
      hashBytes(build.bytes) === firstDigest &&
      build.bytes.equals(builds[0].bytes),
  );
  if (!identical) {
    const differences = [];
    const limit = Math.min(builds[0].bytes.length, builds[1].bytes.length);
    for (let index = 0; index < limit && differences.length < 12; index += 1) {
      if (builds[0].bytes[index] !== builds[1].bytes[index])
        differences.push(index);
    }
    throw new Error(
      `reproducibility check failed: Factory ISO output differs at byte offsets ${differences.join(",")}`,
    );
  }

  await mkdir(outputDirectory, { recursive: true });
  const fileName = outputName(validatedManifest);
  const outputPath = join(outputDirectory, fileName);
  await writeFile(outputPath, builds[0].bytes, { mode: 0o444 });
  const output = {
    role: "factory-iso",
    identity: `factory-cas://${firstDigest.replace(":", "/")}`,
    digest: firstDigest,
    fileName,
    bytes: builds[0].bytes.length,
    path: outputPath,
  };
  const reproducibilityEvidence = {
    mode: reproducibility ? "required" : "disabled",
    builds: buildCount,
    independentDirectories: true,
    independentProcesses: true,
    identical,
  };
  return {
    output,
    reproducibility: reproducibilityEvidence,
    provenance: makeProvenance(
      validatedManifest,
      resolvedAssets,
      output,
      reproducibilityEvidence,
      builds[0].structure,
      effectiveInputs,
    ),
  };
}
