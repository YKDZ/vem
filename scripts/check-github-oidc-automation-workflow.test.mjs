import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(
  ".github/workflows/vm-runtime-acceptance.yml",
  "utf8",
);
const buildWorkflow = readFileSync(
  ".github/workflows/build-windows-runtime-artifacts.yml",
  "utf8",
);
const parsedWorkflow = parse(workflow);
const maintenanceArchitecture = readFileSync(
  "public/windows-factory-runtime-and-maintenance.md",
  "utf8",
);
const inputGuard = "scripts/testbed/validate-vm-runtime-acceptance-inputs.mjs";

function runInputGuard(overrides = {}) {
  return spawnSync(process.execPath, [inputGuard], {
    encoding: "utf8",
    env: {
      ...process.env,
      RUN_ID: "RUN-42",
      WINDOWS_SSH_USER: "YKDZ",
      MAINTENANCE_CONTROL_PLANE_URL: "https://control-plane.example/api/",
      MAINTENANCE_ALLOW_INSECURE_HTTP: "false",
      MAINTENANCE_RUNNER_PEER_ID: "550e8400-e29b-41d4-a716-446655440001",
      MAINTENANCE_TARGET_MACHINE_ID: "550e8400-e29b-41d4-a716-446655440002",
      ...overrides,
    },
  });
}

describe("GitHub OIDC maintenance automation workflow guard", () => {
  it("fixes the protected main trust boundary and runner labels in repository code", () => {
    assert.match(workflow, /timeout-minutes:\s*120/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /environment:\s*vem-maintenance-testbed/);
    assert.match(workflow, /if:\s*github\.ref == 'refs\/heads\/main'/);
    assert.match(
      workflow,
      /runs-on:\s*\[self-hosted, Linux, X64, vem-runtime\]/,
    );
    assert.match(workflow, /audience=vem-maintenance/);
    assert.match(
      workflow,
      /MAINTENANCE_ALLOW_INSECURE_HTTP:\s*\$\{\{ vars\.VEM_MAINTENANCE_ALLOW_INSECURE_HTTP \}\}/,
    );
    const inputGuardSource = readFileSync(inputGuard, "utf8");
    assert.match(
      inputGuardSource,
      /url\.protocol === "http:"[\s\S]*MAINTENANCE_ALLOW_INSECURE_HTTP === "true"/,
    );
    assert.doesNotMatch(workflow, /runner_labels:/);
    assert.doesNotMatch(workflow, /maintenance_runner_peer_id:/);
    assert.doesNotMatch(workflow, /maintenance_target_machine_id:/);
    assert.match(
      workflow,
      /MAINTENANCE_CONTROL_PLANE_URL:\s*\$\{\{ vars\.VEM_MAINTENANCE_CONTROL_PLANE_URL \}\}/,
    );
    assert.match(
      workflow,
      /MAINTENANCE_RUNNER_PEER_ID:\s*\$\{\{ vars\.VEM_MAINTENANCE_RUNNER_PEER_ID \}\}/,
    );
    assert.match(
      workflow,
      /MAINTENANCE_TARGET_MACHINE_ID:\s*\$\{\{ vars\.VEM_MAINTENANCE_TARGET_MACHINE_ID \}\}/,
    );
    assert.doesNotMatch(workflow, /MAINTENANCE_GITHUB_OIDC_TRUST_POLICY/);
    assert.doesNotMatch(workflow, /MAINTENANCE_AUTOMATION_JWT_SECRET/);

    const dispatchInputs = parsedWorkflow.on.workflow_dispatch.inputs;
    assert.equal(dispatchInputs.runner_labels, undefined);
    assert.equal(dispatchInputs.maintenance_runner_peer_id, undefined);
    assert.equal(dispatchInputs.maintenance_target_machine_id, undefined);
    const job = parsedWorkflow.jobs["vm-runtime-acceptance"];
    assert.deepEqual(job["runs-on"], [
      "self-hosted",
      "Linux",
      "X64",
      "vem-runtime",
    ]);
    assert.equal(job.environment, "vem-maintenance-testbed");
    assert.equal(job.if, "github.ref == 'refs/heads/main'");
    assert.equal(job.permissions["id-token"], "write");
  });

  it("pins every external action reference to a full commit SHA", () => {
    const externalUses = [
      ...(workflow + buildWorkflow).matchAll(/^\s*uses:\s*([^\s]+)$/gm),
    ]
      .map((match) => match[1])
      .filter((reference) => !reference.startsWith("./"));
    assert.ok(externalUses.length > 0);
    for (const reference of externalUses) {
      assert.match(reference, /@[0-9a-f]{40}$/);
    }
  });

  it("exchanges the endpoint value and exercises create, verify, and always-revoke", () => {
    assert.match(workflow, /payload\.value/);
    assert.match(workflow, /maintenance-automation\/exchange/);
    assert.match(workflow, /maintenance-automation\/session/);
    assert.match(workflow, /request = "POST"/);
    assert.match(workflow, /request = "GET"/);
    assert.match(workflow, /session\/revoke/);
    assert.match(workflow, /if:\s*always\(\)/);
    assert.doesNotMatch(workflow, /if:\s*inputs\.maintenance_/);
    assert.doesNotMatch(
      workflow,
      /EPHEMERAL_API_BASE_URL.*maintenance-automation/,
    );
  });

  it("disables curl URL globbing for every workflow request", () => {
    const curlInvocations = workflow.match(/\bcurl\s+[^\n]*/g) ?? [];
    assert.ok(curlInvocations.length > 0, "workflow should make curl requests");
    for (const invocation of curlInvocations) {
      assert.match(invocation, /\bcurl\s+--globoff\b/, invocation);
    }
  });

  it("validates workflow inputs outside Bash and uses only the canonical control-plane URL", () => {
    const job = parsedWorkflow.jobs["vm-runtime-acceptance"];
    assert.equal(job.env.WINDOWS_SSH_USER, "${{ inputs.windows_ssh_user }}");
    for (const step of job.steps.filter((candidate) => candidate.run)) {
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
    }

    const acceptance = job.steps.find(
      (candidate) => candidate.name === "Run VM Runtime Acceptance",
    );
    assert.match(
      acceptance.run,
      /--remote "\$WINDOWS_SSH_USER@\$VM_GUEST_MAINTENANCE_HOST"/,
    );

    const canonical = runInputGuard({
      MAINTENANCE_CONTROL_PLANE_URL: "HTTPS://CONTROL-PLANE.EXAMPLE:443/api/",
    });
    assert.equal(canonical.status, 0, canonical.stderr);
    assert.equal(
      canonical.stdout,
      "MAINTENANCE_CONTROL_PLANE_CANONICAL_URL=https://control-plane.example/api\n",
    );

    for (const [name, overrides] of [
      [
        "shell injection",
        { WINDOWS_SSH_USER: "YKDZ; touch /tmp/vem-workflow-injection" },
      ],
      [
        "invalid run id",
        { RUN_ID: "RUN-42$(touch /tmp/vem-run-id-injection)" },
      ],
    ]) {
      const result = runInputGuard(overrides);
      assert.notEqual(result.status, 0, `${name} must be rejected`);
    }

    const backslashDifferential = "https://control-plane.example/api\\session";
    assert.equal(
      new URL(backslashDifferential).href,
      "https://control-plane.example/api/session",
    );
    assert.notEqual(
      runInputGuard({
        MAINTENANCE_CONTROL_PLANE_URL: backslashDifferential,
      }).status,
      0,
      "backslashes that WHATWG URL normalizes must be rejected before curl",
    );

    for (const url of [
      "https://control-plane.example/api?",
      "https://control-plane.example/api#",
      "https://control-plane.example/api[]",
    ]) {
      assert.notEqual(
        runInputGuard({ MAINTENANCE_CONTROL_PLANE_URL: url }).status,
        0,
        `empty URL delimiter must be rejected: ${url}`,
      );
    }

    for (const endpoint of ["exchange", "session", "session/revoke"]) {
      assert.match(
        workflow,
        new RegExp(
          `\\$MAINTENANCE_CONTROL_PLANE_CANONICAL_URL/maintenance-automation/${endpoint}`,
        ),
      );
    }
    assert.doesNotMatch(
      workflow,
      /MAINTENANCE_CONTROL_PLANE_URL(?:%\/|\/maintenance-automation)/,
    );
  });

  it("keeps OIDC and automation tokens in 0600 files and scans evidence before upload", () => {
    assert.match(workflow, /umask 077/);
    assert.match(workflow, /mode:\s*0o600/);
    assert.match(workflow, /::add-mask::%s/);
    assert.match(workflow, /--config -/);
    assert.doesNotMatch(workflow, /ID_TOKEN=/);
    assert.doesNotMatch(workflow, /EXCHANGE_RESPONSE=/);
    assert.doesNotMatch(workflow, /--data\s+"\$request_body"/);
    assert.match(workflow, /automation-token\.jwt/);
    assert.match(workflow, /maintenance-automation-leak-guard/);
    assert.match(workflow, /rm -f[\s\S]*automation-token\.jwt/);
    assert.doesNotMatch(
      workflow,
      /upload-artifact[\s\S]*automation-token\.jwt/,
    );
  });

  it("keeps every VM Runtime Acceptance bash step syntactically valid", () => {
    const steps = parsedWorkflow.jobs["vm-runtime-acceptance"].steps;
    for (const step of steps.filter((candidate) => candidate.run)) {
      const script = step.run.replace(/\$\{\{.*?\}\}/g, "github_value");
      const checked = spawnSync("bash", ["-n"], {
        input: script,
        encoding: "utf8",
      });
      assert.equal(
        checked.status,
        0,
        `${step.name} has invalid bash syntax: ${checked.stderr}`,
      );
    }
  });

  it("documents deployment-owned control-plane trust and edge rate limiting", () => {
    assert.match(
      maintenanceArchitecture,
      /independently deployed\s+Maintenance control-plane/i,
    );
    assert.match(maintenanceArchitecture, /VEM_MAINTENANCE_CONTROL_PLANE_URL/);
    assert.match(maintenanceArchitecture, /VEM_MAINTENANCE_RUNNER_PEER_ID/);
    assert.match(maintenanceArchitecture, /VEM_MAINTENANCE_TARGET_MACHINE_ID/);
    assert.match(maintenanceArchitecture, /read-only mounted files/i);
    assert.match(maintenanceArchitecture, /30 exchange\s+requests per minute/i);
    assert.match(maintenanceArchitecture, /reverse proxy/i);
  });
});
