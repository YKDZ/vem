import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aria2cOnce,
  downloadArtifactParallel,
  findArtifact,
  ghArtifactUrl,
  parseDownloadOptions,
} from "./download-github-artifact-parallel.ts";

const ARTIFACT = {
  id: 42,
  name: "vending-vision-main-deadbeef",
  size_in_bytes: 8,
  expired: false,
};

type JsonRecord = Record<string, unknown>;

type RunProcessFixture = NonNullable<
  Parameters<typeof aria2cOnce>[0]["runProcess"]
>;

function fakeResponse(headers: Record<string, string | null>): Response {
  return {
    status: 302,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  } as unknown as Response;
}

function runProcessFixture(
  behavior: (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      capture?: boolean;
      timeoutMs?: number;
    },
  ) => {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  } | Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
  }>,
): RunProcessFixture {
  return async (command: string, args: string[], options = {}) => {
    assert.equal(typeof command, "string");
    return behavior(command, args, options);
  };
}

test("aria2cOnce splits an absolute output into --dir and --out", async () => {
  const observed: { args?: string[]; options?: JsonRecord } = {};
  const runProcess = runProcessFixture(async (_command, args, options) => {
    observed.args = args;
    observed.options = options;
    return { code: 0, stdout: "", stderr: "" };
  });
  await aria2cOnce({
    url: "https://example.test/artifact.zip",
    output: "/opt/candidate/actions-artifact.zip",
    connections: 16,
    runProcess,
  });
  assert.ok(observed.args);
  const dirIndex = observed.args.indexOf("--dir");
  const outIndex = observed.args.indexOf("--out");
  assert.ok(dirIndex >= 0);
  assert.ok(outIndex >= 0);
  assert.equal(observed.args[dirIndex + 1], "/opt/candidate");
  assert.equal(observed.args[outIndex + 1], "actions-artifact.zip");
  assert.equal(
    observed.args.includes("/opt/candidate/actions-artifact.zip"),
    false,
  );
  assert.ok(observed.options);
  assert.equal(observed.options.capture, true);
  assert.equal(observed.options.timeoutMs, 120_000);
});

test("parseDownloadOptions validates the download contract", () => {
  const options = parseDownloadOptions([
    "--repo",
    "hbhjt/vending-vision",
    "--artifact-id",
    "42",
    "--output",
    "/tmp/artifact.zip",
    "--connections",
    "16",
  ]);
  assert.equal(options.repo, "hbhjt/vending-vision");
  assert.equal(options.artifactId, "42");
  assert.equal(options.output, "/tmp/artifact.zip");
  assert.equal(options.connections, 16);
  assert.equal(options.maxUrlRefreshes, 40);
  assert.throws(
    () =>
      parseDownloadOptions([
        "--repo",
        "hbhjt/vending-vision",
        "--output",
        "/tmp/artifact.zip",
      ]),
    /--artifact-id or --artifact-name is required/,
  );
  assert.throws(
    () =>
      parseDownloadOptions([
        "--repo",
        "hbhjt/vending-vision",
        "--artifact-id",
        "42",
        "--output",
        "relative.zip",
      ]),
    /--output must be an absolute path/,
  );
  assert.throws(
    () =>
      parseDownloadOptions([
        "--repo",
        "hbhjt/vending-vision",
        "--artifact-id",
        "42",
        "--output",
        "/tmp/artifact.zip",
        "--connections",
        "64",
      ]),
    /--connections must be an integer between 1 and 16/,
  );
});

test("findArtifact resolves the artifact by id or name", async () => {
  const byId = runProcessFixture(() => ({
    code: 0,
    stdout: JSON.stringify(ARTIFACT),
    stderr: "",
  }));
  assert.deepEqual(
    await findArtifact({
      repo: "hbhjt/vending-vision",
      artifactId: "42",
      artifactName: null,
      runProcess: byId,
    }),
    { id: 42, name: ARTIFACT.name, sizeInBytes: 8 },
  );

  const byName = runProcessFixture((_command, args) => {
    assert.match(args.join(" "), /artifacts\?per_page=100/);
    return {
      code: 0,
      stdout: JSON.stringify([{ ...ARTIFACT, id: 7 }]),
      stderr: "",
    };
  });
  const resolved = await findArtifact({
    repo: "hbhjt/vending-vision",
    artifactId: null,
    artifactName: ARTIFACT.name,
    runProcess: byName,
  });
  assert.equal(resolved.id, 7);

  const expired = runProcessFixture(() => ({
    code: 0,
    stdout: JSON.stringify({ ...ARTIFACT, expired: true }),
    stderr: "",
  }));
  await assert.rejects(
    findArtifact({
      repo: "hbhjt/vending-vision",
      artifactId: "42",
      artifactName: null,
      runProcess: expired,
    }),
    /has expired on GitHub/,
  );
});

test("ghArtifactUrl requires an authenticated gh token and an HTTPS location", async () => {
  const runProcess = runProcessFixture((command, args) => {
    assert.equal(command, "gh");
    return { code: 0, stdout: "secret-token\n", stderr: "" };
  });
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    assert.equal(
      input,
      "https://api.github.com/repos/hbhjt/vending-vision/actions/artifacts/42/zip",
    );
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer secret-token");
    assert.equal(init?.redirect, "manual");
    return fakeResponse({
      location: "https://blob.example/artifact.zip",
    });
  };
  assert.equal(
    await ghArtifactUrl({
      repo: "hbhjt/vending-vision",
      artifact: { id: 42 },
      runProcess,
      fetchImpl,
    }),
    "https://blob.example/artifact.zip",
  );

  await assert.rejects(
    ghArtifactUrl({
      repo: "hbhjt/vending-vision",
      artifact: { id: 42 },
      runProcess,
      fetchImpl: async () => fakeResponse({ location: null }),
    }),
    /download location is missing or unsafe/,
  );
});

test("downloadArtifactParallel resumes after partial attempts and verifies SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-download-test-"));
  const output = join(root, "artifact.zip");
  try {
    await writeFile(output, "half");
    const payload = Buffer.from("full-bod");
    let aria2cCalls = 0;
    let urlFetches = 0;
    const runProcess = runProcessFixture(async (command, args) => {
      if (command === "gh" && args[0] === "auth") {
        return { code: 0, stdout: "token\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "api") {
        return { code: 0, stdout: JSON.stringify(ARTIFACT), stderr: "" };
      }
      if (command === "aria2c") {
        aria2cCalls += 1;
        if (aria2cCalls === 1) {
          // First signed URL window is interrupted mid-transfer.
          return { code: 3, stdout: "", stderr: "expired" };
        }
        await writeFileSyncForTest(output, payload);
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${command}`);
    });
    const fetchImpl = async () => {
      urlFetches += 1;
      return fakeResponse({ location: "https://blob.example/artifact.zip" });
    };
    const logs: string[] = [];
    const result = await downloadArtifactParallel({
      repo: "hbhjt/vending-vision",
      artifactId: "42",
      artifactName: null,
      output,
      connections: 4,
      maxUrlRefreshes: 3,
      expectedSha256: await sha256Buffer(payload),
      pollMs: 250,
      runProcess,
      fetchImpl,
      log: (message: string) => logs.push(message),
    });
    assert.equal(aria2cCalls, 2);
    assert.equal(urlFetches, 2);
    assert.equal(result.byteSize, 8);
    assert.equal(result.sha256, await sha256Buffer(payload));
    assert.equal(await readFile(output, "utf8"), payload.toString("utf8"));
    assert.ok(logs.some((line) => line.includes("refreshing signed URL")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function writeFileSyncForTest(path: string, buffer: Buffer) {
  // Deferred to keep the fixture readable without a top-level fs import alias.
  return writeFile(path, buffer);
}

async function sha256Buffer(buffer: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(buffer).digest("hex");
}
