#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN_API_DIRECTORY = "apps/admin-ui/src/api";
const EXCLUDED_API_FILES = new Set([
  "apps/admin-ui/src/api/auth.ts",
  "apps/admin-ui/src/api/request.ts",
]);
const WRITE_HELPERS = new Set(["post", "patch"]);
const CONTRACT_WRITE_HELPERS = new Set([
  "postContract",
  "patchContract",
  "postResponseContract",
]);
const WRITE_CALL_PATTERN =
  /\b(?:post|patch|postContract|patchContract|postResponseContract)\s*(?:<[\s\S]*?>)?\s*\(/;
const BROAD_TYPE_PATTERN = /\b(?:Record\s*<\s*string\s*,\s*unknown\s*>|any)\b/;
const SHARED_BODY_TYPE_PATTERN =
  /\b(?:z\.input\s*<|Admin[A-Z][A-Za-z0-9]*(?:Request|Input)|MachineEnvironmentControlRequest)\b/;
const LOCAL_TYPE_UTILITY_NAMES = new Set([
  "Array",
  "Blob",
  "Date",
  "Exclude",
  "Extract",
  "File",
  "FormData",
  "Map",
  "NonNullable",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "Record",
  "Required",
  "Set",
]);

function pathExists(root, path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

function directoryExists(root, path) {
  try {
    return statSync(join(root, path)).isDirectory();
  } catch {
    return false;
  }
}

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function listFiles(root, directory) {
  if (!directoryExists(root, directory)) return [];

  const absoluteDirectory = join(root, directory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const repositoryPath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      files.push(...listFiles(root, repositoryPath));
    } else if (entry.isFile() && repositoryPath.endsWith(".ts")) {
      files.push(repositoryPath);
    }
  }
  return files.sort();
}

function extractFunctions(source) {
  const functions = [];
  const declarationPattern =
    /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  const asyncArrowPattern =
    /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*async\s*(?:<[\s\S]*?>\s*)?\(/g;

  let match;
  while ((match = declarationPattern.exec(source)) !== null) {
    const [, name] = match;
    const parametersStart = declarationPattern.lastIndex;
    let parameterDepth = 1;
    let parametersEnd = parametersStart;
    for (; parametersEnd < source.length; parametersEnd += 1) {
      const character = source[parametersEnd];
      if (character === "(") parameterDepth += 1;
      if (character === ")") parameterDepth -= 1;
      if (parameterDepth === 0) break;
    }

    const parameters = source.slice(parametersStart, parametersEnd);
    let bodyOpen = -1;
    for (let index = parametersEnd + 1; index < source.length; index += 1) {
      if (source[index] !== "{") continue;
      const nextSource = source.slice(index + 1).trimStart();
      if (/^(return|await|const|let|if|for|try)\b/.test(nextSource)) {
        bodyOpen = index;
        break;
      }
    }
    if (bodyOpen === -1) continue;

    const bodyStart = bodyOpen + 1;
    let depth = 1;
    let index = bodyStart;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) break;
    }
    functions.push({
      name,
      parameters,
      body: source.slice(bodyStart, index),
    });
    declarationPattern.lastIndex = index + 1;
  }

  while ((match = asyncArrowPattern.exec(source)) !== null) {
    const [, name] = match;
    const parametersStart = asyncArrowPattern.lastIndex;
    const parametersEnd = findBalancedEnd(
      source,
      parametersStart - 1,
      "(",
      ")",
    );
    if (parametersEnd === -1) continue;

    const arrowStart = source.indexOf("=>", parametersEnd + 1);
    if (arrowStart === -1) continue;

    const bodyStart = skipWhitespace(source, arrowStart + 2);
    if (source[bodyStart] === "{") {
      const bodyEnd = findBalancedEnd(source, bodyStart, "{", "}");
      if (bodyEnd === -1) continue;
      functions.push({
        name,
        parameters: source.slice(parametersStart, parametersEnd),
        body: source.slice(bodyStart + 1, bodyEnd),
      });
      asyncArrowPattern.lastIndex = bodyEnd + 1;
      continue;
    }

    const bodyEnd = findExpressionEnd(source, bodyStart);
    functions.push({
      name,
      parameters: source.slice(parametersStart, parametersEnd),
      body: source.slice(bodyStart, bodyEnd),
    });
    asyncArrowPattern.lastIndex = bodyEnd;
  }

  return functions;
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function findBalancedEnd(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findExpressionEnd(source, start) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parenDepth += 1;
    if (character === ")") parenDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth -= 1;
    if (
      character === ";" &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return index;
    }
  }
  return source.length;
}

function helperCalls(functionSource) {
  const calls = [];
  const callPattern =
    /\b(post|patch|postContract|patchContract|postResponseContract)\s*(?:<[\s\S]*?>)?\s*\(/g;
  let match;
  while ((match = callPattern.exec(functionSource)) !== null) {
    calls.push(match[1]);
  }
  return calls;
}

function functionUsesWriteHelper(fn) {
  return WRITE_CALL_PATTERN.test(fn.body);
}

function functionUsesBroadQuery(parameters) {
  return /(?:^|,)\s*query\s*\??\s*:\s*Record\s*<\s*string\s*,\s*unknown\s*>/.test(
    parameters,
  );
}

function bodyParameterType(parameters) {
  const match = /\b(?:body|input)\??\s*:/g.exec(parameters);
  if (!match) return "";

  const typeStart = match.index + match[0].length;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = typeStart; index < parameters.length; index += 1) {
    const character = parameters[index];
    if (character === "<") angleDepth += 1;
    if (character === ">" && angleDepth > 0) angleDepth -= 1;
    if (character === "(") parenDepth += 1;
    if (character === ")" && parenDepth > 0) parenDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}" && braceDepth > 0) braceDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (
      character === "," &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return parameters.slice(typeStart, index).trim();
    }
  }
  return parameters.slice(typeStart).trim();
}

function isLocalBodyType(typeText) {
  if (!typeText) return false;
  if (typeText.startsWith("{")) return true;
  if (SHARED_BODY_TYPE_PATTERN.test(typeText)) return false;

  const typeNames = typeText.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  return typeNames.some((typeName) => !LOCAL_TYPE_UTILITY_NAMES.has(typeName));
}

function checkWriteCaller(caller, fn) {
  const failures = [];
  const calls = helperCalls(fn.body);
  for (const call of calls) {
    if (WRITE_HELPERS.has(call)) {
      failures.push(`admin write caller uses unbound ${call}: ${caller}`);
    }
  }
  if (!calls.some((call) => CONTRACT_WRITE_HELPERS.has(call))) {
    failures.push(`admin write caller missing schema-bound helper: ${caller}`);
  }

  const bodyType = bodyParameterType(fn.parameters);
  if (isLocalBodyType(bodyType)) {
    failures.push(`admin write caller uses local body type: ${caller}`);
  }
  if (BROAD_TYPE_PATTERN.test(bodyType)) {
    failures.push(`admin write caller uses broad body type: ${caller}`);
  }
  return failures;
}

function indexWriteCallers(root) {
  const callers = new Map();
  for (const path of listFiles(root, ADMIN_API_DIRECTORY)) {
    if (EXCLUDED_API_FILES.has(path) || path.endsWith(".spec.ts")) continue;
    const source = readText(root, path);
    for (const fn of extractFunctions(source)) {
      if (!functionUsesWriteHelper(fn)) continue;
      callers.set(`${path}#${fn.name}`, { path, fn });
    }
  }
  return callers;
}

function checkWriteModuleQueryTypes(root, writeModulePaths) {
  const failures = [];

  for (const path of writeModulePaths) {
    if (!pathExists(root, path)) continue;
    const source = readText(root, path);
    for (const fn of extractFunctions(source)) {
      if (!functionUsesBroadQuery(fn.parameters)) continue;
      failures.push(
        `admin api write module uses broad query type: ${path}#${fn.name}`,
      );
    }
  }

  return failures;
}

export function checkAdminApiContracts(options = {}) {
  const root = options.root ?? process.cwd();
  const failures = [];
  const checks = [];
  const callers = indexWriteCallers(root);
  const writeModulePaths = new Set(
    [...callers.values()].map((indexed) => indexed.path),
  );

  for (const [caller, indexed] of callers) {
    failures.push(...checkWriteCaller(caller, indexed.fn));
  }
  failures.push(...checkWriteModuleQueryTypes(root, writeModulePaths));

  checks.push({
    name: "admin-writes-use-schema-bound-contracts",
    passed: !failures.some((failure) =>
      failure.startsWith("admin write caller"),
    ),
    detail: "admin writes use schema-bound helpers and shared body types",
  });
  checks.push({
    name: "admin-write-modules-avoid-broad-query-shortcuts",
    passed: !failures.some((failure) =>
      failure.startsWith("admin api write module uses broad query type"),
    ),
    detail: "admin API modules with writes use shared query contracts",
  });

  return {
    ok: failures.length === 0,
    checks,
    failures,
    writeCallers: [...callers.keys()].sort(),
  };
}

function printResult(result) {
  for (const check of result.checks) {
    const mark = check.passed ? "ok" : "not ok";
    console.log(`${mark} - ${check.name}: ${check.detail}`);
  }
  for (const failure of result.failures) {
    console.error(`not ok - ${failure}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlagIndex = process.argv.indexOf("--root");
  const root =
    rootFlagIndex === -1 ? process.cwd() : process.argv[rootFlagIndex + 1];
  const result = checkAdminApiContracts({ root });
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
