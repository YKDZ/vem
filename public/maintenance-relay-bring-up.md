# Maintenance Relay Bring-up Runbook

This runbook brings up the first Controlled Maintenance Ingress relay on the
test VPS. The initial relay entrypoint is WireGuard UDP 51820 on the existing
test VPS, with the Service API maintenance relay planner supplying the public
plan, WireGuard templates, and fail-closed firewall ACLs.

The relay data plane is Linux WireGuard plus Linux firewall rules. It is not a
long-running Node service. The `apps/service-api` maintenance relay module is
control-plane tooling: it validates the relay plan, renders WireGuard config
from externally supplied secrets, and renders an `iptables` ACL plan.

Do not write private keys to the repository, public docs, issue comments, CI
artifacts, or shell history; private keys must not be committed. Store relay,
runner, and machine private keys only in the relay host secret location,
runner-local secret storage, GitHub secrets, or the Windows VM secret store used
for the active verification.

## Scope

This runbook is for a human-in-the-loop test VPS bring-up. It does not configure
the real VPS by itself, does not define production maintenance policy, and does
not make VM runtime acceptance a default pull-request check.

The first intended session is:

- source peer: `github-runner`
- target peer: `win10-vm`
- allowed protocol: TCP
- allowed port: `22`
- denied flows: machine-to-runner, machine-to-machine, relay-to-machine SSH,
  and any unstated peer forwarding

## Generate The Public Plan

From the repository root, inspect the non-secret sample plan:

```sh
pnpm --filter service-api maintenance-relay:plan -- --dry-plan
```

The default sample plan is safe for a dry demo because it contains sample public
keys, peer names, roles, tunnel IPs, sessions, and firewall commands, but no
private keys. Confirm the relay fields before touching the VPS:

- interface: `wg-vem-maint`
- relay address: `10.91.0.1/24`
- relay endpoint: `118.25.104.160:51820`
- listen port: `51820`
- firewall chain: `VEM-MAINTENANCE-RELAY`
- allowed flow: `github-runner` to `win10-vm` TCP `22`

Before live rendering, create an operator-local plan file outside tracked
source, for example `.scratch/maintenance-relay/relay-plan.local.json`. Copy the
dry plan JSON into that file and replace only the peer `publicKey` values with
the real public keys generated below. Render from the operator-local plan file:

```sh
pnpm --filter service-api maintenance-relay:plan -- \
  --plan-file .scratch/maintenance-relay/relay-plan.local.json \
  --dry-plan
```

Do not edit Service API source just to install live public keys. The default
sample plan remains useful for dry demos; live relay bring-up must use
`--plan-file` so the RelayPlan, relay config, and peer config all use the same
operator-reviewed public keys.

## Create Or Provide Keys Per Host

Generate each peer private key on the host that owns that peer. Only public keys
are copied into the operator-local plan file.

On the test VPS relay host, generate only the relay key:

```sh
umask 077
mkdir -p /etc/vem-maintenance-relay/keys
wg genkey | tee /etc/vem-maintenance-relay/keys/relay.private | wg pubkey > /etc/vem-maintenance-relay/keys/relay.public
sudo chmod 600 /etc/vem-maintenance-relay/keys/relay.private
cat /etc/vem-maintenance-relay/keys/relay.public
```

On the self-hosted GitHub runner, generate only the runner key:

```sh
umask 077
sudo mkdir -p /var/lib/vem-maintenance-relay/keys
sudo sh -c 'wg genkey | tee /var/lib/vem-maintenance-relay/keys/github-runner.private | wg pubkey > /var/lib/vem-maintenance-relay/keys/github-runner.public'
sudo chmod 600 /var/lib/vem-maintenance-relay/keys/github-runner.private
sudo cat /var/lib/vem-maintenance-relay/keys/github-runner.public
```

On the Windows Machine Runtime Testbed VM, generate only the machine key with
WireGuard for Windows:

```powershell
$wg = "C:\Program Files\WireGuard\wg.exe"
$keyDir = "C:\ProgramData\VEM\maintenance-relay\keys"
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
icacls $keyDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
$privateKey = & $wg genkey
Set-Content -Path "$keyDir\win10-vm.private" -Value $privateKey -NoNewline
$publicKey = $privateKey | & $wg pubkey
Set-Content -Path "$keyDir\win10-vm.public" -Value $publicKey -NoNewline
Get-Content "$keyDir\win10-vm.public"
```

If a short-lived operator workstation generates runner or VM keys for emergency
bootstrap, transfer each private key only over an encrypted channel to its owning
host, verify the destination file mode or Windows ACL, then delete every
operator and VPS copy immediately:

```sh
shred -u /tmp/github-runner.private /tmp/win10-vm.private
sudo find /etc/vem-maintenance-relay/keys -maxdepth 1 -type f \
  \( -name 'github-runner.private' -o -name 'win10-vm.private' \) -delete
```

The VPS must not retain the runner or Windows VM private keys after bring-up.

Public docs may show placeholders only:

```ini
PrivateKey = <relay private key from /etc/vem-maintenance-relay/keys/relay.private>
```

Do not paste real private key material into the repo, even temporarily.

## Render Configs From Secrets

Render only the config needed by the current host. Avoid exporting private keys
in a shared shell profile.

On the VPS, render the relay host config and firewall plan from the
operator-local plan file:

```sh
WG_RELAY_PRIVATE_KEY="$(sudo cat /etc/vem-maintenance-relay/keys/relay.private)" \
pnpm --filter service-api maintenance-relay:plan -- \
  --plan-file .scratch/maintenance-relay/relay-plan.local.json \
  --render relay \
  > /tmp/vem-maintenance-relay-rendered.json
```

The rendered JSON separates:

- `relayConfig`: sensitive relay host WireGuard config
- `firewall.commands`: non-secret `iptables` commands for the relay host

On a Linux runner host, render only its peer config:

```sh
WG_PEER_PRIVATE_KEY="$(sudo cat /var/lib/vem-maintenance-relay/keys/github-runner.private)" \
pnpm --filter service-api maintenance-relay:plan -- \
  --plan-file .scratch/maintenance-relay/relay-plan.local.json \
  --render peer \
  --peer github-runner \
  > /tmp/vem-maintenance-relay-runner-rendered.json
```

The CLI still accepts `WG_RUNNER_PRIVATE_KEY` and `WG_MACHINE_PRIVATE_KEY` for
the default all-config render mode, but the live runbook uses per-host
`WG_PEER_PRIVATE_KEY` so runner and Windows VM private keys do not have to pass
through the VPS.

For the Windows VM, either run the same CLI from a checked-out repository on the
VM with `WG_PEER_PRIVATE_KEY` set for that PowerShell session, or assemble the
WireGuard import file from the reviewed dry plan values: local `Address =
10.91.2.10/32`, local `PrivateKey =
<C:\ProgramData\VEM\maintenance-relay\keys\win10-vm.private>`, relay `PublicKey
= <relay public key from plan>`, `Endpoint = 118.25.104.160:51820`, and
`AllowedIPs = 10.91.0.1/32, 10.91.1.10/32`.

The public runbook intentionally does not include a complete usable peer config.
Treat every rendered peer config as a secret because it contains that peer's
private key.

## Apply On The Test VPS

Perform these steps only during the manual HITL verification window.

1. Confirm UDP 51820 is reachable through the VPS cloud firewall or security
   group, and that local host firewall policy allows inbound UDP `51820`.
2. Install WireGuard and `iptables`, then enable IPv4 forwarding:

   ```sh
   sudo apt-get update
   sudo apt-get install -y wireguard iptables
   printf 'net.ipv4.ip_forward=1\n' | sudo tee /etc/sysctl.d/99-vem-maintenance-relay.conf
   sudo sysctl --system
   ```

3. Safely extract `relayConfig` and `firewall.commands` from the CLI JSON:

   ```sh
   node <<'NODE'
   const fs = require("node:fs");
   const rendered = JSON.parse(
     fs.readFileSync("/tmp/vem-maintenance-relay-rendered.json", "utf8"),
   );
   if (typeof rendered.relayConfig !== "string") {
     throw new Error("rendered relayConfig missing");
   }
   if (!Array.isArray(rendered.firewall?.commands)) {
     throw new Error("rendered firewall.commands missing");
   }
   fs.writeFileSync("/tmp/wg-vem-maint.conf", rendered.relayConfig, {
     mode: 0o600,
   });
   fs.writeFileSync(
     "/tmp/vem-maintenance-relay-firewall.commands",
     rendered.firewall.commands.join("\n") + "\n",
     { mode: 0o600 },
   );
   NODE
   sudo install -m 0600 /tmp/wg-vem-maint.conf /etc/wireguard/wg-vem-maint.conf
   ```

4. Apply the rendered `firewall.commands` with `sudo`, preserving command order
   and executing each full line through the shell so commands such as
   `while iptables -D ...; do :; done` run correctly:

   ```sh
   while IFS= read -r command; do
     [ -n "$command" ] || continue
     sudo bash -c "$command"
   done < /tmp/vem-maintenance-relay-firewall.commands
   ```

5. Bring up the WireGuard interface:

   ```sh
   sudo wg-quick up wg-vem-maint
   sudo wg show wg-vem-maint
   ```

The plan creates the `VEM-MAINTENANCE-RELAY` chain, allows established return
traffic, allows only the explicit runner-to-machine TCP 22 flow, drops other
peer forwarding, and rejects relay-host SSH output to machine peers.

## Configure Peers

Install each rendered peer config only on its owning host:

- On a Linux runner, extract and start the runner config:

  ```sh
  node <<'NODE'
  const fs = require("node:fs");
  const rendered = JSON.parse(
    fs.readFileSync("/tmp/vem-maintenance-relay-runner-rendered.json", "utf8"),
  );
  const config = rendered.peerConfigs?.["github-runner"];
  if (typeof config !== "string") throw new Error("github-runner peer config missing");
  fs.writeFileSync("/tmp/wg-vem-maint.conf", config, { mode: 0o600 });
  NODE
  sudo install -m 0600 /tmp/wg-vem-maint.conf /etc/wireguard/wg-vem-maint.conf
  sudo wg-quick up wg-vem-maint
  sudo wg show wg-vem-maint
  ```

- For the Windows VM runtime acceptance base image, prefer the canonical
  clean-base factory preparation path. Pass the WireGuard installer artifact,
  the reviewed VM peer config, and the runner peer source IP to
  `scripts/testbed/win10-vem-e2e.mjs --mode clean-base-factory-acceptance`:

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

  The preparation script verifies installer and config hashes, installs the
  WireGuard tunnel as an automatic Windows service, writes only non-secret
  relay evidence, and configures `VEM Controlled Maintenance SSH` for the
  supplied runner peer source address.

- For break-glass investigation only, manually import the reviewed
  `win10-vm.conf` with WireGuard for Windows. Use a placeholder path in
  automation, not real key text in the repo:

  ```powershell
  $tunnel = "C:\ProgramData\VEM\maintenance-relay\win10-vm.conf"
  & "C:\Program Files\WireGuard\wireguard.exe" /installtunnelservice $tunnel
  Get-Service "WireGuardTunnelwin10-vm"
  ```

The Windows VM must still use Controlled Maintenance Ingress for SSH: allow TCP
`22` only from the runner WireGuard peer address, and keep kiosk-account SSH
denied.

## Verification

Record non-secret evidence only. Good evidence includes command names, statuses,
interface names, peer names, timestamps, and redacted handshake summaries.

On the test VPS:

```sh
sudo wg show wg-vem-maint
sudo ip addr show wg-vem-maint
sudo sysctl net.ipv4.ip_forward
sudo iptables -S VEM-MAINTENANCE-RELAY
sudo iptables -S FORWARD
sudo iptables -S OUTPUT
```

Confirm:

- WireGuard data plane is up on `wg-vem-maint`.
- UDP 51820 is listening and reachable from outside the VPS network.
- Each active peer has a recent peer handshake after its host starts WireGuard.
- The `FORWARD` path jumps to `VEM-MAINTENANCE-RELAY`.
- The chain accepts established traffic, allows runner-to-machine TCP `22`, and
  drops denied flows.
- Relay host output to machine TCP `22` is rejected unless a future plan
  explicitly authorizes relay-host maintenance.

From the runner peer, verify the allowed flow:

```sh
ssh <maintenance-user>@10.91.2.10 hostname
```

Verify denied flows without recording secrets. From the runner peer, non-SSH to
the machine should fail:

```sh
nc -vz 10.91.2.10 80
```

From the machine peer, verify the reverse machine-to-runner SSH path is denied:

```powershell
ssh <runner-user>@10.91.1.10 hostname
```

From the VPS relay host, verify relay-to-machine SSH is denied:

```sh
ssh <maintenance-user>@10.91.2.10 hostname
```

The non-SSH machine service probe, reverse machine-to-runner SSH path, and
relay-to-machine SSH path should fail. Capture only the result, timestamp,
source peer name, target peer name, target port, and redacted command output.

## Rollback

Rollback must leave the relay fail-closed.

```sh
sudo wg-quick down wg-vem-maint || true
sudo iptables -D FORWARD -i wg-vem-maint -j VEM-MAINTENANCE-RELAY 2>/dev/null || true
sudo iptables -F VEM-MAINTENANCE-RELAY 2>/dev/null || true
sudo iptables -X VEM-MAINTENANCE-RELAY 2>/dev/null || true
sudo iptables -D OUTPUT -o wg-vem-maint -d 10.91.2.10/32 -p tcp --dport 22 -j REJECT 2>/dev/null || true
sudo rm -f /etc/wireguard/wg-vem-maint.conf
```

After rollback, confirm:

- `wg show wg-vem-maint` fails or reports no such interface.
- `iptables -S VEM-MAINTENANCE-RELAY` fails or reports no such chain.
- UDP 51820 is no longer accepted unless the host firewall is intentionally left
  open for the next maintenance window.
- Runner-to-machine SSH over the relay no longer succeeds.

## Evidence Template

Use this shape for issue comments or PR notes:

```text
Maintenance Relay HITL evidence
Date:
Relay host: test VPS
Interface: wg-vem-maint
Entrypoint: UDP 51820
Plan source: pnpm --filter service-api maintenance-relay:plan -- --plan-file .scratch/maintenance-relay/relay-plan.local.json --dry-plan
WireGuard status: up/down, redacted peer handshake ages
Firewall status: VEM-MAINTENANCE-RELAY present, allowed runner-to-machine TCP 22, denied flows checked
Allowed flow: github-runner -> win10-vm TCP 22 passed/failed
Denied flow checks: non-SSH to machine passed/failed, machine-to-runner from machine peer passed/failed, relay-to-machine from VPS passed/failed
Rollback: completed/not needed
Secrets: no private keys recorded
```
