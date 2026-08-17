#!/usr/bin/env node

// Static check for feedback-loop traps that previously cost full VM cycles:
//   1. A `#`/`//` comment string inside an array later joined into a single
//      PowerShell `-Command` line. The first comment comments out every
//      following statement, silently disabling the command.
//   2. `Set-Content -Encoding utf8` inside a PowerShell command string. On
//      Windows PowerShell 5.1 this writes a UTF-8 BOM, which the strict JSON
//      config loader rejects.
//
// The check is intentionally narrow and deterministic so it stays fast and
// low-noise: it only inspects arrays that are joined with `;` and string
// literals that would become comment tokens on a single command line.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRECTORIES = [
  join(ROOT, "scripts/testbed"),
  join(ROOT, "scripts/windows"),
];

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const entry = statSync(path);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (
      /\.(mjs|ps1|psm1)$/.test(name) &&
      !name.endsWith(".test.mjs")
    ) {
      found.push(path);
    }
  }
  return found;
}

function splitStringLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const end = source.indexOf(quote, start + 1);
  if (end < 0) return null;
  return source.slice(start + 1, end);
}

export function findStaticTraps(source, path) {
  const traps = [];
  let cursor = 0;
  while (cursor < source.length) {
    const joinIndex = source.indexOf(".join(", cursor);
    if (joinIndex < 0) break;
    const joinerMatch = source.slice(joinIndex).match(/^\.join\(\s*(?:"; ?"|'; ?')\s*\)/);
    if (!joinerMatch) {
      cursor = joinIndex + 1;
      continue;
    }
    // Walk back to the opening bracket of the array. The closing bracket sits
    // immediately before `.join`; the first `[` reached at nesting depth zero
    // opens the array whose elements we inspect.
    const closeBracket = source.lastIndexOf("]", joinIndex - 1);
    if (closeBracket < 0) {
      cursor = joinIndex + 1;
      continue;
    }
    let arrayStart = closeBracket;
    let depth = 0;
    while (arrayStart > 0) {
      arrayStart -= 1;
      const char = source[arrayStart];
      if (char === "]") depth += 1;
      else if (char === "[") {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    if (source[arrayStart] !== "[") {
      cursor = joinIndex + 1;
      continue;
    }
    // Extract string literal elements and check their first characters.
    let elementCursor = arrayStart + 1;
    while (elementCursor < joinIndex) {
      while (elementCursor < joinIndex && /\s/.test(source[elementCursor])) {
        elementCursor += 1;
      }
      if (elementCursor >= joinIndex) break;
      const literal = splitStringLiteral(source, elementCursor);
      if (literal !== null) {
        const trimmed = literal.trimStart();
        if (trimmed.startsWith("# ") || trimmed.startsWith("//")) {
          traps.push(
            `${path}: comment string inside a joined PowerShell command line: ${literal.slice(0, 80)}`,
          );
        }
        if (/Set-Content/.test(literal) && /-Encoding\s+utf8/i.test(literal)) {
          traps.push(
            `${path}: Set-Content -Encoding utf8 writes a BOM on Windows PowerShell 5.1: ${literal.slice(0, 120)}`,
          );
        }
      }
      const comma = source.indexOf(",", elementCursor);
      if (comma < 0 || comma >= joinIndex) break;
      elementCursor = comma + 1;
    }
    cursor = joinIndex + 1;
  }
  return traps;
}

export function checkTestbedStaticTraps() {
  const files = SCAN_DIRECTORIES.flatMap(walk);
  const traps = [];
  for (const path of files) {
    traps.push(...findStaticTraps(readFileSync(path, "utf8"), path));
  }
  return { files, traps };
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const { files, traps } = checkTestbedStaticTraps();
  if (traps.length > 0) {
    console.error(traps.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`no static testbed traps in ${files.length} files`);
  }
}
