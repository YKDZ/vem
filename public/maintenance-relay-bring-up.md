# Maintenance Relay Migration

The former Service API static relay planner and iptables renderer are retired.
They must not be used to create WireGuard peer files or firewall commands.

The maintained implementation is the independently deployed
`apps/maintenance-relay` application. It exchanges
`MAINTENANCE_RELAY_CREDENTIAL` for a short-lived `maintenance_relay` token,
pulls versioned desired state from Service API, applies peers with `wg syncconf`,
and atomically replaces only the `inet vem_maintenance_relay` nftables table.
The table uses source, target, protocol, and port tuples with kernel timeouts;
WireGuard connectivity alone does not allow SSH.

The relay needs an existing WireGuard interface and the `wg` and `nft` tools.
Its minimum runtime configuration is:

```text
SERVICE_API_BASE_URL=https://service-api.example/api/
MAINTENANCE_RELAY_CREDENTIAL=<relay credential secret>
MAINTENANCE_RELAY_INTERFACE=wg0
MAINTENANCE_RELAY_POLL_INTERVAL_MS=5000
MAINTENANCE_RELAY_JOURNAL_PATH=/var/lib/vem/maintenance-relay/journal.json
```

Run it with `pnpm --filter maintenance-relay start` during development. The
test-only privileged image under `apps/maintenance-relay/test/privileged` is
for required real-kernel verification; it is not a production deployment
artifact. The relay does not proxy SSH in user space and never accepts API-provided shell text.

Container namespace, capability, filesystem, published-port, HTTPS exception,
production packaging, and transport policy are tracked separately in issue 03.
