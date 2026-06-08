# Machine provisioning default API Base URL

This runbook is for machine installer and bring-up automation. The default API
Base URL points at the existing service API claim endpoint; it is not a separate
provisioning service.

## Values

Use the environment-specific service API `/api` base:

| Environment | Default API Base URL |
| --- | --- |
| staging | `https://staging-api.example.com/api` |
| production | `https://api.example.com/api` |

## Configure

Preferred installer path:

```powershell
.\scripts\windows\vending-daemon-smoke.ps1 `
  -DaemonExe C:\VEM\vending-daemon.exe `
  -MachineUiExe C:\VEM\machine.exe `
  -DataDir C:\ProgramData\VEM\vending-daemon `
  -DefaultApiBaseUrl https://staging-api.example.com/api
```

The script writes `VEM_DEFAULT_API_BASE_URL` as a service-level environment
value before starting the daemon. On first boot, the daemon seeds
`machine-config.json` with that API Base URL and the machine UI shows the
standard Machine Claim Code page.

When the script launches the machine UI, answer the first-boot prompts only
after confirming the visible page is Machine Claim Code and the UI does not show
or require a backend URL input. For a non-interactive run where an operator has
already made the same visual checks, pass
`-FirstBootMachineClaimCodePageObserved` and
`-FirstBootBackendUrlInputAbsent`.

Production uses the same command with `https://api.example.com/api`.

If a deployment already writes `machine-config.json`, set `apiBaseUrl` there.
An existing `machine-config.json` overrides VEM_DEFAULT_API_BASE_URL, so a field
service override in the data dir is not replaced by the service environment.

## Verify

1. Start the daemon and read `daemon-ready.json` from the data dir.
2. Call `GET /v1/config` on the ready file base URL with the ready file bearer
   token. Confirm `public.apiBaseUrl` is the staging or production value.
3. Confirm `runtimeFlags.advancedMaintenanceConfig` is false unless admin
   tooling explicitly enabled it.
4. Open the machine UI on an unclaimed machine. The first boot screen should
   show Machine Claim Code only; it should not ask the operator for a backend
   URL.
5. The smoke script calls daemon IPC `POST /v1/provisioning/claim` with the
   deliberately invalid test claim code `WXYZ-2345`. The daemon must forward to
   the service API `/machines/claim` endpoint under the configured API Base URL.

For this non-consuming connectivity check, expect a safe invalid-code response
such as `machine_claim_invalid_or_expired` from the service API path. A network
or DNS failure should surface as `machine_claim_backend_unavailable` and fails
the smoke.
