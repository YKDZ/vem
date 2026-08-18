import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_PATTERNS = Object.freeze([
  {
    name: "creation-date-guess",
    pattern: /CreationDate|Sort-Object[^\n]*CreationDate/i,
    reason: "按创建时间猜测子进程身份",
  },
  {
    name: "win32-process-probe",
    pattern: /Get-CimInstance[^\n]*Win32_Process/i,
    reason: "探测生产进程内部拓扑",
  },
  {
    name: "command-line-probe",
    pattern: /\.CommandLine/i,
    reason: "解析进程命令行猜测角色",
  },
  {
    name: "guessed-taskkill",
    pattern: /taskkill[^\n]*\/PID/i,
    reason: "按猜测 PID 杀进程",
  },
  {
    name: "vision-log-tail",
    pattern: /vision\.log/i,
    reason: "读取产品日志尾部反推失败",
  },
]);

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const entry = statSync(path);
    if (entry.isDirectory()) {
      found.push(...walk(path));
    } else if (/\.(mjs|js|ps1|psm1)$/.test(name) && !name.endsWith(".test.mjs")) {
      found.push(path);
    }
  }
  return found;
}

export function auditProbeBoundaries(root) {
  const violations = [];
  for (const path of walk(root)) {
    const source = readFileSync(path, "utf8");
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(source)) {
        violations.push(`${path}:${rule.name}:${rule.reason}`);
      }
    }
  }
  return violations;
}

export function assertProbeBoundaries(root) {
  const violations = auditProbeBoundaries(root);
  if (violations.length > 0) {
    throw new Error(`probe boundary violations:\n${violations.join("\n")}`);
  }
  return violations;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2];
  if (!root) {
    throw new Error("usage: probe-audit.mjs <directory>");
  }
  assertProbeBoundaries(root);
}
