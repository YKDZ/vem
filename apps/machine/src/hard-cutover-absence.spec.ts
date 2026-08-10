import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const forbidden = [
  "vem.vision.v1",
  "vision.try_on.start",
  "vision.try_on.stop",
  "vision.try_on.started",
  "vision.try_on.stopped",
  "openVisionTryOnSession",
  "VisionTryOnSession",
  "useTryOnPreview",
  "tryon_frontend",
  "/try-on/{session}.mjpeg",
  "tryOnSilhouette",
];

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child);
    return entry.name.endsWith(".spec.ts") ? [] : [child];
  });
}

describe("Vision V2 hard cutover absence", () => {
  it("keeps retired session, preview, and V1 identifiers out of shipped source", () => {
    const paths = [
      resolve(root, "apps/machine/src/native"),
      resolve(root, "apps/machine/src/router"),
      resolve(root, "apps/machine/src/views"),
      resolve(root, "apps/machine/src/composables"),
      resolve(root, "packages/shared/generated/vision-v2"),
    ];
    const violations = filesUnder(paths[0]!).concat(
      ...paths.slice(1).map(filesUnder),
    ).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return forbidden.filter((token) => source.includes(token)).map(
        (token) => `${path}: ${token}`,
      );
    });
    expect(violations).toEqual([]);
  });
});
