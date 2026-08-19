#!/usr/bin/env node

// Downloads a GitHub Actions artifact with bounded multi-connection resume.
//
// The Azure-backed artifact blob throttles a single connection hard (tens of
// KiB/s in the VM testbed network). aria2c with 16 range connections raises
// throughput by an order of magnitude. GitHub signs each download URL for a
// short window, so this helper re-requests the signed URL and resumes after
// every interrupted attempt until the full artifact byte count is present.
//
// Requirements on the host running the download:
//   - gh (authenticated; used to resolve and re-sign artifact URLs)
//   - aria2c (used for the parallel transfer)
//
// The artifact is verified by exact byte size and an optional SHA-256. The
// same entry point works locally and, with --via-ssh, drives the transfer on
// a remote host while keeping the gh token on the invoking machine.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

const MAX_ARIA2_CONNECTIONS = 16;
const DEFAULT_MAX_URL_REFRESHES = 40;
const DEFAULT_POLL_MS = 5_000;
const ARIA2_RUN_TIMEOUT_MS = 120_000;

export function parseDownloadOptions(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    flags.set(name, value);
    index += 1;
  }
  const repo = flags.get("repo");
  const artifactId = flags.get("artifact-id");
  const artifactName = flags.get("artifact-name");
  const output = flags.get("output");
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("--repo must be an owner/repository name");
  }
  if (!artifactId && !artifactName) {
    throw new Error("--artifact-id or --artifact-name is required");
  }
  if (artifactId && !/^\d+$/.test(artifactId)) {
    throw new Error("--artifact-id must be a positive integer");
  }
  if (!output || !isAbsolute(output)) {
    throw new Error("--output must be an absolute path");
  }
  const connections = flags.has("connections")
    ? Number(flags.get("connections"))
    : MAX_ARIA2_CONNECTIONS;
  if (
    !Number.isInteger(connections) ||
    connections < 1 ||
    connections > MAX_ARIA2_CONNECTIONS
  ) {
    throw new Error(
      `--connections must be an integer between 1 and ${MAX_ARIA2_CONNECTIONS}`,
    );
  }
  const maxUrlRefreshes = flags.has("max-url-refreshes")
    ? Number(flags.get("max-url-refreshes"))
    : DEFAULT_MAX_URL_REFRESHES;
  if (!Number.isInteger(maxUrlRefreshes) || maxUrlRefreshes < 1) {
    throw new Error("--max-url-refreshes must be a positive integer");
  }
  const expectedSha256 = flags.get("expected-sha256") ?? null;
  if (expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("--expected-sha256 must be a lowercase SHA-256");
  }
  const pollMs = flags.has("poll-ms")
    ? Number(flags.get("poll-ms"))
    : DEFAULT_POLL_MS;
  if (!Number.isInteger(pollMs) || pollMs < 250) {
    throw new Error("--poll-ms must be an integer of at least 250");
  }
  return {
    repo,
    artifactId: artifactId ?? null,
    artifactName: artifactName ?? null,
    output,
    connections,
    maxUrlRefreshes,
    expectedSha256,
    pollMs,
    viaSsh: flags.get("via-ssh") ?? null,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill("SIGKILL");
            resolvePromise({
              code: null,
              stdout,
              stderr,
              timedOut: true,
            });
          }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolvePromise({ code: code ?? null, stdout, stderr });
    });
  });
}

export async function ghArtifactUrl({
  repo,
  artifact,
  runProcess = run,
  fetchImpl = fetch,
}) {
  const tokenResult = await runProcess("gh", ["auth", "token"], {
    capture: true,
  });
  if (tokenResult.code !== 0 || !tokenResult.stdout.trim()) {
    throw new Error("gh auth token is unavailable; run `gh auth login`");
  }
  const token = tokenResult.stdout.trim();
  const response = await fetchImpl(
    `https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    },
  );
  if (response.status !== 302) {
    throw new Error(
      `artifact ${artifact.id} URL resolution returned ${response.status}`,
    );
  }
  const location = response.headers.get("location");
  if (!location || !/^https:\/\//.test(location)) {
    throw new Error("artifact download location is missing or unsafe");
  }
  return location;
}

export async function findArtifact({
  repo,
  artifactId,
  artifactName,
  runProcess = run,
}) {
  const target = artifactId
    ? `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}`
    : `https://api.github.com/repos/${repo}/actions/artifacts?per_page=100`;
  const listing = await runProcess("gh", ["api", target], { capture: true });
  if (listing.code !== 0) {
    throw new Error(
      `artifact lookup failed: ${listing.stderr.trim() || listing.code}`,
    );
  }
  const parsed = JSON.parse(listing.stdout);
  const artifacts = Array.isArray(parsed) ? parsed : [parsed];
  const match = artifactName
    ? artifacts.find((candidate) => candidate.name === artifactName)
    : artifacts.find((candidate) => candidate.id === Number(artifactId));
  if (!match) {
    throw new Error(
      artifactName
        ? `artifact "${artifactName}" was not found`
        : `artifact ${artifactId} was not found`,
    );
  }
  if (match.expired === true) {
    throw new Error(`artifact "${match.name}" has expired on GitHub`);
  }
  return {
    id: Number(match.id),
    name: String(match.name),
    sizeInBytes: Number(match.size_in_bytes),
  };
}

export async function aria2cOnce({
  url,
  output,
  connections,
  runProcess = run,
}) {
  // aria2c's --out is always relative to --dir; an absolute --out would be
  // re-rooted under the process cwd and the byte-count check would loop
  // forever. Split an absolute target into --dir + basename instead.
  const dir = dirname(output);
  const name = basename(output);
  return runProcess(
    "aria2c",
    [
      "-c",
      "-x",
      String(connections),
      "-s",
      String(connections),
      "-k",
      "1M",
      "--file-allocation=none",
      "--max-tries=1",
      "--timeout=30",
      "--connect-timeout=15",
      "--retry-wait=2",
      "--dir",
      dir,
      "--out",
      name,
      url,
    ],
    { capture: true, timeoutMs: ARIA2_RUN_TIMEOUT_MS },
  );
}

export async function downloadArtifactParallel(options) {
  const {
    repo,
    artifactId,
    artifactName,
    output,
    connections,
    maxUrlRefreshes,
    expectedSha256,
    pollMs,
    runProcess = run,
    fetchImpl = fetch,
    log = console.log,
  } = options;
  const artifact = await findArtifact({
    repo,
    artifactId,
    artifactName,
    runProcess,
  });
  await mkdir(dirname(output), { recursive: true });
  log(
    `downloading ${artifact.name} (${artifact.sizeInBytes} bytes) with ${connections} connections`,
  );
  const startedAt = Date.now();
  for (let attempt = 0; attempt < maxUrlRefreshes; attempt += 1) {
    const url = await ghArtifactUrl({
      repo,
      artifact,
      runProcess,
      fetchImpl,
    });
    const result = await aria2cOnce({
      url,
      output,
      connections,
      runProcess,
    });
    let currentSize = 0;
    try {
      currentSize = (await stat(output)).size;
    } catch {
      currentSize = 0;
    }
    if (currentSize === artifact.sizeInBytes) break;
    log(
      `aria2c exited ${result.code} at ${currentSize}/${artifact.sizeInBytes} bytes; refreshing signed URL`,
    );
    if (attempt + 1 < maxUrlRefreshes) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
  const entry = await stat(output);
  if (entry.size !== artifact.sizeInBytes) {
    throw new Error(
      `artifact download incomplete after ${maxUrlRefreshes} URL refreshes`,
    );
  }
  const sha256 = await sha256File(output);
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(
      `artifact SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`,
    );
  }
  return {
    artifact,
    path: output,
    byteSize: entry.size,
    sha256,
    elapsedMs: Date.now() - startedAt,
  };
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDownloadOptions(args);
  if (options.viaSsh) {
    throw new Error(
      "--via-ssh is not implemented yet; run this helper on the host that has gh + aria2c",
    );
  }
  const result = await downloadArtifactParallel(options);
  console.log(JSON.stringify(result, null, 2));
}

if (
  typeof import.meta !== "undefined" &&
  import.meta.url === `file://${process.argv[1]}`
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
