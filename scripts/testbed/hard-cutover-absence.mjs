#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const DEFAULT_ROOT = resolve(import.meta.dirname, "../..");
const FORBIDDEN_PATTERNS = Object.freeze([
  { category: "protocol-v1", pattern: /\bvem[.]vision[.]v1\b/ },
  { category: "legacy-v1-fixture", pattern: /\brejects-v[0-9]-protocol\b/ },
  {
    category: "legacy-try-on-wire-message",
    pattern: /\bvision[.]try_on[.](?:start|stop|started|stopped)\b/,
  },
  {
    category: "obsolete-try-on-progress-event",
    pattern: /\bvision[.]try_on[.]attempt[.]progress\b/,
  },
  {
    category: "legacy-try-on-client",
    pattern:
      /\b(?:openVisionTryOnSess[i]on|VisionTryOnSess[i]on|useTryOnPrev[i]ew)\b/,
  },
  {
    category: "legacy-preview-route",
    pattern: /\/try-on\/\{[^}]+}[.]mjpeg\b|try-on-prev[i]ew\b/i,
  },
  {
    category: "legacy-silhouette",
    pattern: /(?<!legacy-)\bsilhouette\b/i,
  },
  {
    category: "legacy-silhouette-field",
    pattern: /try[_-]?on[_-]?silhouett[e]|tryOnSilhouett[e]/i,
  },
  {
    category: "legacy-silhouette-purpose",
    pattern: /try[_-]?on[_-]?silhouett[e](?:[_-]?media)?|tryOnSilhouett[e]/i,
  },
  {
    category: "legacy-silhouette-upload-endpoint",
    pattern: /\/media-assets\/try-on-silhouett[e]s/i,
  },
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
    pattern: /\b(?:VisionTryOnSess[i]on|try_on_sess[i]on|tryOnSess[i]on)\b/,
  },
  {
    category: "standalone-repository-url",
    pattern:
      /(?:https?:\/\/github[.]com\/hbhjt\/|(?:git[+]ssh|ssh):\/\/(?:git@)?github[.]com\/hbhjt\/|git@github[.]com:hbhjt\/)virtual-tryon(?:[.]git)?(?![-\w])/i,
  },
  {
    category: "standalone-repository-path",
    pattern:
      /(?:[.][.][\\/]|[A-Za-z]:[\\/]|\/workspaces\/)?virtual-tryon[\\/](?:run[.]ps1|app[\\/]|static[\\/]|scripts[\\/]|requirements[.]txt|vendor[\\/])/i,
  },
  {
    category: "standalone-server-entrypoint",
    pattern:
      /\bapp[.]main:app\b|\bfrom\s+app[.]main\s+import\s+[A-Za-z_]\w*|\bimport\s+app[.]main\b|\bimportlib(?:[.]import_module)?\s*[(]\s*["']app[.]main["']|\buvicorn(?:[.]run)?\s*[(]?\s*["']app[.]main:app["']/,
  },
  {
    category: "standalone-browser-camera-owner",
    pattern:
      /\bnavigator\s*(?:[?]?[.]\s*mediaDevices|(?:[?][.])?\s*\[\s*["']mediaDevices["']\s*\])\s*(?:[?]?[.]\s*getUserMedia|(?:[?][.])?\s*\[\s*["']getUserMedia["']\s*\])\s*[(]/,
  },
]);

function splitLegacyConstructionMatches(source) {
  const matches = source.matchAll(
    /\[[\s\S]{0,200}?\][.]join\(\s*["']{2}\s*\)/g,
  );
  return [...matches].filter((match) => {
    const fragments = [...match[0].matchAll(/["']([^"']+)["']/g)].map(
      ([, fragment]) => fragment,
    );
    const normalized = fragments
      .join("")
      .replace(/[^a-z]/gi, "")
      .toLowerCase();
    return normalized.includes(["tryon", "sil", "houette"].join(""));
  });
}

const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".rs",
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

const RETIRED_MEDIA_TOKEN = ["sil", "houette"].join("");
const LEGACY_MIGRATION_ALLOWANCES = Object.freeze({
  [`packages/db/drizzle/20260701170000_variant_try_on_${RETIRED_MEDIA_TOKEN}_media_assets/migration.sql`]:
    {
      digest:
        "90ea0d9d541a594e5aee635537838faa10e71f44d62e82119d35dcd499828816",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
  [`packages/db/drizzle/20260701171000_machine_planogram_try_on_${RETIRED_MEDIA_TOKEN}/migration.sql`]:
    {
      digest:
        "8d666502d7928114fea2aa912bdc5f57793e85091a28c34ff5fc94c7c9c43e7b",
      occurrences: {
        "legacy-silhouette-field": 1,
        "legacy-silhouette-purpose": 1,
      },
    },
  "packages/db/drizzle/20260809010000_try_on_garment_variant_associations/migration.sql":
    {
      digest:
        "a37e480d30ce79d55edb4b177d78140990e9aec77f3e68f4718b0c6930985186",
      occurrences: {
        "legacy-silhouette-field": 2,
        "legacy-silhouette-purpose": 2,
      },
    },
  "packages/db/drizzle/20260810000000_hard_delete_legacy_try_on_data/migration.sql":
    {
      digest:
        "a1b4e5f81b95ebca62f71091a23ec5876e4da5ae11ca97fbe24fdebfa7b877f7",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
  "packages/db/drizzle/20260722000000_remove_inventory_refill_authority/snapshot.json":
    {
      digest:
        "a0347f6c12811f34e14632ec3f51452cb86af315d43a220b1eb9fe42ee48b49c",
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
    },
});

const SQLITE_HISTORICAL_MIGRATION_DIGESTS = Object.freeze({
  MIGRATION_V10:
    "d6b4d396b172d96cd8222966f751190d5e0a2104c307bf4b4c64578fcec174e5",
  MIGRATION_V19:
    "d9661dc18064b8da335115f142ebde3e879858a0b3a37e3064194441bea98333",
});

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function rustMigrationLiteral(source, name) {
  return source.match(
    new RegExp(`pub const ${name}: &str = r#"([\\s\\S]*?)"#;`),
  )?.[1];
}

function legacyAllowance(path, root, source) {
  const relativePath = relative(root, path);
  const migration = LEGACY_MIGRATION_ALLOWANCES[relativePath];
  if (migration) {
    return {
      valid: digest(source) === migration.digest,
      occurrences: migration.occurrences,
      integrityLabel: "legacy-migration-digest",
    };
  }
  if (relativePath === "apps/vending-daemon/src/state/schema.rs") {
    const v10 = rustMigrationLiteral(source, "MIGRATION_V10");
    const v19 = rustMigrationLiteral(source, "MIGRATION_V19");
    const literalColumn =
      /pub const RETIRED_PLANOGRAM_MEDIA_COLUMN: &str = "try_on_silhouett[e]_url";/.test(
        source,
      );
    return {
      valid:
        v10 !== undefined &&
        v19 !== undefined &&
        digest(v10) === SQLITE_HISTORICAL_MIGRATION_DIGESTS.MIGRATION_V10 &&
        digest(v19) === SQLITE_HISTORICAL_MIGRATION_DIGESTS.MIGRATION_V19 &&
        literalColumn,
      occurrences: {
        "legacy-silhouette-field": 5,
        "legacy-silhouette-purpose": 5,
      },
      integrityLabel: "sqlite-history-or-tombstone",
    };
  }
  return null;
}

function patternMatches(source, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))];
}

export function scanHardCutoverAbsence({
  root = DEFAULT_ROOT,
  artifactScopes = [],
  diagnostics = [],
} = {}) {
  const trackedOutput = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
  });
  const trackedPaths = trackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const tab = record.indexOf("\t");
      const mode = record.slice(0, record.indexOf(" "));
      const relativePath = record.slice(tab + 1);
      const path = resolve(root, relativePath);
      if (mode === "100644" || mode === "100755") return [path];
      if (mode === "120000") {
        diagnostics.push(`${relativePath}:tracked-symlink-skipped`);
        return [];
      }
      if (mode === "160000") {
        diagnostics.push(`${relativePath}:tracked-submodule-skipped`);
        return [];
      }
      diagnostics.push(`${relativePath}:tracked-type-${mode}-skipped`);
      return [];
    });
  const paths = [
    ...trackedPaths,
    ...artifactScopes.flatMap((scope) =>
      filesUnder(resolve(root, scope), { scanArtifacts: true }),
    ),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const trackedPathSet = new Set(trackedPaths);
  return paths.flatMap((path) => {
    if (trackedPathSet.has(path)) {
      try {
        if (!lstatSync(path).isFile()) {
          return [`${relative(root, path)}:tracked-worktree-type-mismatch`];
        }
      } catch {
        return [`${relative(root, path)}:tracked-file-unreadable`];
      }
    }
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      return [`${relative(root, path)}:tracked-file-unreadable`];
    }
    if (bytes.includes(0)) {
      diagnostics.push(`${relative(root, path)}:binary-nul-skipped`);
      return [];
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      diagnostics.push(`${relative(root, path)}:binary-non-utf8-skipped`);
      return [];
    }
    const allowance = legacyAllowance(path, root, source);
    const integrityViolations =
      allowance !== null && !allowance.valid
        ? [`${relative(root, path)}:${allowance.integrityLabel}`]
        : [];
    return [
      ...integrityViolations,
      ...FORBIDDEN_PATTERNS.flatMap(({ category, pattern }) => {
        const matches = patternMatches(source, pattern);
        if (matches.length === 0) return [];
        const permitted = allowance?.occurrences[category];
        if (allowance?.valid && permitted === matches.length) return [];
        if (
          isHistoricalLegacyRecord(path) &&
          [
            "protocol-v1",
            "legacy-try-on-client",
            "legacy-preview-route",
            "legacy-silhouette",
            "legacy-silhouette-field",
            "legacy-silhouette-purpose",
            "legacy-start-stop-operation",
            "legacy-try-on-session-module",
          ].includes(category)
        ) {
          return [];
        }
        return [`${relative(root, path)}:${category}`];
      }),
      ...(() => {
        const matches = splitLegacyConstructionMatches(source);
        if (matches.length === 0) return [];
        return [`${relative(root, path)}:legacy-split-construction`];
      })(),
    ];
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
