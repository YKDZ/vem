import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDaemonIpcGeneratedContractInputs,
  generateDaemonIpcContracts,
} from "./generate-contracts";

describe("Daemon IPC contract generator", () => {
  it("exports transaction checkout Zod JSON Schema and shared fixtures as generator inputs", () => {
    const inputs = buildDaemonIpcGeneratedContractInputs().transaction;

    expect(inputs.schema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(inputs.schema.title).toBe("CurrentTransactionSnapshot");
    expect(inputs.schema).toHaveProperty("$defs.CheckoutFlowAction");
    expect(JSON.stringify(inputs.schema)).not.toContain("submit_payment");
    expect(JSON.stringify(inputs.schema)).not.toContain("collect_goods");
    expect(inputs.validFixtures.length).toBeGreaterThan(0);
    expect(inputs.invalidFixtures.map((fixture) => fixture.name)).toContain(
      "legacySubmitPaymentAction",
    );
  });

  it("exports scanner status JSON Schema and shared fixtures as generator inputs", () => {
    const inputs = buildDaemonIpcGeneratedContractInputs();

    expect(inputs.scanner.schema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(inputs.scanner.schema.title).toBe("ScannerRuntimeStatus");
    expect(inputs.scanner.schema).toHaveProperty("additionalProperties", false);
    expect(inputs.scanner.validFixtures).toContainEqual(
      expect.objectContaining({
        adapter: "serial_text",
        code: "SCANNER_READY",
      }),
    );
    expect(
      inputs.scanner.invalidFixtures.map((fixture) => fixture.name),
    ).toEqual(["unknownField", "missingCode"]);
  });

  it("orchestrates schema, fixture, and Rust generation without requiring git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-daemon-ipc-generator-"));
    const spawnCalls: Array<{ command: string; args: string[]; cwd: string }> =
      [];

    try {
      const result = generateDaemonIpcContracts({
        mode: "write",
        repoRoot: root,
        spawnSync(command, args, options) {
          spawnCalls.push({
            command,
            args: [...args],
            cwd: options.cwd,
          });
          if (command === "node") {
            return {
              status: 0,
              stdout: "",
              stderr: "",
            };
          }
          if (args.includes("--version")) {
            return {
              status: 0,
              stdout: "cargo-typify 0.7.0\n",
              stderr: "",
            };
          }

          const outputIndex = args.indexOf("--output");
          const outputPath = args[outputIndex + 1];
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, "#![allow(clippy::needless_lifetimes)]\n");
          return {
            status: 0,
            stdout: `generated ${outputPath}`,
            stderr: "",
          };
        },
      });

      expect(result.changedPaths).toEqual([]);
      expect(spawnCalls).toEqual([
        expect.objectContaining({
          command: "node",
          args: expect.arrayContaining([
            expect.stringContaining("node_modules/oxfmt/dist/cli.js"),
            expect.stringContaining("transaction_checkout.schema.json"),
            expect.stringContaining("scanner_status_invalid.snapshots.json"),
          ]),
          cwd: root,
        }),
        {
          command: "cargo",
          args: ["typify", "--version"],
          cwd: root,
        },
        expect.objectContaining({
          command: "cargo",
          args: expect.arrayContaining([
            "typify",
            "--no-builder",
            "--additional-derive",
            "PartialEq",
          ]),
          cwd: root,
        }),
        expect.objectContaining({
          command: "cargo",
          args: expect.arrayContaining([
            "typify",
            "--no-builder",
            "--additional-derive",
            "PartialEq",
          ]),
          cwd: root,
        }),
        expect.objectContaining({
          command: "cargo",
          args: expect.arrayContaining([
            "typify",
            "--no-builder",
            "--additional-derive",
            "PartialEq",
            expect.stringContaining(
              "src/generated/runtime_configuration.rs",
            ),
            expect.stringContaining("schemas/runtime_configuration.schema.json"),
          ]),
          cwd: root,
        }),
      ]);

      const schema = JSON.parse(
        readFileSync(
          join(
            root,
            "crates/daemon-ipc-contracts/schemas/transaction_checkout.schema.json",
          ),
          "utf8",
        ),
      );
      expect(schema.title).toBe("CurrentTransactionSnapshot");

      const scannerSchema = JSON.parse(
        readFileSync(
          join(
            root,
            "crates/daemon-ipc-contracts/schemas/scanner_status.schema.json",
          ),
          "utf8",
        ),
      );
      expect(scannerSchema.title).toBe("ScannerRuntimeStatus");

      const generated = readFileSync(
        join(
          root,
          "crates/daemon-ipc-contracts/src/generated/transaction_checkout.rs",
        ),
        "utf8",
      );
      expect(generated).toContain(
        "// @generated by scripts/daemon-ipc-contracts/generate-contracts.ts",
      );
      expect(generated).toContain("Do not edit by hand.");

      const scannerGenerated = readFileSync(
        join(
          root,
          "crates/daemon-ipc-contracts/src/generated/scanner_status.rs",
        ),
        "utf8",
      );
      expect(scannerGenerated).toContain("Do not edit by hand.");

      const scannerInvalidFixtures = JSON.parse(
        readFileSync(
          join(
            root,
            "crates/daemon-ipc-contracts/tests/fixtures/scanner_status_invalid.snapshots.json",
          ),
          "utf8",
        ),
      );
      expect(
        scannerInvalidFixtures.map((fixture: { name: string }) => fixture.name),
      ).toEqual(["unknownField", "missingCode"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails check mode when committed transaction generated output is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-daemon-ipc-generator-"));

    try {
      const spawnSync = (
        _command: string,
        args: string[],
        _options: { cwd: string; encoding: "utf8" },
      ) => {
        if (_command === "node") {
          return { status: 0, stdout: "", stderr: "" };
        }

        if (args.includes("--version")) {
          return {
            status: 0,
            stdout: "cargo-typify 0.7.0\n",
            stderr: "",
          };
        }

        const outputIndex = args.indexOf("--output");
        const outputPath = args[outputIndex + 1];
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, "pub struct Regenerated;\n");
        return { status: 0, stdout: "", stderr: "" };
      };

      generateDaemonIpcContracts({
        mode: "write",
        repoRoot: root,
        spawnSync,
      });
      writeFileSync(
        join(
          root,
          "crates/daemon-ipc-contracts/src/generated/transaction_checkout.rs",
        ),
        "manually edited generated output\n",
      );

      expect(() =>
        generateDaemonIpcContracts({
          mode: "check",
          repoRoot: root,
          spawnSync,
        }),
      ).toThrow(
        /Daemon IPC generated contracts are stale[\s\S]*src\/generated\/transaction_checkout\.rs/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    "crates/daemon-ipc-contracts/schemas/scanner_status.schema.json",
    "crates/daemon-ipc-contracts/src/generated/scanner_status.rs",
    "crates/daemon-ipc-contracts/tests/fixtures/scanner_status_valid.snapshots.json",
    "crates/daemon-ipc-contracts/tests/fixtures/scanner_status_invalid.snapshots.json",
  ])(
    "fails check mode when committed scanner output is stale: %s",
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), "vem-daemon-ipc-generator-"));

      try {
        const spawnSync = (
          _command: string,
          args: string[],
          _options: { cwd: string; encoding: "utf8" },
        ) => {
          if (_command === "node") {
            return { status: 0, stdout: "", stderr: "" };
          }

          if (args.includes("--version")) {
            return {
              status: 0,
              stdout: "cargo-typify 0.7.0\n",
              stderr: "",
            };
          }

          const outputIndex = args.indexOf("--output");
          const outputPath = args[outputIndex + 1];
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, "pub struct Regenerated;\n");
          return { status: 0, stdout: "", stderr: "" };
        };

        generateDaemonIpcContracts({
          mode: "write",
          repoRoot: root,
          spawnSync,
        });
        writeFileSync(join(root, path), "manually edited scanner output\n");

        expect(() =>
          generateDaemonIpcContracts({
            mode: "check",
            repoRoot: root,
            spawnSync,
          }),
        ).toThrow(
          new RegExp(
            `Daemon IPC generated contracts are stale[\\s\\S]*${path.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            )}`,
          ),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
