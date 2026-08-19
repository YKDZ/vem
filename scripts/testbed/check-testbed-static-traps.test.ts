import assert from "node:assert/strict";
import test from "node:test";

import { findStaticTraps } from "./check-testbed-static-traps.ts";

test("flags comment strings inside joined PowerShell command lines", () => {
  const source = `
const command = [
  "$ErrorActionPreference = 'Stop'",
  "# this comment silently disables the statements after it",
  "if (Test-Path x) { Remove-Item x }",
].join("; ");
`;
  const traps = findStaticTraps(source, "sample.ts");
  assert.ok(traps.some((trap) => trap.includes("comment string inside")));
});

test("flags Set-Content -Encoding utf8 BOM writes", () => {
  const source = `
const command = [
  "$config = Get-Content -Raw x.json",
  "($config | ConvertTo-Json) | Set-Content -LiteralPath x.json -Encoding utf8",
].join("; ");
`;
  const traps = findStaticTraps(source, "sample.ts");
  assert.ok(traps.some((trap) => trap.includes("writes a BOM")));
});

test("accepts clean command arrays and non-joined strings", () => {
  const source = `
const command = [
  "$config = Get-Content -Raw x.json",
  "[IO.File]::WriteAllText(x, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new(false))",
].join("; ");
const label = "# not a trap: plain hash string";
`;
  const traps = findStaticTraps(source, "sample.ts");
  assert.deepEqual(traps, []);
});
