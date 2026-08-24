import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CommandResult } from "../../test-adapter.ts";
import type { ImplicitRecommendationAcceptanceAdapter } from "./implicit-recommendation-driver.ts";

import { buildAcceptanceReport } from "../../acceptance-report.ts";
import { CdpTestAdapter } from "../../cdp-adapter.ts";
import {
  BusinessSetProcessReplay,
  type ProcessReplaySummary,
} from "../../process-replay.ts";
import { InstalledImplicitRecommendationAdapter } from "./implicit-recommendation-cdp-adapter.ts";
import { runImplicitRecommendationBusinessSet } from "./implicit-recommendation-driver.ts";

type CdpBoundary = {
  endpoint?: string;
  client: {
    send: (
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number },
    ) => Promise<unknown>;
  } | null;
  connect(options?: { timeoutMs?: number }): Promise<unknown>;
  close(): Promise<void>;
  run(command: string, args?: string[]): Promise<CommandResult>;
};

interface MainDependencies {
  createCdpAdapter?: () => CdpBoundary;
  createAcceptanceAdapter?: (input: {
    boundary: CdpBoundary;
    artifactRoot: string | null;
  }) => ImplicitRecommendationAcceptanceAdapter;
  runBusinessSet?: typeof runImplicitRecommendationBusinessSet;
  runReplay?: <T>(
    context: Parameters<typeof BusinessSetProcessReplay.run>[0],
    operation: () => Promise<T> | T,
  ) => Promise<T>;
  io?: {
    writeFile(
      path: string,
      content: string,
      encoding: "utf8",
    ): Promise<unknown>;
  };
  writeStdout?: (content: string) => void;
  runId?: string;
}

function argumentValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

/** Installed-Windows entry point for the independent core recommendation set. */
export async function main(
  args: string[] = process.argv.slice(2),
  dependencies: MainDependencies = {},
) {
  const mode = argumentValue(args, "--mode") ?? "fast";
  if (mode !== "fast" && mode !== "full") {
    throw new Error("implicit recommendation mode must be fast or full");
  }
  const outPath = argumentValue(args, "--out");
  const artifactRoot = outPath
    ? join(dirname(outPath), "implicit-recommendation-artifacts")
    : null;
  const replayDirectory = process.env.VEM_PROCESS_REPLAY_DIR ?? null;
  const replayEnabled =
    process.env.VEM_PROCESS_REPLAY === "1" &&
    replayDirectory !== null &&
    outPath !== null;
  const cdp = (dependencies.createCdpAdapter ?? (() => new CdpTestAdapter()))();
  try {
    await cdp.connect({ timeoutMs: 20_000 });
    const acceptanceAdapter = (
      dependencies.createAcceptanceAdapter ??
      ((input) => new InstalledImplicitRecommendationAdapter(input))
    )({ boundary: cdp, artifactRoot });
    let replaySummary: ProcessReplaySummary | null = null;
    const runBusinessSet = () =>
      (dependencies.runBusinessSet ?? runImplicitRecommendationBusinessSet)(
        acceptanceAdapter,
      );
    if (replayEnabled && !cdp.endpoint) {
      throw new Error("implicit recommendation replay requires a CDP endpoint");
    }
    const result = replayEnabled
      ? await (dependencies.runReplay ?? BusinessSetProcessReplay.run)(
          {
            endpoint: cdp.endpoint!,
            outputDirectory: join(replayDirectory!, "implicit-recommendation"),
            businessSet: "implicitRecommendation",
            onSummary: (summary) => {
              replaySummary = summary;
            },
          },
          runBusinessSet,
        )
      : await runBusinessSet();
    const supportingEvidence: unknown[] = [result.evidence];
    if (replaySummary) {
      supportingEvidence.push({
        kind: "business-set-process-replay",
        summary: replaySummary,
      });
    }
    const report = buildAcceptanceReport({
      runId:
        dependencies.runId ??
        process.env.VEM_TESTBED_RUN_ID ??
        "implicit-recommendation",
      mode,
      pass: 1,
      businessSets: [
        {
          name: "implicitRecommendation",
          assertions: result.assertions,
          supportingEvidence,
        },
      ],
    });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outPath) {
      await (dependencies.io?.writeFile ?? writeFile)(
        outPath,
        serialized,
        "utf8",
      );
    }
    (dependencies.writeStdout ?? ((content) => process.stdout.write(content)))(
      serialized,
    );
    return report;
  } finally {
    await cdp.close();
  }
}

if (
  typeof import.meta !== "undefined" &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
