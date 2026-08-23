import Ajv from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface BundleTargets {
  sourceOutput: string;
  visionRoot: string;
}

interface SchemaProperty {
  const?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
}

interface SchemaBranch {
  properties?: Record<string, SchemaProperty>;
}

interface GeneratedSchema {
  oneOf?: SchemaBranch[];
}

interface FixtureMessage {
  name?: string;
  message?: unknown;
  type?: string;
  payload?: {
    result?: Record<string, unknown>;
  };
}

type AjvSchema = Parameters<Ajv["compile"]>[0];

function withTemporaryBundles<T>(callback: (targets: BundleTargets) => T): T {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "vem-vision-v2-contracts-"));
  const sourceOutput = join(temporaryRoot, "shared");
  const visionRoot = join(temporaryRoot, "vision");
  try {
    return callback({ sourceOutput, visionRoot });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function generate({
  sourceOutput,
  visionRoot,
  check = false,
}: BundleTargets & { check?: boolean }): SpawnSyncReturns<string> {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/vision-v2-contracts/generate-bundle.ts",
      ...(check ? ["--check"] : []),
      "--source-output",
      sourceOutput,
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
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function parseGeneratedSchema(path: string): GeneratedSchema {
  return parseJson(readFileSync(path, "utf8")) as GeneratedSchema;
}

function parseFixtures(path: string): FixtureMessage[] {
  return parseJson(readFileSync(path, "utf8")) as FixtureMessage[];
}

test("publishes byte-stable bundles only into temporary cross-repository targets", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    const sourceManifest = readFileSync(
      join(sourceOutput, "manifest.json"),
      "utf8",
    );
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    assert.equal(
      readFileSync(join(sourceOutput, "manifest.json"), "utf8"),
      sourceManifest,
    );
    assert.equal(
      readFileSync(
        join(visionRoot, "contracts/vem_vision_v2/manifest.json"),
        "utf8",
      ),
      sourceManifest,
    );
    const generatedRuntimeIdentity = readFileSync(
      join(root, "packages/shared/src/generated/vision-v2-bundle.ts"),
      "utf8",
    );
    assert.match(generatedRuntimeIdentity, /VISION_V2_RUNTIME_IDENTITY/);
    assert.match(
      generatedRuntimeIdentity,
      /protocol: visionV2BundleManifest\.protocol/,
    );
    assert.match(
      generatedRuntimeIdentity,
      /contractDigest: visionV2BundleManifest\.bundleDigest/,
    );
    assert.equal(generate({ sourceOutput, visionRoot, check: true }).status, 0);
  });
});

test("detects a tampered manifest and unexpected generated file", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    writeFileSync(join(sourceOutput, "manifest.json"), "{}\n", "utf8");
    const manifestDrift = generate({ sourceOutput, visionRoot, check: true });
    assert.notEqual(manifestDrift.status, 0);
    assert.match(
      String(manifestDrift.stderr),
      /Vision V2 contract bundle drifted/,
    );

    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    writeFileSync(join(sourceOutput, "unexpected.json"), "{}\n", "utf8");
    const extraFileDrift = generate({ sourceOutput, visionRoot, check: true });
    assert.notEqual(extraFileDrift.status, 0);
    assert.match(String(extraFileDrift.stderr), /unexpected\.json/);
  });
});

test("detects noncanonical and duplicate-key manifest spellings", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    const manifestPath = join(sourceOutput, "manifest.json");
    const rawManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(JSON.parse(rawManifest), null, 2)}\n`,
      "utf8",
    );
    assert.notEqual(
      generate({ sourceOutput, visionRoot, check: true }).status,
      0,
    );

    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    writeFileSync(
      manifestPath,
      rawManifest.replace(
        '"protocol":"vem.vision.v2",',
        '"protocol":"vem.vision.v2","protocol":"vem.vision.v2",',
      ),
      "utf8",
    );
    assert.notEqual(
      generate({ sourceOutput, visionRoot, check: true }).status,
      0,
    );
  });
});

test("publishes standalone Unicode code-point bounds with the shared corpus", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    const schema = parseGeneratedSchema(
      join(sourceOutput, "vision-v2.server.schema.json"),
    );
    const valid = parseFixtures(
      join(sourceOutput, "fixtures", "server-valid.json"),
    );
    const invalid = parseFixtures(
      join(sourceOutput, "fixtures", "server-invalid.json"),
    );
    const ready = schema.oneOf?.find(
      (branch) => branch.properties?.type?.const === "vision.ready",
    );
    assert.ok(ready);
    const readyProperties = ready.properties ?? {};
    const messageIdBounds = readyProperties.messageId ?? {};
    const capabilities = readyProperties.payload?.properties?.capabilities;
    assert.ok(capabilities);
    assert.deepEqual(
      {
        minLength: messageIdBounds.minLength,
        maxLength: messageIdBounds.maxLength,
        capabilityMaxLength: capabilities.items?.maxLength,
      },
      { minLength: 1, maxLength: 128, capabilityMaxLength: 64 },
    );

    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema as unknown as AjvSchema,
    );
    assert.equal(validate(valid.at(-1)), true);
    for (const fixture of invalid.filter((fixture) =>
      fixture.name?.includes("code-point-over-limit") ?? false,
    )) {
      assert.equal(validate(fixture.message), false, fixture.name ?? "fixture");
    }
  });
});

test("rejects the same HTTPS loopback result in TypeScript, JSON Schema, and generated Python guards", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    const valid = parseFixtures(
      join(sourceOutput, "fixtures", "server-valid.json"),
    );
    const completed = valid.find(
      (fixture) => fixture.type === "vision.try_on.attempt.completed",
    );
    assert.ok(completed);
    const completedPayload = completed.payload ?? {};
    const completedResult = completedPayload.result ?? {};
    const httpsResult = {
      ...completed,
      payload: {
        ...completedPayload,
        result: {
          ...completedResult,
          reference:
            "https://127.0.0.1:65499/results/output?token=result-token",
        },
      },
    };

    const schema = parseGeneratedSchema(
      join(sourceOutput, "vision-v2.server.schema.json"),
    );
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      schema as unknown as AjvSchema,
    );
    assert.equal(validate(httpsResult), false);
    assert.match(
      readFileSync(join(sourceOutput, "python", "vision_v2_models.py"), "utf8"),
      /parsed\.scheme != "http"/,
    );
  });
});
