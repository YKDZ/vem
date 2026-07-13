# VM Runtime Acceptance Entrypoint

> Migration notice: the fixed host paths, repository-owned adapter, static relay
> plan, and password SSH steps in this document have been removed. The accepted
> replacement is
> [Windows Factory Runtime And Controlled Maintenance](./windows-factory-runtime-and-maintenance.md).
> None of those legacy mechanisms may satisfy the new Factory Image Acceptance
> or VM Runtime Acceptance gates, and they must be removed during migration.

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

The automated Windows runtime gate runs through a self-hosted runner and an
externally deployed VM Host Adapter. The repository owns the adapter protocol,
not VM names, paths, disk tools, or provider configuration. This gate is the
primary automation target for Windows-specific behavior, not a replacement for
GitHub-hosted Windows smoke.

Testbed Runner Maintenance Ingress is the explicit control-plane path from a self-hosted runner to a disposable Machine Runtime Testbed VM. It is not production controlled remote maintenance access. It may allow the runner to reach Windows SSH for the maintenance account through a narrowly scoped source allowlist, while preserving kiosk-account SSH denial and production defaults.

For the relay-backed path, bring up the test VPS WireGuard Maintenance Relay
with the [Maintenance Relay bring-up runbook](./maintenance-relay-bring-up.md)
before dispatching VM runtime acceptance. The workflow takes `vm_wireguard_ip`,
`runner_wireguard_peer_ip`, and `runner_wireguard_interface` inputs, starts the
runner WireGuard peer before Windows SSH readiness, and uses the VM WireGuard IP
as the Windows SSH host for both restore readiness and runtime acceptance. The
relay path remains Controlled Maintenance Ingress: WireGuard and SSH are implementation mechanisms, while the allowed source peer and target machine SSH
flow must stay explicit.

The repository workflow and VM host adapter do not bootstrap the VM-side relay.
The approved base image for the target VM must already include a configured and
running VM WireGuard peer plus Windows Controlled Maintenance Ingress allowing
the runner peer IP to SSH to the maintenance account. Before restore, the
workflow records this preconfigured-base-image contract in diagnostics and the
adapter validates it against the allowlisted target configuration. If that
contract is absent, restore fails clearly before destructive disk operations or
at Windows SSH readiness; it must not claim to auto-configure the VM peer or
Windows ingress.

Produce that relay-capable base image through the clean-base factory
preparation path, not a one-off host-specific mutation. Run
`scripts/testbed/win10-vem-e2e.mjs --mode clean-base-factory-acceptance` with
the optional Maintenance Relay inputs:

```sh
node scripts/testbed/win10-vem-e2e.mjs \
  --mode clean-base-factory-acceptance \
  --run-id <RUN-ID> \
  --clean-base-source <clean-windows-base-uri> \
  --daemon-artifact ./path/to/vending-daemon.exe \
  --machine-ui-artifact ./path/to/machine.exe \
  --maintenance-relay-wireguard-installer ./path/to/wireguard-amd64.msi \
  --maintenance-relay-wireguard-config ./.scratch/maintenance-relay/win10-vm.conf \
  --maintenance-relay-source-allowlist 10.91.1.10 \
  --remote <maintenance-user>@<clean-vm-host> \
  --allow-clean-base-prepare
```

The runner uploads the WireGuard installer and VM peer config as run-scoped
artifacts, verifies their hashes inside Windows, installs the tunnel service,
and enables the exact Controlled Maintenance Ingress allowlist. The VM peer
config contains private key material and must remain in operator-local scratch
or secret storage.

The VM host adapter prepares the Windows VM through strict
`vem-vm-host-adapter-request/v2` and `vem-vm-host-adapter-report/v2` contracts.
The workflow sends only a logical target, content-addressed approved base, and
requested capabilities to the runner-service adapter. The report's
`observed.targetBinding` must use `host-target-mapping/v1` and repeat that
logical target, so a host-specific VM identity cannot be substituted silently.
No host filesystem paths, VM names, disk paths, credentials, or host platform
options are present in workflow inputs or uploaded reports.

The lifecycle is explicit: `restore-approved-base` creates or restores a
disposable overlay and reports it `active`; runtime acceptance runs against
that overlay; display and default-audio capture are individual operations after
acceptance; `cleanup` runs with `always()` and must remove the overlay. A
successful adapter report must negotiate every requested capability and provide
every requested serial mapping. Timeout and cancellation send `SIGTERM` to the
adapter process group, escalate to `SIGKILL` when needed, wait for termination,
and invoke the same explicit cleanup operation before the client exits. Failed,
timed-out, and cancelled attempts write validated sanitized adapter diagnostics
for artifact upload, rather than being reported as Windows SSH readiness
failures.

The external adapter is selected by the runner service. The repository only
ships `scripts/testbed/run-vm-host-adapter.mjs`,
`scripts/testbed/vm-host-adapter-contract.mjs`, the request/report contract,
and a deterministic fake adapter for conformance tests. It should restore a
disposable runtime overlay from the approved factory runtime base image before
each run and must not rerun clean-base preparation for every runtime attempt.

The first self-hosted workflow is manually triggered with `workflow_dispatch` only. It must run as a single-flight infrastructure job and must not attach to pull-request or push events until VM restore, cleanup, locking, and failure recovery are proven stable.

The first workflow should be a dedicated `.github/workflows/vm-runtime-acceptance.yml` rather than part of the regular CI or Windows bring-up bundle workflows. It should consume the shared Windows runtime artifact workflow, call the VM host adapter for restore, post-acceptance capture, and always-run cleanup reports, prepare the ephemeral platform, run `scripts/testbed/win10-vem-e2e.mjs --mode vm-runtime-acceptance`, and upload the run-scoped acceptance artifacts.

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

- remote `VEM_KIOSK_PASSWORD`
- remote `VEM_MAINTENANCE_PASSWORD`
- remote `VEM_AUTOLOGON_PASSWORD`
- `MACHINE_CLAIM_LOOKUP_HMAC_KEY`
- `PAYMENT_MOCK_ENABLED=true`
- `VEM_MAINTENANCE_RELAY_RUNNER_WG_CONFIG` or runner-local
  `VEM_MAINTENANCE_RELAY_RUNNER_WG_CONFIG_PATH`

The self-hosted VM runner host must also provide `node`, `docker`, `virsh`,
`qemu-img`, `ssh`, `ssh-keygen`, `wg`, and `wg-quick`. Windows SSH readiness and
acceptance require the run-scoped private key and short-lived certificate passed
through `--identity` and `--certificate`; password SSH and password secrets are
not accepted. The workflow uploads
`maintenance-relay-diagnostics.txt` with only non-secret relay diagnostics:
interface name, runner peer IP, Windows SSH host, preconfigured VM relay
contract, `wg show` summaries, and WireGuard config existence, permissions, and
SHA-256 hashes. It must not include the full runner peer config, even with
private keys or preshared keys redacted.

This gate is a manual runtime gate, not a default pull-request check. It can prove runtime-ready and simulated-hardware-ready on the Machine Runtime Testbed, but it cannot prove production sell-ready.
