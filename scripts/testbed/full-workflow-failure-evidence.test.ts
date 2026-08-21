import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createFullWorkflowEvidenceBundle } from "./full-workflow-evidence-bundle.ts";
import { buildFullWorkflowEvidenceManifest } from "./full-workflow-evidence-manifest.ts";
import {
  fullWorkflowCommandSucceeded,
  runFullWorkflowOrchestrator,
  runSerialTrackLifecycle,
} from "./full-workflow-orchestrator.ts";

function writeSummaryBinding(summaryPath: string, manifestPath: string) {
  const manifest = readFileSync(manifestPath);
  writeFileSync(
    summaryPath,
    `${JSON.stringify({
      evidenceInventory: {
        reportPath: manifestPath,
        manifestFile: {
          byteLength: manifest.byteLength,
          sha256: createHash("sha256").update(manifest).digest("hex"),
        },
      },
    })}\n`,
  );
}

describe("完整业务流失败证据", () => {
  it("缺少业务报告时仍保留有界子进程诊断并打包实际文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-failure-"));
    try {
      const guestInputPath = join(root, "guest-input.json");
      const handoffPath = join(root, "handoff.json");
      const outPath = join(root, "full-workflow-tracks.json");
      const smokePath = join(root, "installed-runtime-smoke.json");
      const artifactRoot = join(root, "vision-experience-artifacts");
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "stale.log"), "stale evidence\n");
      const failureScreenshot = readFileSync(
        new URL("../../apps/machine/src-tauri/app-icon.png", import.meta.url),
      );
      writeFileSync(
        guestInputPath,
        `${JSON.stringify({ workflowIdentity: { githubSha: "a".repeat(40) } })}\n`,
      );
      writeFileSync(handoffPath, "{}\n");
      writeFileSync(smokePath, '{"ok":true}\n');

      const aggregate = await runFullWorkflowOrchestrator(
        {
          mode: "fast",
          focus: ["visionExperience"],
          commit: "a".repeat(40),
          guestInputPath,
          handoffPath,
          outPath,
        },
        {
          beforeTrack: async () => undefined,
          runTrack: async (track: { artifactRoot: string }) => {
            mkdirSync(track.artifactRoot, { recursive: true });
            writeFileSync(
              join(track.artifactRoot, "failure-diagnostics.json"),
              `${JSON.stringify({
                machineRuntimeTrace: [
                  { kind: "navigation", route: "#/products/product:1" },
                ],
                cdp: { console: [], exceptions: [], networkErrors: [] },
                vision: { listener: { reachable: false }, roles: [] },
              })}\n`,
            );
            writeFileSync(
              join(track.artifactRoot, "failure-screenshot.png"),
              failureScreenshot,
            );
            return {
              status: "failed",
              exitCode: 17,
              stdout: `stage=connect\npassword="${"split-secret ".repeat(50_000)}"\nstage=try-on-clicked\n`,
              stderr:
                "-----BEGIN PRIVATE KEY-----\npem-material-secret\n-----END PRIVATE KEY-----\n" +
                '{"privateKeyPem":"private-key-secret","databaseUrl":"postgres://db-user:db-password@db/test"}\n' +
                'password="first second third\n' +
                "Authorization: Bearer should-not-leak\nBearer standalone-secret\nresult-surface timed out\n",
            };
          },
          captureTerminal: async () => ({ ok: true, facts: {} }),
          recover: async () => ({ ok: true, actions: [], errors: [] }),
        },
      );

      assert.equal(aggregate.ok, false);
      assert.equal(aggregate.businessOutcome.ok, false);
      const stdoutPath = join(artifactRoot, "child-stdout.log");
      const stderrPath = join(artifactRoot, "child-stderr.log");
      const processPath = join(artifactRoot, "child-process.json");
      const failureDiagnosticsPath = join(
        artifactRoot,
        "failure-diagnostics.json",
      );
      const failureScreenshotPath = join(
        artifactRoot,
        "failure-screenshot.png",
      );
      const stdout = readFileSync(stdoutPath, "utf8");
      assert.match(stdout, /^stage=connect/);
      assert.match(stdout, /bounded child output truncated/);
      assert.match(stdout, /stage=try-on-clicked\n$/);
      assert.doesNotMatch(stdout, /split-secret/);
      const stderr = readFileSync(stderrPath, "utf8");
      assert.match(stderr, /result-surface timed out/);
      assert.doesNotMatch(stderr, /should-not-leak/);
      assert.doesNotMatch(stderr, /standalone-secret/);
      assert.doesNotMatch(stderr, /private-key-secret/);
      assert.doesNotMatch(stderr, /pem-material-secret/);
      assert.doesNotMatch(stderr, /db-user|db-password/);
      assert.doesNotMatch(stderr, /first|second|third/);
      assert.match(stderr, /\[REDACTED\]/);
      const process = JSON.parse(readFileSync(processPath, "utf8"));
      assert.equal(process.exitCode, 17);
      assert.equal(process.streams.stdout.truncated, true);
      assert.ok(process.streams.stdout.capturedBytes <= 512 * 1024);
      assert.equal(process.streams.stderr.truncated, false);
      assert.equal(existsSync(join(artifactRoot, "stale.log")), false);

      const manifestPath = join(root, "full-workflow-evidence-manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.tracks.length, 1);
      assert.equal(manifest.tracks[0].key, "visionExperience");
      assert.equal(manifest.tracks[0].businessStatus, "failed");
      assert.equal(manifest.tracks[0].report, null);
      assert.match(
        manifest.tracks[0].primaryReason,
        /result-surface timed out/,
      );
      assert.deepEqual(
        new Set(manifest.tracks[0].diagnostics),
        new Set([stdoutPath, stderrPath, processPath, failureDiagnosticsPath]),
      );
      assert.equal(
        manifest.tracks[0].machineRuntimeTrace,
        `${failureDiagnosticsPath}#machineRuntimeTrace`,
      );
      assert.deepEqual(manifest.tracks[0].screenshots, [failureScreenshotPath]);
      assert.equal(
        manifest.files.filter(
          (file: { track: string }) => file.track === "visionExperience",
        ).length,
        5,
      );

      const bundleRoot = join(root, "failure-bundle");
      const bundle = createFullWorkflowEvidenceBundle(
        {
          manifestPath,
          summaryPath: outPath,
          smokePath,
          bundleRoot,
          allowIncomplete: true,
        },
        {
          publishDirectory: (source: string, destination: string) =>
            renameSync(source, destination),
        },
      );
      const evidenceMembers = bundle.files.filter((path: string) =>
        path.startsWith("evidence/"),
      );
      assert.equal(evidenceMembers.length, 5);
      assert.ok(
        evidenceMembers.every((path: string) =>
          existsSync(join(bundleRoot, path)),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不从不完整清单复制超限截图", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-bounded-kind-"));
    try {
      const oversized = join(root, "failure.png");
      const bytes = Buffer.alloc(3 * 1024 * 1024, 1);
      writeFileSync(oversized, bytes);
      const manifestPath = join(root, "manifest.json");
      const summaryPath = join(root, "summary.json");
      const smokePath = join(root, "smoke.json");
      writeFileSync(
        manifestPath,
        `${JSON.stringify({
          ok: false,
          files: [
            {
              path: oversized,
              track: "visionExperience",
              kind: "screenshots",
              byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        })}\n`,
      );
      writeSummaryBinding(summaryPath, manifestPath);
      writeFileSync(smokePath, "{}\n");
      const bundleRoot = join(root, "bundle");
      const bundle = createFullWorkflowEvidenceBundle(
        {
          manifestPath,
          summaryPath,
          smokePath,
          bundleRoot,
          allowIncomplete: true,
        },
        {
          publishDirectory: (source: string, destination: string) =>
            renameSync(source, destination),
        },
      );
      assert.deepEqual(
        bundle.files.filter((path: string) => path.startsWith("evidence/")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不从不完整清单复制零字节未知证据类型", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-unknown-kind-"));
    try {
      const unknown = join(root, "unknown.bin");
      const bytes = Buffer.alloc(0);
      writeFileSync(unknown, bytes);
      const manifestPath = join(root, "manifest.json");
      const summaryPath = join(root, "summary.json");
      const smokePath = join(root, "smoke.json");
      writeFileSync(
        manifestPath,
        `${JSON.stringify({
          ok: false,
          files: [
            {
              path: unknown,
              track: "visionExperience",
              kind: "unknown",
              byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        })}\n`,
      );
      writeSummaryBinding(summaryPath, manifestPath);
      writeFileSync(smokePath, "{}\n");
      const bundleRoot = join(root, "bundle");
      const bundle = createFullWorkflowEvidenceBundle(
        {
          manifestPath,
          summaryPath,
          smokePath,
          bundleRoot,
          allowIncomplete: true,
        },
        {
          publishDirectory: (source: string, destination: string) =>
            renameSync(source, destination),
        },
      );
      assert.deepEqual(
        bundle.files.filter((path: string) => path.startsWith("evidence/")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不完整打包拒绝被替换且不再匹配当前摘要的清单", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stale-manifest-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const summaryPath = join(root, "summary.json");
      const smokePath = join(root, "smoke.json");
      writeFileSync(manifestPath, '{"ok":false,"files":[]}\n');
      writeSummaryBinding(summaryPath, manifestPath);
      writeFileSync(smokePath, "{}\n");
      writeFileSync(
        manifestPath,
        '{"ok":false,"files":[],"replacement":true}\n',
      );
      assert.throws(
        () =>
          createFullWorkflowEvidenceBundle(
            {
              manifestPath,
              summaryPath,
              smokePath,
              bundleRoot: join(root, "bundle"),
              allowIncomplete: true,
            },
            {
              publishDirectory: (source: string, destination: string) =>
                renameSync(source, destination),
            },
          ),
        /summary.*manifest|manifest.*summary/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("清理旧报告或证据失败时不执行轨道且不索引陈旧文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-stale-cleanup-"));
    try {
      const guestInputPath = join(root, "guest-input.json");
      const handoffPath = join(root, "handoff.json");
      const outPath = join(root, "full-workflow-tracks.json");
      const reportPath = join(root, "vision-experience.json");
      const artifactRoot = join(root, "vision-experience-artifacts");
      const staleArtifact = join(artifactRoot, "stale.json");
      writeFileSync(
        guestInputPath,
        `${JSON.stringify({ workflowIdentity: { githubSha: "a".repeat(40) } })}\n`,
      );
      writeFileSync(handoffPath, "{}\n");
      writeFileSync(reportPath, '{"ok":true,"stale":true}\n');
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(staleArtifact, '{"stale":true}\n');
      let childRuns = 0;

      const aggregate = await runFullWorkflowOrchestrator(
        {
          mode: "fast",
          focus: ["visionExperience"],
          commit: "a".repeat(40),
          guestInputPath,
          handoffPath,
          outPath,
        },
        {
          clearTrackReport: () => {
            throw new Error("report is locked");
          },
          clearTrackArtifacts: () => {
            throw new Error("artifact root is locked");
          },
          beforeTrack: async () => undefined,
          runTrack: async () => {
            childRuns += 1;
            return { status: "passed", exitCode: 0 };
          },
          captureTerminal: async () => ({ ok: true, facts: {} }),
          recover: async () => ({ ok: true, actions: [], errors: [] }),
        },
      );

      assert.equal(childRuns, 0);
      assert.equal(aggregate.businessOutcome.ok, false);
      assert.match(
        aggregate.execution.executedTracks[0].error,
        /report is locked.*artifact root is locked/,
      );
      assert.deepEqual(aggregate.execution.executedTracks[0].evidenceTrust, {
        report: false,
        artifactRoot: false,
      });
      const manifest = JSON.parse(
        readFileSync(
          join(root, "full-workflow-evidence-manifest.json"),
          "utf8",
        ),
      );
      assert.equal(manifest.tracks[0].report, null);
      assert.deepEqual(manifest.tracks[0].diagnostics, []);
      assert.equal(
        manifest.files.some(
          (file: { path?: string }) =>
            file.path === reportPath || file.path === staleArtifact,
        ),
        false,
      );
      assert.equal(existsSync(reportPath), true);
      assert.equal(existsSync(staleArtifact), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("快速模式提前停止后不信任未执行轨道的旧证据", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-unexecuted-stale-"));
    try {
      const guestInputPath = join(root, "guest-input.json");
      const handoffPath = join(root, "handoff.json");
      const outPath = join(root, "full-workflow-tracks.json");
      const staleReport = join(root, "vision-experience.json");
      const staleArtifactRoot = join(root, "vision-experience-artifacts");
      const staleArtifact = join(staleArtifactRoot, "stale.log");
      writeFileSync(
        guestInputPath,
        `${JSON.stringify({ workflowIdentity: { githubSha: "a".repeat(40) } })}\n`,
      );
      writeFileSync(handoffPath, "{}\n");
      writeFileSync(staleReport, '{"ok":true,"stale":true}\n');
      mkdirSync(staleArtifactRoot, { recursive: true });
      writeFileSync(staleArtifact, "stale evidence\n");
      let childRuns = 0;

      const aggregate = await runFullWorkflowOrchestrator(
        {
          mode: "fast",
          focus: ["startup", "visionExperience"],
          commit: "a".repeat(40),
          guestInputPath,
          handoffPath,
          outPath,
        },
        {
          beforeTrack: async () => undefined,
          runTrack: async () => {
            childRuns += 1;
            return {
              status: "failed",
              exitCode: 1,
              stderr: "startup failed",
            };
          },
          captureTerminal: async () => ({ ok: true, facts: {} }),
          recover: async () => ({
            ok: false,
            actions: [],
            errors: ["recovery failed"],
          }),
        },
      );

      assert.equal(childRuns, 1);
      assert.equal(aggregate.execution.executedTracks.length, 1);
      const manifest = JSON.parse(
        readFileSync(
          join(root, "full-workflow-evidence-manifest.json"),
          "utf8",
        ),
      );
      const vision = manifest.tracks.find(
        (track: { key?: string }) => track.key === "visionExperience",
      );
      assert.equal(vision.report, null);
      assert.deepEqual(vision.diagnostics, []);
      assert.equal(
        manifest.files.some(
          (file: { path?: string }) =>
            file.path === staleReport || file.path === staleArtifact,
        ),
        false,
      );
      assert.equal(existsSync(staleReport), true);
      assert.equal(existsSync(staleArtifact), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("证据构建或落盘失败时仍返回原业务判定", async () => {
    for (const failure of [
      {
        name: "scan",
        expected: "artifact disappeared during scan",
        dependencies: {
          buildEvidenceManifest: () => {
            throw new Error("artifact disappeared during scan");
          },
        },
      },
      {
        name: "manifest-write",
        expected: "manifest disk is full",
        dependencies: {
          writeEvidenceManifest: () => {
            throw new Error("manifest disk is full");
          },
        },
      },
      {
        name: "aggregate-write",
        expected: "aggregate disk is full",
        dependencies: {
          writeAggregate: () => {
            throw new Error("aggregate disk is full");
          },
        },
      },
    ]) {
      const root = mkdtempSync(
        join(tmpdir(), `vem-workflow-evidence-io-${failure.name}-`),
      );
      try {
        const guestInputPath = join(root, "guest-input.json");
        const handoffPath = join(root, "handoff.json");
        const outPath = join(root, "full-workflow-tracks.json");
        const manifestPath = join(root, "full-workflow-evidence-manifest.json");
        writeFileSync(
          guestInputPath,
          `${JSON.stringify({ workflowIdentity: { githubSha: "a".repeat(40) } })}\n`,
        );
        writeFileSync(handoffPath, "{}\n");
        if (failure.name === "manifest-write") {
          writeFileSync(manifestPath, '{"stale":true}\n');
        }
        if (failure.name === "aggregate-write") {
          writeFileSync(outPath, '{"stale":true}\n');
        }
        const aggregate = await runFullWorkflowOrchestrator(
          {
            mode: "fast",
            focus: ["visionExperience"],
            commit: "a".repeat(40),
            guestInputPath,
            handoffPath,
            outPath,
          },
          {
            ...failure.dependencies,
            beforeTrack: async () => undefined,
            runTrack: async () => ({
              status: "failed",
              exitCode: 17,
              stderr: "result-surface timed out",
            }),
            captureTerminal: async () => ({ ok: true, facts: {} }),
            recover: async () => ({ ok: true, actions: [], errors: [] }),
          },
        );
        assert.equal(aggregate.businessOutcome.ok, false);
        assert.match(
          aggregate.businessOutcome.failures[0].reason,
          /result-surface timed out/,
        );
        assert.match(
          aggregate.execution.executedTracks[0].error,
          /result-surface timed out/,
        );
        assert.equal(aggregate.evidenceInventory.ok, false);
        if (failure.name === "aggregate-write") {
          assert.equal(aggregate.operationalOutcome.ok, false);
          assert.ok(
            aggregate.operationalOutcome.failures.some((message: string) =>
              message.includes(failure.expected),
            ),
          );
          assert.equal(fullWorkflowCommandSucceeded(aggregate), false);
          assert.equal(aggregate.operationalOutcome.canonicalResultPath, null);
          assert.equal(existsSync(outPath), false);
          assert.equal(
            fullWorkflowCommandSucceeded({
              ...aggregate,
              ok: true,
              businessOutcome: { ok: true, failures: [] },
            }),
            false,
          );
        } else {
          assert.ok(
            aggregate.evidenceInventory.failures.some((message: string) =>
              message.includes(failure.expected),
            ),
          );
        }
        if (failure.name === "manifest-write") {
          assert.equal(aggregate.evidenceInventory.reportPath, null);
          assert.equal(existsSync(manifestPath), false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("子进程证据无法持久化时不替换轨道失败", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-child-evidence-io-failure-"));
    try {
      const parentFile = join(root, "not-a-directory");
      writeFileSync(parentFile, "file\n");
      const [entry] = await runSerialTrackLifecycle({
        tracks: [
          {
            key: "visionExperience",
            name: "visionExperience",
            validator: "visionExperience",
            runner: { kind: "node" },
            reportPath: join(root, "missing-report.json"),
            artifactRoot: join(parentFile, "artifacts"),
          },
        ],
        runTrack: async () => ({
          status: "failed",
          exitCode: 9,
          stderr: "business child failed",
        }),
        beforeTrack: async () => undefined,
        captureTerminal: async () => ({ ok: true, facts: {} }),
        recover: async () => ({ ok: true, actions: [], errors: [] }),
      });
      assert.equal(entry.businessStatus, "failed");
      assert.equal(entry.error, "business child failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("失败轨道缺少运行时轨迹与截图时在清单中给出非阻塞告警", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-failed-policy-warning-"));
    try {
      const reportPath = join(root, "vision-experience.json");
      const artifactRoot = join(root, "vision-experience-artifacts");
      writeFileSync(reportPath, "{}\n");
      mkdirSync(artifactRoot, { recursive: true });
      writeFileSync(join(artifactRoot, "child-stderr.log"), "route failed\n");
      const manifest = buildFullWorkflowEvidenceManifest({
        tracks: [
          {
            key: "visionExperience",
            reportPath,
            artifactRoot,
            result: {
              businessStatus: "failed",
              error: "route failed",
              evidenceTrust: { report: true, artifactRoot: true },
            },
          },
        ],
      });
      assert.equal(manifest.ok, true);
      assert.deepEqual(manifest.failures, []);
      assert.ok(
        manifest.warnings.some((message: string) =>
          message.includes("failed Machine Runtime Trace"),
        ),
      );
      assert.ok(
        manifest.warnings.some((message: string) =>
          message.includes("failure screenshot"),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("汇总报告递归脱敏终态与恢复对象中的敏感字段", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-summary-redaction-"));
    try {
      const guestInputPath = join(root, "guest-input.json");
      const handoffPath = join(root, "handoff.json");
      const outPath = join(root, "full-workflow-tracks.json");
      writeFileSync(
        guestInputPath,
        `${JSON.stringify({ workflowIdentity: { githubSha: "a".repeat(40) } })}\n`,
      );
      writeFileSync(handoffPath, "{}\n");
      const aggregate = await runFullWorkflowOrchestrator(
        {
          mode: "fast",
          focus: ["visionExperience"],
          commit: "a".repeat(40),
          guestInputPath,
          handoffPath,
          outPath,
        },
        {
          beforeTrack: async () => undefined,
          runTrack: async () => ({
            status: "failed",
            exitCode: 7,
            stderr: "route failed",
          }),
          captureTerminal: async () => ({
            ok: true,
            reason: "token=terminal-secret",
            facts: { apiKey: "api-secret" },
          }),
          recover: async () => ({
            ok: false,
            actions: [],
            errors: ['password="recovery secret"'],
            evidence: { privateKeyPem: "pem-secret" },
          }),
        },
      );
      assert.equal(aggregate.businessOutcome.ok, false);
      const summary = readFileSync(outPath, "utf8");
      assert.doesNotMatch(
        summary,
        /terminal-secret|api-secret|recovery secret|pem-secret/,
      );
      assert.match(summary, /\[REDACTED\]/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
