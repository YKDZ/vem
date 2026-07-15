#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  RUNTIME_ARTIFACT_FILES,
  RUNTIME_DESCRIPTOR_FILE,
  readRuntimeArtifactDescriptor,
  validateRuntimeArtifactDescriptor,
  validateRuntimeArtifactDirectory,
} from "../factory/runtime-artifact-descriptor.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const UPDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const DEFAULT_VISION_PYTHON = "3.11.9";
const PREAPPROVAL_FILES = [
  "bundle.bin",
  "vision-release-descriptor.json",
  "test-vision-candidate.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
  "preapproval-manifest.json",
  "SHA256SUMS",
];

function usage() {
  return `
prepare-unified-field-delivery.mjs prepare \
  --output DIR \
  --update-id ID \
  --runtime-directory DIR \
  --vision-preapproval-directory DIR \
  --vision-factory-directory DIR \
  --expected-vision-bundle-digest sha256:...

prepare-unified-field-delivery.mjs prepare-preapproval \
  --output DIR \
  --update-id ID \
  --runtime-directory DIR \
  --vision-preapproval-directory DIR \
  --expected-vision-bundle-digest sha256:...

prepare-unified-field-delivery.mjs skeleton \
  --output DIR \
  --update-id ID \
  --source-commit <40-hex> \
  [--expected-vision-bundle-digest sha256:...]
`.trim();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new Error(`invalid argument: ${token}`);
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestFile(path) {
  return digestBytes(readFileSync(path));
}

function assertSha256(value, label) {
  if (!SHA256.test(String(value ?? ""))) {
    throw new Error(`${label} must be sha256:<64 lowercase hex>`);
  }
  return String(value);
}

function assertCommit(value, label) {
  if (!COMMIT.test(String(value ?? ""))) {
    throw new Error(`${label} must be a full Git SHA`);
  }
  return String(value);
}

function assertUpdateId(value) {
  if (!UPDATE_ID.test(String(value ?? ""))) {
    throw new Error(
      "update-id must be 3-128 safe characters (letters, digits, . _ -)",
    );
  }
  return String(value);
}

function ensureEmptyDirectory(path) {
  const root = resolve(path);
  if (existsSync(root)) {
    throw new Error(`output already exists: ${root}`);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function copyTreeStrict(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });
}

function readJson(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function buildManagedUpdateManifest({
  updateId,
  sourceCommit,
  windowsStageRoot,
  runtimeDescriptor,
}) {
  const artifact = (role) =>
    runtimeDescriptor.artifacts.find((entry) => entry.role === role);
  const daemon = artifact("vem-daemon");
  const machine = artifact("vem-machine-ui");
  const webview = artifact("webview2-loader");
  return {
    updateId,
    sourceCommit,
    components: [
      {
        component: "daemon",
        artifactPath: `${windowsStageRoot}\\runtime\\${daemon.name}`,
        sha256: daemon.digest.slice(7),
        targetPath: "C:\\VEM\\bringup\\vending-daemon.exe",
      },
      {
        component: "ui",
        artifactPath: `${windowsStageRoot}\\runtime\\${machine.name}`,
        sha256: machine.digest.slice(7),
        targetPath: "C:\\VEM\\bringup\\machine.exe",
        sidecars: [
          {
            artifactPath: `${windowsStageRoot}\\runtime\\${webview.name}`,
            sha256: webview.digest.slice(7),
            targetPath: "C:\\VEM\\bringup\\WebView2Loader.dll",
          },
        ],
      },
    ],
  };
}

async function loadRuntimeDescriptor(runtimeDirectory) {
  const descriptor = validateRuntimeArtifactDescriptor(
    await readRuntimeArtifactDescriptor(runtimeDirectory),
  );
  await validateRuntimeArtifactDirectory(runtimeDirectory, descriptor);
  return descriptor;
}

function verifyPreapprovalDirectory(directory, expectedBundleDigest) {
  const root = resolve(directory);
  for (const name of PREAPPROVAL_FILES) {
    if (!existsSync(join(root, name))) {
      throw new Error(`vision preapproval file missing: ${name}`);
    }
  }
  const manifest = readJson(
    join(root, "preapproval-manifest.json"),
    "vision preapproval manifest",
  );
  if (
    manifest.schemaVersion !== "vem-vision-preapproval-delivery/v1" ||
    manifest.kind !== "vision-preapproval-delivery"
  ) {
    throw new Error("vision preapproval manifest contract is invalid");
  }
  const bundleDigest = assertSha256(
    manifest.expectedDigest,
    "vision preapproval expectedDigest",
  );
  if (expectedBundleDigest && bundleDigest !== expectedBundleDigest) {
    throw new Error("vision preapproval digest does not match expected digest");
  }
  for (const [name, digest] of Object.entries(manifest.files ?? {})) {
    if (!existsSync(join(root, name))) {
      throw new Error(
        `vision preapproval manifest references missing file: ${name}`,
      );
    }
    if (digestFile(join(root, name)) !== digest) {
      throw new Error(`vision preapproval file digest mismatch: ${name}`);
    }
  }
  return {
    root,
    manifest,
    expectedDigest: bundleDigest,
    descriptorDigest: assertSha256(
      manifest.descriptorDigest,
      "vision preapproval descriptorDigest",
    ),
  };
}

function verifyVisionFactoryDirectory(directory, expectedBundleDigest) {
  const root = resolve(directory);
  const provisioningPath = join(
    root,
    "VEM",
    "VISION-FACTORY-PROVISIONING.JSON",
  );
  const provisioning = readJson(
    provisioningPath,
    "vision factory provisioning manifest",
  );
  if (
    provisioning.schemaVersion !== "vem-vision-factory-provisioning/v1" ||
    provisioning.kind !== "vision-factory-provisioning"
  ) {
    throw new Error("vision factory provisioning manifest contract is invalid");
  }
  for (const [relativePath, digest] of Object.entries(
    provisioning.files ?? {},
  )) {
    const path = join(root, "VEM", ...relativePath.split("/"));
    if (!existsSync(path)) {
      throw new Error(`vision factory delivery file missing: ${relativePath}`);
    }
    if (digestFile(path) !== digest) {
      throw new Error(
        `vision factory delivery digest mismatch: ${relativePath}`,
      );
    }
  }
  const classificationPath = join(root, "experimental-acceptance.json");
  const classification = existsSync(classificationPath)
    ? readJson(classificationPath, "experimental Vision acceptance")
    : null;
  if (classification) {
    const bundleDigest = assertSha256(
      classification.bundleDigest,
      "experimental Vision bundle digest",
    );
    if (expectedBundleDigest && bundleDigest !== expectedBundleDigest) {
      throw new Error(
        "experimental Vision acceptance digest does not match expected digest",
      );
    }
  }
  return { root, provisioning, classification };
}

function stageSha256Sums(root) {
  const lines = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        visit(path);
      } else {
        lines.push(
          `${digestFile(path).slice(7)}  ${relative(root, path).replaceAll("\\", "/")}`,
        );
      }
    }
  }
  visit(root);
  writeFileSync(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function writeApplyInstructions(
  path,
  candidate,
  { includeVisionFactory = true } = {},
) {
  const lines = [
    "# Non-ISO / field host apply",
    `$updateRoot = "C:\\VEM\\updates\\${candidate.updateId}"`,
    `Get-FileHash -Algorithm SHA256 -LiteralPath "$updateRoot\\managed-update.json"`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\bringup\\apply-managed-update.ps1 \\`,
    `  -ManifestPath "$updateRoot\\managed-update.json" \\`,
    `  -EvidencePath "$updateRoot\\managed-update-evidence.json"`,
    "",
    "# Vision preapproval (same digest as later Factory/ISO)",
    `$preapproval = "$updateRoot\\vision-preapproval\\VEM-VISION-PREAPPROVAL"`,
    `$preapprovalManifest = Get-Content -LiteralPath "$preapproval\\preapproval-manifest.json" -Raw -Encoding UTF8 | ConvertFrom-Json`,
    `if ($preapprovalManifest.expectedDigest -cne "${candidate.vision.bundleDigest ?? "<missing-exact-digest>"}") { throw "unexpected Vision digest" }`,
    `& "$preapproval\\test-vision-candidate.ps1" \\`,
    `  -BundlePath "$preapproval\\bundle.bin" \\`,
    `  -ExpectedDigest $preapprovalManifest.expectedDigest \\`,
    `  -DescriptorPath "$preapproval\\vision-release-descriptor.json" \\`,
    `  -PreapprovalManifestPath "$preapproval\\preapproval-manifest.json" \\`,
    `  -ConformanceEvidencePath "$preapproval\\vision-conformance.json" \\`,
    `  -ReportPath "$preapproval\\vision-conformance-report.json"`,
  ];
  if (includeVisionFactory) {
    lines.push(
      "",
      "# Provision experimental Factory delivery bytes onto the host without changing install semantics",
      `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\bringup\\provision-vision-factory-release.ps1 \\`,
      `  -FactoryMediaRoot "$updateRoot\\vision-factory\\VEM"`,
    );
  } else {
    lines.push(
      "",
      "# Preapproval stops here and does not claim Factory acceptance.",
      "# Finalize later with the same exact runtime bytes, the same managed-update.json, and the same immutable Vision Candidate bytes.",
      "# Do not create a second Vision installer.",
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function buildCandidate({
  updateId,
  sourceCommit,
  runtimeDescriptor,
  visionBundleDigest,
  visionPythonVersion,
  preapproval,
  visionFactory,
}) {
  const runtimeArtifacts = Object.fromEntries(
    runtimeDescriptor.artifacts.map((artifact) => [
      artifact.role,
      {
        name: artifact.name,
        digest: artifact.digest,
        bytes: artifact.bytes,
      },
    ]),
  );
  return {
    schemaVersion: "vem-unified-field-delivery/v1",
    kind: "unified-field-delivery",
    updateId,
    sourceCommit,
    runtime: {
      descriptorIdentity: runtimeDescriptor.identity,
      workflowRunIdentity: runtimeDescriptor.workflow.identity,
      artifactName: runtimeDescriptor.workflow.artifactName,
      artifacts: runtimeArtifacts,
    },
    vision: {
      bundleDigest: visionBundleDigest ?? null,
      pythonVersion: visionPythonVersion,
      preapprovalDescriptorDigest: preapproval?.descriptorDigest ?? null,
      experimentalAcceptanceDigest:
        visionFactory?.classification?.bundleDigest ?? null,
    },
    progressiveAcceptance: {
      invariant:
        "One exact runtime descriptor and one exact Vision candidate digest flow through VM acceptance, non-ISO managed update, and Factory/ISO evidence.",
      verifierEntrypoint:
        "node scripts/windows/verify-progressive-delivery.mjs --candidate <candidate.json> ...",
    },
  };
}

async function prepare(
  options,
  {
    includeVisionFactory = true,
    requireExpectedVisionBundleDigest = false,
  } = {},
) {
  const outputRoot = ensureEmptyDirectory(options.output);
  const updateId = assertUpdateId(options["update-id"]);
  const runtimeDirectory = resolve(String(options["runtime-directory"] ?? ""));
  const runtimeDescriptor = await loadRuntimeDescriptor(runtimeDirectory);
  const sourceCommit = assertCommit(
    runtimeDescriptor.commit,
    "runtime descriptor commit",
  );
  const suppliedVisionBundleDigest = options["expected-vision-bundle-digest"];
  if (requireExpectedVisionBundleDigest && !suppliedVisionBundleDigest) {
    throw new Error(
      "expected vision bundle digest is required for preapproval",
    );
  }
  const expectedVisionBundleDigest = suppliedVisionBundleDigest
    ? assertSha256(suppliedVisionBundleDigest, "expected vision bundle digest")
    : null;
  const preapproval = verifyPreapprovalDirectory(
    options["vision-preapproval-directory"],
    expectedVisionBundleDigest,
  );
  const visionFactory = includeVisionFactory
    ? verifyVisionFactoryDirectory(
        options["vision-factory-directory"],
        expectedVisionBundleDigest ?? preapproval.expectedDigest,
      )
    : null;
  const visionBundleDigest =
    expectedVisionBundleDigest ?? preapproval.expectedDigest;
  const visionPythonVersion = String(
    options["vision-python-version"] ?? DEFAULT_VISION_PYTHON,
  );

  const runtimeOut = join(outputRoot, "runtime");
  mkdirSync(runtimeOut, { recursive: true });
  for (const file of [
    RUNTIME_DESCRIPTOR_FILE,
    ...RUNTIME_ARTIFACT_FILES.map((entry) => entry.name),
  ]) {
    copyFileSync(join(runtimeDirectory, file), join(runtimeOut, file));
  }

  const preapprovalOut = join(
    outputRoot,
    "vision-preapproval",
    "VEM-VISION-PREAPPROVAL",
  );
  copyTreeStrict(preapproval.root, preapprovalOut);
  if (visionFactory) {
    const visionFactoryOut = join(outputRoot, "vision-factory");
    copyTreeStrict(visionFactory.root, visionFactoryOut);
  }

  const windowsUpdateRoot = `C:\\VEM\\updates\\${updateId}`;
  const managedUpdateManifest = buildManagedUpdateManifest({
    updateId,
    sourceCommit,
    windowsStageRoot: windowsUpdateRoot,
    runtimeDescriptor,
  });
  writeJson(join(outputRoot, "managed-update.json"), managedUpdateManifest);

  const candidate = buildCandidate({
    updateId,
    sourceCommit,
    runtimeDescriptor,
    visionBundleDigest,
    visionPythonVersion,
    preapproval,
    visionFactory,
  });
  writeJson(join(outputRoot, "candidate.json"), candidate);
  writeApplyInstructions(
    join(outputRoot, "APPLY-FIELD-UPDATE.ps1"),
    candidate,
    {
      includeVisionFactory,
    },
  );
  writeJson(join(outputRoot, "progressive-acceptance.json"), {
    schemaVersion: "vem-progressive-acceptance-inputs/v1",
    kind: "progressive-acceptance-inputs",
    candidatePath: "candidate.json",
    managedUpdateManifestPath: "managed-update.json",
    vmRuntimeExpectation: {
      daemonSha256: candidate.runtime.artifacts["vem-daemon"].digest.slice(7),
      machineUiSha256:
        candidate.runtime.artifacts["vem-machine-ui"].digest.slice(7),
    },
    mergePreservationNote:
      "Factory and field work must keep one path: this candidate binds exact runtime bytes plus one immutable Vision digest; do not reintroduce direct exe replacement or stage-specific Vision rebuilds.",
  });
  stageSha256Sums(outputRoot);
}

function skeleton(options) {
  const outputRoot = ensureEmptyDirectory(options.output);
  const updateId = assertUpdateId(options["update-id"]);
  const sourceCommit = assertCommit(options["source-commit"], "source-commit");
  const visionBundleDigest = options["expected-vision-bundle-digest"]
    ? assertSha256(
        options["expected-vision-bundle-digest"],
        "expected vision bundle digest",
      )
    : null;

  mkdirSync(join(outputRoot, "runtime-input"), { recursive: true });
  mkdirSync(join(outputRoot, "vision-preapproval-input"), { recursive: true });
  mkdirSync(join(outputRoot, "vision-factory-input"), { recursive: true });
  writeJson(join(outputRoot, "required-inputs.json"), {
    schemaVersion: "vem-unified-field-delivery-skeleton/v1",
    kind: "unified-field-delivery-skeleton",
    updateId,
    sourceCommit,
    missingExactInputs: [
      "runtime-input/WINDOWS-RUNTIME-ARTIFACTS.json with vending-daemon.exe, machine.exe, WebView2Loader.dll",
      "vision-preapproval-input/VEM-VISION-PREAPPROVAL self-contained candidate delivery",
      "vision-factory-input experimental Factory delivery with VEM/VISION-FACTORY-PROVISIONING.JSON",
      visionBundleDigest
        ? null
        : "operator-pinned immutable Vision candidate digest",
    ].filter(Boolean),
    expectedVisionPythonVersion: DEFAULT_VISION_PYTHON,
  });
  writeFileSync(
    join(outputRoot, "NEXT-STEPS.md"),
    [
      `1. Place exact runtime artifacts plus ${RUNTIME_DESCRIPTOR_FILE} under \`runtime-input/\`.`,
      "2. Generate the self-contained Vision preapproval unit with:",
      "",
      "```bash",
      "node scripts/factory/experimental-vision-candidate.mjs prepare-preapproval \\",
      "  --candidate-dir /tmp/vision-candidate \\",
      "  --tag vX.Y.Z-rc.N \\",
      `  --expected-bundle-digest ${visionBundleDigest ?? "sha256:<operator-pinned-exact-bundle-digest>"} \\`,
      "  --expected-supplier-identity spki-sha256:<supplier-identity> \\",
      "  --output vision-preapproval-input",
      "```",
      "",
      "3. Build and apply the L3 preapproval phase before any Factory provisioning:",
      "",
      "```bash",
      "node scripts/windows/prepare-unified-field-delivery.mjs prepare-preapproval \\",
      `  --output /tmp/vem-field-preapproval-${updateId} \\`,
      `  --update-id ${updateId} \\`,
      "  --runtime-directory runtime-input \\",
      "  --vision-preapproval-directory vision-preapproval-input/VEM-VISION-PREAPPROVAL \\",
      `  --expected-vision-bundle-digest ${visionBundleDigest ?? "sha256:<operator-pinned-exact-bundle-digest>"}`,
      "```",
      "",
      "Run its APPLY-FIELD-UPDATE.ps1 to produce Vision conformance. This phase stops before Factory provisioning and does not claim Factory acceptance.",
      "",
      "4. Finalize the same exact Vision digest into an experimental Factory delivery with:",
      "",
      "```bash",
      "node scripts/factory/experimental-vision-candidate.mjs finalize \\",
      "  --candidate-dir /tmp/vision-candidate \\",
      "  --tag vX.Y.Z-rc.N \\",
      `  --expected-bundle-digest ${visionBundleDigest ?? "sha256:<operator-pinned-exact-bundle-digest>"} \\`,
      "  --expected-supplier-identity spki-sha256:<supplier-identity> \\",
      "  --conformance /tmp/vision-conformance.json \\",
      "  --acceptance-private-key /tmp/vem-acceptance-private.pem \\",
      "  --expected-acceptance-identity spki-sha256:<acceptance-identity> \\",
      "  --verifier /trusted/vision-release-verifier.exe \\",
      "  --base-manifest /trusted/factory-manifest.json \\",
      "  --output vision-factory-input",
      "```",
      "",
      "5. Re-run the final prepare command with the same update ID, runtime bytes, managed update, preapproval unit, and Vision installer; do not create a second installer.",
      "",
      "```bash",
      "node scripts/windows/prepare-unified-field-delivery.mjs prepare \\",
      `  --output /tmp/vem-field-test-candidate-<timestamp> \\`,
      `  --update-id ${updateId} \\`,
      "  --runtime-directory runtime-input \\",
      "  --vision-preapproval-directory vision-preapproval-input/VEM-VISION-PREAPPROVAL \\",
      "  --vision-factory-directory vision-factory-input \\",
      `  --expected-vision-bundle-digest ${visionBundleDigest ?? "sha256:<operator-pinned-exact-bundle-digest>"}`,
      "```",
    ].join("\n"),
  );
  stageSha256Sums(outputRoot);
}

const options = parseArgs(process.argv.slice(2));

Promise.resolve()
  .then(async () => {
    if (options.command === "prepare") {
      return prepare(options);
    }
    if (options.command === "prepare-preapproval") {
      return prepare(options, {
        includeVisionFactory: false,
        requireExpectedVisionBundleDigest: true,
      });
    }
    if (options.command === "skeleton") {
      return skeleton(options);
    }
    throw new Error(usage());
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
