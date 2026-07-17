import {
  invalidDaemonIpcScannerStatuses,
  validDaemonIpcScannerStatuses,
} from "@vem/shared/fixtures/daemon-ipc-scanner";
import {
  invalidCurrentDaemonIpcTransactionSnapshots,
  validCurrentDaemonIpcTransactionSnapshots,
} from "@vem/shared/fixtures/daemon-ipc-transaction";
import {
  type DaemonIpcJsonSchemaDocument,
  exportDaemonIpcScannerStatusJsonSchema,
  exportDaemonIpcSaleStartCapabilityJsonSchema,
  exportDaemonIpcTransactionCheckoutJsonSchema,
} from "@vem/shared/schemas/daemon-ipc";
import { exportRuntimeConfigurationJsonSchema } from "@vem/shared/schemas/runtime-configuration";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type SpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type SpawnSync = (
  command: string,
  args: string[],
  options: { cwd: string; encoding: "utf8" },
) => SpawnResult;

type GeneratorMode = "write" | "check";

type GeneratorPaths = {
  transactionSchemaPath: string;
  transactionGeneratedPath: string;
  transactionValidFixturePath: string;
  transactionInvalidFixturePath: string;
  scannerSchemaPath: string;
  scannerGeneratedPath: string;
  scannerValidFixturePath: string;
  scannerInvalidFixturePath: string;
  runtimeConfigurationSchemaPath: string;
  runtimeConfigurationGeneratedPath: string;
  saleStartCapabilitySchemaPath: string;
  saleStartCapabilityGeneratedPath: string;
};

export type DaemonIpcGeneratedContractInputs = {
  transaction: {
    schema: DaemonIpcJsonSchemaDocument;
    validFixtures: unknown[];
    invalidFixtures: Array<{ name: string; snapshot: unknown }>;
  };
  scanner: {
    schema: DaemonIpcJsonSchemaDocument;
    validFixtures: unknown[];
    invalidFixtures: Array<{ name: string; snapshot: unknown }>;
  };
  runtimeConfiguration: {
    schema: DaemonIpcJsonSchemaDocument;
  };
  saleStartCapability: {
    schema: DaemonIpcJsonSchemaDocument;
  };
};

export type DaemonIpcContractGenerationResult = {
  mode: GeneratorMode;
  checkedPaths: string[];
  changedPaths: string[];
};

const thisFile = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(thisFile), "../..");
const expectedCargoTypifyVersion = "cargo-typify 0.7.0";

function defaultPaths(repoRoot: string): GeneratorPaths {
  const crateRoot = resolve(repoRoot, "crates/daemon-ipc-contracts");
  return {
    transactionSchemaPath: resolve(
      crateRoot,
      "schemas/transaction_checkout.schema.json",
    ),
    transactionGeneratedPath: resolve(
      crateRoot,
      "src/generated/transaction_checkout.rs",
    ),
    transactionValidFixturePath: resolve(
      crateRoot,
      "tests/fixtures/transaction_checkout_valid.snapshots.json",
    ),
    transactionInvalidFixturePath: resolve(
      crateRoot,
      "tests/fixtures/transaction_checkout_invalid.snapshots.json",
    ),
    scannerSchemaPath: resolve(crateRoot, "schemas/scanner_status.schema.json"),
    scannerGeneratedPath: resolve(crateRoot, "src/generated/scanner_status.rs"),
    scannerValidFixturePath: resolve(
      crateRoot,
      "tests/fixtures/scanner_status_valid.snapshots.json",
    ),
    scannerInvalidFixturePath: resolve(
      crateRoot,
      "tests/fixtures/scanner_status_invalid.snapshots.json",
    ),
    runtimeConfigurationSchemaPath: resolve(
      crateRoot,
      "schemas/runtime_configuration.schema.json",
    ),
    runtimeConfigurationGeneratedPath: resolve(
      crateRoot,
      "src/generated/runtime_configuration.rs",
    ),
    saleStartCapabilitySchemaPath: resolve(
      crateRoot,
      "schemas/sale_start_capability.schema.json",
    ),
    saleStartCapabilityGeneratedPath: resolve(
      crateRoot,
      "src/generated/sale_start_capability.rs",
    ),
  };
}

function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeJson(path: string, value: unknown) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function getCargoTypifyVersion(repoRoot: string, spawnSync: SpawnSync): string {
  const version = spawnSync("cargo", ["typify", "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (version.status !== 0) {
    throw new Error(
      [
        "cargo typify --version failed for Daemon IPC contract generation",
        version.stdout,
        version.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const actualVersion = version.stdout.trim();
  if (actualVersion !== expectedCargoTypifyVersion) {
    throw new Error(
      `Expected ${expectedCargoTypifyVersion} for Daemon IPC contract generation, got ${actualVersion}`,
    );
  }

  return actualVersion;
}

function generatedHeader(
  cargoTypifyVersion: string,
  sourcePath: string,
): string {
  return [
    "// @generated by scripts/daemon-ipc-contracts/generate-contracts.ts",
    `// Source: ${sourcePath} via Zod 4 JSON Schema export.`,
    `// Generator: ${cargoTypifyVersion}. Do not edit by hand.`,
    "#![allow(dead_code)]",
    "",
  ].join("\n");
}

function writeGeneratorInputs(
  paths: GeneratorPaths,
  inputs: DaemonIpcGeneratedContractInputs,
) {
  writeJson(paths.transactionSchemaPath, inputs.transaction.schema);
  writeJson(
    paths.transactionValidFixturePath,
    inputs.transaction.validFixtures,
  );
  writeJson(
    paths.transactionInvalidFixturePath,
    inputs.transaction.invalidFixtures,
  );
  writeJson(paths.scannerSchemaPath, inputs.scanner.schema);
  writeJson(paths.scannerValidFixturePath, inputs.scanner.validFixtures);
  writeJson(paths.scannerInvalidFixturePath, inputs.scanner.invalidFixtures);
  writeJson(
    paths.runtimeConfigurationSchemaPath,
    inputs.runtimeConfiguration.schema,
  );
  writeJson(
    paths.saleStartCapabilitySchemaPath,
    inputs.saleStartCapability.schema,
  );
}

function formatGeneratorJsonInputs(
  repoRoot: string,
  paths: GeneratorPaths,
  spawnSync: SpawnSync,
) {
  const oxfmt = spawnSync(
    "node",
    [
      resolve(repoRoot, "node_modules/oxfmt/dist/cli.js"),
      paths.transactionSchemaPath,
      paths.transactionValidFixturePath,
      paths.transactionInvalidFixturePath,
      paths.scannerSchemaPath,
      paths.scannerValidFixturePath,
      paths.scannerInvalidFixturePath,
      paths.runtimeConfigurationSchemaPath,
      paths.saleStartCapabilitySchemaPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (oxfmt.status !== 0) {
    throw new Error(
      [
        "oxfmt failed for Daemon IPC generated JSON inputs",
        oxfmt.stdout,
        oxfmt.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function runCargoTypify(
  repoRoot: string,
  schemaPath: string,
  generatedPath: string,
  spawnSync: SpawnSync,
) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  const typify = spawnSync(
    "cargo",
    [
      "typify",
      "--no-builder",
      "--additional-derive",
      "PartialEq",
      "--output",
      generatedPath,
      schemaPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (typify.status !== 0) {
    throw new Error(
      [
        `cargo typify failed for Daemon IPC schema ${relativePath(schemaPath, repoRoot)}`,
        typify.stdout,
        typify.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function writeGeneratedHeader(
  path: string,
  cargoTypifyVersion: string,
  sourcePath = "packages/shared/src/schemas/daemon-ipc.ts",
) {
  const generated = readIfExists(path) ?? "";
  writeText(
    path,
    `${generatedHeader(cargoTypifyVersion, sourcePath)}${generated}`,
  );
}

function relativePath(path: string, repoRoot: string): string {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}

function assertFreshGeneratedOutputs(
  expectedPaths: GeneratorPaths,
  actualPaths: GeneratorPaths,
  repoRoot: string,
): string[] {
  const changedPaths = Object.entries(expectedPaths)
    .filter(
      ([key, expectedPath]) =>
        readIfExists(expectedPath) !==
        readIfExists(actualPaths[key as keyof GeneratorPaths]),
    )
    .map(([, expectedPath]) => expectedPath);

  if (changedPaths.length > 0) {
    throw new Error(
      [
        "Daemon IPC generated contracts are stale. Run `pnpm generate:daemon-ipc-contracts` and commit the regenerated files.",
        ...changedPaths.map(
          (path) => `changed: ${relativePath(path, repoRoot)}`,
        ),
      ].join("\n"),
    );
  }

  return changedPaths;
}

export function buildDaemonIpcGeneratedContractInputs(): DaemonIpcGeneratedContractInputs {
  return {
    transaction: {
      schema: exportDaemonIpcTransactionCheckoutJsonSchema(),
      validFixtures: Object.values(validCurrentDaemonIpcTransactionSnapshots),
      invalidFixtures: Object.entries(
        invalidCurrentDaemonIpcTransactionSnapshots,
      ).map(([name, snapshot]) => ({ name, snapshot })),
    },
    scanner: {
      schema: exportDaemonIpcScannerStatusJsonSchema(),
      validFixtures: Object.values(validDaemonIpcScannerStatuses),
      invalidFixtures: Object.entries(invalidDaemonIpcScannerStatuses).map(
        ([name, snapshot]) => ({ name, snapshot }),
      ),
    },
    runtimeConfiguration: {
      schema: exportRuntimeConfigurationJsonSchema(),
    },
    saleStartCapability: {
      schema: exportDaemonIpcSaleStartCapabilityJsonSchema(),
    },
  };
}

export type DaemonIpcTransactionCheckoutContractInputs =
  DaemonIpcGeneratedContractInputs["transaction"];

export function generateDaemonIpcContracts(
  options: {
    mode?: GeneratorMode;
    repoRoot?: string;
    spawnSync?: SpawnSync;
  } = {},
): DaemonIpcContractGenerationResult {
  const mode = options.mode ?? "write";
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const spawnSync = options.spawnSync ?? nodeSpawnSync;
  const targetPaths = defaultPaths(repoRoot);
  const inputs = buildDaemonIpcGeneratedContractInputs();
  const checkedPaths = Object.values(targetPaths);

  if (mode === "write") {
    writeGeneratorInputs(targetPaths, inputs);
    formatGeneratorJsonInputs(repoRoot, targetPaths, spawnSync);
    const cargoTypifyVersion = getCargoTypifyVersion(repoRoot, spawnSync);
    runCargoTypify(
      repoRoot,
      targetPaths.transactionSchemaPath,
      targetPaths.transactionGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      targetPaths.transactionGeneratedPath,
      cargoTypifyVersion,
    );
    runCargoTypify(
      repoRoot,
      targetPaths.scannerSchemaPath,
      targetPaths.scannerGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(targetPaths.scannerGeneratedPath, cargoTypifyVersion);
    runCargoTypify(
      repoRoot,
      targetPaths.runtimeConfigurationSchemaPath,
      targetPaths.runtimeConfigurationGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      targetPaths.runtimeConfigurationGeneratedPath,
      cargoTypifyVersion,
      "packages/shared/src/schemas/runtime-configuration.ts",
    );
    runCargoTypify(
      repoRoot,
      targetPaths.saleStartCapabilitySchemaPath,
      targetPaths.saleStartCapabilityGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      targetPaths.saleStartCapabilityGeneratedPath,
      cargoTypifyVersion,
    );
    return { mode, checkedPaths, changedPaths: [] };
  }

  const tempRoot = mkdtempSync(join(tmpdir(), "vem-daemon-ipc-contracts-"));
  try {
    const actualPaths = defaultPaths(tempRoot);
    writeGeneratorInputs(actualPaths, inputs);
    formatGeneratorJsonInputs(repoRoot, actualPaths, spawnSync);
    const cargoTypifyVersion = getCargoTypifyVersion(repoRoot, spawnSync);
    runCargoTypify(
      repoRoot,
      actualPaths.transactionSchemaPath,
      actualPaths.transactionGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      actualPaths.transactionGeneratedPath,
      cargoTypifyVersion,
    );
    runCargoTypify(
      repoRoot,
      actualPaths.scannerSchemaPath,
      actualPaths.scannerGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(actualPaths.scannerGeneratedPath, cargoTypifyVersion);
    runCargoTypify(
      repoRoot,
      actualPaths.runtimeConfigurationSchemaPath,
      actualPaths.runtimeConfigurationGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      actualPaths.runtimeConfigurationGeneratedPath,
      cargoTypifyVersion,
      "packages/shared/src/schemas/runtime-configuration.ts",
    );
    runCargoTypify(
      repoRoot,
      actualPaths.saleStartCapabilitySchemaPath,
      actualPaths.saleStartCapabilityGeneratedPath,
      spawnSync,
    );
    writeGeneratedHeader(
      actualPaths.saleStartCapabilityGeneratedPath,
      cargoTypifyVersion,
    );
    const changedPaths = assertFreshGeneratedOutputs(
      targetPaths,
      actualPaths,
      repoRoot,
    );
    return { mode, checkedPaths, changedPaths };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function main() {
  const mode: GeneratorMode = process.argv.includes("--check")
    ? "check"
    : "write";
  const result = generateDaemonIpcContracts({ mode });
  const action = mode === "check" ? "checked" : "generated";
  for (const path of result.checkedPaths) {
    console.log(`${action}: ${relativePath(path, defaultRepoRoot)}`);
  }
}

if (process.argv[1] === thisFile) {
  main();
}
