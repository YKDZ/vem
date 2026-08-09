import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const visionRoot = fileURLToPath(
  new URL("../../../vending-vision", import.meta.url),
);

test("checks the committed Shared bundle without a sibling checkout", () => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/vision-v2-contracts/generate-bundle.ts",
      "--check",
      "--local-only",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=vem-source`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("publishes one deterministic V2 bundle and rejects cross-repository drift", () => {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/vision-v2-contracts/generate-bundle.ts",
      "--check",
      "--vision-root",
      visionRoot,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=vem-source`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("is byte-stable across two writes and identical in Vision", () => {
  const write = () =>
    spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/vision-v2-contracts/generate-bundle.ts",
        "--vision-root",
        visionRoot,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=vem-source`,
        },
      },
    );
  assert.equal(write().status, 0);
  const sourceManifest = readFileSync(
    `${root}/packages/shared/generated/vision-v2/manifest.json`,
    "utf8",
  );
  assert.equal(write().status, 0);
  assert.equal(
    readFileSync(
      `${root}/packages/shared/generated/vision-v2/manifest.json`,
      "utf8",
    ),
    sourceManifest,
  );
  assert.equal(
    readFileSync(`${visionRoot}/contracts/vem_vision_v2/manifest.json`, "utf8"),
    sourceManifest,
  );
});
