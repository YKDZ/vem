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

This gate is a manual runtime gate, not a default pull-request check. It can prove runtime-ready and simulated-hardware-ready on the Machine Runtime Testbed, but it cannot prove production sell-ready.
