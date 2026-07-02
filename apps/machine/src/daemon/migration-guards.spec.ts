import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const forbidden = [
  "startNativeMqttRuntime",
  "createMachineMqttClient",
  "flushOutboxEvents",
  "listenPaymentCodeScanned",
  "startScanner",
  "scannerSelfCheck",
  "startVisionRuntime",
  "stopVisionRuntime",
  "exportLocalLogsZip",
  "getMachineRuntimeConfig",
  "requestMachineToken",
  "external-natural-environment",
  "External Natural Environment",
  "QWeather",
  "qweather",
  "@/hardware/adapter",
  "@/hardware/mock-adapter",
  "localOutbox",
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    if (!/\.(ts|vue)$/.test(path) || path.endsWith(".spec.ts")) return [];
    if (
      path.includes("/src/native/") ||
      path.includes("/src/mqtt/") ||
      path.includes("/src/local/") ||
      path.includes("/src/api/") ||
      path.endsWith("/src/components/MockHardwareControls.vue")
    ) {
      return [];
    }
    return [path];
  });
}

describe("machine-ui daemon migration guards", () => {
  it("does not reference old critical runtime APIs from production src", () => {
    const root = new URL("../..", import.meta.url).pathname;
    const offenders = files(join(root, "src")).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return forbidden
        .filter((term) => content.includes(term))
        .map((term) => `${relative(root, file)}:${term}`);
    });

    expect(offenders).toEqual([]);
  });
});
