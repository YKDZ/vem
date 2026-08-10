#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectPng } from "./display-evidence.mjs";

const METADATA_SCHEMA = "vem-documentation-screenshot-metadata/v1";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  const normalized = [];
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

function normalizeOptionalStringList(value, label) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when present`);
  }
  const normalized = [];
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

function normalizeViewport(value) {
  if (!value || typeof value !== "object") {
    throw new Error("viewport must be an object");
  }
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isInteger(width) || width < 1) {
    throw new Error("viewport width must be a positive integer");
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error("viewport height must be a positive integer");
  }
  return { width, height };
}

function validateCommit(value) {
  if (!/^[a-f0-9]{7,40}$/i.test(value)) {
    throw new Error("commit must be a git commit hash");
  }
  return value;
}

function actualOrientation(capture) {
  if (capture.widthPx === capture.heightPx) return "square";
  return capture.heightPx > capture.widthPx ? "portrait" : "landscape";
}

export function normalizeDocumentationScreenshotMetadata(input) {
  if (!input || typeof input !== "object") {
    throw new Error("documentation screenshot metadata must be an object");
  }
  const expectedOrientation =
    input.expectedOrientation == null
      ? null
      : String(input.expectedOrientation);
  if (
    expectedOrientation !== null &&
    !["portrait", "landscape"].includes(expectedOrientation)
  ) {
    throw new Error(
      "expectedOrientation must be portrait or landscape when present",
    );
  }
  return {
    id: isNonEmptyString(input.id)
      ? input.id.trim()
      : (() => {
          throw new Error("id must be a non-empty string");
        })(),
    source:
      input.source === "admin-ui" || input.source === "machine-runtime"
        ? input.source
        : (() => {
            throw new Error("source must be admin-ui or machine-runtime");
          })(),
    route: isNonEmptyString(input.route)
      ? input.route.trim()
      : (() => {
          throw new Error("route must be a non-empty string");
        })(),
    capturedAt: isNonEmptyString(input.capturedAt)
      ? input.capturedAt.trim()
      : (() => {
          throw new Error("capturedAt must be a non-empty string");
        })(),
    commit: validateCommit(
      isNonEmptyString(input.commit)
        ? input.commit.trim()
        : (() => {
            throw new Error("commit must be a non-empty string");
          })(),
    ),
    sourceCommit:
      input.sourceCommit == null
        ? null
        : validateCommit(
            isNonEmptyString(input.sourceCommit)
              ? input.sourceCommit.trim()
              : (() => {
                  throw new Error("sourceCommit must be a non-empty string");
                })(),
          ),
    viewport: normalizeViewport(input.viewport),
    expectedOrientation,
    expectedTexts: normalizeStringList(input.expectedTexts, "expectedTexts"),
    detectedTexts: normalizeOptionalStringList(
      input.detectedTexts,
      "detectedTexts",
    ),
    manualReviewReason:
      input.manualReviewReason == null
        ? null
        : isNonEmptyString(input.manualReviewReason)
          ? input.manualReviewReason.trim()
          : (() => {
              throw new Error("manualReviewReason must be a non-empty string");
            })(),
  };
}

export function evaluateDocumentationScreenshot({ bytes, metadata }) {
  const normalizedMetadata = normalizeDocumentationScreenshotMetadata(metadata);
  const inspected = inspectPng(bytes);
  if (!inspected.ok) {
    return {
      schemaVersion: METADATA_SCHEMA,
      status: "rejected",
      reasons: [`PNG inspection failed: ${inspected.message}`],
      metadata: normalizedMetadata,
      capture: null,
    };
  }

  const capture = {
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

  const detectedTexts = normalizedMetadata.detectedTexts;
  if (status !== "rejected") {
    if (detectedTexts === null) {
      reasons.push(
        "expected text metadata is present but no detected text evidence was supplied",
      );
      status = "manual-review";
    } else {
      const missingTexts = normalizedMetadata.expectedTexts.filter(
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
}) {
  const [bytes, metadataBytes] = await Promise.all([
    readFile(screenshotPath),
    readFile(metadataPath, "utf8"),
  ]);
  const result = evaluateDocumentationScreenshot({
    bytes,
    metadata: JSON.parse(metadataBytes),
  });
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return result;
}

export function parseDocumentationScreenshotQualityArgs(args) {
  const options = {};
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
  const result = await evaluateDocumentationScreenshotFile(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "rejected") process.exitCode = 1;
}
