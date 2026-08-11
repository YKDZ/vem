import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const BINARY_ALLOWLIST_NAME = "hard-cutover-binary-allowlist.json";
const BINARY_ALLOWLIST_SCHEMA = "vem-hard-cutover-binary-allowlist/v1";

function writeBinaryAllowlist(root, entries) {
  writeFileSync(
    join(root, BINARY_ALLOWLIST_NAME),
    `${JSON.stringify({ entries, schemaVersion: BINARY_ALLOWLIST_SCHEMA })}\n`,
  );
  execFileSync("git", ["add", BINARY_ALLOWLIST_NAME], { cwd: root });
}

function initGuardRepo(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeBinaryAllowlist(root, []);
}

function machineAudioEntry(path, payload) {
  return {
    category: "machine-audio",
    gitMode: "100644",
    path,
    reason: "Production Machine audio asset.",
    sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

describe("Vision V2 hard-cutover absence guard", () => {
  it("covers Machine, shared contracts, testbed scripts, package metadata, specs, and generated bundles", () => {
    assert.deepEqual(assertHardCutoverAbsence(), []);
  });

  it("detects every retired try-on category through dynamic negative fixtures", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-"));
    try {
      initGuardRepo(root);
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
      initGuardRepo(root);
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
      initGuardRepo(root);
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
      initGuardRepo(root);
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

  it("rejects symlink, submodule, and worktree type drift", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-types-"));
    try {
      initGuardRepo(root);
      writeFileSync(join(root, "target.txt"), "not tracked\n");
      symlinkSync("target.txt", join(root, "reference-link"));
      writeFileSync(join(root, "missing.txt"), "tracked\n");
      writeFileSync(join(root, "replaced.txt"), "tracked\n");
      execFileSync(
        "git",
        ["add", "reference-link", "missing.txt", "replaced.txt"],
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
      unlinkSync(join(root, "reference-link"));
      writeFileSync(join(root, "reference-link"), "regular drift\n");
      unlinkSync(join(root, "replaced.txt"));
      symlinkSync("target.txt", join(root, "replaced.txt"));

      const violations = scanHardCutoverAbsence({ root });

      assert.deepEqual(violations.sort(), [
        "missing.txt:tracked-file-unreadable",
        "reference-link:tracked-symlink-forbidden",
        "replaced.txt:tracked-worktree-type-mismatch",
        "vendor/reference:tracked-submodule-forbidden",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the exact approved binary set and identity", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-binary-"));
    try {
      initGuardRepo(root);
      const relativePath = "apps/machine/src/assets/audio/approved.wav";
      const payload = Buffer.from("approved\0audio");
      const binary = join(root, relativePath);
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, payload);
      writeBinaryAllowlist(root, [machineAudioEntry(relativePath, payload)]);
      execFileSync("git", ["add", relativePath], { cwd: root });

      assert.deepEqual(scanHardCutoverAbsence({ root }), []);

      writeFileSync(binary, Buffer.from("tampered\0audio"));
      assert.ok(
        scanHardCutoverAbsence({ root }).includes(
          `${relativePath}:binary-identity-mismatch`,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const deletedRoot = mkdtempSync(
      join(tmpdir(), "vem-hard-cutover-binary-deleted-"),
    );
    try {
      initGuardRepo(deletedRoot);
      const relativePath = "apps/machine/src/assets/audio/approved.wav";
      const payload = Buffer.from("approved\0audio");
      const binary = join(deletedRoot, relativePath);
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, payload);
      writeBinaryAllowlist(deletedRoot, [
        machineAudioEntry(relativePath, payload),
      ]);
      execFileSync("git", ["add", relativePath], { cwd: deletedRoot });
      execFileSync("git", ["rm", "-f", "--", relativePath], {
        cwd: deletedRoot,
      });

      const violations = scanHardCutoverAbsence({ root: deletedRoot });

      assert.ok(
        violations.includes(`${relativePath}:binary-allowlist-entry-missing`),
      );
    } finally {
      rmSync(deletedRoot, { recursive: true, force: true });
    }
  });

  it("rejects new executable binaries and malformed allowlist authority", () => {
    const executableRoot = mkdtempSync(
      join(tmpdir(), "vem-hard-cutover-executable-"),
    );
    try {
      initGuardRepo(executableRoot);
      const executable = "standalone-service.exe";
      writeFileSync(
        join(executableRoot, executable),
        Buffer.from("MZ\0untrusted"),
      );
      execFileSync("git", ["add", executable], { cwd: executableRoot });

      assert.ok(
        scanHardCutoverAbsence({ root: executableRoot }).includes(
          `${executable}:binary-unapproved`,
        ),
      );
      writeBinaryAllowlist(executableRoot, [
        {
          category: "machine-ui-asset",
          gitMode: "100644",
          path: executable,
          reason: "Production Machine UI image asset.",
          sha256: createHash("sha256")
            .update(readFileSync(join(executableRoot, executable)))
            .digest("hex"),
        },
      ]);
      assert.ok(
        scanHardCutoverAbsence({ root: executableRoot }).includes(
          `${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`,
        ),
      );
    } finally {
      rmSync(executableRoot, { recursive: true, force: true });
    }

    const paths = [
      "apps/machine/src/assets/audio/a.wav",
      "apps/machine/src/assets/audio/b.wav",
    ];
    const payloads = [Buffer.from("a\0"), Buffer.from("b\0")];
    const entries = paths.map((path, index) =>
      machineAudioEntry(path, payloads[index]),
    );
    const mutations = [
      {
        entries: [...entries].reverse(),
        schemaVersion: BINARY_ALLOWLIST_SCHEMA,
      },
      {
        entries: [entries[0], entries[0]],
        schemaVersion: BINARY_ALLOWLIST_SCHEMA,
      },
      { entries, extra: true, schemaVersion: BINARY_ALLOWLIST_SCHEMA },
      {
        entries: [
          {
            category: entries[0].category,
            extra: "field",
            gitMode: entries[0].gitMode,
            path: entries[0].path,
            reason: entries[0].reason,
            sha256: entries[0].sha256,
          },
        ],
        schemaVersion: BINARY_ALLOWLIST_SCHEMA,
      },
    ];
    mutations.forEach((manifest, index) => {
      const root = mkdtempSync(
        join(tmpdir(), `vem-hard-cutover-manifest-${index}-`),
      );
      try {
        initGuardRepo(root);
        paths.forEach((path, pathIndex) => {
          const binary = join(root, path);
          mkdirSync(dirname(binary), { recursive: true });
          writeFileSync(binary, payloads[pathIndex]);
        });
        writeFileSync(
          join(root, BINARY_ALLOWLIST_NAME),
          `${JSON.stringify(manifest)}\n`,
        );
        execFileSync("git", ["add", BINARY_ALLOWLIST_NAME, ...paths], {
          cwd: root,
        });

        assert.ok(
          scanHardCutoverAbsence({ root }).includes(
            `${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`,
          ),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    const noncanonicalRoot = mkdtempSync(
      join(tmpdir(), "vem-hard-cutover-manifest-noncanonical-"),
    );
    try {
      initGuardRepo(noncanonicalRoot);
      paths.forEach((path, index) => {
        const binary = join(noncanonicalRoot, path);
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, payloads[index]);
      });
      writeFileSync(
        join(noncanonicalRoot, BINARY_ALLOWLIST_NAME),
        `${JSON.stringify(
          { entries, schemaVersion: BINARY_ALLOWLIST_SCHEMA },
          null,
          2,
        )}\n`,
      );
      execFileSync("git", ["add", BINARY_ALLOWLIST_NAME, ...paths], {
        cwd: noncanonicalRoot,
      });

      assert.ok(
        scanHardCutoverAbsence({ root: noncanonicalRoot }).includes(
          `${BINARY_ALLOWLIST_NAME}:binary-allowlist-invalid`,
        ),
      );
    } finally {
      rmSync(noncanonicalRoot, { recursive: true, force: true });
    }
  });

  it("scans built artifacts even when they live under dist", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-hard-cutover-artifact-"));
    try {
      initGuardRepo(root);
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
