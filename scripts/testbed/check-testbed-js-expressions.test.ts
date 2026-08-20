import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkTestbedJsExpressions,
  collectExpressions,
  compileExpression,
} from "./check-testbed-js-expressions.ts";

test("compiles valid CDP expressions", () => {
  assert.equal(compileExpression("(() => ({ ok: true }))()"), null);
  assert.equal(compileExpression("location.hash"), null);
  assert.equal(
    compileExpression(
      "window.__VEM_MACHINE_RUNTIME_TRACE_SNAPSHOT__?.runtimeGenerationId ?? null",
    ),
    null,
  );
  assert.equal(
    compileExpression(
      `const prefix = ${JSON.stringify(`transaction:${"orderNo"}:`)}; (() => prefix)()`,
    ),
    null,
  );
});

test("rejects syntactically broken CDP expressions", () => {
  assert.notEqual(compileExpression("(() => { const broken = ; })()"), null);
  assert.notEqual(compileExpression("(() => { return 1"), null);
});

test("collects evaluateExpression literals and named constants", () => {
  const source = [
    "const DEMO_EXPRESSION = `(() => ({ ok: true }))()`;",
    "await evaluateExpression(client, `(() => ({ ok: false }))()`);",
    "await evaluateExpression(client, DEMO_EXPRESSION);",
  ].join("\n");
  const occurrences = collectExpressions(source, "fixture.ts");
  const kinds = occurrences.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ["constant", "evaluate"]);
});

test("forbids inline expression: literals but allows constant references", () => {
  const violating = collectExpressions(
    'client.send("Runtime.evaluate", { expression: `(() => 1)()`, returnByValue: true });',
    "fixture.ts",
  );
  assert.ok(
    violating.some((entry) => entry.kind === "expression-key"),
    "inline expression literal must be flagged",
  );
  const allowed = collectExpressions(
    'client.send("Runtime.evaluate", { expression: DEMO_EXPRESSION, returnByValue: true });',
    "fixture.ts",
  );
  assert.ok(
    allowed.every((entry) => entry.kind !== "expression-key"),
    "constant references must be allowed",
  );
});

test("the real testbed tree has no syntax errors or inline expression literals", () => {
  const result = checkTestbedJsExpressions();
  assert.deepEqual(result.errors, []);
  assert.ok(result.files > 100);
  assert.ok(result.occurrences > 50);
});
