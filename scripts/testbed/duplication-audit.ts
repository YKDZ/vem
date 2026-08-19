import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DUPLICATED_WAITER = /(?:function|const)\s+waitForCondition\s*(?:\(|=)/;

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const entry = statSync(path);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (/\.(ts|js)$/.test(name) && !name.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

export function auditDuplicatedWaiters(root) {
  const violations = [];
  for (const path of walk(root)) {
    if (path.endsWith("condition-waiter.ts")) continue;
    const source = readFileSync(path, "utf8");
    if (DUPLICATED_WAITER.test(source)) {
      violations.push(`${path}:duplicated-wait-for-condition`);
    }
  }
  return violations;
}

export function assertNoDuplicatedWaiters(root) {
  const violations = auditDuplicatedWaiters(root);
  if (violations.length > 0) {
    throw new Error(`duplicated waiter violations:\n${violations.join("\n")}`);
  }
  return violations;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    throw new Error("usage: duplication-audit.ts <directory>");
  }
  assertNoDuplicatedWaiters(root);
}
