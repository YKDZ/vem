# Maintenance Relay Migration

The legacy Service API renderer is retired. It must not be used to create
WireGuard peer files or firewall commands.

The maintained implementation is the independently deployed
`apps/maintenance-relay` application. It exchanges
the credential from `MAINTENANCE_RELAY_CREDENTIAL_FILE` for a short-lived
`maintenance_relay` token,
pulls versioned desired state from Service API, applies peers with `wg syncconf`,
and atomically replaces only the `inet vem_maintenance_relay` nftables table.
The table uses source, target, protocol, and port tuples with kernel timeouts;
WireGuard connectivity alone does not allow SSH.

The production image creates and owns its WireGuard interface. It includes only
the compiled relay, production dependencies, and the `ip`, `wg`, and `nft`
tools needed for the kernel data plane. The container entrypoint reads its
credential and WireGuard private key from read-only secret files; neither is an
environment-variable example or a repository artifact.

Every peer reconcile writes only a public peer fragment as a `0600` file in the
relay runtime tmpfs. Node invokes the fixed image helper with a spawn argument
array. The helper streams the read-only private-key secret into a separate
`0600` full config containing `PrivateKey`, `ListenPort = 51820`, and the peer
fragment, calls `wg syncconf`, and removes the full config on success, failure,
or signal. Unique working directories and serialized reconciles prevent
concurrent config reuse. The relay private key is never part of an environment
value, API payload, desired or observed state, persistent journal, or log.

The relay requires HTTPS for `SERVICE_API_BASE_URL` by default. The only
insecure exception is `MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP=true`, and it is
accepted only when the HTTP destination is loopback, RFC1918, or a single-label
private container-network destination. The relay reports that exception as
degraded transport health through its observed state, which the Admin Operations
Console displays. Public, link-local, and dotted non-private HTTP destinations
are rejected at startup.

Its development configuration is:

```text
SERVICE_API_BASE_URL=https://service-api.example/api/
MAINTENANCE_RELAY_CREDENTIAL_FILE=/run/secrets/maintenance_relay_credential
MAINTENANCE_RELAY_INTERFACE=wg0
MAINTENANCE_RELAY_TUNNEL_ADDRESS=10.91.0.1
MAINTENANCE_RELAY_POLL_INTERVAL_MS=5000
MAINTENANCE_RELAY_JOURNAL_PATH=/run/vem/maintenance-relay/journal.json
MAINTENANCE_RELAY_HEALTH_PORT=8080
```

Run it with `pnpm --filter maintenance-relay start` during development. The
production deployment sample is
`apps/maintenance-relay/compose.production.example.yaml`. It gives the relay a
dedicated bridge network namespace, publishes only UDP 51820, drops every Linux
capability except `NET_ADMIN`, uses a read-only filesystem, and supplies only
`/tmp` and `/run` as restricted tmpfs mounts. The `maintenance_relay_private_key`
and credential are Compose secrets mounted read-only at `/run/secrets`.

Management health listens only on `127.0.0.1:8080` inside the relay namespace
and is intentionally not published. `GET /healthz` returns a small JSON
transport contract: HTTPS is `healthy`; an explicitly allowed insecure HTTP
destination is `degraded` with its reason. It never reports credentials, private
keys, desired peer data, or firewall state.

The Admin Operations Console classifies a relay report as stale after the
control-plane freshness window. A stale or never-reported relay has unknown
overall health; it is never inferred to be healthy from its last transport mode.

The test-only privileged image under `apps/maintenance-relay/test/privileged`
remains for required real-kernel nftables verification. The production container
does not proxy SSH in user space and never accepts API-provided shell text.

Run `pnpm --filter maintenance-relay test:container` to build the production
image and verify its contents, runtime user, capabilities, mounts, read-only
filesystem, published ports, loopback health contract, and degraded insecure
transport policy with a real `docker run`.
