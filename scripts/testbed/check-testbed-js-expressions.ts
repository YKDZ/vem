#!/usr/bin/env node

// 静态门禁：testbed 中的 CDP JS 表达式必须是可编译的合法 JavaScript。
// 1) 所有传给 evaluateExpression / Runtime.evaluate expression: 的字符串字面量
//    都用 new Function 做语法编译（模板插值先替换为占位值），避免笔误只在上
//    VM 才暴露。
// 2) `expression:` 键不允许直接写字符串字面量——必须引用命名常量或调用
//    helper，防止新增难以解释和维护的内联 JS。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIRECTORIES = [join(ROOT, "scripts/testbed")];
const EXPRESSION_CONSTANT = /^[A-Za-z0-9_]*_EXPRESSION$/;

interface ExpressionOccurrence {
  path: string;
  line: number;
  kind: "evaluate" | "expression-key" | "constant";
  source: string;
}

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const entry = statSync(path);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (
      name.endsWith(".ts") &&
      !name.startsWith("check-testbed-js-expressions")
    ) {
      found.push(path);
    }
  }
  return found;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function stringLiteralAt(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      value += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && source[index + 1] === "{") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") depth -= 1;
        cursor += 1;
      }
      value += source.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (ch === quote) return { value, end: index + 1 };
    value += ch;
    index += 1;
  }
  return null;
}

function matchingCloseParen(source: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      const literal = stringLiteralAt(source, index);
      if (!literal) return -1;
      index = literal.end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function secondCallArgument(
  source: string,
  open: number,
): { source: string; start: number } | null {
  const close = matchingCloseParen(source, open);
  if (close < 0) return null;
  let depth = 0;
  let argumentStart = -1;
  let argumentEnd = close;
  let commaSeen = 0;
  let index = open + 1;
  while (index < close) {
    const ch = source[index];
    if (ch === '"' || ch === "'" || ch === "`") {
      const literal = stringLiteralAt(source, index);
      if (!literal) return null;
      index = literal.end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      commaSeen += 1;
      if (commaSeen === 1) argumentStart = index + 1;
      else if (commaSeen === 2) {
        argumentEnd = index;
        break;
      }
    }
    index += 1;
  }
  if (argumentStart < 0) return null;
  const rawArgument = source.slice(argumentStart, argumentEnd);
  const leadingWhitespace = rawArgument.length - rawArgument.trimStart().length;
  return {
    source: rawArgument.trim(),
    start: argumentStart + leadingWhitespace,
  };
}

function substituteTemplateInterpolations(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("${", index);
    if (start < 0) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, start);
    let depth = 1;
    let cursor = start + 2;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    output += "0";
    index = cursor;
  }
  return output;
}

function unescapeStringLiteral(source: string): string {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch !== "\\" || index + 1 >= source.length) {
      output += ch;
      continue;
    }
    const next = source[index + 1];
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (next === "v") output += "\v";
    else if (next === "0") output += "\0";
    else output += next;
    index += 1;
  }
  return output;
}

export function compileExpression(source: string): Error | null {
  const substituted = unescapeStringLiteral(
    substituteTemplateInterpolations(source),
  );
  const attempts = [substituted, `return (${substituted});`];
  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(attempt);
      return null;
    } catch {
      // try the next wrapping form
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(substituted);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function collectExpressions(source: string, path: string) {
  const occurrences: ExpressionOccurrence[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const evaluateIndex = source.indexOf("evaluateExpression(", cursor);
    if (evaluateIndex >= 0) {
      const open = evaluateIndex + "evaluateExpression".length;
      const argument = secondCallArgument(source, open);
      if (argument) {
        const literal = stringLiteralAt(source, argument.start);
        if (literal) {
          occurrences.push({
            path,
            line: lineOf(source, evaluateIndex),
            kind: "evaluate",
            source: literal.value,
          });
        }
      }
      cursor = open + 1;
      continue;
    }
    const keyIndex = source.indexOf("expression:", cursor);
    if (keyIndex < 0) break;
    let valueStart = keyIndex + "expression:".length;
    while (valueStart < source.length && /\s/.test(source[valueStart])) {
      valueStart += 1;
    }
    const literal = stringLiteralAt(source, valueStart);
    if (literal) {
      occurrences.push({
        path,
        line: lineOf(source, keyIndex),
        kind: "expression-key",
        source: literal.value,
      });
      cursor = literal.end;
    } else {
      cursor = keyIndex + "expression:".length;
    }
  }
  const constantPattern = /\bconst\s+([A-Za-z0-9_]+)\s*=\s*/g;
  let match;
  while ((match = constantPattern.exec(source)) !== null) {
    if (!EXPRESSION_CONSTANT.test(match[1])) continue;
    let valueStart = constantPattern.lastIndex;
    while (valueStart < source.length && /\s/.test(source[valueStart])) {
      valueStart += 1;
    }
    const literal = stringLiteralAt(source, valueStart);
    if (literal) {
      occurrences.push({
        path,
        line: lineOf(source, match.index),
        kind: "constant",
        source: literal.value,
      });
      constantPattern.lastIndex = literal.end;
    }
  }
  return occurrences;
}

export function checkTestbedJsExpressions() {
  const files = SCAN_DIRECTORIES.flatMap(walk);
  const occurrences = files.flatMap((path) =>
    collectExpressions(readFileSync(path, "utf8"), path),
  );
  const errors: string[] = [];
  const compiled = new Set<string>();
  for (const occurrence of occurrences) {
    if (occurrence.kind === "expression-key") {
      errors.push(
        `${occurrence.path}:${occurrence.line}: inline expression: literal is forbidden; hoist to a named *_EXPRESSION constant or use a driver helper`,
      );
      continue;
    }
    if (compiled.has(occurrence.source)) continue;
    compiled.add(occurrence.source);
    const failure = compileExpression(occurrence.source);
    if (failure) {
      errors.push(
        `${occurrence.path}:${occurrence.line}: JS expression is not valid JavaScript: ${failure.message}`,
      );
    }
  }
  return { files: files.length, occurrences: occurrences.length, errors };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  const result = checkTestbedJsExpressions();
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `checked ${result.files} files, ${result.occurrences} JS expression literals, no syntax errors\n`,
    );
  }
}
