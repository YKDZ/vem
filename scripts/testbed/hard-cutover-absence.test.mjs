import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  assertHardCutoverAbsence,
  scanHardCutoverAbsence,
} from "./hard-cutover-absence.mjs";

describe("Vision V2 hard-cutover absence guard", () => {
  it("covers Machine, shared contracts, testbed scripts, package metadata, specs, and generated bundles", () => {
    assert.deepEqual(assertHardCutoverAbsence(), []);
  });

  it("detects every retired try-on category through dynamic negative fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const dot = (...parts) => parts.join(".");
      const pathWithBracedPart = (...parts) => parts.join("/");
      const nestedCustomerRoute = [
        "#",
        "products",
        "product-key",
        "try-on",
      ].join("/");
      const retiredSelector = ["try", "on", "exit"].join("-");
      const fabricatedPhaseField = ["completed", "Observed"].join("");
      const retiredSessionModule = ["try", "_on", "_session"].join("");
      const retiredProtocolFixture = ["rejects-v", "1", "-protocol"].join("");
      const retiredProgressEvent = dot(
        "vision",
        "try_on",
        "attempt",
        "progress",
      );
      const retiredShape = "sil" + "hou" + "ette";
      const retiredField = ["try", "On", retiredShape, "Url"].join("");
      const retiredPurpose = ["try", "_on", retiredShape].join("");
      const retiredUploadRoute = [
        "/media-assets/",
        ["try", "-on-", retiredShape, "s"].join(""),
      ].join("");
      const splitProductionReference = Buffer.from(
        "Y29uc3QgcmV0aXJlZCA9IFsidHJ5IiwgIl9vbl8iLCAic2lsIiwgImhvdSIsICJldHRlIl0uam9pbigiIik7",
        "base64",
      ).toString("utf8");
      const standaloneUrl =
        "https://" + ["github.com", "hbhjt", "virtual-tryon.git"].join("/");
      const standalonePath = "..\\" + ["virtual-tryon", "run.ps1"].join("\\");
      const standaloneServer = ["app", "main"].join(".") + ":app";
      const standaloneCamera =
        ["navigator", "mediaDevices", "getUserMedia"].join(".") + "()";
      const fixtures = [
        ["protocol.txt", dot("vem", "vision", "v1")],
        ["fixture.txt", retiredProtocolFixture],
        ["wire.txt", dot("vision", "try_on", "start")],
        ["progress.txt", retiredProgressEvent],
        ["client.txt", ["use", "TryOn", "Preview"].join("")],
        [
          "route.txt",
          `${pathWithBracedPart("", "try-on", "{session}")}.${["m", "jpeg"].join("")}`,
        ],
        ["media.txt", ["sil", "houette"].join("")],
        ["operation.txt", dot("try_on", "stop_preview")],
        ["nested-route.txt", nestedCustomerRoute],
        ["selector.txt", `[data-test="${retiredSelector}"]`],
        ["phase.txt", fabricatedPhaseField],
        ["session.txt", retiredSessionModule],
        ["field.txt", retiredField],
        ["purpose.txt", `purpose: ${retiredPurpose}`],
        ["endpoint.txt", retiredUploadRoute],
        ["production.ts", splitProductionReference],
        ["standalone-url.txt", standaloneUrl],
        ["standalone-path.txt", standalonePath],
        ["standalone-server.txt", standaloneServer],
        ["standalone-camera.txt", standaloneCamera],
      ];
      for (const [name, body] of fixtures) {
        writeFileSync(join(root, name), `${body}\n`);
      }
      execFileSync("git", ["add", "--", ...fixtures.map(([name]) => name)], {
        cwd: root,
      });
      const violations = scanHardCutoverAbsence({ root });
      assert.deepEqual(
        [...new Set(violations.map((entry) => entry.split(":").at(-1)))].sort(),
        [
          "fabricated-try-on-phase-evidence",
          "legacy-nested-customer-route",
          "legacy-preview-route",
          "legacy-silhouette",
          "legacy-silhouette-field",
          "legacy-silhouette-purpose",
          "legacy-silhouette-upload-endpoint",
          "legacy-split-construction",
          "legacy-start-stop-operation",
          "legacy-try-on-client",
          "legacy-try-on-selector",
          "legacy-try-on-session-module",
          "legacy-try-on-wire-message",
          "legacy-v1-fixture",
          "obsolete-try-on-progress-event",
          "protocol-v1",
          "standalone-browser-camera-owner",
          "standalone-repository-path",
          "standalone-repository-url",
          "standalone-server-entrypoint",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans every tracked regular file without relying on path or extension", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-tracked-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const forbidden =
        "https://" + ["github.com", "hbhjt", "virtual-tryon"].join("/");
      const tracked = [
        "run.ps1",
        "app/main.py",
        "deployment/deploy.ps1",
        "arbitrary/reference.sh",
        "arbitrary/reference.bat",
        "arbitrary/reference.toml",
        "arbitrary/reference.psm1",
      ];
      for (const relativePath of tracked) {
        const path = join(root, relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${forbidden}\n`);
      }
      writeFileSync(join(root, "untracked.py"), `${forbidden}\n`);
      execFileSync("git", ["add", "--", ...tracked], { cwd: root });

      const violations = scanHardCutoverAbsence({ root });

      assert.deepEqual(
        violations.map((entry) => entry.split(":", 1)[0]).sort(),
        [...tracked].sort(),
      );
      assert.ok(violations.every((entry) => !entry.includes("untracked.py")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects standalone dependency variants and guard-self hiding", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-variants-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const dot = ".";
      const repository = ["github.com", "hbhjt", "virtual-tryon.git"].join("/");
      const module = ["app", "main"].join(dot);
      const media = "media" + "Devices";
      const capture = "get" + "User" + "Media";
      const fixtures = new Map([
        ["url-https.py", "https://" + repository],
        ["url-git-ssh.sh", "git+ssh://git@" + repository],
        [
          "url-scp.toml",
          "git@github.com:" + ["hbhjt", "virtual-tryon.git"].join("/"),
        ],
        ["path-relative.bat", "..\\" + ["virtual-tryon", "run.ps1"].join("\\")],
        ["path-posix.psm1", "/opt/" + ["virtual-tryon", "run.ps1"].join("/")],
        [
          "path-windows.py",
          "C:\\src\\" + ["virtual-tryon", "run.ps1"].join("\\"),
        ],
        ["server-from.py", `from ${module} import app`],
        ["server-import.py", `import ${module}`],
        ["server-importlib.py", `importlib.import_module("${module}")`],
        ["server-uvicorn.py", `uvicorn.run("${module}:app")`],
        ["camera-dot.js", `navigator.${media}.${capture}()`],
        ["camera-optional.js", `navigator?.${media}?.${capture}()`],
        ["camera-bracket.js", `navigator["${media}"]["${capture}"]()`],
        ["camera-mixed.js", `navigator?.["${media}"]?.${capture}()`],
        [
          "scripts/testbed/hard-cutover-absence.test.mjs",
          `execFileSync("powershell", ["../${["virtual-tryon", "run.ps1"].join("/")}"])`,
        ],
      ]);
      for (const [relativePath, source] of fixtures) {
        const path = join(root, relativePath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${source}\n`);
      }
      execFileSync("git", ["add", "--", ...fixtures.keys()], { cwd: root });

      const violations = scanHardCutoverAbsence({ root });

      assert.deepEqual(
        [...new Set(violations.map((entry) => entry.split(":", 1)[0]))].sort(),
        [...fixtures.keys()].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows similar text that is not a standalone dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-similar-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const capture = "get" + "User" + "Media";
      const similar = [
        "https://" + ["github.com", "hbhjt", "virtual-tryon-docs"].join("/"),
        "from " + ["myapp", "main"].join(".") + " import app",
        "camera." + capture + "()",
        ["navigator", "mediaDevices", "enumerateDevices"].join(".") + "()",
      ].join("\n");
      writeFileSync(join(root, "similar.txt"), similar);
      execFileSync("git", ["add", "similar.txt"], { cwd: root });

      assert.deepEqual(scanHardCutoverAbsence({ root }), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records binary, symlink, submodule, and unreadable tracked entries", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-types-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, "nul.bin"), Buffer.from("text\0payload"));
      writeFileSync(join(root, "non-utf8.bin"), Buffer.from([0xff, 0xfe]));
      writeFileSync(join(root, "target.txt"), "not tracked\n");
      symlinkSync("target.txt", join(root, "reference-link"));
      writeFileSync(join(root, "missing.txt"), "tracked\n");
      writeFileSync(join(root, "replaced.txt"), "tracked\n");
      execFileSync(
        "git",
        [
          "add",
          "nul.bin",
          "non-utf8.bin",
          "reference-link",
          "missing.txt",
          "replaced.txt",
        ],
        { cwd: root },
      );
      execFileSync(
        "git",
        [
          "update-index",
          "--add",
          "--cacheinfo",
          "160000,1111111111111111111111111111111111111111,vendor/reference",
        ],
        { cwd: root },
      );
      unlinkSync(join(root, "missing.txt"));
      unlinkSync(join(root, "replaced.txt"));
      symlinkSync("target.txt", join(root, "replaced.txt"));
      const diagnostics = [];

      const violations = scanHardCutoverAbsence({ root, diagnostics });

      assert.deepEqual(violations, [
        "missing.txt:tracked-file-unreadable",
        "replaced.txt:tracked-worktree-type-mismatch",
      ]);
      assert.deepEqual(
        diagnostics.map((entry) => entry.split(":").at(-1)).sort(),
        [
          "binary-non-utf8-skipped",
          "binary-nul-skipped",
          "tracked-submodule-skipped",
          "tracked-symlink-skipped",
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans built artifacts even when they live under dist", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-artifact-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const artifact = join(root, "apps", "machine", "dist");
      mkdirSync(artifact, { recursive: true });
      writeFileSync(
        join(artifact, "app.js"),
        ["completed", "Observed"].join("") + "\n",
      );
      const violations = scanHardCutoverAbsence({
        root,
        artifactScopes: ["apps/machine/dist"],
      });
      assert.deepEqual(violations, [
        "apps/machine/dist/app.js:fabricated-try-on-phase-evidence",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
