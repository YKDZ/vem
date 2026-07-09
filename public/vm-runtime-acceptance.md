# VM Runtime Acceptance Entrypoint

`scripts/testbed/win10-vem-e2e.mjs --mode vm-runtime-acceptance` is the future CI/manual runtime gate for the Win10 Machine Runtime Testbed. It is non-interactive and emits a structured report plus logs under `artifacts/vm-runtime-acceptance/<run-id>/`.

## Dry Run

Use dry-run before touching the VM:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode vm-runtime-acceptance \
  --run-id RUN-181 \
  --platform-target ephemeral-run-181 \
  --ephemeral-database-url postgres://vem_test:REDACTED@127.0.0.1:55432/vem_acceptance_run_181 \
  --ephemeral-api-base-url http://127.0.0.1:26849/api \
  --ephemeral-mqtt-url mqtt://127.0.0.1:1883 \
  --daemon-artifact ./path/to/vending-daemon.exe \
  --machine-ui-artifact ./path/to/machine.exe \
  --dry-run
```

The plan includes the child commands for dirty-host factory reset acceptance, ephemeral platform setup, runtime acceptance, and simulated hardware sale-flow. The entrypoint canonicalizes `--run-id` once and uses that value for the evidence root, service-api ephemeral setup, dirty-host acceptance, runtime acceptance, sale-flow evidence lookup, and default testbed machine identity. If `--machine-code` is supplied explicitly, it must be the same canonical identity that service-api can generate from the machine-code prefix plus canonical run id.

If clean-base factory evidence has already been produced by issue #182, pass it with `--clean-base-evidence artifacts/clean-base-factory-acceptance/<run-id>/clean-base-factory-acceptance.json`. The VM runtime plan then adds a non-blocking validation step that runs `validate-clean-base-evidence` and reports `cleanBasePreparationAcceptance` separately from dirty-host reset acceptance. Without that evidence, clean-base remains `not_asserted`.

## Live Run

Live mode uses the same arguments without `--dry-run`. The orchestrator writes:

- `vm-runtime-acceptance-report.json`
- `ephemeral-platform.json`
- child response JSON files for dirty-host factory acceptance, runtime acceptance, and simulated hardware sale-flow
- stdout/stderr logs for each step
- `screenshots/index.json`, which indexes any available screenshot artifacts and existing display proof; when no screenshot file is produced it is marked `missing`
- `sessions/index.json`, which indexes available interactive Windows session evidence and step artifact paths

## Safety Gates

The entrypoint refuses shared VPS or production targets for the ephemeral platform. Dry-run uses the same target guard as live service-api setup for known shared hosts and production database names such as `vem`, `vem_prod`, `vem_production`, `vem-vps`, and `vem_vps`. It requires explicit `--ephemeral-database-url`, `--ephemeral-api-base-url`, and `--ephemeral-mqtt-url`, plus the service-api setup flags `--allow-ephemeral-target` and `--allow-mock-payment`.

The simulated sale-flow step is only planned after the same run's `ephemeral-platform.json` path is known. The sale-flow child command still validates that evidence before it mutates runtime state.

## Self-Hosted Windows Runtime Gate

The first automated Windows runtime gate should run through a self-hosted runner on the current Unraid host at `192.168.2.23`, restoring or preparing the canonical Windows testbed VM before each acceptance run. The first version does not introduce a separate controller machine. This gate is the primary automation target for Windows-specific behavior, not a later replacement for GitHub hosted Windows smoke.

The runner contract must stay host-portable. Repository workflows should call a small VM restore/start/wait contract rather than depending directly on Unraid-only paths or UI behavior. The current implementation may use a `libvirt-qcow2` adapter on Unraid, but a later dedicated host or cloud server should be able to provide the same contract with a different adapter.

Testbed Runner Maintenance Ingress is the explicit control-plane path from a self-hosted runner to a disposable Machine Runtime Testbed VM. It is not production controlled remote maintenance access. It may allow the runner to reach Windows SSH for the maintenance account through a narrowly scoped source allowlist, while preserving kiosk-account SSH denial and production defaults.

For the relay-backed path, bring up the test VPS WireGuard Maintenance Relay
with `public/maintenance-relay-bring-up.md` before dispatching VM runtime
acceptance. The relay path remains Controlled Maintenance Ingress: WireGuard and
SSH are implementation mechanisms, while the allowed source peer and target
machine SSH flow must stay explicit.

The VM host adapter contract only prepares a reachable Windows VM. It takes a run id, a base image identity, and a target VM identity; it stops the VM, restores or rebuilds the disk, starts the VM, waits for Windows SSH, and emits restore evidence including the Windows SSH endpoint, observed host identity, base image hash, and evidence path. It must not build VEM artifacts, start the ephemeral platform, provision the machine, run runtime acceptance, run simulated sale-flow, or interpret VEM business results.

The adapter must emit a `vm-host-restore-report/v1` JSON report, and runtime acceptance should consume that report instead of inferring VM state from host-specific paths. The first report shape is:

```json
{
  "schemaVersion": "vm-host-restore-report/v1",
  "adapter": "libvirt-qcow2",
  "runId": "RUN-EXAMPLE",
  "targetVm": {
    "name": "win10-vem-solidified-acceptance"
  },
  "baseImage": {
    "path": "/mnt/user/isos/vem-factory-runtime-image-RUN-191-20260705.qcow2",
    "sha256": "lowercase-sha256"
  },
  "restoredDisk": {
    "path": "/mnt/user/domains/win10-vem-solidified-acceptance/vdisk1.qcow2",
    "backingFile": "/mnt/user/isos/vem-factory-runtime-image-RUN-191-20260705.qcow2"
  },
  "windowsSsh": {
    "host": "windows-host-or-ip",
    "user": "maintenance-user"
  },
  "result": "passed"
}
```

The repository adapter entrypoint should live at `scripts/testbed/vm-host-adapter.mjs` because it runs on the VM host or self-hosted runner, not inside the Windows VM. The first mode is `--mode restore --adapter libvirt-qcow2`, taking the run id, target VM identity, base image, overlay disk, Windows SSH user, and output report path. It must validate all destructive inputs against an allowlist before stopping a VM or replacing a disk.

The `libvirt-qcow2` allowlist should live in repository configuration at `scripts/testbed/vm-host-adapters/libvirt-qcow2.unraid.json`. It may contain non-secret infrastructure identities such as allowed VM names, overlay disk paths, base image paths, and the Windows maintenance SSH user. Secrets and credentials must remain in GitHub secrets or runner-local environment.

The first version should restore the runtime acceptance VM by rebuilding the `win10-vem-solidified-acceptance` qcow2 overlay from the approved factory runtime base image before each run. It should not rerun clean-base factory preparation for every runtime acceptance attempt. Clean-base factory acceptance remains the upstream evidence gate for producing or approving the factory runtime base image.

The first self-hosted workflow is manually triggered with `workflow_dispatch` only. It must run as a single-flight infrastructure job and must not attach to pull-request or push events until VM restore, cleanup, locking, and failure recovery are proven stable.

The first workflow should be a dedicated `.github/workflows/vm-runtime-acceptance.yml` rather than part of the regular CI or Windows bring-up bundle workflows. It should consume the shared Windows runtime artifact workflow, call the VM host adapter to produce `vm-host-restore-report.json`, prepare the ephemeral platform, run `scripts/testbed/win10-vem-e2e.mjs --mode vm-runtime-acceptance`, and upload the run-scoped acceptance artifacts.

Windows runtime artifacts are the current-run `vending-daemon.exe`, `machine.exe`, and `WebView2Loader.dll` built by the shared GitHub workflow. Dependency and compiler intermediates may use GitHub cache, but the final runtime artifacts are passed as same-run artifacts rather than reused across commits.

GitHub hosted Windows runner coverage may still be used for narrow build or script smoke checks, but it must not assert kiosk session readiness, shell launcher behavior, portrait display proof, virtual COM pair behavior, WebView kiosk startup, `runtimeReady`, `simulatedHardwareReady`, or production `sellReady`. Those remain self-hosted VM runtime acceptance or real hardware acceptance responsibilities.

Clean-base evidence is never inferred from the dirty-host testbed. `--clean-base-evidence` must point at a separate `clean-base-factory-acceptance-report/v1` report with `kind: clean-base-factory-acceptance`, `result: passed`, `ok: true`, `dryRun: false`, `source.kind: clean-windows-base`, lowercase SHA-256 artifact hashes, `cleanBasePreparationAcceptance: passed`, `dirtyHostResetAcceptance: not_asserted`, `sellReady: not_asserted`, the complete Factory Windows Baseline policy contract (`schemaVersion`, `model`, `requiredCapabilities`, `disabledRuntimeInterference`, and `evidenceFields`), and every required assertion passed. The required assertions cover display orientation/resolution, SSH reachability through the clean VM or temporary factory harness, Tailscale absent by default, Windows update installation and automatic restart disabled, sleep/hibernation disabled, testsigning off, Defender/firewall posture with SMB/File Sharing not enabled and no default product-managed inbound remote access rule, Factory Remote Maintenance Capability with `sshd_config` explicitly denying kiosk SSH, Windows 10 Pro consumer-experience best-effort policy evidence, autologon, shell launcher or scheduled task startup, daemon service, UI launcher/task, clean runtime reset gate, simulated hardware mode, startup reaching bring-up or sales-eligible state, and absence of retained VEM identity/state/secrets/evidence.

The Factory Image Delivery Unit report generated from clean-base evidence is a
reviewable delivery index. It does not replace the clean-base acceptance report
as the runtime gate input, and it must not assert runtime-ready,
simulated-hardware-ready, or sell-ready status on its own.

The existing `100.68.189.11` / `192.168.2.161` retained-state VM remains dirty-host evidence unless it has first been rebuilt from a clean base and documented by the clean-base acceptance report. Known dirty identifiers (`win10-vem-e2e`, `DESKTOP-2STVS5B`, dirty/retained labels) and production identities (`vem`, `100.66.207.119`, `VEM-WIN10-REAL-01`, `Admin@real`) are refused as clean-base sources.

The final `vm-runtime-acceptance-report.json` is sanitized before it is written as a CI artifact. It does not include full child command arrays or parsed child subreports, and it redacts Postgres URL passwords plus `claimCode`, `secret`, `token`, and `password` values in diagnostic text.

The report distinguishes:

- `dirtyHostResetAcceptance`
- `cleanBasePreparationAcceptance` as `not_asserted`, or as `passed` only when optional clean-base evidence validates against the clean-base contract; missing, failed, dirty-source, dry-run, or invalid evidence is reported as failed and not asserted
- `runtimeReady`
- `simulatedHardwareReady`
- `sellReady` as `not_asserted`

If dirty-host display proof, platform setup, runtime acceptance, or sale-flow fails, later dependent steps are marked `blocked` rather than treated as passed.

## Required Secrets And Environment

Future CI or a self-hosted runner must provide:

- `SSHPASS`, when using `--sshpass` or `--factory-credentials-from-sshpass`
- remote `VEM_KIOSK_PASSWORD`
- remote `VEM_MAINTENANCE_PASSWORD`
- remote `VEM_AUTOLOGON_PASSWORD`
- `MACHINE_CLAIM_LOOKUP_HMAC_KEY`
- `PAYMENT_MOCK_ENABLED=true`

The self-hosted VM runner host must also provide `node`, `docker`, `virsh`, `qemu-img`, `ssh`, and `sshpass`. The `sshpass` binary is required when the workflow uses the repository secret `VEM_TESTBED_WINDOWS_PASSWORD` for Windows SSH readiness and acceptance commands instead of a runner-local SSH key.

This gate is a manual runtime gate, not a default pull-request check. It can prove runtime-ready and simulated-hardware-ready on the Machine Runtime Testbed, but it cannot prove production sell-ready.
