#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_SCHEMA = "vem-field-kit/v1";
const PART_SIZE_DEFAULT = 950 * 1024 * 1024;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KIT_SCRIPTS = [
  "install-vision-main-artifact.ps1",
  "vision-main-artifacts.psm1",
  "install-vem-runtime-owners.ps1",
  "install-field-kit.ps1",
  "probe-vem-runtime.ps1",
];

function required(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  if (index < 0) throw new Error(`--${name} is required`);
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} requires a value`);
  return value;
}

function sha256File(path: string): string {
  const digest = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes <= 0) break;
      digest.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest("hex");
}

function assertSha256(path: string, expected: string, label: string): void {
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `${label} sha256 mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

function copyVerified(
  source: string,
  destination: string,
  expectedSha256: string,
  label: string,
): { name: string; byteSize: number; sha256: string } {
  assertSha256(source, expectedSha256, label);
  copyFileSync(source, destination);
  const stat = statSync(destination);
  return {
    name: destination.split("/").pop()!,
    byteSize: stat.size,
    sha256: expectedSha256,
  };
}

export function packageFieldKit(args: string[]): Record<string, unknown> {
  const vemCommit = required(args, "vem-commit");
  if (!/^[a-f0-9]{40}$/.test(vemCommit))
    throw new Error("--vem-commit must be 40 hex");
  const runtimeManifestPath = resolve(required(args, "runtime-manifest"));
  const runtimeSourceDigest =
    args[args.indexOf("--runtime-source-digest") + 1] ?? null;
  const runtimeDirArg = args[args.indexOf("--runtime-dir") + 1] ?? null;
  const runtimeDir = runtimeDirArg ? resolve(runtimeDirArg) : null;
  const visionManifestPath = resolve(required(args, "vision-manifest"));
  const modelPackPath = resolve(required(args, "model-pack"));
  const modelPackSha256 = required(args, "model-pack-sha256");
  if (!/^[a-f0-9]{64}$/.test(modelPackSha256))
    throw new Error("--model-pack-sha256 must be 64 hex");
  const outDir = resolve(required(args, "out-dir"));
  const partSizeMbIndex = args.indexOf("--part-size-mb");
  const partSize =
    Number(
      partSizeMbIndex >= 0
        ? args[partSizeMbIndex + 1]
        : String(PART_SIZE_DEFAULT / 1024 / 1024),
    ) *
    1024 *
    1024;
  if (!Number.isInteger(partSize) || partSize <= 0)
    throw new Error("--part-size-mb must be a positive integer");

  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
  if (runtimeManifest.schemaVersion !== "vem-runtime-artifacts/v1") {
    throw new Error("runtime manifest schema is invalid");
  }
  const normalizedRuntimeManifest =
    runtimeManifest.commit === vemCommit
      ? runtimeManifest
      : runtimeSourceDigest &&
          runtimeManifest.sourceDigest === runtimeSourceDigest
        ? { ...runtimeManifest, commit: vemCommit }
        : null;
  if (!normalizedRuntimeManifest) {
    throw new Error(
      "runtime manifest does not bind vem-commit; pass --runtime-source-digest when source is unchanged",
    );
  }
  const visionManifest = JSON.parse(readFileSync(visionManifestPath, "utf8"));
  if (visionManifest.schemaVersion !== "vending-vision-main-artifacts/v1") {
    throw new Error("vision manifest schema is invalid");
  }

  const stage = join(outDir, ".stage");
  mkdirSync(stage, { recursive: true });
  try {
    const runtimeFile = (
      artifact: { path: string; sha256: string },
      name: string,
    ) => ({
      source: runtimeDir ? join(runtimeDir, name) : resolve(artifact.path),
      name,
      expectedSha256: artifact.sha256,
    });
    const members = [
      copyVerified(
        runtimeFile(runtimeManifest.artifacts.daemon, "vending-daemon.exe")
          .source,
        join(stage, "vending-daemon.exe"),
        runtimeFile(runtimeManifest.artifacts.daemon, "vending-daemon.exe")
          .expectedSha256,
        "daemon",
      ),
      copyVerified(
        runtimeFile(runtimeManifest.artifacts.machine, "machine.exe").source,
        join(stage, "machine.exe"),
        runtimeFile(runtimeManifest.artifacts.machine, "machine.exe")
          .expectedSha256,
        "machine",
      ),
      copyVerified(
        runtimeFile(
          runtimeManifest.artifacts.webViewLoader,
          "WebView2Loader.dll",
        ).source,
        join(stage, "WebView2Loader.dll"),
        runtimeFile(
          runtimeManifest.artifacts.webViewLoader,
          "WebView2Loader.dll",
        ).expectedSha256,
        "webViewLoader",
      ),
    ];
    writeFileSync(
      join(stage, "vem-runtime-artifacts.json"),
      `${JSON.stringify(normalizedRuntimeManifest, null, 2)}\n`,
      "utf8",
    );
    copyFileSync(
      visionManifestPath,
      join(stage, "vending-vision-main-artifacts.json"),
    );
    members.push(
      copyVerified(
        resolve(
          visionManifest.runtime.archivePath ??
            join(dirname(visionManifestPath), visionManifest.runtime.file),
        ),
        join(stage, "vending-vision-windows-x86_64.zip"),
        visionManifest.runtime.sha256,
        "vision runtime",
      ),
      copyVerified(
        modelPackPath,
        join(stage, "vending-vision-ai-models.zip"),
        modelPackSha256,
        "AI model pack",
      ),
    );
    for (const script of KIT_SCRIPTS) {
      const source = join(REPO_ROOT, "scripts", "windows", script);
      copyFileSync(source, join(stage, script));
      members.push({
        name: script,
        byteSize: readFileSync(source).byteLength,
        sha256: sha256File(source),
      });
    }

    const kitManifest = {
      schemaVersion: KIT_SCHEMA,
      vemCommit,
      visionCommit: visionManifest.commit,
      modelPackSha256,
      members,
    };
    writeFileSync(
      join(stage, "vem-field-kit-manifest.json"),
      `${JSON.stringify(kitManifest, null, 2)}\n`,
      "utf8",
    );

    const zipName = `vem-field-kit-${vemCommit}.zip`;
    const zipPath = join(outDir, zipName);
    execFileSync(
      "bsdtar",
      [
        "-a",
        "--options",
        "zip:compression=store",
        "-cf",
        zipPath,
        "-C",
        stage,
        ".",
      ],
      { stdio: "pipe" },
    );
    const zipSha256 = sha256File(zipPath);

    const partPrefix = `${zipPath}.part`;
    execFileSync("split", [
      "-b",
      String(partSize),
      "-d",
      "-a",
      "2",
      zipPath,
      partPrefix,
    ]);
    const parts = readdirSync(outDir)
      .filter((name) => name.startsWith(`${zipName}.part`))
      .sort()
      .map((name) => {
        const partPath = join(outDir, name);
        return {
          name,
          byteSize: statSync(partPath).size,
          sha256: sha256File(partPath),
        };
      });

    const verifyCmd = [
      "@echo off",
      "setlocal",
      'cd /d "%~dp0"',
      `set "ZIP=${zipName}"`,
      `set "EXPECTED_SHA=${zipSha256}"`,
      `set "EXPECTED_SIZE=${statSync(zipPath).size}"`,
      "echo Joining parts...",
      `copy /b ${parts.map((p) => `"${p.name}"`).join("+")} "%ZIP%" >nul`,
      "if errorlevel 1 goto :fail",
      'for %%F in ("%ZIP%") do set "SIZE=%%~zF"',
      'if not "%SIZE%"=="%EXPECTED_SIZE%" (echo FAIL: size mismatch & goto :fail)',
      'for /f "usebackq delims=" %%H in (`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 -LiteralPath \'%CD%\\%ZIP%\').Hash.ToLowerInvariant()"`) do set "HASH=%%H"',
      'if not "%HASH%"=="%EXPECTED_SHA%" (echo FAIL: sha mismatch & goto :fail)',
      "echo PASS: parts joined correctly",
      "exit /b 0",
      ":fail",
      "echo FAIL: verification failed",
      "exit /b 1",
    ];
    writeFileSync(
      join(outDir, "verify-parts.cmd"),
      `${verifyCmd.join("\r\n")}\r\n`,
      "utf8",
    );

    return {
      schemaVersion: KIT_SCHEMA,
      vemCommit,
      visionCommit: visionManifest.commit,
      zip: {
        name: zipName,
        byteSize: statSync(zipPath).size,
        sha256: zipSha256,
      },
      parts,
      members,
      outDir,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  try {
    const result = packageFieldKit(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
