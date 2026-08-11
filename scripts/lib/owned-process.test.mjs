import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { runOwnedCommand } from "./owned-process.mjs";

const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

describe("owned external process runner", () => {
  it("returns bounded output for an ordinary command", async () => {
    assert.equal(
      await runOwnedCommand(
        process.execPath,
        ["-e", "process.stdout.write('ok')"],
        {
          deadlineMs: 1_000,
          maximumOutputBytes: 1024,
        },
      ),
      "ok",
    );
  });

  it("terminates commands that exceed either output bound", async () => {
    for (const stream of ["stdout", "stderr"]) {
      await assert.rejects(
        runOwnedCommand(
          process.execPath,
          ["-e", `process.${stream}.write("x".repeat(2048))`],
          { deadlineMs: 1_000, maximumOutputBytes: 1024 },
        ),
        /output exceeded its bound/i,
      );
    }
  });

  it(
    "kills a deadline-exceeded leader and its descendant before returning",
    { skip: process.platform === "win32" },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-owned-process-"));
      temporaryRoots.push(root);
      const executable = join(root, "pinned-fake-command");
      const leaderPath = join(root, "leader.pid");
      const descendantPath = join(root, "descendant.pid");
      const markerPath = join(root, "late-marker");
      const source = `#!${process.execPath}\nconst { spawn } = require("node:child_process");\nconst fs = require("node:fs");\nconst [leaderPath, descendantPath, markerPath] = process.argv.slice(2);\nprocess.on("SIGTERM", () => {});\nfs.writeFileSync(leaderPath, String(process.pid));\nconst descendant = spawn("/usr/bin/sleep", ["30"], { stdio: "ignore" });\nfs.writeFileSync(descendantPath, String(descendant.pid));\nsetTimeout(() => fs.writeFileSync(markerPath, "late"), 2_000);\nsetInterval(() => {}, 10_000);\n`;
      writeFileSync(executable, source);
      chmodSync(executable, 0o755);
      const pinnedSha256 = createHash("sha256").update(source).digest("hex");
      assert.equal(
        createHash("sha256").update(readFileSync(executable)).digest("hex"),
        pinnedSha256,
        "the test executes the exact pinned fake bytes",
      );

      const startedAt = Date.now();
      await assert.rejects(
        runOwnedCommand(executable, [leaderPath, descendantPath, markerPath], {
          deadlineMs: 150,
          maximumOutputBytes: 1024,
        }),
        /exceeded.*150ms deadline/i,
      );
      assert.ok(Date.now() - startedAt < 1_000, "cleanup stays bounded");
      const leaderPid = Number(readFileSync(leaderPath, "utf8"));
      const descendantPid = Number(readFileSync(descendantPath, "utf8"));
      assert.equal(
        processExists(leaderPid),
        false,
        "leader is physically dead",
      );
      assert.equal(
        processExists(descendantPid),
        false,
        "descendant is physically dead",
      );
      assert.equal(existsSync(markerPath), false, "no late work survives");
    },
  );
});
