import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { renderNftablesTransaction } from "./backends";

const execFileAsync = promisify(execFile);
const REQUIRED = process.env["VEM_RELAY_PRIVILEGED_REQUIRED"] === "1";

const FLOW = {
  sessionId: "550e8400-e29b-41d4-a716-446655440003",
  sourcePeerId: "550e8400-e29b-41d4-a716-446655440001",
  sourceTunnelAddress: "10.91.1.10",
  targetMachineId: "550e8400-e29b-41d4-a716-446655440002",
  targetTunnelAddress: "10.91.16.10",
  protocol: "tcp" as const,
  port: 22 as const,
};

describe("maintenance relay privileged Linux network", () => {
  it("enforces tuple expiry and default deny without changing unrelated nftables state", async (context) => {
    const missing = await missingPrerequisite();
    if (missing) {
      if (REQUIRED) {
        throw new Error(
          `required privileged relay test unavailable: ${missing}`,
        );
      }
      context.skip(`privileged relay test unavailable: ${missing}`);
      return;
    }

    const directory = await mkdtemp(join(tmpdir(), "vem-relay-netns-"));
    const rulesPath = join(directory, "rules.nft");
    const timeoutRulesPath = join(directory, "timeout-rules.nft");
    const timeoutClientPath = join(directory, "timeout-client.cjs");
    const revokeRulesPath = join(directory, "revoke-rules.nft");
    const revokeClientPath = join(directory, "revoke-client.cjs");
    const revokeReadyPath = join(directory, "revoke-ready");
    const revokeAppliedPath = join(directory, "revoke-applied");
    const peerAddresses = ["10.91.1.10", "10.91.16.10", "10.91.16.11"];
    try {
      await Promise.all([
        writeFile(
          rulesPath,
          renderNftablesTransaction(
            "wg0",
            peerAddresses,
            [
              {
                ...FLOW,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
            new Date(),
          ),
        ),
        writeFile(
          timeoutRulesPath,
          renderNftablesTransaction(
            "wg0",
            peerAddresses,
            [
              {
                ...FLOW,
                expiresAt: new Date(Date.now() + 4_000).toISOString(),
              },
            ],
            new Date(),
            true,
          ),
        ),
        writeFile(timeoutClientPath, timeoutClient),
        writeFile(
          revokeRulesPath,
          renderNftablesTransaction("wg0", peerAddresses, [], new Date(), true),
        ),
        writeFile(revokeClientPath, revokeClient),
      ]);

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(
          "unshare",
          ["--mount", "--net", "--fork", "bash", "-ec", namespaceScript],
          {
            env: {
              ...process.env,
              VEM_RELAY_NFT_RULES: rulesPath,
              VEM_RELAY_NFT_TIMEOUT_RULES: timeoutRulesPath,
              VEM_RELAY_TIMEOUT_CLIENT: timeoutClientPath,
              VEM_RELAY_NFT_REVOKE_RULES: revokeRulesPath,
              VEM_RELAY_REVOKE_CLIENT: revokeClientPath,
              VEM_RELAY_REVOKE_READY: revokeReadyPath,
              VEM_RELAY_REVOKE_APPLIED: revokeAppliedPath,
            },
            maxBuffer: 1024 * 1024,
          },
        ));
      } catch (error) {
        const failure = error as Error & { stderr?: string; stdout?: string };
        throw new Error(
          `${failure.message}\nstdout:\n${failure.stdout ?? ""}\nstderr:\n${failure.stderr ?? ""}`,
        );
      }
      if (REQUIRED) process.stdout.write(stdout);

      for (const evidence of [
        "allow-return=passed",
        "peer-to-relay=denied",
        "peer-to-lan=denied",
        "other-interface-to-peer=denied",
        "peer-lateral=denied",
        "machine-lateral=denied",
        "relay-originated=denied",
        "atomic-rollback=passed",
        "unrelated-table=preserved",
        "existing-connection-timeout=disconnected",
        "existing-connection-revoke=blocked",
        "new-connection-after-revoke=denied",
      ]) {
        expect(stdout).toContain(`EVIDENCE ${evidence}`);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 45_000);
});

async function missingPrerequisite(): Promise<string | undefined> {
  const commands = [
    "bash",
    "ip",
    "mount",
    "nft",
    "node",
    "sysctl",
    "unshare",
    "wg",
  ];
  const availability = await Promise.all(
    commands.map(async (command) => {
      try {
        await execFileAsync("sh", ["-c", `command -v ${command}`]);
        return true;
      } catch {
        return false;
      }
    }),
  );
  const missingCommand = commands.find((_, index) => !availability[index]);
  if (missingCommand) return `missing ${missingCommand}`;
  try {
    await execFileAsync("unshare", ["--mount", "--net", "true"]);
    return undefined;
  } catch {
    return "mount/network namespace capability is missing";
  }
}

const timeoutClient = String.raw`
const net = require("node:net");

const socket = net.createConnection({ host: "10.91.16.10", port: 22 });
let buffer = "";
let beforeEchoed = false;
let afterSent = false;
let completed = false;
const initialEchoTimeout = setTimeout(
  () => fail("timed out waiting for the initial allowed echo"),
  3_000,
);

function finishSuccess() {
  if (completed) return;
  completed = true;
  console.log("EVIDENCE existing-connection-timeout=disconnected");
  socket.destroy();
  process.exit(0);
}

function fail(message) {
  if (completed) return;
  completed = true;
  console.error(message);
  socket.destroy();
  process.exit(1);
}

socket.setNoDelay(true);
socket.on("connect", () => socket.write("before-timeout\n"));
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (!beforeEchoed && buffer.includes("before-timeout\n")) {
    beforeEchoed = true;
    clearTimeout(initialEchoTimeout);
    buffer = "";
    setTimeout(() => {
      afterSent = true;
      socket.write("after-timeout\n");
      setTimeout(finishSuccess, 2_500);
    }, 6_000);
    return;
  }
  if (afterSent && buffer.includes("after-timeout\n")) {
    fail("existing connection transferred data after tuple expiry");
  }
});
socket.on("error", (error) => {
  if (afterSent) finishSuccess();
  else fail("connection failed before timeout: " + error.message);
});
socket.on("close", () => {
  if (afterSent) finishSuccess();
  else fail("connection closed before tuple timeout was exercised");
});
setTimeout(() => fail("existing connection timeout test did not finish"), 12_000);
`;

const revokeClient = String.raw`
const fs = require("node:fs");
const net = require("node:net");

const socket = net.createConnection({ host: "10.91.16.10", port: 22 });
let buffer = "";
let afterSent = false;
let completed = false;

function finishSuccess() {
  if (completed) return;
  completed = true;
  console.log("EVIDENCE existing-connection-revoke=blocked");
  socket.destroy();
  process.exit(0);
}

function fail(message) {
  if (completed) return;
  completed = true;
  console.error(message);
  socket.destroy();
  process.exit(1);
}

socket.setNoDelay(true);
socket.on("connect", () => socket.write("before-revoke\n"));
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  if (!afterSent && buffer.includes("before-revoke\n")) {
    buffer = "";
    fs.writeFileSync(process.env.VEM_RELAY_REVOKE_READY, "ready\n");
    const waitForRevoke = setInterval(() => {
      if (!fs.existsSync(process.env.VEM_RELAY_REVOKE_APPLIED)) return;
      clearInterval(waitForRevoke);
      afterSent = true;
      socket.write("after-revoke\n");
      setTimeout(finishSuccess, 1_500);
    }, 25);
    return;
  }
  if (afterSent && buffer.includes("after-revoke\n")) {
    fail("existing connection transferred data after session revoke");
  }
});
socket.on("error", (error) => {
  if (afterSent) finishSuccess();
  else fail("connection failed before revoke: " + error.message);
});
socket.on("close", () => {
  if (afterSent) finishSuccess();
  else fail("connection closed before revoke was applied");
});
setTimeout(() => fail("existing connection revoke test did not finish"), 8_000);
`;

const namespaceScript = String.raw`
set -o pipefail
sysctl -qw net.ipv4.ip_forward=1
mount --make-rprivate /

namespaces="runner machine lateral lan"
cleanup() {
  kill $(jobs -pr) 2>/dev/null || true
  for namespace in $namespaces; do
    ip netns del "$namespace" 2>/dev/null || true
  done
}
trap cleanup EXIT

for namespace in $namespaces; do
  ip netns add "$namespace"
  ip netns exec "$namespace" ip link set lo up
done

ip link add run-ul type veth peer name runner-eth
ip link add mach-ul type veth peer name machine-eth
ip link add lat-ul type veth peer name lateral-eth
ip link add lan-relay type veth peer name lan-eth
ip link set runner-eth netns runner
ip link set machine-eth netns machine
ip link set lateral-eth netns lateral
ip link set lan-eth netns lan

ip addr add 192.0.2.1/30 dev run-ul
ip addr add 192.0.2.5/30 dev mach-ul
ip addr add 192.0.2.9/30 dev lat-ul
ip addr add 198.51.100.1/30 dev lan-relay
ip link set run-ul up
ip link set mach-ul up
ip link set lat-ul up
ip link set lan-relay up
ip netns exec runner bash -ec 'ip addr add 192.0.2.2/30 dev runner-eth; ip link set runner-eth up'
ip netns exec machine bash -ec 'ip addr add 192.0.2.6/30 dev machine-eth; ip link set machine-eth up'
ip netns exec lateral bash -ec 'ip addr add 192.0.2.10/30 dev lateral-eth; ip link set lateral-eth up'
ip netns exec lan bash -ec 'ip addr add 198.51.100.2/30 dev lan-eth; ip link set lan-eth up; ip route add 10.91.0.0/16 via 198.51.100.1'

ip link add wg0 type wireguard
ip addr add 10.91.0.1/32 dev wg0
relay_private="$(wg genkey)"
runner_private="$(wg genkey)"
machine_private="$(wg genkey)"
lateral_private="$(wg genkey)"
relay_public="$(printf '%s' "$relay_private" | wg pubkey)"
runner_public="$(printf '%s' "$runner_private" | wg pubkey)"
machine_public="$(printf '%s' "$machine_private" | wg pubkey)"
lateral_public="$(printf '%s' "$lateral_private" | wg pubkey)"
wg set wg0 private-key <(printf '%s' "$relay_private") listen-port 51820
ip link set wg0 up

ip netns exec runner bash -ec "
  ip link add wg-runner type wireguard
  ip addr add 10.91.1.10/32 dev wg-runner
  wg set wg-runner private-key <(printf '%s' '$runner_private') listen-port 51821 peer '$relay_public' allowed-ips 10.91.0.1/32,10.91.16.10/32,10.91.16.11/32,198.51.100.2/32 endpoint 192.0.2.1:51820
  ip link set wg-runner up
  ip route add 10.91.0.1/32 dev wg-runner
  ip route add 10.91.16.10/32 dev wg-runner
  ip route add 10.91.16.11/32 dev wg-runner
  ip route add 198.51.100.2/32 dev wg-runner
"
ip netns exec machine bash -ec "
  ip link add wg-machine type wireguard
  ip addr add 10.91.16.10/32 dev wg-machine
  wg set wg-machine private-key <(printf '%s' '$machine_private') listen-port 51822 peer '$relay_public' allowed-ips 10.91.0.1/32,10.91.1.10/32,10.91.16.11/32,198.51.100.2/32 endpoint 192.0.2.5:51820
  ip link set wg-machine up
  ip route add 10.91.0.1/32 dev wg-machine
  ip route add 10.91.1.10/32 dev wg-machine
  ip route add 10.91.16.11/32 dev wg-machine
  ip route add 198.51.100.2/32 dev wg-machine
"
ip netns exec lateral bash -ec "
  ip link add wg-lateral type wireguard
  ip addr add 10.91.16.11/32 dev wg-lateral
  wg set wg-lateral private-key <(printf '%s' '$lateral_private') listen-port 51823 peer '$relay_public' allowed-ips 10.91.0.1/32,10.91.1.10/32,10.91.16.10/32 endpoint 192.0.2.9:51820
  ip link set wg-lateral up
  ip route add 10.91.0.1/32 dev wg-lateral
  ip route add 10.91.1.10/32 dev wg-lateral
  ip route add 10.91.16.10/32 dev wg-lateral
"

relay_config="$(mktemp)"
cat > "$relay_config" <<EOF
[Interface]
PrivateKey = $relay_private
ListenPort = 51820

[Peer]
PublicKey = $runner_public
AllowedIPs = 10.91.1.10/32
Endpoint = 192.0.2.2:51821

[Peer]
PublicKey = $machine_public
AllowedIPs = 10.91.16.10/32
Endpoint = 192.0.2.6:51822

[Peer]
PublicKey = $lateral_public
AllowedIPs = 10.91.16.11/32
Endpoint = 192.0.2.10:51823
EOF
wg syncconf wg0 "$relay_config"
rm -f "$relay_config"
ip route add 10.91.1.10/32 dev wg0
ip route add 10.91.16.10/32 dev wg0
ip route add 10.91.16.11/32 dev wg0

ip netns exec machine node -e 'require("node:net").createServer((socket) => socket.pipe(socket)).listen(22, "10.91.16.10"); require("node:net").createServer((socket) => socket.pipe(socket)).listen(2222, "10.91.16.10")' & machine_server=$!
ip netns exec runner node -e 'require("node:net").createServer((socket) => socket.pipe(socket)).listen(2222, "10.91.1.10")' & runner_server=$!
ip netns exec lateral node -e 'require("node:net").createServer((socket) => socket.pipe(socket)).listen(22, "10.91.16.11")' & lateral_server=$!
ip netns exec lan node -e 'require("node:net").createServer((socket) => socket.pipe(socket)).listen(2200, "198.51.100.2")' & lan_server=$!
node -e 'require("node:net").createServer((socket) => socket.pipe(socket)).listen(2200, "10.91.0.1")' & relay_server=$!
sleep 1

nft add table inet vem_relay_unrelated
nft -f "$VEM_RELAY_NFT_RULES"

if ! ip netns exec runner timeout 3 bash -ec 'exec 3<>/dev/tcp/10.91.16.10/22; printf "allow-return\n" >&3; read -r response <&3; test "$response" = allow-return'; then
  wg show >&2
  ip netns exec runner wg show >&2
  ip netns exec machine wg show >&2
  ip netns exec runner ip route get 192.0.2.1 >&2
  ip route get 192.0.2.2 >&2
  ip -s link show run-ul >&2
  ip netns exec runner ip -s link show runner-eth >&2
  ss -lunp >&2
  ip netns exec runner ss -lunp >&2
  nft list table inet vem_maintenance_relay >&2
  exit 1
fi
echo 'EVIDENCE allow-return=passed'

if ip netns exec runner timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.0.1/2200'; then exit 1; fi
echo 'EVIDENCE peer-to-relay=denied'
if ip netns exec runner timeout 2 bash -ec 'exec 3<>/dev/tcp/198.51.100.2/2200'; then exit 1; fi
echo 'EVIDENCE peer-to-lan=denied'
if ip netns exec lan timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.16.10/22'; then exit 1; fi
echo 'EVIDENCE other-interface-to-peer=denied'
if ip netns exec runner timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.16.11/22'; then exit 1; fi
echo 'EVIDENCE peer-lateral=denied'
if ip netns exec machine timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.1.10/2222'; then exit 1; fi
echo 'EVIDENCE machine-lateral=denied'
if timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.16.10/22'; then exit 1; fi
echo 'EVIDENCE relay-originated=denied'

cat > /tmp/invalid-relay-transaction.nft <<'EOF'
delete table inet vem_maintenance_relay
add table inet vem_maintenance_relay
delete table inet vem_relay_table_that_does_not_exist
EOF
if nft -f /tmp/invalid-relay-transaction.nft 2>/dev/null; then exit 1; fi
nft list set inet vem_maintenance_relay active_flows >/dev/null
ip netns exec runner timeout 3 bash -ec 'exec 3<>/dev/tcp/10.91.16.10/22; printf "rollback\n" >&3; read -r response <&3; test "$response" = rollback'
echo 'EVIDENCE atomic-rollback=passed'
nft list table inet vem_relay_unrelated >/dev/null
echo 'EVIDENCE unrelated-table=preserved'

rm -f "$VEM_RELAY_REVOKE_READY" "$VEM_RELAY_REVOKE_APPLIED"
ip netns exec runner timeout 10 node "$VEM_RELAY_REVOKE_CLIENT" & revoke_client=$!
for attempt in $(seq 1 50); do
  if [ -f "$VEM_RELAY_REVOKE_READY" ]; then break; fi
  sleep 0.1
done
test -f "$VEM_RELAY_REVOKE_READY"
nft -f "$VEM_RELAY_NFT_REVOKE_RULES"
touch "$VEM_RELAY_REVOKE_APPLIED"
wait "$revoke_client"
if ip netns exec runner timeout 2 bash -ec 'exec 3<>/dev/tcp/10.91.16.10/22'; then exit 1; fi
echo 'EVIDENCE new-connection-after-revoke=denied'

nft -f "$VEM_RELAY_NFT_TIMEOUT_RULES"
ip netns exec runner timeout 15 node "$VEM_RELAY_TIMEOUT_CLIENT"
nft list table inet vem_relay_unrelated >/dev/null
`;
