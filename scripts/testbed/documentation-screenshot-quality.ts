#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectPng } from "./display-evidence.ts";

const METADATA_SCHEMA = "vem-documentation-screenshot-metadata/v1";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const normalized: string[] = [];
  const seen = new Set();
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      normalized.push(trimmed);
      seen.add(trimmed);
    }
  }
  return normalized;
}

function normalizeOptionalStringList(
  value: unknown,
  label: string,
): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when present`);
  }
  const normalized: string[] = [];
  const seen = new Set();
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      normalized.push(trimmed);
      seen.add(trimmed);
    }
  }
  return normalized;
}

function normalizeViewport(value: unknown): { width: number; height: number } {
  if (!value || typeof value !== "object") {
    throw new Error("viewport must be an object");
  }
  const width = Number(recordValue(value).width);
  const height = Number(recordValue(value).height);
  if (!Number.isInteger(width) || width < 1) {
    throw new Error("viewport width must be a positive integer");
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error("viewport height must be a positive integer");
  }
  return { width, height };
}

function validateCommit(value: unknown): string {
  if (!/^[a-f0-9]{7,40}$/i.test(String(value))) {
    throw new Error("commit must be a git commit hash");
  }
  return String(value);
}

function actualOrientation(capture: JsonRecord): string {
  if (capture.widthPx === capture.heightPx) return "square";
  return Number(capture.heightPx) > Number(capture.widthPx)
    ? "portrait"
    : "landscape";
}

export function normalizeDocumentationScreenshotMetadata(
  input: unknown,
): JsonRecord {
  if (!input || typeof input !== "object") {
    throw new Error("documentation screenshot metadata must be an object");
  }
  const inputRecord = recordValue(input);
  const expectedOrientation =
    inputRecord.expectedOrientation == null
      ? null
      : String(inputRecord.expectedOrientation);
  if (
    expectedOrientation !== null &&
    !["portrait", "landscape"].includes(expectedOrientation)
  ) {
    throw new Error(
      "expectedOrientation must be portrait or landscape when present",
    );
  }
  return {
    id: isNonEmptyString(inputRecord.id)
      ? String(inputRecord.id).trim()
      : (() => {
          throw new Error("id must be a non-empty string");
        })(),
    source:
      inputRecord.source === "admin-ui" ||
      inputRecord.source === "machine-runtime"
        ? inputRecord.source
        : (() => {
            throw new Error("source must be admin-ui or machine-runtime");
          })(),
    route: isNonEmptyString(inputRecord.route)
      ? String(inputRecord.route).trim()
      : (() => {
          throw new Error("route must be a non-empty string");
        })(),
    capturedAt: isNonEmptyString(inputRecord.capturedAt)
      ? String(inputRecord.capturedAt).trim()
      : (() => {
          throw new Error("capturedAt must be a non-empty string");
        })(),
    commit: validateCommit(
      isNonEmptyString(inputRecord.commit)
        ? String(inputRecord.commit).trim()
        : (() => {
            throw new Error("commit must be a non-empty string");
          })(),
    ),
    sourceCommit:
      inputRecord.sourceCommit == null
        ? null
        : validateCommit(
            isNonEmptyString(inputRecord.sourceCommit)
              ? String(inputRecord.sourceCommit).trim()
              : (() => {
                  throw new Error("sourceCommit must be a non-empty string");
                })(),
          ),
    viewport: normalizeViewport(inputRecord.viewport),
    expectedOrientation,
    expectedTexts: normalizeStringList(
      inputRecord.expectedTexts,
      "expectedTexts",
    ),
    detectedTexts: normalizeOptionalStringList(
      inputRecord.detectedTexts,
      "detectedTexts",
    ),
    manualReviewReason:
      inputRecord.manualReviewReason == null
        ? null
        : isNonEmptyString(inputRecord.manualReviewReason)
          ? String(inputRecord.manualReviewReason).trim()
          : (() => {
              throw new Error("manualReviewReason must be a non-empty string");
            })(),
  };
}

export function evaluateDocumentationScreenshot({
  bytes,
  metadata,
}: {
  bytes: Buffer;
  metadata: JsonRecord;
}): JsonRecord {
  const normalizedMetadata = normalizeDocumentationScreenshotMetadata(metadata);
  const inspected = recordValue(inspectPng(bytes));
  if (!inspected.ok) {
    return {
      schemaVersion: METADATA_SCHEMA,
      status: "rejected",
      reasons: [`PNG inspection failed: ${inspected.message}`],
      metadata: normalizedMetadata,
      capture: null,
    };
  }

  const capture: JsonRecord = {
    format: inspected.format,
    widthPx: inspected.widthPx,
    heightPx: inspected.heightPx,
    pixelCount: inspected.pixelCount,
    nonTransparentPixelCount: inspected.nonTransparentPixelCount,
    nonTransparentPixelRatio: inspected.nonTransparentPixelRatio,
    distinctPixelCount: inspected.distinctPixelCount,
    orientation: actualOrientation(inspected),
  };

  const reasons = [];
  let status = "passed";
  if (capture.nonTransparentPixelCount === 0) {
    reasons.push("screenshot is fully transparent or blank");
    status = "rejected";
  }
  if (capture.distinctPixelCount === 1) {
    reasons.push("screenshot is a solid-color image");
    status = "rejected";
  }
  if (
    normalizedMetadata.expectedOrientation !== null &&
    capture.orientation !== normalizedMetadata.expectedOrientation
  ) {
    reasons.push(
      `screenshot orientation mismatch: expected ${normalizedMetadata.expectedOrientation}, got ${capture.orientation}`,
    );
    status = "rejected";
  }

  const expectedTexts = arrayValue(normalizedMetadata.expectedTexts).map(
    (value: unknown) => String(value),
  );
  const detectedTexts =
    normalizedMetadata.detectedTexts == null
      ? null
      : arrayValue(normalizedMetadata.detectedTexts).map((value: unknown) =>
          String(value),
        );
  if (status !== "rejected") {
    if (detectedTexts === null) {
      reasons.push(
        "expected text metadata is present but no detected text evidence was supplied",
      );
      status = "manual-review";
    } else {
      const missingTexts = expectedTexts.filter(
        (expected) => !detectedTexts.includes(expected),
      );
      if (missingTexts.length > 0) {
        reasons.push(
          `expected text is missing from detected text evidence: ${missingTexts.join(", ")}`,
        );
        status = "rejected";
      }
    }
  }

  if (
    status === "manual-review" &&
    normalizedMetadata.manualReviewReason !== null
  ) {
    reasons.push(
      `manual review reason recorded: ${normalizedMetadata.manualReviewReason}`,
    );
  }

  return {
    schemaVersion: METADATA_SCHEMA,
    status,
    reasons,
    metadata: normalizedMetadata,
    capture,
  };
}

export async function evaluateDocumentationScreenshotFile({
  screenshotPath,
  metadataPath,
  outputPath = null,
}: {
  screenshotPath: string;
  metadataPath: string;
  outputPath?: string | null;
}): Promise<JsonRecord> {
  const [bytes, metadataBytes] = await Promise.all([
    readFile(screenshotPath),
    readFile(metadataPath, "utf8"),
  ]);
  const result = evaluateDocumentationScreenshot({
    bytes,
    metadata: JSON.parse(metadataBytes) as JsonRecord,
  });
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export function parseDocumentationScreenshotQualityArgs(
  args: string[],
): JsonRecord {
  const options: JsonRecord = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    if (arg === "--screenshot") options.screenshotPath = resolve(next());
    else if (arg === "--metadata") options.metadataPath = resolve(next());
    else if (arg === "--out") options.outputPath = resolve(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.screenshotPath) throw new Error("--screenshot is required");
  if (!options.metadataPath) throw new Error("--metadata is required");
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseDocumentationScreenshotQualityArgs(
    process.argv.slice(2),
  );
  const result = await evaluateDocumentationScreenshotFile({
    screenshotPath: String(options.screenshotPath),
    metadataPath: String(options.metadataPath),
    outputPath:
      options.outputPath == null ? null : String(options.outputPath),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "rejected") process.exitCode = 1;
}
