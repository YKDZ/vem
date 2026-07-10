# Clean-Base Factory Acceptance

> Migration notice: the platform-specific source and Unraid values in this
> document describe the current legacy testbed only. They are superseded as
> normative architecture by
> [Windows Factory Runtime And Controlled Maintenance](./windows-factory-runtime-and-maintenance.md).
> New implementation must use the platform-neutral Factory ISO, Factory
> Personalization Media, runner-local adapter, and hash-addressed evidence
> contracts defined there. The Unraid source contract below must be removed
> before the new Factory Image Acceptance gate is declared passing.

`scripts/testbed/win10-vem-e2e.mjs --mode clean-base-factory-acceptance` 是 clean-base factory preparation 的规范入口。它记录干净 Windows 基础来源、必需基线、状态缺失检查、准备关口、验证器证据以及可复用的 snapshot/report 路径；只有显式允许 live mode 后，才会把固定 runtime artifacts 分发到既有 clean VM，执行 factory preparation 和 verifier，并写出机器可校验的 clean-base acceptance evidence。

## Clean Source Boundary

这个 gate 的干净 Windows 来源必须是 Unraid 主机 `/mnt/user/isos` 目录下的一个已确认 Windows 10 ISO，然后由该 ISO 新建 canonical clean-base VM，并在 factory preparation 前创建 clean snapshot。现场记录不能只写目录、URI prefix 或占位符；必须记录具体 ISO 文件名和 ISO 文件的 SHA-256。

仓库当前不知道最终批准使用的 ISO 文件名，因此 runbook 只固定证据字段和命名规则，不把尖括号形式的示例占位符当作 source identity。clean-base evidence 必须在 `source.iso.fileName`、`source.iso.sha256` 和 `source.iso.uri` 中记录实际 ISO 身份，其中 `source.iso.uri` 必须等于 `unraid://192.168.2.23/isos/` 加上实际 ISO 文件名。

后续来源链是：实际 ISO identity -> `unraid://192.168.2.23/vms/win10-vem-clean-base` -> `snapshot:vem-clean-base-before-factory-prep`。现有 retained-state Machine Runtime Testbed VM 即使本地 reset，仍然只能作为 dirty-host evidence。它可以用于开发和 dirty-host runtime acceptance，但 clean-base evidence 必须来自 ISO 新建的 canonical VM 及其 clean snapshot。

## Source Contract

以下 contract 是 public runbook 的稳定机器校验锚点。检查脚本应校验这些结构化字段，不应依赖章节散文。

```json clean-base-source-contract/v1
{
  "schemaVersion": "clean-base-source-contract/v1",
  "iso": {
    "storageHost": "192.168.2.23",
    "storageDirectory": "/mnt/user/isos",
    "uriPrefix": "unraid://192.168.2.23/isos/",
    "fileNameEvidenceField": "source.iso.fileName",
    "sha256EvidenceField": "source.iso.sha256",
    "uriEvidenceField": "source.iso.uri",
    "fileNamePattern": "^[^/\\\\]+\\.iso$",
    "sha256Pattern": "^[a-f0-9]{64}$",
    "uriRule": "source.iso.uri == iso.uriPrefix + source.iso.fileName",
    "placeholderIdentityAllowed": false
  },
  "canonicalVm": {
    "uri": "unraid://192.168.2.23/vms/win10-vem-clean-base",
    "sourceEvidenceField": "source.uri"
  },
  "cleanSnapshot": {
    "name": "vem-clean-base-before-factory-prep",
    "uri": "snapshot:vem-clean-base-before-factory-prep",
    "boundary": "pre-factory-preparation",
    "evidenceField": "source.snapshot"
  },
  "acceptanceEvidence": {
    "pathPattern": "artifacts/clean-base-factory-acceptance/<RUN-ID>/clean-base-factory-acceptance.json",
    "schemaVersion": "clean-base-factory-acceptance-report/v1",
    "kind": "clean-base-factory-acceptance"
  },
  "sourceChain": [
    "approved-windows-10-iso",
    "canonical-clean-base-vm",
    "pre-factory-preparation-snapshot",
    "clean-base-factory-acceptance-report"
  ],
  "allowedBeforeCleanSnapshot": [
    "windows-install-from-declared-iso",
    "temporary-administrator-access",
    "ssh-maintenance-reachability",
    "portrait-display-baseline",
    "temporary-network-setup",
    "clean-snapshot-creation"
  ],
  "forbiddenBeforeCleanSnapshot": [
    "vem-runtime-installation",
    "machine-provisioning-claim",
    "production-identity-or-secrets",
    "inventory-product-payment-or-order-state",
    "unrecorded-windows-tuning"
  ],
  "dirtySourcePolicy": {
    "retainedStateTestbed": "dirty-host-evidence-only",
    "localResetDoesNotPromoteCleanBase": true
  }
}
```

clean-base acceptance report 的 `source.uri` 必须是 `unraid://192.168.2.23/vms/win10-vem-clean-base`，`source.snapshot` 必须是 `vem-clean-base-before-factory-prep`。ISO provenance 需要记录实际文件名、实际 SHA-256 和实际 `source.iso.uri`；runtime acceptance 消费 VM URI 和 snapshot boundary，因为仓库 runner 只准备既有 VM，不创建 Unraid VM。

retained-state Machine Runtime Testbed VM 只有在从上述 ISO-created canonical clean base 重建，并且 clean-base acceptance report 记录完整 source chain 后，才能成为 clean-base evidence。仅执行本地 reset、删除 VEM 目录、重新跑 factory preparation 或拿到 passing dirty-host acceptance report，都不能把 retained-state VM 提升为 clean-base evidence。

### Clean Snapshot 前允许

clean snapshot 前允许的人工初始化范围必须保持很小。

clean snapshot 前只允许以下人工初始化：

- 从已记录具体文件名和 SHA-256 的 Unraid ISO 安装 Windows。
- 为完成安装、进入 VM、执行基线设置而使用的临时管理员访问。
- 为验证维护访问而启用 SSH reachability。
- 为所需竖屏交互式桌面姿态记录显示基线。
- 为安装 Windows、连通 SSH、记录基线而必需的临时网络配置。
- 创建 `vem-clean-base-before-factory-prep` clean snapshot。

这些动作只定义 Windows base 和访问路径，不得安装或配置 VEM runtime 行为。

### Clean Snapshot 前禁止

clean snapshot 前禁止引入任何 VEM runtime 或业务状态。

clean snapshot 必须早于以下任何事项：

- 手工安装 VEM runtime、复制 `vending-daemon.exe` 或 `machine.exe`、预置 `C:\VEM\bringup` 内容，或临时创建运行时服务/任务。
- Machine provisioning claim，或任何面向平台机器的 `claim` 流程。
- 生产 identity/secrets，包括真实机器编码、生产 provisioning profile、生产 API/MQTT credentials、支付 secrets、claim codes、tokens 或 passwords。
- 来自生产环境、共享 VPS、retained testbed runs 或历史 acceptance attempts 的库存、产品、支付或订单状态。
- 未记录的 Windows tuning，包括未追踪的更新策略修改、服务移除、驱动调整、注册表修改、防火墙例外、计划任务、桌面/kiosk shell 修改或安全姿态修改。

如果发现任何禁止状态，该 VM 不能作为 clean-base evidence。要么从 ISO source chain 重新构建，要么只把该 host 当作 dirty-host evidence。

## Dry Run

Run this first from the repository:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode clean-base-factory-acceptance \
  --run-id RUN-182 \
  --clean-base-source unraid://192.168.2.23/vms/win10-vem-clean-base \
  --clean-base-snapshot vem-clean-base-before-factory-prep \
  --daemon-artifact-sha256 <sha256> \
  --machine-ui-artifact-sha256 <sha256> \
  --dry-run
```

The plan emits `clean-base-factory-acceptance-plan/v1` and writes no remote state. It refuses known dirty-host sources such as the existing `100.68.189.11` / `192.168.2.161` / `win10-vem-e2e` / `DESKTOP-2STVS5B` testbed, plus real production identities such as `vem`, `100.66.207.119`, `VEM-WIN10-REAL-01`, and `Admin@real`, so that retained-state reset evidence or the industrial PC cannot be mislabeled as clean-base proof. Declared daemon and machine UI artifact hashes must be lowercase SHA-256 values.

## Live Orchestration

Live clean-base preparation requires `--allow-clean-base-prepare` before the runner creates remote staging directories, uploads scripts, uploads artifacts, or runs any mutating PowerShell on the VM:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode clean-base-factory-acceptance \
  --run-id RUN-185 \
  --clean-base-source unraid://192.168.2.23/vms/win10-vem-clean-base \
  --clean-base-snapshot vem-clean-base-before-factory-prep \
  --daemon-artifact ./path/to/vending-daemon.exe \
  --machine-ui-artifact ./path/to/machine.exe \
  --daemon-artifact-sha256 <sha256> \
  --machine-ui-artifact-sha256 <sha256> \
  --maintenance-relay-wireguard-installer ./path/to/wireguard-amd64.msi \
  --maintenance-relay-wireguard-config ./.scratch/maintenance-relay/win10-vm.conf \
  --maintenance-relay-source-allowlist 10.91.1.10 \
  --remote <maintenance-user>@<clean-vm-host> \
  --allow-clean-base-prepare
```

The machine UI artifact must have `WebView2Loader.dll` next to `machine.exe`. Live clean-base mode rejects `--use-existing-remote-artifacts`; it must upload local daemon, machine UI, and WebView2 sidecar artifacts for the run. The runner hashes local daemon/UI artifacts before upload and refuses mismatches against declared hashes. Before upload or any remote directory/script staging, it refuses known dirty-host or production remote identifiers and probes the remote hostname, Controlled Maintenance Ingress endpoint identity, and retained-state absence through read-only SSH. The retained-state absence probe covers `C:\VEM\bringup`, `C:\ProgramData\VEM\bringup`, `C:\ProgramData\VEM\provisioning`, `C:\ProgramData\VEM\secrets`, `C:\ProgramData\VEM\overrides`, `C:\ProgramData\VEM\evidence`, `C:\ProgramData\VEM\vending-daemon`, the `VemVendingDaemon` service, and `VEMMachineUI` / `VEM\StartVisionServer` tasks. On the remote VM it repeats the clean source identity and retained-state absence checks before staging inputs, then runs `prepare-factory-runtime.ps1` without dirty-host reset mode, runs `verify-factory-runtime.ps1`, collects `factory-runtime-preparation.json`, `factory-runtime-verification-action.json`, `factory-runtime-verification.json`, and writes `clean-base-factory-acceptance.json`.

The Maintenance Relay options are optional for a generic factory image, but are
required for the relay-backed GitHub VM runtime acceptance base image. They are
local artifacts, not repository files: the runner uploads the WireGuard
installer and the VM peer config to the remote staging directory, verifies
their SHA-256 hashes on Windows, installs the tunnel as a Windows service, and
enables `VEM Controlled Maintenance SSH` only for the supplied runner peer IP.
The config contains the VM private key and must stay in operator-local scratch
or secret storage.

Failure reports include structured diagnostics such as `clean_base_identity_refused`, `clean_base_preflight_failed`, `factory_input_staging_failed`, `factory_preparation_failed`, and `factory_verifier_failed`; operators should treat raw command output as supporting detail, not as the primary failure contract.

## Evidence Contract

The acceptance report path is:

```text
artifacts/clean-base-factory-acceptance/<RUN-ID>/clean-base-factory-acceptance.json
```

The Factory Image Delivery Unit report is generated from that completed
acceptance report:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode factory-image-delivery-unit \
  --clean-base-evidence artifacts/clean-base-factory-acceptance/<RUN-ID>/clean-base-factory-acceptance.json \
  --out artifacts/clean-base-factory-acceptance/<RUN-ID>/factory-image-delivery-unit-report.json
```

The delivery report is a sanitized review index, not a VM mutation step. It
ties together the clean image or snapshot source identity, declared build
inputs, daemon and machine UI artifact hashes, factory manifest reference,
preparation logs, verifier evidence, screenshot/session evidence availability,
and the clean-base acceptance report reference. When screenshots or interactive
session artifacts are not available, their indexes are explicitly marked
`missing`.

The report must use `schemaVersion: clean-base-factory-acceptance-report/v1`, `kind: clean-base-factory-acceptance`, `result: passed`, `ok: true`, and `dryRun: false`. Its `source.kind` must be `clean-windows-base`, with a non-dirty/non-production `source.uri` and machine identity details. #181 validates this contract before it can assert clean-base readiness; arbitrary JSON, dirty-host reports, dry-run plans, failed reports, or reports with missing assertions are treated as failed clean-base evidence and do not change runtime acceptance.

The report must include machine-checkable assertions:

- `displayOrientationResolution`: `1080x1920` portrait
- `sshReachability`: SSH available on the clean VM or temporary factory harness while preparing/verifying the image
- `tailscaleDefaultAbsent`: Tailscale service and CLI are absent by default
- `windowsUpdatePolicy`: automatic update installation and automatic restart disabled
- `powerPolicy`: sleep and hibernation disabled
- `bootPolicy`: Windows `testsigning` off
- `securityPosture`: Defender and firewall enabled, with VEM runtime exclusions, no default product-managed inbound remote access rule, and SMB/File Sharing not enabled as a maintenance entry
- `factoryRemoteMaintenanceCapability`: factory preparation installs/enables OpenSSH Server for maintenance-account isolation without installing Tailscale by default; maintenance users are allowed through `OpenSSH Users` while kiosk SSH is explicitly denied through `sshd_config`
- `maintenanceRelay`: when enabled for the relay-backed runtime test base image,
  WireGuard is installed, the VM tunnel service starts automatically, the
  staged config hash matches the declared hash, and `VEM Controlled Maintenance
SSH` exactly matches the runner peer source allowlist
- `consumerExperienceInterference`: consumer foreground interference policies configured, Store automatic app updates disabled, and kiosk foreground takeover recorded as Windows 10 Pro best-effort policy evidence
- `sleepDisabled`: S3/S4 or equivalent sleep states disabled
- `testsigningOff`: Windows `testsigning` off
- `autologonConfigured`: kiosk autologon configured
- `startupLauncherMode`: shell launcher or scheduled task mode configured
- `daemonService`: `VemVendingDaemon` installed and configured
- `uiLauncherTask`: `VEMMachineUI` launcher/task configured
- `runtimeResetGateClean`: reset gate confirms no retained VEM runtime state
- `simulatedHardwareMode`: runtime configured for simulated hardware mode
- `startupReachesBringUpOrSalesEligible`: startup reaches bring-up or sales-eligible state
- preflight absence proof for machine identity, provisioning profile, protected secrets, daemon state, previous VEM evidence, retained bring-up directories, daemon service, and startup tasks
- factory runtime preparation result, factory manifest path, verifier result, and `factory-runtime-verification.json`
- explicit readiness levels: `cleanBasePreparationAcceptance: passed`, `dirtyHostResetAcceptance: not_asserted`, `runtimeReady: not_asserted`, `simulatedHardwareReady: not_asserted`, and `sellReady: not_asserted`

The Factory Image Delivery Unit report must use
`schemaVersion: factory-image-delivery-unit-report/v1` and `kind:
factory-image-delivery-unit`. It repeats readiness as assertion objects and may
only assert `cleanBasePreparationAcceptance` from the completed clean-base
report. `dirtyHostResetAcceptance`, `runtimeReady`, `simulatedHardwareReady`,
and `sellReady` remain `not_asserted` until their own gates produce evidence.
The report is sanitized before writing: claim codes, secrets, tokens,
passwords, production machine identity, and field network credentials must not
appear in the delivery artifact.

Minimal report shape:

```json
{
  "schemaVersion": "clean-base-factory-acceptance-report/v1",
  "kind": "clean-base-factory-acceptance",
  "result": "passed",
  "ok": true,
  "dryRun": false,
  "source": {
    "kind": "clean-windows-base",
    "uri": "unraid://192.168.2.23/vms/win10-vem-clean-base",
    "snapshot": "vem-clean-base-before-factory-prep"
  },
  "factoryWindowsBaselinePolicy": {
    "schemaVersion": "factory-windows-baseline-policy/v1",
    "model": "allowlist",
    "requiredCapabilities": [
      "defender_enabled",
      "firewall_enabled",
      "no_default_product_remote_ingress",
      "vem_runtime_defender_exclusions",
      "openssh_server_for_maintenance_users",
      "tailscale_not_installed_by_default",
      "kiosk_account_denied_remote_access",
      "windows_event_logging",
      "powershell_management",
      "networking_certificates_time_sync",
      "webview2_runtime_support",
      "display_touch_usb_serial_drivers",
      "fonts_input_methods"
    ],
    "disabledRuntimeInterference": [
      "windows_auto_update_installation",
      "windows_auto_update_auto_restart",
      "sleep",
      "hibernation",
      "testsigning",
      "store_automatic_app_updates",
      "consumer_experience_autostart",
      "consumer_experience_foreground_popups",
      "consumer_experience_kiosk_foreground_takeover_best_effort"
    ],
    "evidenceFields": {
      "windowsUpdatePolicy": "assertions.windowsUpdatePolicy",
      "powerPolicy": "assertions.powerPolicy",
      "bootPolicy": "assertions.bootPolicy",
      "securityPosture": "assertions.securityPosture",
      "remoteMaintenanceCapability": "assertions.factoryRemoteMaintenanceCapability",
      "consumerExperienceInterference": "assertions.consumerExperienceInterference"
    }
  },
  "artifacts": {
    "daemonSha256": "<lowercase-sha256>",
    "machineUiSha256": "<lowercase-sha256>"
  },
  "readiness": {
    "cleanBasePreparationAcceptance": "passed",
    "dirtyHostResetAcceptance": "not_asserted",
    "runtimeReady": "not_asserted",
    "simulatedHardwareReady": "not_asserted",
    "sellReady": "not_asserted"
  },
  "assertions": {
    "displayOrientationResolution": {
      "status": "passed",
      "orientation": "portrait",
      "widthPx": 1080,
      "heightPx": 1920
    },
    "sshReachability": { "status": "passed" },
    "tailscaleDefaultAbsent": { "status": "passed" },
    "windowsUpdatePolicy": {
      "status": "passed",
      "automaticUpdateInstallation": "disabled",
      "automaticRestart": "disabled"
    },
    "powerPolicy": {
      "status": "passed",
      "sleep": "disabled",
      "hibernation": "disabled"
    },
    "bootPolicy": {
      "status": "passed",
      "testsigning": "off"
    },
    "securityPosture": {
      "status": "passed",
      "defender": "enabled",
      "firewall": "enabled",
      "defenderExclusions": ["C:\\VEM\\bringup", "C:\\ProgramData\\VEM"],
      "inboundFirewallRules": [],
      "enabledVemInboundRules": [],
      "fileAndPrinterSharing": "not_enabled"
    },
    "factoryRemoteMaintenanceCapability": {
      "status": "passed",
      "opensshServer": "available",
      "tailscale": "not_installed_by_default",
      "kioskRemoteAccess": "denied",
      "maintenanceUsersOnly": true,
      "sshdConfigDeniesKioskUser": true
    },
    "consumerExperienceInterference": {
      "status": "passed",
      "componentAutostart": "policy_configured",
      "foregroundPopups": "policy_configured",
      "storeAutomaticAppUpdates": "disabled",
      "kioskForegroundTakeover": "best_effort_policy_configured"
    },
    "sleepDisabled": { "status": "passed" },
    "testsigningOff": { "status": "passed" },
    "autologonConfigured": { "status": "passed" },
    "startupLauncherMode": { "status": "passed" },
    "daemonService": { "status": "passed" },
    "uiLauncherTask": { "status": "passed" },
    "runtimeResetGateClean": { "status": "passed" },
    "simulatedHardwareMode": { "status": "passed", "mode": "simulated" },
    "startupReachesBringUpOrSalesEligible": {
      "status": "passed",
      "state": "bring_up"
    },
    "preflightNoMachineIdentity": { "status": "passed" },
    "preflightNoProvisioningProfile": { "status": "passed" },
    "preflightNoProtectedSecrets": { "status": "passed" },
    "preflightNoDaemonState": { "status": "passed" },
    "preflightNoPreviousVemEvidence": { "status": "passed" }
  }
}
```

## Destructive Gate

Live clean-base preparation must require `--allow-clean-base-prepare`. The repository entrypoint only accepts an existing clean VM; it does not create, reimage, or snapshot Unraid VMs. Any future script that cleans, reimages, or snapshots the VM must keep the same explicit allow flag and must not target the real `vem` industrial PC, a retained dirty-host testbed, or any production machine identity.

## Repository Script Boundary

Factory image preparation scripts kept in the repository must be repeatable production or testbed entrypoints, verifier/test guards for those entrypoints, or currently referenced runbook operations. One-off scripts for a specific Unraid VM, ISO installation attempt, local path, temporary credential handoff, or historical smoke must stay outside the repository unless they are promoted into a parameterized canonical runner with tests and documented evidence output.

The clean-base implementation must include a script inventory check before delivery. Each script under `scripts/` should have an owner/use category or be removed when it is no longer referenced by a package script, public runbook, acceptance entrypoint, or verifier. No retained script may bypass factory manifests, verifier output, or acceptance evidence for the image preparation path.

Retained factory preparation scripts:

- `scripts/testbed/win10-vem-e2e.mjs`: canonical clean-base and VM runtime acceptance entrypoint.
- `scripts/windows/prepare-factory-runtime.ps1`: canonical Windows factory runtime preparation entrypoint.
- `scripts/windows/verify-factory-runtime.ps1`: verifier that writes `factory-runtime-verification.json`.
- `scripts/check-repository-script-inventory.mjs`: repository guard that keeps retained scripts classified and blocks image-prep shortcuts that bypass manifest, verifier, or acceptance evidence.

## VM Runtime Acceptance Handoff

After a clean-base report exists, pass it into the issue #181 runtime gate:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode vm-runtime-acceptance \
  --run-id RUN-182 \
  --platform-target ephemeral-run-182 \
  --ephemeral-database-url postgres://vem_test:REDACTED@127.0.0.1:55432/vem_acceptance_run_182 \
  --ephemeral-api-base-url http://127.0.0.1:26849/api \
  --ephemeral-mqtt-url mqtt://127.0.0.1:1883 \
  --clean-base-evidence artifacts/clean-base-factory-acceptance/RUN-182/clean-base-factory-acceptance.json \
  --daemon-artifact ./path/to/vending-daemon.exe \
  --machine-ui-artifact ./path/to/machine.exe \
  --dry-run
```

Without `--clean-base-evidence`, VM runtime acceptance continues to report `cleanBasePreparationAcceptance` as `not_asserted`.
