#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_SCOPES = Object.freeze([
  "apps/machine/src",
  "apps/machine/src-tauri",
  "apps/machine/package.json",
  "docs",
  "packages/shared/src",
  "packages/shared/generated",
  "packages/shared/package.json",
  "scripts/testbed",
  "scripts/windows",
  ".github/workflows",
  "package.json",
  "pnpm-lock.yaml",
  "turbo.json",
]);

const FORBIDDEN_PATTERNS = Object.freeze([
  { category: "protocol-v1", pattern: /\bvem[.]vision[.]v1\b/ },
  {
    category: "legacy-try-on-wire-message",
    pattern: /\bvision[.]try_on[.](?:start|stop|started|stopped)\b/,
  },
  {
    category: "legacy-try-on-client",
    pattern:
      /\b(?:openVisionTryOnSession|VisionTryOnSession|useTryOnPreview)\b/,
  },
  {
    category: "legacy-preview-route",
    pattern: /\/try-on\/\{[^}]+}[.]mjpeg\b|try-on-preview\b/i,
  },
  { category: "legacy-silhouette", pattern: /\bsilhouette\b/i },
  { category: "transport-specific-preview", pattern: /\bmjpeg\b/i },
  {
    category: "legacy-start-stop-operation",
    pattern: /\btry_on[.](?:start|stop)_preview\b/,
  },
  {
    category: "legacy-nested-customer-route",
    pattern:
      /#\/products\/[^\s"'`]+\/try-on\b|path\s*:\s*["']\/products\/:[^"']+\/try-on\b/,
  },
  {
    category: "legacy-try-on-selector",
    pattern: /(?:data-test\s*=\s*["']|\[data-test=["'])try-on-exit\b/,
  },
  {
    category: "fabricated-try-on-phase-evidence",
    pattern: /\b(?:accepted|progress|completed)Observed\b/,
  },
  {
    category: "legacy-try-on-session-module",
    pattern: /\b(?:VisionTryOnSession|try_on_session|tryOnSession)\b/,
  },
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ps1",
  ".sql",
  ".txt",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

function extension(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}

function shouldSkip(path, { scanArtifacts = false } = {}) {
  const names = scanArtifacts
    ? /(?:^|[\\/])(?:node_modules|target|coverage|[.]turbo|[.]git)(?:[\\/]|$)/
    : /(?:^|[\\/])(?:node_modules|dist|target|coverage|[.]turbo|[.]git)(?:[\\/]|$)/;
  return names.test(path);
}

function filesUnder(path, options = {}) {
  if (shouldSkip(path, options)) return [];
  const stats = statSync(path);
  if (!stats.isDirectory())
    return TEXT_EXTENSIONS.has(extension(path)) ? [path] : [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesUnder(resolve(path, entry.name), options),
  );
}

function isHistoricalLegacyRecord(path) {
  return /(?:^|[\\/])docs[\\/](?:archive|软著|adr)(?:[\\/]|$)/.test(path);
}

export function scanHardCutoverAbsence({
  root = DEFAULT_ROOT,
  scopes = DEFAULT_SCOPES,
  extraFiles = [],
  artifactScopes = [],
} = {}) {
  const self = new Set([
    resolve(import.meta.filename),
    resolve(import.meta.dirname, "hard-cutover-absence.test.mjs"),
  ]);
  const paths = [
    ...scopes.flatMap((scope) => filesUnder(resolve(root, scope))),
    ...artifactScopes.flatMap((scope) =>
      filesUnder(resolve(root, scope), { scanArtifacts: true }),
    ),
    ...extraFiles.map((file) => resolve(file)),
  ].filter((path, index, all) => all.indexOf(path) === index);
  return paths.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return FORBIDDEN_PATTERNS.flatMap(({ category, pattern }) => {
      pattern.lastIndex = 0;
      if (!pattern.test(source)) return [];
      if (self.has(path)) return [];
      if (
        isHistoricalLegacyRecord(path) &&
        [
          "protocol-v1",
          "legacy-try-on-client",
          "legacy-preview-route",
          "legacy-silhouette",
          "legacy-start-stop-operation",
          "legacy-try-on-session-module",
          "transport-specific-preview",
        ].includes(category)
      ) {
        return [];
      }
      return [`${relative(root, path)}:${category}`];
    });
  });
}

export function assertHardCutoverAbsence(options) {
  const violations = scanHardCutoverAbsence(options);
  if (violations.length > 0) {
    throw new Error(
      `Vision V2 hard-cutover forbidden references found:\n${violations.join("\n")}`,
    );
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const artifactScopes = [];
    for (let index = 2; index < process.argv.length; index += 1) {
      if (process.argv[index] !== "--artifact" || !process.argv[index + 1]) {
        throw new Error(
          "usage: hard-cutover-absence.mjs [--artifact <built-directory>]",
        );
      }
      artifactScopes.push(process.argv[index + 1]);
      index += 1;
    }
    assertHardCutoverAbsence({ artifactScopes });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
