import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("../../../", import.meta.url).pathname;
const suppliedImage = process.env.VEM_RELAY_CONTAINER_TEST_IMAGE;
const image =
  suppliedImage ?? `vem-maintenance-relay-container-test:${process.pid}`;
const container = `vem-maintenance-relay-container-test-${process.pid}`;
const fixtureContainer = `${container}-fixture`;
const credentialVolume = `${container}-credential`;
const privateKeyVolume = `${container}-private-key`;
const dataPlaneNetwork = `${container}-network`;
const apiContainer = `${container}-api`;
const relayContainer = `${container}-relay`;
const runnerContainer = `${container}-runner`;
const machineContainer = `${container}-machine`;
let temporaryDirectory;
let relayKeyPair;

async function docker(args, options = {}) {
  return await execFileAsync("docker", args, {
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

async function inspect(target) {
  const { stdout } = await docker(["inspect", target]);
  return JSON.parse(stdout)[0];
}

async function execRelayWithNetAdmin(args, name = relayContainer) {
  return await docker([
    "exec",
    name,
    "/usr/bin/setpriv",
    "--inh-caps",
    "+net_admin",
    "--ambient-caps",
    "+net_admin",
    "--no-new-privs",
    ...args,
  ]);
}

async function waitFor(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForRunning(name) {
  await waitFor(
    async () => {
      const state = await inspect(name);
      if (state.State.Running) return true;
      const { stdout, stderr } = await docker(["logs", name]);
      throw new Error(
        `container state=${state.State.Status}; logs=${stdout}${stderr}`,
      );
    },
    `${name} did not remain running`,
    5_000,
  );
}

function generateWireGuardKeyPair() {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "X25519");
  assert.equal(typeof jwk.d, "string");
  assert.equal(typeof jwk.x, "string");
  return {
    privateKey: Buffer.from(jwk.d, "base64url").toString("base64"),
    publicKey: Buffer.from(jwk.x, "base64url").toString("base64"),
  };
}

async function requireKernelWireGuard() {
  try {
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--entrypoint",
      "sh",
      image,
      "-ec",
      "ip link add wg-preflight type wireguard; ip link show wg-preflight >/dev/null",
    ]);
  } catch (error) {
    const failure = error;
    throw new Error(
      `required production WireGuard runner capability unavailable: ${failure.stderr || failure.message}`,
    );
  }
}

describe("maintenance relay production container", () => {
  before(async () => {
    relayKeyPair = generateWireGuardKeyPair();
    temporaryDirectory = await mkdtemp(
      join("/dev/shm", "vem-relay-container-"),
    );
    await Promise.all([
      writeFile(
        join(temporaryDirectory, "private-key"),
        `${relayKeyPair.privateKey}\n`,
        {
          mode: 0o400,
        },
      ),
      writeFile(
        join(temporaryDirectory, "credential"),
        "relay-credential-at-least-thirty-two-bytes\n",
        { mode: 0o400 },
      ),
    ]);
    if (!suppliedImage) {
      await docker([
        "build",
        "--no-cache",
        "--file",
        join(root, "apps/maintenance-relay/Dockerfile"),
        "--tag",
        image,
        root,
      ]);
    }
    await requireKernelWireGuard();
    await Promise.all([
      docker(["volume", "create", credentialVolume]),
      docker(["volume", "create", privateKeyVolume]),
    ]);
    await docker([
      "run",
      "--detach",
      "--name",
      fixtureContainer,
      "--user",
      "0:0",
      "--mount",
      `type=volume,src=${credentialVolume},dst=/run/credential`,
      "--mount",
      `type=volume,src=${privateKeyVolume},dst=/run/private-key`,
      "--entrypoint",
      "sh",
      image,
      "-c",
      "sleep infinity",
    ]);
    await docker([
      "cp",
      join(temporaryDirectory, "credential"),
      `${fixtureContainer}:/run/credential/value`,
    ]);
    await docker([
      "cp",
      join(temporaryDirectory, "private-key"),
      `${fixtureContainer}:/run/private-key/value`,
    ]);
    await docker([
      "exec",
      fixtureContainer,
      "sh",
      "-c",
      "chown 1001:1001 /run/credential/value /run/private-key/value && chmod 0400 /run/credential/value /run/private-key/value",
    ]);
    await docker(["rm", "--force", fixtureContainer]);
  });

  after(async () => {
    await docker(["rm", "--force", container]).catch(() => undefined);
    await docker(["rm", "--force", fixtureContainer]).catch(() => undefined);
    for (const name of [
      apiContainer,
      relayContainer,
      runnerContainer,
      machineContainer,
    ]) {
      await docker(["rm", "--force", name]).catch(() => undefined);
    }
    await docker(["network", "rm", dataPlaneNetwork]).catch(() => undefined);
    for (const volume of [credentialVolume, privateKeyVolume]) {
      await docker(["volume", "rm", "--force", volume]).catch(() => undefined);
    }
    if (!suppliedImage) {
      await docker(["image", "rm", "--force", image]).catch(() => undefined);
    }
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("contains only the deployed runtime and starts under the constrained runtime policy", async () => {
    const imageInspection = await inspect(image);
    assert.deepEqual(imageInspection.Config.ExposedPorts, { "51820/udp": {} });
    assert.equal(imageInspection.Config.User, "1001:1001");

    await docker([
      "run",
      "--detach",
      "--name",
      container,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1001,gid=1001,mode=1770",
      "--tmpfs",
      "/run/vem/maintenance-relay:rw,noexec,nosuid,nodev,size=4m,uid=1001,gid=1001,mode=0700",
      "--mount",
      `type=volume,src=${credentialVolume},dst=/run/secrets/maintenance-relay-credential,readonly`,
      "--mount",
      `type=volume,src=${privateKeyVolume},dst=/run/secrets/maintenance-relay-private-key,readonly`,
      "--sysctl",
      "net.ipv4.ip_forward=1",
      "--publish",
      "127.0.0.1::51820/udp",
      "--env",
      "SERVICE_API_BASE_URL=http://service-api:26849/api",
      "--env",
      "MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP=true",
      "--env",
      "MAINTENANCE_RELAY_CREDENTIAL_FILE=/run/secrets/maintenance-relay-credential/value",
      "--env",
      "MAINTENANCE_RELAY_PRIVATE_KEY_PATH=/run/secrets/maintenance-relay-private-key/value",
      "--env",
      "MAINTENANCE_RELAY_TUNNEL_ADDRESS=10.91.0.1",
      "--env",
      "MAINTENANCE_RELAY_POLL_INTERVAL_MS=600000",
      image,
    ]);
    await waitForRunning(container);

    const running = await inspect(container);
    assert.equal(running.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(running.HostConfig.CapDrop, ["ALL"]);
    assert.deepEqual(running.HostConfig.CapAdd, ["CAP_NET_ADMIN"]);
    assert.notEqual(running.HostConfig.NetworkMode, "host");
    assert.deepEqual(Object.keys(running.NetworkSettings.Ports), ["51820/udp"]);
    assert.equal(running.HostConfig.Sysctls["net.ipv4.ip_forward"], "1");
    assert.deepEqual(
      running.Mounts.map(({ Type, Name, Destination, RW }) => ({
        Type,
        Name,
        Destination,
        RW,
      })).sort((left, right) =>
        left.Destination.localeCompare(right.Destination),
      ),
      [
        {
          Type: "volume",
          Name: credentialVolume,
          Destination: "/run/secrets/maintenance-relay-credential",
          RW: false,
        },
        {
          Type: "volume",
          Name: privateKeyVolume,
          Destination: "/run/secrets/maintenance-relay-private-key",
          RW: false,
        },
      ],
    );
    assert.deepEqual(Object.keys(running.HostConfig.Tmpfs).sort(), [
      "/run/vem/maintenance-relay",
      "/tmp",
    ]);
    assert.match(
      running.HostConfig.Tmpfs["/run/vem/maintenance-relay"],
      /uid=1001/,
    );
    assert.match(running.HostConfig.Tmpfs["/tmp"], /nosuid/);

    const { stdout: runtimeEvidence } = await docker([
      "exec",
      container,
      "sh",
      "-ec",
      [
        "awk '/^Uid:/ { print $2 }' /proc/1/status",
        "awk '/^CapInh:/ { print $2 }' /proc/1/status",
        "awk '/^CapPrm:/ { print $2 }' /proc/1/status",
        "awk '/^CapEff:/ { print $2 }' /proc/1/status",
        "awk '/^CapBnd:/ { print $2 }' /proc/1/status",
        "awk '/^CapAmb:/ { print $2 }' /proc/1/status",
        "awk '/^NoNewPrivs:/ { print $2 }' /proc/1/status",
        "tr '\\0' ' ' </proc/1/cmdline | grep -Fq 'node /app/dist/main.js'",
        'test "$(cat /proc/sys/net/ipv4/ip_forward)" = 1',
        "ip -4 -o address show dev wg0 | grep -Fq '10.91.0.1/32'",
        "test ! -e /app/src",
        "test ! -d /pnpm",
        "test ! -d /root/.cache",
        "! touch /app/rootfs-must-stay-read-only",
        "touch /tmp/restricted-tmpfs /run/vem/maintenance-relay/restricted-tmpfs",
        "test \"$(getcap /usr/bin/setpriv)\" = '/usr/bin/setpriv cap_net_admin=eip'",
        'test -z "$(getcap /usr/bin/ip /usr/bin/wg /usr/sbin/nft /usr/local/bin/node)"',
        "test \"$(stat -c '%u:%g:%a' /usr/local/libexec/maintenance-relay-wireguard-syncconf)\" = 0:0:555",
        "! setcap cap_net_admin=ep /tmp/restricted-tmpfs",
        "test \"$(stat -c '%u:%g:%a' /run/secrets/maintenance-relay-credential/value)\" = 1001:1001:400",
        "test \"$(stat -c '%u:%g:%a' /run/secrets/maintenance-relay-private-key/value)\" = 1001:1001:400",
        "! touch /run/secrets/maintenance-relay-private-key/value",
        'for command in npm npx corepack pnpm pnpx yarn yarnpkg tsx esbuild; do ! command -v "$command"; done',
        "node -e 'fetch(\"http://127.0.0.1:8080/healthz\").then(async response => { if (!response.ok) process.exit(1); console.log(JSON.stringify(await response.json())); })'",
      ].join("; "),
    ]);
    const lines = runtimeEvidence.trim().split("\n");
    assert.equal(lines[0], "1001");
    assert.deepEqual(lines.slice(1, 6), [
      "0000000000001000",
      "0000000000001000",
      "0000000000001000",
      "0000000000001000",
      "0000000000001000",
    ]);
    assert.equal(lines[6], "1");
    assert.deepEqual(JSON.parse(lines.at(-1)), {
      status: "degraded",
      transport: {
        mode: "insecure-http",
        health: "degraded",
        reason: "Service API uses explicitly allowed insecure HTTP",
      },
    });

    const configuredEnvironment = running.Config.Env.join("\n");
    assert.doesNotMatch(
      configuredEnvironment,
      /^MAINTENANCE_RELAY_CREDENTIAL=/m,
    );
    for (const secret of [
      "relay-credential-at-least-thirty-two-bytes",
      relayKeyPair.privateKey,
    ]) {
      assert.equal(configuredEnvironment.includes(secret), false);
    }

    await execRelayWithNetAdmin(
      [
        "sh",
        "-ec",
        [
          "directory=$(mktemp -d /run/vem/maintenance-relay/vem-relay-wg-XXXXXX)",
          "trap 'rm -rf -- \"$directory\"' 0 1 2 15",
          ': >"$directory/peers.conf"',
          'chmod 0600 "$directory/peers.conf"',
          'if /usr/local/libexec/maintenance-relay-wireguard-syncconf wg-missing /run/secrets/maintenance-relay-private-key/value "$directory/peers.conf" >/dev/null 2>&1; then exit 1; fi',
          'test -z "$(find "$directory" -name \'syncconf.*\' -print -quit)"',
          'rm -rf -- "$directory"',
          "trap - 0 1 2 15",
        ].join("; "),
      ],
      container,
    );
    const [{ stdout: runtimeDirectories }, containerLogs] = await Promise.all([
      docker([
        "exec",
        container,
        "find",
        "/run/vem/maintenance-relay",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-name",
        "vem-relay-wg-*",
        "-print",
      ]),
      docker(["logs", container]),
    ]);
    assert.equal(runtimeDirectories, "");
    assert.equal(
      `${containerLogs.stdout}${containerLogs.stderr}`.includes(
        relayKeyPair.privateKey,
      ),
      false,
    );

    const { stdout: runtimeFileList } = await docker([
      "exec",
      container,
      "find",
      "/app",
      "-xdev",
      "-print",
    ]);
    for (const path of runtimeFileList.trim().split("\n")) {
      assert.doesNotMatch(
        path,
        /\/(?:src|source|test|tests|__tests__|docs|examples|scripts|types|benchmark|benchmarks)(?:\/|$)/i,
      );
      assert.doesNotMatch(path, /\.(?:ts|tsx|cts|mts|map|tsbuildinfo)$/i);
      assert.doesNotMatch(
        path,
        /\/node_modules\/(?:esbuild|tsx|typescript|vite|vitest|oxfmt|oxlint)(?:\/|$)/,
      );
      assert.doesNotMatch(path, /\/(?:\.cache|\.pnpm-store|_cacache)(?:\/|$)/);
    }
  });

  it("forwards between two real WireGuard peers and removes a stale peer route in the production image", async () => {
    const relayPublicKey = relayKeyPair.publicKey;
    const peerKeys = [generateWireGuardKeyPair(), generateWireGuardKeyPair()];
    const runnerId = "550e8400-e29b-41d4-a716-446655440001";
    const machineId = "550e8400-e29b-41d4-a716-446655440002";
    const sessionId = "550e8400-e29b-41d4-a716-446655440003";
    const desiredState = {
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion: 1,
      generatedAt: new Date().toISOString(),
      peers: [
        {
          id: runnerId,
          role: "runner",
          publicKey: peerKeys[0].publicKey,
          tunnelAddress: "10.91.1.10",
        },
        {
          id: machineId,
          role: "machine",
          publicKey: peerKeys[1].publicKey,
          tunnelAddress: "10.91.16.10",
        },
      ],
      authorizations: [
        {
          sessionId,
          sourcePeerId: runnerId,
          sourceTunnelAddress: "10.91.1.10",
          targetMachineId: machineId,
          targetTunnelAddress: "10.91.16.10",
          protocol: "tcp",
          port: 22,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    };
    const apiScript = `
      const http = require("node:http");
      let desired = ${JSON.stringify(desiredState)};
      http.createServer((request, response) => {
        console.log(request.method, request.url);
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => {
          if (request.url === "/drop-machine") {
            desired = { ...desired, desiredStateVersion: 2, generatedAt: new Date().toISOString(), peers: desired.peers.slice(0, 1), authorizations: [] };
            response.writeHead(204).end();
            return;
          }
          let data;
          if (request.url.endsWith("/credential-exchange")) data = { actor: "maintenance_relay", accessToken: "relay-token", expiresAt: new Date(Date.now() + 60000).toISOString() };
          else if (request.url.endsWith("/desired-state")) data = desired;
          else if (request.url.endsWith("/observed-state")) {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            console.log("OBSERVED", JSON.stringify(data));
          }
          else { response.writeHead(404).end(); return; }
          response.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ code: 0, data }));
        });
      }).listen(26849, "0.0.0.0");
    `;

    await docker(["network", "create", dataPlaneNetwork]);
    await docker([
      "run",
      "--detach",
      "--name",
      apiContainer,
      "--network",
      dataPlaneNetwork,
      "--network-alias",
      "service-api",
      "--entrypoint",
      "node",
      image,
      "-e",
      apiScript,
    ]);
    for (const name of [runnerContainer, machineContainer]) {
      await docker([
        "run",
        "--detach",
        "--name",
        name,
        "--network",
        dataPlaneNetwork,
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--entrypoint",
        "sh",
        image,
        "-c",
        "sleep infinity",
      ]);
    }
    await docker([
      "run",
      "--detach",
      "--name",
      relayContainer,
      "--network",
      dataPlaneNetwork,
      "--network-alias",
      "relay",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "NET_ADMIN",
      "--sysctl",
      "net.ipv4.ip_forward=1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=1001,gid=1001,mode=1770",
      "--tmpfs",
      "/run/vem/maintenance-relay:rw,noexec,nosuid,nodev,size=4m,uid=1001,gid=1001,mode=0700",
      "--mount",
      `type=volume,src=${credentialVolume},dst=/run/secrets/maintenance-relay-credential,readonly`,
      "--mount",
      `type=volume,src=${privateKeyVolume},dst=/run/secrets/maintenance-relay-private-key,readonly`,
      "--env",
      "SERVICE_API_BASE_URL=http://service-api:26849/api",
      "--env",
      "MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP=true",
      "--env",
      "MAINTENANCE_RELAY_CREDENTIAL_FILE=/run/secrets/maintenance-relay-credential/value",
      "--env",
      "MAINTENANCE_RELAY_PRIVATE_KEY_PATH=/run/secrets/maintenance-relay-private-key/value",
      "--env",
      "MAINTENANCE_RELAY_TUNNEL_ADDRESS=10.91.0.1",
      "--env",
      "MAINTENANCE_RELAY_POLL_INTERVAL_MS=1000",
      image,
    ]);
    await waitForRunning(relayContainer);

    try {
      await waitFor(
        async () => {
          const { stdout } = await execRelayWithNetAdmin([
            "wg",
            "show",
            "wg0",
            "peers",
          ]);
          return stdout.trim().split("\n").filter(Boolean).length === 2;
        },
        "relay did not apply both desired peers",
        8_000,
      );
    } catch (error) {
      const [relayLogs, apiLogs, directApi] = await Promise.all([
        docker(["logs", relayContainer]),
        docker(["logs", apiContainer]),
        docker([
          "exec",
          relayContainer,
          "node",
          "-e",
          'fetch("http://service-api:26849/api/maintenance-relay/desired-state", { signal: AbortSignal.timeout(2000) }).then(async response => console.log(response.status, await response.text())).catch(error => { console.error(error); process.exit(1) })',
        ]).catch((failure) => ({
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? failure.message,
        })),
      ]);
      throw new Error(
        `${error.message}; relay logs=${relayLogs.stdout}${relayLogs.stderr}; API logs=${apiLogs.stdout}${apiLogs.stderr}; direct API=${directApi.stdout}${directApi.stderr}`,
      );
    }
    const [appliedRelayPublicKey, appliedRelayListenPort] = await Promise.all([
      execRelayWithNetAdmin(["wg", "show", "wg0", "public-key"]),
      execRelayWithNetAdmin(["wg", "show", "wg0", "listen-port"]),
    ]);
    assert.equal(appliedRelayPublicKey.stdout.trim(), relayPublicKey);
    assert.equal(appliedRelayListenPort.stdout.trim(), "51820");
    const relayAddress = (await inspect(relayContainer)).NetworkSettings
      .Networks[dataPlaneNetwork].IPAddress;
    const configurePeer = async ({ name, privateKey, address, target }) => {
      await docker([
        "exec",
        name,
        "sh",
        "-ec",
        [
          "ip link add wg0 type wireguard",
          `ip address add ${address}/32 dev wg0`,
          `printf '%s' '${privateKey}' >/tmp/private-key`,
          "chmod 0600 /tmp/private-key",
          `wg set wg0 private-key /tmp/private-key peer '${relayPublicKey}' allowed-ips 10.91.0.1/32,${target}/32 endpoint ${relayAddress}:51820 persistent-keepalive 1`,
          "rm -f /tmp/private-key",
          "ip link set wg0 up",
          `ip route add ${target}/32 dev wg0`,
        ].join("; "),
      ]);
    };
    await configurePeer({
      name: runnerContainer,
      privateKey: peerKeys[0].privateKey,
      address: "10.91.1.10",
      target: "10.91.16.10",
    });
    await configurePeer({
      name: machineContainer,
      privateKey: peerKeys[1].privateKey,
      address: "10.91.16.10",
      target: "10.91.1.10",
    });
    await docker([
      "exec",
      "--detach",
      machineContainer,
      "node",
      "-e",
      'require("node:net").createServer(socket => socket.pipe(socket)).listen(22, "10.91.16.10")',
    ]);
    try {
      await waitFor(
        async () => {
          try {
            const { stdout } = await docker([
              "exec",
              runnerContainer,
              "node",
              "-e",
              'const net=require("node:net"); const socket=net.createConnection({host:"10.91.16.10",port:22}); socket.setTimeout(1500); socket.on("connect",()=>socket.write("production-forwarding\\n")); socket.on("data",data=>{process.stdout.write(data); socket.end()}); socket.on("timeout",()=>process.exit(1)); socket.on("error",()=>process.exit(1))',
            ]);
            return stdout === "production-forwarding\n";
          } catch {
            return false;
          }
        },
        "production relay did not forward runner TCP/22 to machine",
        8_000,
      );
    } catch (error) {
      const [
        relayWireGuard,
        runnerWireGuard,
        machineWireGuard,
        relayRoutes,
        nft,
      ] = await Promise.all([
        execRelayWithNetAdmin(["wg", "show", "wg0"]),
        docker(["exec", runnerContainer, "wg", "show", "wg0"]),
        docker(["exec", machineContainer, "wg", "show", "wg0"]),
        execRelayWithNetAdmin(["ip", "route", "show", "dev", "wg0"]),
        execRelayWithNetAdmin([
          "nft",
          "list",
          "table",
          "inet",
          "vem_maintenance_relay",
        ]),
      ]);
      throw new Error(
        `${error.message}; relay wg=${relayWireGuard.stdout}${relayWireGuard.stderr}; runner wg=${runnerWireGuard.stdout}${runnerWireGuard.stderr}; machine wg=${machineWireGuard.stdout}${machineWireGuard.stderr}; routes=${relayRoutes.stdout}${relayRoutes.stderr}; nft=${nft.stdout}${nft.stderr}`,
      );
    }

    await docker([
      "exec",
      apiContainer,
      "node",
      "-e",
      'fetch("http://127.0.0.1:26849/drop-machine", { method: "POST" }).then(response => { if (!response.ok) process.exit(1) })',
    ]);
    try {
      await waitFor(async () => {
        const [peers, routes] = await Promise.all([
          execRelayWithNetAdmin(["wg", "show", "wg0", "peers"]),
          execRelayWithNetAdmin([
            "ip",
            "-j",
            "route",
            "show",
            "dev",
            "wg0",
            "proto",
            "186",
          ]),
        ]);
        return (
          peers.stdout.trim().split("\n").filter(Boolean).length === 1 &&
          !routes.stdout.includes("10.91.16.10")
        );
      }, "relay retained a stale WireGuard peer or /32 route");
    } catch (error) {
      const [peers, routes, relayLogs, apiLogs] = await Promise.all([
        execRelayWithNetAdmin(["wg", "show", "wg0", "peers"]),
        execRelayWithNetAdmin([
          "ip",
          "route",
          "show",
          "dev",
          "wg0",
          "proto",
          "186",
        ]),
        docker(["logs", relayContainer]),
        docker(["logs", apiContainer]),
      ]);
      throw new Error(
        `${error.message}; peers=${peers.stdout}${peers.stderr}; routes=${routes.stdout}${routes.stderr}; relay logs=${relayLogs.stdout}${relayLogs.stderr}; API logs=${apiLogs.stdout}${apiLogs.stderr}`,
      );
    }
    const [journal, relayInspection, relayLogs, runtimeDirectories] =
      await Promise.all([
        docker([
          "exec",
          relayContainer,
          "cat",
          "/run/vem/maintenance-relay/journal.json",
        ]),
        inspect(relayContainer),
        docker(["logs", relayContainer]),
        docker([
          "exec",
          relayContainer,
          "find",
          "/run/vem/maintenance-relay",
          "-maxdepth",
          "1",
          "-type",
          "d",
          "-name",
          "vem-relay-wg-*",
          "-print",
        ]),
      ]);
    assert.equal(
      [
        journal.stdout,
        journal.stderr,
        relayInspection.Config.Env.join("\n"),
        relayLogs.stdout,
        relayLogs.stderr,
      ].some((output) => output.includes(relayKeyPair.privateKey)),
      false,
    );
    assert.equal(runtimeDirectories.stdout, "");
  });
});
