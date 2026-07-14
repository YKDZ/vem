# Machine provisioning default API base URL

Factory media provides the Platform endpoint before a machine is claimed. Use the staging endpoint for acceptance media and the production endpoint only for production media. A seeded `machine-config.json` overrides VEM_DEFAULT_API_BASE_URL when the two values differ.

Run `scripts/windows/vending-daemon-smoke.ps1` with `-DefaultApiBaseUrl` and `-MaintenancePin` after the daemon starts. The smoke path reads `/v1/config/summary`, opens a short-lived local maintenance session, then submits the deliberately invalid claim through the typed Bring-Up task. It must receive a business rejection from the Platform `/machines/claim` path, not a backend-unavailable error.

Confirm the first boot UI with `-FirstBootMachineClaimCodePageObserved` and `-FirstBootBackendUrlInputAbsent`: it must show the Machine Claim Code page without a backend URL field. The one-time Factory bootstrap capability can create the first protected maintenance session; after it is consumed, supply the maintenance PIN rather than recreating a capability.
