import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const cli = join(repoRoot, "scripts/precutover-managed-media.mjs");
const token = "test-owned-daemon-token";
const mediaBytes = Buffer.from("test-owned-managed-media-bytes\n");
const digest = `sha256:${createHash("sha256").update(mediaBytes).digest("hex")}`;
const descriptor = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  reference: "/api/media-assets/00000000-0000-4000-8000-000000000001/content",
  digest,
  contentType: "image/png",
  byteSize: mediaBytes.byteLength,
  purpose: "product_display_image",
  revision: { catalogRevision: "catalog-42", assetRevision: "asset-7" },
});

const temporaryRoots = [];
afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (status) =>
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function withDaemon(options, callback) {
  let snapshotReads = 0;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization ?? null,
      method: request.method,
      url: request.url,
    });
    if (request.url === "/v1/media/snapshot") {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      snapshotReads += 1;
      const generation =
        options.generationChange && snapshotReads > 1
          ? "catalog-43"
          : "catalog-42";
      const projection = {
        descriptor,
        readiness: options.readiness ?? "ready",
        readyUrl: null,
        diagnostic: null,
        diagnosticReason: null,
      };
      projection.readyUrl = `${origin}/media/${digest}?grant=abcdefghijklmnop`;
      if (projection.readiness !== "ready") {
        projection.readyUrl = null;
        projection.diagnostic = "not ready";
        projection.diagnosticReason = "download_failed";
      }
      const assets = options.missing
        ? []
        : options.duplicate
          ? [projection, structuredClone(projection)]
          : [projection];
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ generation, assets }));
      return;
    }
    if (request.url === "/v1/sale-view") {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          items: [
            {
              catalogKey: "product-1:variant-1",
              coverImageMedia: descriptor,
              coverImageReadyUrl: `${origin}/media/${digest}?grant=abcdefghijklmnop`,
              tryOnGarmentMedia: null,
              tryOnGarmentReadyUrl: null,
            },
          ],
          source: "live",
          planogramVersion: "planogram-9",
          lastUpdatedAt: "2026-08-11T00:00:00.000Z",
        }),
      );
      return;
    }
    if (request.url === `/media/${digest}?grant=abcdefghijklmnop`) {
      if (options.notFound) {
        response.writeHead(404).end();
        return;
      }
      const body = options.tamper
        ? Buffer.from("tampered-media\n")
        : mediaBytes;
      const headers = {
        "content-type": descriptor.contentType,
        "content-length": String(body.byteLength),
        etag: `"${digest}"`,
      };
      response.writeHead(200, headers);
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ origin, requests });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("precutover managed-media receipt", () => {
  it("proves every public daemon media byte and emits a canonical receipt", async () => {
    await withDaemon({}, async ({ origin, requests }) => {
      const temporary = mkdtempSync(join(tmpdir(), "vem-media-receipt-"));
      temporaryRoots.push(temporary);
      const receiptPath = join(temporary, "receipt.json");
      const result = await run([
        "create",
        "--origin",
        origin,
        "--token",
        token,
        "--receipt",
        receiptPath,
      ]);
      assert.equal(result.status, 0, result.stderr);
      const raw = readFileSync(receiptPath, "utf8");
      const receipt = JSON.parse(raw);
      assert.equal(receipt.schemaVersion, "vem.precutover.managed-media.v1");
      assert.equal(receipt.generation, "catalog-42");
      assert.equal(receipt.planogramVersion, "planogram-9");
      assert.equal(receipt.assets.length, 1);
      assert.equal(receipt.assets[0].digest, digest);
      assert.equal(receipt.assets[0].byteSize, mediaBytes.byteLength);
      assert.match(receipt.assets[0].grantSha256, /^sha256:[a-f0-9]{64}$/);
      assert.equal(raw, `${JSON.stringify(receipt)}\n`);
      assert.deepEqual(
        requests.map(({ method, url }) => [method, url]),
        [
          ["GET", "/v1/media/snapshot"],
          ["GET", "/v1/sale-view"],
          ["HEAD", `/media/${digest}?grant=abcdefghijklmnop`],
          ["GET", `/media/${digest}?grant=abcdefghijklmnop`],
          ["GET", "/v1/media/snapshot"],
          ["GET", "/v1/sale-view"],
        ],
      );
      assert.equal(
        requests
          .filter(({ url }) => url.startsWith("/v1/"))
          .every(({ authorization }) => authorization === `Bearer ${token}`),
        true,
      );
    });
  });

  for (const [name, options, expected] of [
    ["warming", { readiness: "warming" }, /not ready/i],
    ["unavailable", { readiness: "unavailable" }, /not ready/i],
    ["missing", { missing: true }, /missing/i],
    ["duplicate", { duplicate: true }, /duplicate/i],
    ["generation change", { generationChange: true }, /generation changed/i],
    ["404", { notFound: true }, /status 404/i],
    ["tampered bytes", { tamper: true }, /byte size|digest/i],
  ]) {
    it(`rejects ${name}`, async () => {
      await withDaemon(options, async ({ origin }) => {
        const temporary = mkdtempSync(join(tmpdir(), "vem-media-reject-"));
        temporaryRoots.push(temporary);
        const result = await run([
          "create",
          "--origin",
          origin,
          "--token",
          token,
          "--receipt",
          join(temporary, "receipt.json"),
        ]);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, expected);
      });
    });
  }
});
