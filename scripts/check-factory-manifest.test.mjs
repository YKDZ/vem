import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflowPath = ".github/workflows/build-factory-iso.yml";
const ciWorkflowPath = ".github/workflows/ci.yml";
const runtimeWorkflowPath =
  ".github/workflows/build-windows-runtime-artifacts.yml";
const skipHostDockerLifecycle =
  process.env.VEM_FACTORY_TEST_SKIP_HOST_DOCKER_LIFECYCLE;

assert.ok(
  skipHostDockerLifecycle === undefined || skipHostDockerLifecycle === "1",
  "VEM_FACTORY_TEST_SKIP_HOST_DOCKER_LIFECYCLE must be exactly 1 when set",
);

function read(path) {
  assert.equal(existsSync(path), true, `${path} should exist`);
  return readFileSync(path, "utf8");
}

function matchesWorkflowSemver(pattern, version) {
  try {
    execFileSync(
      "bash",
      ["-c", '[[ "$1" =~ $2 ]]', "factory-tool-semver", version, pattern],
      { stdio: "ignore" },
    );
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function workflowStep(parsed, name) {
  const step = parsed.jobs.build.steps.find(
    (candidate) => candidate.name === name,
  );
  assert.ok(step, `Factory build workflow has a ${name} step`);
  return step;
}

function shellAsRunner() {
  return process.getuid() === 0
    ? ["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "bash"]
    : ["bash"];
}

async function allocateFactoryWorkDirectory(
  script,
  fixture,
  suffix,
  overrides = {},
) {
  const {
    root,
    manifestStore,
    sourceStore,
    statDirectory,
    manifestDigest,
    dockerLog,
    dockerState,
    dockerRoot,
    builderImage,
  } = fixture;
  const envFile = join(root, `.factory-work-env-${suffix}`);
  const outputFile = join(root, `.factory-work-output-${suffix}`);
  await writeFile(envFile, "");
  await writeFile(outputFile, "");
  await chmod(envFile, 0o666);
  await chmod(outputFile, 0o666);
  const [shell, ...shellArguments] = shellAsRunner();
  execFileSync(
    shell,
    [...shellArguments, "-c", `set -euo pipefail\n${script}`],
    {
      env: {
        ...process.env,
        GITHUB_ENV: envFile,
        GITHUB_OUTPUT: outputFile,
        GITHUB_RUN_ID: "29234872596",
        GITHUB_RUN_ATTEMPT: "1",
        RUNNER_NAME: "fixture-factory-runner",
        MANIFEST_IDENTITY: `sha256:${manifestDigest}`,
        FACTORY_TEST_DOCKER_LOG: dockerLog,
        FACTORY_TEST_DOCKER_STATE: dockerState,
        FACTORY_TEST_DOCKER_ROOT: dockerRoot,
        VEM_FACTORY_WORK_ROOT: root,
        VEM_FACTORY_BUILDER_IMAGE: builderImage,
        VEM_FACTORY_MANIFEST_STORE: manifestStore,
        VEM_FACTORY_WINDOWS_SOURCE_STORE: sourceStore,
        PATH: `${statDirectory}:${process.env.PATH}`,
        ...overrides,
      },
      stdio: "ignore",
    },
  );
  const entry = readFileSync(envFile, "utf8")
    .split("\n")
    .find((line) => line.startsWith("FACTORY_WORK_DIRECTORY="));
  assert.ok(entry, "Factory runner guard exports its allocated work directory");
  return entry.slice("FACTORY_WORK_DIRECTORY=".length);
}

async function factoryScratchFixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-work-root-"));
  const manifestStore = join(root, "manifests");
  const sourceStore = join(root, "windows-source");
  const statDirectory = join(root, "bin");
  const manifestDigest = "a".repeat(64);
  const windowsDigest = "b".repeat(64);
  const builderImage = `oci://registry.example/factory@sha256:${"c".repeat(64)}`;
  const runnerUid = process.getuid() === 0 ? 65534 : process.getuid();
  const runnerGid = process.getgid() === 0 ? 65534 : process.getgid();
  await mkdir(join(manifestStore, "sha256"), { recursive: true });
  await mkdir(join(sourceStore, "sha256"), { recursive: true });
  await mkdir(statDirectory, { recursive: true });
  await writeFile(
    join(manifestStore, "sha256", `${manifestDigest}.json`),
    JSON.stringify({
      source: {
        windowsMedia: {
          role: "windows-source-iso",
          digest: `sha256:${windowsDigest}`,
        },
      },
    }),
  );
  await writeFile(join(sourceStore, "sha256", windowsDigest), "source\n");
  const statPath = execFileSync("bash", ["-c", "command -v stat"], {
    encoding: "utf8",
  }).trim();
  const dockerLog = join(root, "docker.log");
  const dockerState = join(root, "docker-state");
  const dockerRoot = await mkdtemp(join(tmpdir(), "vem-factory-docker-root-"));
  const statShim = join(statDirectory, "stat");
  await writeFile(
    statShim,
    `#!/usr/bin/env bash
if [[ "$1" = -f && "$2" = -c ]]; then
  case "$3" in
    %T) printf '%s\\n' "\${FACTORY_TEST_FILESYSTEM_TYPE:-ext4}" ;;
    '%a %S %d') printf '%s %s %s\\n' "\${FACTORY_TEST_AVAILABLE_BLOCKS:-100000000}" 4096 "\${FACTORY_TEST_AVAILABLE_INODES:-1000000}" ;;
  esac
  exit 0
fi
if [[ "$1" = -c && "$2" = %s && -n "\${FACTORY_TEST_SOURCE_BYTES:-}" ]]; then
  printf '%s\\n' "\${FACTORY_TEST_SOURCE_BYTES}"
  exit 0
fi
exec ${statPath} "$@"
`,
  );
  await chmod(statShim, 0o755);
  const findmntShim = join(statDirectory, "findmnt");
  await writeFile(
    findmntShim,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FACTORY_TEST_FINDMNT_FAIL:-}" != 1 ]] || exit 1
findmnt_target=""
for ((index = 1; index <= $#; index += 1)); do
  if [[ "\${!index}" = --target ]]; then
    next_index=$((index + 1))
    findmnt_target="\${!next_index}"
    break
  fi
done
if [[ "$findmnt_target" = "\${FACTORY_TEST_DOCKER_ROOT:?}" ]]; then
  target="\${FACTORY_TEST_DOCKER_MOUNT_TARGET:-/}"
  source="\${FACTORY_TEST_DOCKER_MOUNT_SOURCE:-/dev/factory}"
  fstype="\${FACTORY_TEST_DOCKER_FILESYSTEM_TYPE:-ext4}"
  fsroot="\${FACTORY_TEST_DOCKER_MOUNT_FSROOT:-/}"
  device="\${FACTORY_TEST_DOCKER_MOUNT_DEVICE:-8:1}"
else
  target="\${FACTORY_TEST_WORK_MOUNT_TARGET:-/}"
  source="\${FACTORY_TEST_WORK_MOUNT_SOURCE:-/dev/factory}"
  fstype="\${FACTORY_TEST_FILESYSTEM_TYPE:-ext4}"
  fsroot="\${FACTORY_TEST_WORK_MOUNT_FSROOT:-/}"
  device="\${FACTORY_TEST_WORK_MOUNT_DEVICE:-8:1}"
fi
printf '{"filesystems":[{"target":"%s","source":"%s","fstype":"%s","fsroot":"%s","maj:min":"%s"}]}\\n' "$target" "$source" "$fstype" "$fsroot" "$device"
`,
  );
  await chmod(findmntShim, 0o755);
  const dockerShim = join(statDirectory, "docker");
  await writeFile(
    dockerShim,
    `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ps)
    for argument in "$@"; do
      case "$argument" in
        id=*)
          [[ "\${FACTORY_TEST_DOCKER_LIST_FAIL:-}" != 1 ]] || exit 1
          candidate="\${argument#id=}"
          if [[ ! -e "\${FACTORY_TEST_DOCKER_STATE:?}/$candidate" ]]; then
            printf '%s\\n' "$candidate"
          fi
          exit 0
          ;;
        name=^/*)
          [[ "\${FACTORY_TEST_DOCKER_LIST_FAIL:-}" != 1 ]] || exit 1
          candidate="\${argument#name=^/}"
          candidate="\${candidate%\\$}"
          if [[ ! -e "\${FACTORY_TEST_DOCKER_STATE:?}/$candidate" ]]; then
            printf 'current-container\\n'
          fi
          exit 0
          ;;
      esac
    done
    if [[ "$*" = *ancestor=* ]]; then
      printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'
    else
      printf 'labeled-container\\n'
    fi
    ;;
  rm)
    candidate="\${@: -1}"
    if [[ "\${FACTORY_TEST_DOCKER_RM_FAIL_CANDIDATE:-}" = "$candidate" ]]; then
      exit 1
    fi
    printf '%s\\n' "$*" >> "\${FACTORY_TEST_DOCKER_LOG:?}"
    touch "\${FACTORY_TEST_DOCKER_STATE:?}/$candidate"
    ;;
  pull)
    printf '%s\\n' "$*" >> "\${FACTORY_TEST_DOCKER_LOG:?}"
    ;;
  image)
    printf 'sha256:%064d\\n' 0
    ;;
  info)
    [[ "\${FACTORY_TEST_DOCKER_INFO_FAIL:-}" != 1 ]] || exit 1
    printf '{"DockerRootDir":"%s"}\\n' "\${FACTORY_TEST_DOCKER_ROOT:?}"
    ;;
  inspect)
    candidate="\${@: -1}"
    if [[ "\${FACTORY_TEST_DOCKER_INSPECT_FAIL_CANDIDATE:-}" = "$candidate" ]]; then
      exit 1
    fi
    if [[ -e "\${FACTORY_TEST_DOCKER_STATE:?}/$candidate" ]]; then
      exit 1
    fi
    cat <<'JSON'
[{"Image":"sha256:0000000000000000000000000000000000000000000000000000000000000000","Path":"node","Args":["/workspace/repo/scripts/factory/factory-cli.mjs","--manifest-store","/factory-manifests","--reproducibility"],"HostConfig":{"NetworkMode":"none","ReadonlyRootfs":true},"Config":{"Labels":{"io.vem.factory.role":"build","io.vem.factory.runner":"fixture-factory-runner","io.vem.factory.run":"29234872596-1"}}}]
JSON
    ;;
  *) exit 1 ;;
esac
`,
  );
  await writeFile(dockerLog, "");
  await mkdir(dockerState, { mode: 0o700 });
  await chmod(dockerShim, 0o755);
  const fixturePaths = [
    root,
    manifestStore,
    join(manifestStore, "sha256"),
    join(manifestStore, "sha256", `${manifestDigest}.json`),
    sourceStore,
    join(sourceStore, "sha256"),
    join(sourceStore, "sha256", windowsDigest),
    statDirectory,
    statShim,
    dockerShim,
    findmntShim,
    dockerLog,
    dockerState,
    dockerRoot,
  ];
  if (process.getuid() === 0) {
    await Promise.all(
      fixturePaths.map((path) => chown(path, runnerUid, runnerGid)),
    );
  }
  await Promise.all([
    chmod(root, 0o700),
    chmod(manifestStore, 0o755),
    chmod(join(manifestStore, "sha256"), 0o755),
    chmod(sourceStore, 0o755),
    chmod(join(sourceStore, "sha256"), 0o755),
    chmod(statDirectory, 0o755),
    chmod(dockerRoot, 0o700),
    chmod(dockerLog, 0o600),
    chmod(dockerState, 0o700),
  ]);
  return {
    root,
    manifestStore,
    sourceStore,
    statDirectory,
    manifestDigest,
    dockerLog,
    dockerState,
    dockerRoot,
    builderImage,
    runnerUid,
  };
}

describe("Factory Manifest and media workflow contract", () => {
  it("exposes a trusted manual trigger without caller-controlled factory inputs", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(parsed.on.workflow_dispatch, null);
    assert.equal(parsed.on.workflow_call, undefined);
    assert.doesNotMatch(
      workflow,
      /windows_source_iso|source_iso_path|private_key/i,
    );
  });

  it("gates restricted stores before trusted checkout on a protected labeled factory runner", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(parsed.jobs.build["runs-on"], [
      "self-hosted",
      "Linux",
      "X64",
      "vem-factory",
    ]);
    assert.equal(parsed.jobs.build.environment, "vem-factory-production");
    assert.equal(parsed.jobs.build.needs, "trust-gate");
    assert.deepEqual(parsed.jobs.build.env, {
      VEM_FACTORY_WORK_ROOT: "${{ vars.VEM_FACTORY_WORK_ROOT }}",
      VEM_FACTORY_PERSONALIZATION_MEDIA_PATH: "",
    });
    assert.deepEqual(parsed.jobs.build.concurrency, {
      group: "vem-factory-iso-single-flight",
      "cancel-in-progress": false,
    });
    assert.match(workflow, /workflow_dispatch\) ;;/);
    assert.match(workflow, /refs\/heads\/main\|refs\/tags\/factory-v\*/);
    assert.match(workflow, /GITHUB_ACTOR.*GITHUB_REPOSITORY_OWNER/);
    assert.match(workflow, /VEM_FACTORY_TRUSTED_RUNNER_NAME/);
    assert.match(workflow, /VEM_FACTORY_MANIFEST_IDENTITY/);
    assert.doesNotMatch(workflow, /inputs\.manifest_identity/);
    const firstBuildStep = parsed.jobs.build.steps[0];
    assert.match(firstBuildStep.name, /Guard Protected Factory Runner/);
    assert.equal(
      firstBuildStep.env.RUNNER_LABELS_JSON,
      '["self-hosted","Linux","X64","vem-factory"]',
    );
    assert.doesNotMatch(
      JSON.stringify(parsed.jobs.build.env),
      /VEM_FACTORY_.*STORE/,
    );
    assert.doesNotMatch(workflow, /\$\{\{\s*vars\.VEM_FACTORY_(?!WORK_ROOT)/);
    assert.doesNotMatch(workflow, /runner\.labels/);
    assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
    for (const name of [
      "VEM_FACTORY_VISION_RELEASE_DELIVERY_UNIT",
      "VEM_FACTORY_REPOSITORY_VISION_TRUSTED_ROOTS",
      "VEM_FACTORY_FACTORY_VISION_TRUSTED_ROOTS",
      "VEM_FACTORY_VISION_EVIDENCE_VERIFIER",
      "VEM_FACTORY_WORK_ROOT",
    ]) {
      assert.match(workflow, new RegExp(name));
    }
    assert.match(
      firstBuildStep.run,
      /VEM_FACTORY_WORK_ROOT[\s\\]+[\s\S]*?test -n "\$\{!name:-\}"/,
    );
    assert.match(
      firstBuildStep.run,
      /Factory work root must be owned by the current runner user/,
    );
    assert.match(firstBuildStep.run, /8#\$factory_work_root_mode & 0077/);
  });

  it("allows regular Vision factory input files through the runner guard", async () => {
    const parsed = parse(read(workflowPath));
    const guard = parsed.jobs.build.steps[0].run;
    const visionInputGuard = guard.slice(guard.lastIndexOf("for path in"));
    const root = await mkdtemp(join(tmpdir(), "vem-factory-vision-guard-"));
    try {
      const inputs = Object.fromEntries(
        [
          ["VEM_FACTORY_VISION_RELEASE_DELIVERY_UNIT", "delivery-unit.json"],
          [
            "VEM_FACTORY_REPOSITORY_VISION_TRUSTED_ROOTS",
            "repository-roots.json",
          ],
          ["VEM_FACTORY_FACTORY_VISION_TRUSTED_ROOTS", "factory-roots.json"],
          ["VEM_FACTORY_VISION_EVIDENCE_VERIFIER", "verifier"],
        ].map(([name, fileName]) => [name, join(root, fileName)]),
      );
      await Promise.all(
        Object.values(inputs).map((path) => writeFile(path, "fixture\n")),
      );
      execFileSync("bash", ["-c", `set -euo pipefail\n${visionInputGuard}`], {
        env: { ...process.env, ...inputs },
        stdio: "ignore",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires exact protected runner labels with Bash before checkout", () => {
    const parsed = parse(read(workflowPath));
    const guard = parsed.jobs.build.steps[0].run;
    const labelGuardStart = guard.indexOf(
      `expected_runner_labels_json='["self-hosted","Linux","X64","vem-factory"]'`,
    );
    const labelGuardEnd = guard.indexOf("for name in", labelGuardStart);
    assert.ok(labelGuardStart >= 0, "runner label guard is present");
    assert.ok(
      labelGuardEnd > labelGuardStart,
      "runner label guard ends before service checks",
    );
    const labelGuard = guard.slice(labelGuardStart, labelGuardEnd);
    assert.doesNotMatch(guard, /\bnode\b|\bjq\b|\bpython(?:3)?\b/);

    const runLabelGuard = (runnerLabels) =>
      execFileSync("bash", ["-c", `set -euo pipefail\n${labelGuard}`], {
        env: { ...process.env, RUNNER_LABELS_JSON: runnerLabels },
        stdio: "ignore",
      });

    runLabelGuard('["self-hosted","Linux","X64","vem-factory"]');
    for (const runnerLabels of [
      '["self-hosted","Linux","X64","vem-factory","additional-label"]',
      '["self-hosted","Linux","X64"]',
      '["evil-self-hosted","Linux","X64","vem-factory"]',
      '[["self-hosted","Linux","X64","vem-factory"]]',
      '{"labels":["self-hosted","Linux","X64","vem-factory"]}',
      '["self-hosted" "Linux","X64","vem-factory"]',
      '["Linux","self-hosted","X64","vem-factory"]',
      '["self-hosted", "Linux", "X64", "vem-factory"]',
    ]) {
      assert.throws(() => runLabelGuard(runnerLabels));
    }
  });

  it("executes manifest-pinned tools offline and uploads only validated bounded JSON evidence", () => {
    const workflow = read(workflowPath);
    assert.match(workflow, /VEM_FACTORY_EXECUTED_BUILDER_IMAGE/);
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_UDF_EXTRACTOR_VERSION/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_UDF_WRITER_VERSION/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_DIGEST/);
    assert.match(workflow, /VEM_FACTORY_WIMLIB_VERSION/);
    assert.match(workflow, /VEM_FACTORY_AUTHENTICODE_VERIFIER_CONTAINER_PATH/);
    assert.match(workflow, /VEM_FACTORY_AUTHENTICODE_CA_BUNDLE/);
    assert.match(workflow, /docker run --name "\$FACTORY_CONTAINER_NAME"/);
    assert.match(workflow, /--network none --read-only/);
    assert.match(workflow, /--vision-release-delivery-unit/);
    assert.match(workflow, /--repository-vision-trusted-roots/);
    assert.match(workflow, /--factory-vision-trusted-roots/);
    assert.match(workflow, /--vision-evidence-verifier/);
    assert.match(workflow, /--wimlib/);
    assert.match(workflow, /--udf-extractor/);
    assert.match(workflow, /--udf-writer/);
    assert.match(workflow, /sanitize-build-evidence\.mjs/);
    const uploadStart = workflow.indexOf(
      "- name: Upload Sanitized Factory Evidence Only",
    );
    const upload = workflow.slice(
      uploadStart,
      workflow.indexOf("- name: Remove Ephemeral", uploadStart),
    );
    assert.match(upload, /factory-provenance\.json/);
    assert.match(upload, /factory-build-result\.json/);
    assert.doesNotMatch(upload, /\.iso|windows-source|cache/i);
  });

  it("accepts only strict Factory Manifest SemVer forms for pinned tools", () => {
    const parsed = parse(read(workflowPath));
    const guard = parsed.jobs.build.steps[0].run;
    const pattern = guard.match(/^\s*factory_tool_semver='([^']+)'$/m)?.[1];
    assert.ok(pattern, "Factory runner guard defines the tool SemVer pattern");
    assert.match(guard, /\[\[ "\$version" =~ \$factory_tool_semver \]\]/);
    for (const version of [
      "0.0.0",
      "1.14.4-1.1build2",
      "1.2.3-alpha.1+build.7",
      "1.2.3+build.7",
    ]) {
      assert.equal(matchesWorkflowSemver(pattern, version), true, version);
    }
    for (const version of [
      "1.2",
      "01.2.3",
      "1.2.3-01",
      "1.2.3+build..7",
      "1.2.3-",
      "not-a-version",
    ]) {
      assert.equal(matchesWorkflowSemver(pattern, version), false, version);
    }
  });

  it("uses a validated Docker reference while preserving the OCI builder identity", () => {
    const parsed = parse(read(workflowPath));
    const prepareStep = workflowStep(
      parsed,
      "Prepare Factory Disk Scratch and Recover Container State",
    );
    const buildStep = workflowStep(
      parsed,
      "Build Through Manifest-Pinned Offline Toolchain",
    );
    const prepare = prepareStep.run;
    const build = buildStep.run;
    assert.match(
      prepare,
      /\[\[ "\$factory_docker_builder_image" =~ \^\[a-z0-9\]/,
    );
    assert.match(
      prepare,
      /factory_docker_builder_image="\$\{VEM_FACTORY_BUILDER_IMAGE#oci:\/\/\}"/,
    );
    assert.match(
      prepare,
      /\[\[ "\$factory_docker_builder_image" != "\$VEM_FACTORY_BUILDER_IMAGE" \]\]/,
    );
    assert.match(prepare, /docker pull "\$factory_docker_builder_image"/);
    assert.match(
      build,
      /--env "VEM_FACTORY_EXECUTED_BUILDER_IMAGE=\$VEM_FACTORY_BUILDER_IMAGE"/,
    );
    assert.match(
      build,
      /--mount "type=bind,src=\$GITHUB_WORKSPACE,dst=\/workspace\/repo,readonly"/,
    );
    assert.match(
      build,
      /"\$FACTORY_DOCKER_BUILDER_IMAGE" \\\n\s+node \/workspace\/repo\/scripts\/factory\/factory-cli\.mjs/,
    );
    assert.doesNotMatch(build, /pnpm(?:\s+install)?/);
    assert.doesNotMatch(prepare, /docker pull "\$VEM_FACTORY_BUILDER_IMAGE"/);
  });

  it("uses guarded disk scratch, resource-capped container lifecycle, and non-root cleanup", async () => {
    const parsed = parse(read(workflowPath));
    const prepare = workflowStep(
      parsed,
      "Prepare Factory Disk Scratch and Recover Container State",
    ).run;
    const cleanupStep = workflowStep(
      parsed,
      "Remove Run-Isolated Factory Work Scratch",
    );
    const buildScript = workflowStep(
      parsed,
      "Build Through Manifest-Pinned Offline Toolchain",
    ).run;
    const fixture = await factoryScratchFixture();
    const { root } = fixture;
    try {
      assert.equal((await lstat(root)).uid, fixture.runnerUid);
      assert.equal((await lstat(root)).mode & 0o777, 0o700);
      const staleDirectory = join(
        root,
        "vem-factory-work-29234872595-1-ABC123",
      );
      await mkdir(staleDirectory, { mode: 0o700 });
      const first = await allocateFactoryWorkDirectory(prepare, fixture, "one");
      assert.equal(
        existsSync(staleDirectory),
        false,
        "startup removes only stale scratch",
      );
      assert.equal(
        (await lstat(first)).uid,
        fixture.runnerUid,
        "scratch is allocated by the runner identity",
      );
      assert.equal((await lstat(first)).mode & 0o777, 0o700);
      assert.equal((await lstat(join(first, "tmp"))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(first, "home"))).mode & 0o777, 0o700);
      assert.equal((await lstat(join(first, "output"))).mode & 0o777, 0o700);

      const second = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "two",
      );
      assert.notEqual(first, second, "each allocation has a unique suffix");
      assert.equal(
        existsSync(first),
        false,
        "startup clears a previous matching scratch",
      );

      const otherPath = join(root, "unrelated-directory");
      await mkdir(otherPath, { mode: 0o700 });
      const [shell, ...shellArguments] = shellAsRunner();
      execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
        env: {
          ...process.env,
          FACTORY_CONTAINER_NAME: "",
          FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
          FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          FACTORY_WORK_DIRECTORY: second,
          GITHUB_RUN_ID: "29234872596",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_NAME: "fixture-factory-runner",
          PATH: `${fixture.statDirectory}:${process.env.PATH}`,
          VEM_FACTORY_WORK_ROOT: root,
        },
        stdio: "ignore",
      });
      assert.equal(
        existsSync(second),
        false,
        "runner identity can remove its scratch",
      );
      assert.equal(
        existsSync(otherPath),
        true,
        "cleanup cannot remove another path",
      );
      assert.equal(
        existsSync(root),
        true,
        "cleanup cannot remove the configured root",
      );

      const dynamicInodeWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "btrfs",
        {
          FACTORY_TEST_AVAILABLE_INODES: "0",
          FACTORY_TEST_FILESYSTEM_TYPE: "btrfs",
        },
      );
      assert.equal(
        existsSync(dynamicInodeWork),
        true,
        "btrfs dynamic inode accounting relies on the byte admission gate",
      );
      execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
        env: {
          ...process.env,
          FACTORY_CONTAINER_NAME: "",
          FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
          FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          FACTORY_WORK_DIRECTORY: dynamicInodeWork,
          GITHUB_RUN_ID: "29234872596",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_NAME: "fixture-factory-runner",
          PATH: `${fixture.statDirectory}:${process.env.PATH}`,
          VEM_FACTORY_WORK_ROOT: root,
        },
        stdio: "ignore",
      });

      const upperBoundaryWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "upper-boundary",
        {
          FACTORY_TEST_AVAILABLE_BLOCKS: "2251799813685248",
          FACTORY_TEST_SOURCE_BYTES: "922337203685477580",
        },
      );
      assert.equal(existsSync(upperBoundaryWork), true);
      execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
        env: {
          ...process.env,
          FACTORY_CONTAINER_NAME: "",
          FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
          FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          FACTORY_WORK_DIRECTORY: upperBoundaryWork,
          GITHUB_RUN_ID: "29234872596",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_NAME: "fixture-factory-runner",
          PATH: `${fixture.statDirectory}:${process.env.PATH}`,
          VEM_FACTORY_WORK_ROOT: root,
        },
        stdio: "ignore",
      });

      execFileSync(
        shell,
        [...shellArguments, "-c", 'rm -f -- "$FACTORY_TEST_DOCKER_STATE"/*'],
        {
          env: {
            ...process.env,
            FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          },
          stdio: "ignore",
        },
      );
      await writeFile(fixture.dockerLog, "");
      const dockerWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "container",
        {
          FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
          VEM_FACTORY_BUILDER_IMAGE: `oci://registry.example/factory@sha256:${"c".repeat(64)}`,
        },
      );
      const containerId = "d".repeat(64);
      await writeFile(join(dockerWork, "factory-container.cid"), containerId);
      await chmod(join(dockerWork, "factory-container.cid"), 0o644);
      execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
        env: {
          ...process.env,
          FACTORY_CONTAINER_NAME: "vem-factory-build-29234872596-1",
          FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
          FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          FACTORY_WORK_DIRECTORY: dockerWork,
          GITHUB_RUN_ID: "29234872596",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_NAME: "fixture-factory-runner",
          PATH: `${fixture.statDirectory}:${process.env.PATH}`,
          VEM_FACTORY_WORK_ROOT: root,
        },
        stdio: "ignore",
      });
      assert.equal(existsSync(dockerWork), false);
      const dockerLog = readFileSync(fixture.dockerLog, "utf8");
      assert.match(dockerLog, /rm -f labeled-container/);
      assert.match(dockerLog, /pull registry\.example\/factory@sha256:/);
      assert.match(dockerLog, /rm -f a{64}/);
      assert.match(dockerLog, new RegExp(`rm -f ${containerId}`));
      assert.match(dockerLog, /rm -f vem-factory-build-29234872596-1/);

      execFileSync(
        shell,
        [...shellArguments, "-c", 'rm -f -- "$FACTORY_TEST_DOCKER_STATE"/*'],
        {
          env: {
            ...process.env,
            FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          },
          stdio: "ignore",
        },
      );
      const failedCleanupWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "remove-failure",
      );
      const failedContainerId = "e".repeat(64);
      await writeFile(
        join(failedCleanupWork, "factory-container.cid"),
        failedContainerId,
      );
      await chmod(join(failedCleanupWork, "factory-container.cid"), 0o644);
      assert.throws(() =>
        execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
          env: {
            ...process.env,
            FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
            FACTORY_TEST_DOCKER_RM_FAIL_CANDIDATE: failedContainerId,
            FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
            FACTORY_WORK_DIRECTORY: failedCleanupWork,
            GITHUB_RUN_ID: "29234872596",
            GITHUB_RUN_ATTEMPT: "1",
            RUNNER_NAME: "fixture-factory-runner",
            PATH: `${fixture.statDirectory}:${process.env.PATH}`,
            VEM_FACTORY_WORK_ROOT: root,
          },
          stdio: "ignore",
        }),
      );
      assert.equal(
        existsSync(failedCleanupWork),
        true,
        "scratch remains when its verified container cannot be removed",
      );

      execFileSync(
        shell,
        [...shellArguments, "-c", 'rm -f -- "$FACTORY_TEST_DOCKER_STATE"/*'],
        {
          env: {
            ...process.env,
            FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
          },
          stdio: "ignore",
        },
      );
      const unavailableCleanupWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "daemon-failure",
      );
      const unavailableContainerId = "f".repeat(64);
      await writeFile(
        join(unavailableCleanupWork, "factory-container.cid"),
        unavailableContainerId,
      );
      await chmod(join(unavailableCleanupWork, "factory-container.cid"), 0o644);
      assert.throws(() =>
        execFileSync(shell, [...shellArguments, "-c", cleanupStep.run], {
          env: {
            ...process.env,
            FACTORY_TEST_DOCKER_INSPECT_FAIL_CANDIDATE: unavailableContainerId,
            FACTORY_TEST_DOCKER_LIST_FAIL: "1",
            FACTORY_TEST_DOCKER_LOG: fixture.dockerLog,
            FACTORY_TEST_DOCKER_STATE: fixture.dockerState,
            FACTORY_WORK_DIRECTORY: unavailableCleanupWork,
            GITHUB_RUN_ID: "29234872596",
            GITHUB_RUN_ATTEMPT: "1",
            RUNNER_NAME: "fixture-factory-runner",
            PATH: `${fixture.statDirectory}:${process.env.PATH}`,
            VEM_FACTORY_WORK_ROOT: root,
          },
          stdio: "ignore",
        }),
      );
      assert.equal(
        existsSync(unavailableCleanupWork),
        true,
        "scratch remains when Docker cannot confirm a failed inspect is absent",
      );

      const staleOnDockerFailure = join(
        root,
        "vem-factory-work-29234872594-1-ABC123",
      );
      await mkdir(staleOnDockerFailure, { mode: 0o700 });
      await assert.rejects(
        allocateFactoryWorkDirectory(
          prepare,
          fixture,
          "prepare-daemon-failure",
          {
            FACTORY_TEST_DOCKER_INSPECT_FAIL_CANDIDATE: "a".repeat(64),
            FACTORY_TEST_DOCKER_LIST_FAIL: "1",
          },
        ),
      );
      assert.equal(
        existsSync(staleOnDockerFailure),
        true,
        "prepare does not remove stale scratch when Docker cannot inspect an orphan",
      );

      const separateSameDeviceWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "separate-same-device-paths",
        {
          FACTORY_TEST_DOCKER_MOUNT_DEVICE: "8:20",
          FACTORY_TEST_DOCKER_MOUNT_FSROOT: "/var/lib/docker",
          FACTORY_TEST_DOCKER_MOUNT_SOURCE: "/dev/rootfs",
          FACTORY_TEST_DOCKER_MOUNT_TARGET: fixture.dockerRoot,
          FACTORY_TEST_WORK_MOUNT_DEVICE: "8:20",
          FACTORY_TEST_WORK_MOUNT_FSROOT: "/srv",
          FACTORY_TEST_WORK_MOUNT_SOURCE: "/dev/rootfs",
          FACTORY_TEST_WORK_MOUNT_TARGET: root,
        },
      );
      assert.equal(
        existsSync(separateSameDeviceWork),
        true,
        "same-device /srv and /var/lib/docker effective paths are separate",
      );

      const differentDeviceWork = await allocateFactoryWorkDirectory(
        prepare,
        fixture,
        "different-docker-device",
        {
          FACTORY_TEST_DOCKER_MOUNT_DEVICE: "0:47",
          FACTORY_TEST_DOCKER_MOUNT_FSROOT: "/",
          FACTORY_TEST_DOCKER_MOUNT_SOURCE: "/dev/docker",
          FACTORY_TEST_DOCKER_MOUNT_TARGET: fixture.dockerRoot,
          FACTORY_TEST_WORK_MOUNT_DEVICE: "0:45",
          FACTORY_TEST_WORK_MOUNT_FSROOT: "/",
          FACTORY_TEST_WORK_MOUNT_SOURCE: "/dev/factory-work",
        },
      );
      assert.equal(
        existsSync(differentDeviceWork),
        true,
        "distinct devices with FSROOT=/ are allowed",
      );

      for (const overrides of [
        { FACTORY_TEST_FILESYSTEM_TYPE: "tmpfs" },
        { FACTORY_TEST_FILESYSTEM_TYPE: "overlay" },
        { FACTORY_TEST_FILESYSTEM_TYPE: "overlayfs" },
        { FACTORY_TEST_FILESYSTEM_TYPE: "fuse.overlayfs" },
        { FACTORY_TEST_FILESYSTEM_TYPE: "unknown" },
        { FACTORY_TEST_FINDMNT_FAIL: "1" },
        { FACTORY_TEST_DOCKER_INFO_FAIL: "1" },
        { FACTORY_TEST_DOCKER_ROOT: root },
        {
          FACTORY_TEST_DOCKER_MOUNT_DEVICE: "8:16",
          FACTORY_TEST_DOCKER_MOUNT_FSROOT: "/var/lib/docker",
          FACTORY_TEST_DOCKER_MOUNT_SOURCE: "/dev/docker-data[/subvolume]",
          FACTORY_TEST_DOCKER_MOUNT_TARGET: fixture.dockerRoot,
          FACTORY_TEST_WORK_MOUNT_DEVICE: "8:16",
          FACTORY_TEST_WORK_MOUNT_FSROOT: "/var/lib/docker/sub",
          FACTORY_TEST_WORK_MOUNT_SOURCE:
            "/dev/docker-data[/subvolume/factory]",
        },
        {
          FACTORY_TEST_DOCKER_MOUNT_DEVICE: "8:18",
          FACTORY_TEST_DOCKER_MOUNT_FSROOT: "/",
          FACTORY_TEST_DOCKER_MOUNT_SOURCE: "/dev/docker-alias",
          FACTORY_TEST_DOCKER_MOUNT_TARGET: fixture.dockerRoot,
          FACTORY_TEST_WORK_MOUNT_DEVICE: "8:18",
          FACTORY_TEST_WORK_MOUNT_FSROOT: "/factory-bind",
          FACTORY_TEST_WORK_MOUNT_SOURCE: "/dev/docker-alias[/factory]",
        },
        { FACTORY_TEST_AVAILABLE_BLOCKS: "1" },
        {
          FACTORY_TEST_AVAILABLE_INODES: "1",
          FACTORY_TEST_FILESYSTEM_TYPE: "ext2/ext3",
        },
        {
          FACTORY_TEST_AVAILABLE_BLOCKS: "21000000",
          FACTORY_TEST_SOURCE_BYTES: "10000000000",
        },
      ]) {
        await assert.rejects(
          allocateFactoryWorkDirectory(prepare, fixture, "rejected", overrides),
        );
      }

      await chmod(root, 0o750);
      try {
        await assert.rejects(
          allocateFactoryWorkDirectory(prepare, fixture, "wrong-mode"),
        );
      } finally {
        await chmod(root, 0o700);
      }
      if (process.getuid() === 0) {
        const wrongOwnerRoot = await mkdtemp(
          join(tmpdir(), "vem-factory-wrong-owner-"),
        );
        try {
          await chmod(wrongOwnerRoot, 0o700);
          await assert.rejects(
            allocateFactoryWorkDirectory(prepare, fixture, "wrong-owner", {
              VEM_FACTORY_WORK_ROOT: wrongOwnerRoot,
            }),
          );
        } finally {
          await rm(wrongOwnerRoot, { recursive: true, force: true });
        }
      }

      const symlinkRoot = join(root, "linked-work-root");
      await symlink(root, symlinkRoot);
      try {
        await assert.rejects(
          allocateFactoryWorkDirectory(prepare, fixture, "symlink", {
            VEM_FACTORY_WORK_ROOT: symlinkRoot,
          }),
        );
      } finally {
        await rm(symlinkRoot, { force: true });
      }
      for (const invalidRoot of ["/", "relative-work-root"]) {
        await assert.rejects(
          allocateFactoryWorkDirectory(prepare, fixture, "invalid", {
            VEM_FACTORY_WORK_ROOT: invalidRoot,
          }),
        );
      }

      assert.match(prepare, /findmnt --json --target "\$factory_mount_path"/);
      assert.match(prepare, /TARGET,SOURCE,FSTYPE,FSROOT,MAJ:MIN/);
      assert.match(prepare, /ext2\/ext3\|ext2\|ext3\|ext4\|xfs\|btrfs\|zfs/);
      assert.match(prepare, /\*overlay\*\|fuse\.overlayfs/);
      assert.match(prepare, /docker info --format '\{\{json \.\}\}'/);
      assert.match(prepare, /DockerRootDir/);
      assert.match(prepare, /must not be inside Docker data-root/);
      assert.match(prepare, /factory_docker_mount_target/);
      assert.match(prepare, /factory_mount_effective_path/);
      assert.match(
        prepare,
        /Factory work root falls within Docker data-root on the same device/,
      );
      assert.match(prepare, /windowsMedia/);
      assert.match(prepare, /VEM_FACTORY_WINDOWS_SOURCE_STORE\/sha256/);
      assert.match(prepare, /120 \* 1024 \* 1024 \* 1024/);
      assert.match(prepare, /windows_source_bytes \* 10/);
      assert.match(prepare, /factory_available_inodes >= 100000/);
      assert.match(prepare, /ext2\/ext3\|ext2\|ext3\|ext4/);
      assert.match(prepare, /btrfs\|xfs\|zfs\) ;;/);
      assert.match(
        prepare,
        /factory_required_blocks=\$\(\(factory_required_bytes \/ factory_block_size\)\)/,
      );
      assert.match(prepare, /factory_required_bytes % factory_block_size != 0/);
      assert.doesNotMatch(prepare, /\+ factory_block_size - 1/);
      assert.match(prepare, /stat -c %u -- "\$factory_work_root"/);
      assert.match(prepare, /8#\$factory_work_root_mode & 0077/);
      assert.match(
        prepare,
        /docker ps -aq[\s\S]*io\.vem\.factory\.runner=\$RUNNER_NAME/,
      );
      assert.ok(
        prepare.indexOf("factory_labeled_containers") <
          prepare.indexOf("while IFS= read -r -d '' factory_stale_name"),
        "labeled Factory containers are removed before any scratch deletion",
      );
      assert.ok(
        prepare.indexOf("for factory_orphan_container") <
          prepare.indexOf("while IFS= read -r -d '' factory_stale_name"),
        "strict legacy-orphan cleanup precedes any scratch deletion",
      );
      assert.match(prepare, /factory_orphan_container/);
      assert.match(prepare, /container\?\.Path === "node"/);
      assert.match(prepare, /factory-cli\.mjs/);
      assert.match(cleanupStep.run, /docker rm -f/);
      assert.match(
        cleanupStep.run,
        /Factory container removal or absence confirmation failed/,
      );
      assert.match(cleanupStep.run, /docker ps -aq --no-trunc --filter/);
      assert.match(
        cleanupStep.run,
        /name=\^\/\$\{factory_container_candidate\}\$/,
      );
      assert.doesNotMatch(cleanupStep.run, /docker rm -f[^\n]*\|\| true/);
      assert.match(cleanupStep.run, /factory_expected_container_name=/);
      assert.match(cleanupStep.run, /labels\?\.\["io\.vem\.factory\.role"\]/);
      assert.match(cleanupStep.run, /io\.vem\.factory\.runner/);
      assert.match(cleanupStep.run, /io\.vem\.factory\.run/);
      assert.ok(
        cleanupStep.run.indexOf("docker rm -f") <
          cleanupStep.run.indexOf("rm -rf"),
        "container removal precedes scratch removal",
      );

      assert.match(buildScript, /--name "\$FACTORY_CONTAINER_NAME"/);
      assert.match(
        prepare,
        /FACTORY_CONTAINER_NAME=%s\\n' "\$factory_container_name"/,
      );
      assert.match(
        prepare,
        /factory_container_name="vem-factory-build-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}"/,
      );
      assert.match(
        buildScript,
        /--cidfile "\$FACTORY_WORK_DIRECTORY\/factory-container\.cid"/,
      );
      assert.match(buildScript, /--label "io\.vem\.factory\.role=build"/);
      assert.match(buildScript, /--user "\$\(id -u\):\$\(id -g\)"/);
      assert.match(
        buildScript,
        /--memory 16g --memory-swap 16g --pids-limit 512 --cpus 4/,
      );
      assert.doesNotMatch(buildScript, /--cpus (?:[5-9]|[1-9][0-9]+)/);
      assert.match(buildScript, /--tmpfs \/tmp:rw,nosuid,nodev,size=512m/);
      assert.match(buildScript, /--log-driver=none/);
      assert.match(
        buildScript,
        /factory_build_log="\$FACTORY_WORK_DIRECTORY\/factory-build\.log"/,
      );
      assert.match(buildScript, /tail -c 65536 "\$factory_build_log"/);
      assert.doesNotMatch(buildScript, /--tmpfs \/tmp\s+\\/);
      assert.match(buildScript, /--env TMPDIR=\/factory-work\/tmp/);
      assert.match(buildScript, /--env HOME=\/factory-work\/home/);
      assert.match(
        buildScript,
        /--mount "type=bind,src=\$FACTORY_WORK_DIRECTORY,dst=\/factory-work"/,
      );
      assert.match(
        buildScript,
        /--mount "type=bind,src=\$FACTORY_OUTPUT_DIRECTORY,dst=\/factory-output"/,
      );
      assert.doesNotMatch(buildScript, /RUNNER_TEMP\/vem-factory-output/);
      assert.match(
        prepare,
        /FACTORY_OUTPUT_DIRECTORY=%s\\n' "\$factory_work_directory\/output"/,
      );
      assert.doesNotMatch(
        read(workflowPath),
        /RUNNER_TEMP\/vem-factory-output/,
      );
      const mediaBuilder = read("scripts/factory/build-factory-media.mjs");
      assert.match(mediaBuilder, /const buildCount = reproducibility \? 2 : 1/);
      assert.match(
        mediaBuilder,
        /join\(tmpdir\(\), `vem-factory-build-\$\{index \+ 1\}-`\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "does not remove a real Docker name collision without current Factory labels",
    { skip: skipHostDockerLifecycle === "1" },
    async () => {
      const parsed = parse(read(workflowPath));
      const cleanup = workflowStep(
        parsed,
        "Remove Run-Isolated Factory Work Scratch",
      ).run;
      const root = await mkdtemp(join(tmpdir(), "vem-factory-cleanup-root-"));
      const collisionToken = randomUUID().replaceAll("-", "");
      const runId = `collision-${collisionToken}`;
      const attempt = "1";
      const runnerName = "factory-cleanup-collision";
      const containerName = `vem-factory-build-${runId}-${attempt}`;
      const fixtureLabel = `factory-cleanup-${collisionToken}`;
      const workDirectory = join(
        root,
        `vem-factory-work-${runId}-${attempt}-ABC123`,
      );
      let containerId;
      let imageId;
      try {
        await chmod(root, 0o700);
        await mkdir(workDirectory, { mode: 0o700 });
        await writeFile(
          join(root, "Dockerfile"),
          `FROM scratch\nLABEL io.vem.factory.test=${fixtureLabel}\n`,
        );
        imageId = execFileSync("docker", ["build", "--quiet", root], {
          encoding: "utf8",
        }).trim();
        containerId = execFileSync(
          "docker",
          [
            "create",
            "--name",
            containerName,
            "--label",
            "io.vem.factory.role=not-build",
            "--label",
            `io.vem.factory.runner=${runnerName}`,
            "--label",
            `io.vem.factory.run=${runId}-${attempt}`,
            "--label",
            `io.vem.factory.test=${fixtureLabel}`,
            imageId,
            "/not-found",
          ],
          { encoding: "utf8" },
        ).trim();
        const [created] = JSON.parse(
          execFileSync("docker", ["inspect", containerId], {
            encoding: "utf8",
          }),
        );
        assert.equal(created.Id, containerId);
        assert.equal(
          created.Config.Labels["io.vem.factory.test"],
          fixtureLabel,
        );
        execFileSync("bash", ["-c", cleanup], {
          env: {
            ...process.env,
            FACTORY_WORK_DIRECTORY: workDirectory,
            GITHUB_RUN_ID: runId,
            GITHUB_RUN_ATTEMPT: attempt,
            RUNNER_NAME: runnerName,
            VEM_FACTORY_WORK_ROOT: root,
          },
          stdio: "ignore",
        });
        execFileSync("docker", ["inspect", containerName], { stdio: "ignore" });
        assert.equal(existsSync(workDirectory), false);
      } finally {
        if (containerId) {
          try {
            const [container] = JSON.parse(
              execFileSync("docker", ["inspect", containerId], {
                encoding: "utf8",
              }),
            );
            if (
              container.Id === containerId &&
              container.Config.Labels["io.vem.factory.test"] === fixtureLabel
            ) {
              execFileSync("docker", ["rm", "-f", containerId], {
                stdio: "ignore",
              });
            }
          } catch {}
        }
        if (imageId) {
          try {
            const [image] = JSON.parse(
              execFileSync("docker", ["image", "inspect", imageId], {
                encoding: "utf8",
              }),
            );
            if (
              image.Id === imageId &&
              image.Config.Labels["io.vem.factory.test"] === fixtureLabel
            ) {
              execFileSync("docker", ["image", "rm", imageId], {
                stdio: "ignore",
              });
            }
          } catch {}
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("consumes host-published Factory Manifest and CAS inputs without a runtime artifact handoff", () => {
    const workflow = read(workflowPath);
    const parsed = parse(workflow);
    assert.equal(parsed.jobs["build-runtime-artifacts"], undefined);
    assert.equal(parsed.jobs.build.needs, "trust-gate");
    assert.deepEqual(parsed.jobs.build.env, {
      VEM_FACTORY_WORK_ROOT: "${{ vars.VEM_FACTORY_WORK_ROOT }}",
      VEM_FACTORY_PERSONALIZATION_MEDIA_PATH: "",
    });
    assert.doesNotMatch(
      workflow,
      /build-windows-runtime-artifacts|build-runtime-artifacts|RUNTIME_ARTIFACT|vem-runtime-artifacts|import-runtime-artifacts|actions\/download-artifact/,
    );
  });

  it("runs Factory media tests in the tracked builder image", () => {
    const workflow = read(ciWorkflowPath);
    const parsed = parse(workflow);
    const staticJob = parsed.jobs.static;
    assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
    assert.match(
      workflow,
      /docker build\s+\\\n\s+--file scripts\/factory\/Dockerfile/,
    );
    assert.match(workflow, /Run Factory Media Contract Tests In Builder/);
    assert.match(workflow, /docker run --rm/);
    assert.match(workflow, /--env HOME=\/tmp/);
    assert.match(workflow, /--user "\$\(id -u\):\$\(id -g\)"/);
    assert.match(
      workflow,
      /VEM_FACTORY_TEST_UDF_WRITER=\/usr\/bin\/genisoimage/,
    );
    assert.match(workflow, /sha256sum \/usr\/bin\/genisoimage/);
    const installStep = staticJob.steps.find(
      ({ name }) => name === "Install Dependencies",
    );
    const hostDockerStep = staticJob.steps.find(
      ({ name }) => name === "Run Factory Host Docker Lifecycle Contract",
    );
    const builderStep = staticJob.steps.find(
      ({ name }) => name === "Run Factory Media Contract Tests In Builder",
    );
    assert.ok(hostDockerStep, "Static job runs the real Docker lifecycle test");
    assert.match(
      hostDockerStep.run,
      /node --test --test-name-pattern[\s\S]*does not remove a real Docker name collision without current Factory labels[\s\S]*scripts\/check-factory-manifest\.test\.mjs/,
    );
    assert.doesNotMatch(
      hostDockerStep.run,
      /VEM_FACTORY_TEST_SKIP_HOST_DOCKER_LIFECYCLE/,
    );
    assert.ok(
      staticJob.steps.indexOf(installStep) <
        staticJob.steps.indexOf(hostDockerStep) &&
        staticJob.steps.indexOf(hostDockerStep) <
          staticJob.steps.indexOf(builderStep),
      "host Docker lifecycle coverage runs after dependencies and before Builder tests",
    );
    assert.match(
      builderStep.run,
      /--env VEM_FACTORY_TEST_SKIP_HOST_DOCKER_LIFECYCLE=1/,
    );
    assert.doesNotMatch(
      builderStep.run,
      /\/var\/run\/docker\.sock|docker\.sock/,
    );
    const manifestContract = read("scripts/check-factory-manifest.test.mjs");
    assert.match(manifestContract, /skip: skipHostDockerLifecycle === "1"/);
    assert.match(
      read("scripts/factory/build-factory-media.test.mjs"),
      /fixture genisoimage digest must match the pinned contract/,
    );
    assert.doesNotMatch(workflow, /Install Factory Media Fixture Tools/);
    assert.doesNotMatch(workflow, /apt-cache policy genisoimage/);
    assert.doesNotMatch(
      workflow,
      /VEM_FACTORY_TEST_UDF_WRITER_DIGEST: sha256:/,
    );
    assert.match(
      read("scripts/factory/build-factory-media.test.mjs"),
      /skip: !process\.env\.VEM_FACTORY_REAL_WINDOWS_ISO/,
    );
    assert.doesNotMatch(
      read("scripts/factory/factory-builder-definition.test.mjs"),
      /skip:/,
    );
    assert.doesNotMatch(
      read("scripts/factory/build-factory-media.test.mjs"),
      /spawnSync\(\s*["']pwsh["']|execFileSync\(\s*["']pwsh["']/,
    );
    const runtimeDependencyStep = workflow.slice(
      workflow.indexOf(
        "- name: Load Factory Manifest Runtime Dependency Without Host node_modules",
      ),
      workflow.indexOf("- name: Run Factory Media Contract Tests In Builder"),
    );
    assert.match(
      runtimeDependencyStep,
      /docker run --rm --network none --read-only --tmpfs \/tmp/,
    );
    assert.match(
      runtimeDependencyStep,
      /src="\$GITHUB_WORKSPACE\/scripts",dst=\/workspace\/repo\/scripts,readonly/,
    );
    assert.match(
      runtimeDependencyStep,
      /src="\$GITHUB_WORKSPACE\/public",dst=\/workspace\/repo\/public,readonly/,
    );
    assert.match(
      runtimeDependencyStep,
      /node --input-type=module --eval 'import\("\/workspace\/repo\/scripts\/factory\/factory-manifest\.mjs"\)'/,
    );
  });

  it("requires non-optional Factory personalization behavior on the Windows PowerShell job", () => {
    const workflow = read(ciWorkflowPath);
    const parsed = parse(workflow);
    const windowsJob = parsed.jobs["windows-vision-release-installer"];
    assert.equal(windowsJob["runs-on"], "windows-2022");
    assert.equal(windowsJob.defaults.run.shell, "pwsh");
    const nodeSetupStep = windowsJob.steps.find(
      ({ uses }) => uses === "actions/setup-node@v6",
    );
    assert.ok(nodeSetupStep, "Windows PowerShell job must set up Node.js");
    assert.equal(nodeSetupStep.with.cache, "pnpm");
    const installStep = windowsJob.steps.find(
      ({ name }) => name === "Install Dependencies",
    );
    assert.equal(installStep.run, "pnpm install --frozen-lockfile");
    const behaviorStep = windowsJob.steps.find(
      ({ name }) => name === "Run Factory personalization behavior checks",
    );
    assert.ok(behaviorStep, "Windows PowerShell job must run factory behavior");
    assert.ok(
      windowsJob.steps.indexOf(installStep) <
        windowsJob.steps.indexOf(behaviorStep),
      "Windows job must install workspace dependencies before factory behavior",
    );
    assert.match(
      behaviorStep.run,
      /node --test scripts\/check-windows-factory-maintenance\.test\.mjs/,
    );
    assert.doesNotMatch(behaviorStep.run, /\bskip\b/i);
    const staticJob = parsed.jobs.static;
    assert.equal(
      staticJob.steps.some(
        ({ name }) =>
          name ===
          "Require Host PowerShell For Factory Personalization Behavior",
      ),
      false,
    );
  });

  it("binds reusable runtime outputs and exact build toolchain into artifact identity", () => {
    const workflow = read(runtimeWorkflowPath);
    const parsed = parse(workflow);
    assert.deepEqual(Object.keys(parsed.on.workflow_call.outputs).sort(), [
      "artifact_identity",
      "artifact_name",
      "commit",
      "workflow_run_identity",
    ]);
    assert.equal(parsed.jobs.build["runs-on"], "windows-2022");
    assert.match(workflow, /node-version:\s*24\.16\.0/);
    assert.match(workflow, /toolchain:\s*1\.96\.0/);
    const rustInstallStep = workflowStep(parsed, "Install Rust");
    assert.equal(rustInstallStep.with.components, "llvm-tools-preview");
    const cargoCacheStep = workflowStep(parsed, "Restore Cargo cache");
    assert.match(
      cargoCacheStep.with.key,
      /hashFiles\('Cargo\.lock', '\.github\/workflows\/build-windows-runtime-artifacts\.yml'\)/,
    );
    const daemonBuildStep = workflowStep(parsed, "Build Vending Daemon");
    assert.equal(
      daemonBuildStep.env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS,
      "-Ctarget-feature=+crt-static",
    );
    assert.equal(
      parsed.jobs.build.env?.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS,
      undefined,
    );
    assert.deepEqual(
      parsed.jobs.build.steps
        .filter((step) =>
          Object.hasOwn(
            step.env ?? {},
            "CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS",
          ),
        )
        .map((step) => step.name),
      ["Build Vending Daemon"],
    );
    const importGateStep = workflowStep(
      parsed,
      "Verify Vending Daemon Static CRT Imports",
    );
    assert.match(importGateStep.run, /rustc --print sysroot/);
    assert.match(importGateStep.run, /llvm-readobj\.exe/);
    assert.match(importGateStep.run, /--coff-imports/);
    assert.match(
      importGateStep.run,
      /throw "llvm-readobj\.exe failed to inspect \$\{daemonExe\}: \$coffImports"/,
    );
    assert.match(importGateStep.run, /\$\{daemonExe\}:/);
    const dynamicCrtImportPattern = String.raw`(?im)^\s*Name:\s*(?:(?:VCRUNTIME|MSVCR|MSVCP|CONCRT)\d+[A-Z0-9_]*|ucrtbase|ucrtbased|api-ms-win-crt-[A-Z0-9-]+)\.dll\s*$`;
    assert.ok(
      importGateStep.run.includes(
        `$coffImports -match '${dynamicCrtImportPattern}'`,
      ),
      "static CRT import gate must use the exact dynamic CRT denylist",
    );
    const dynamicCrtImportRegex = new RegExp(
      dynamicCrtImportPattern.slice("(?im)".length),
      "im",
    );
    for (const dll of [
      "MSVCR100.dll",
      "MSVCR120.dll",
      "vcruntime140_1.DLL",
      "MSVCP999.dll",
      "msvcp140_ATOMIC_WAIT.dll",
      "CONCRT120.dll",
      "concrt140d.DLL",
      "ucrtbase.dll",
      "ucrtbased.dll",
      "API-MS-WIN-CRT-RUNTIME-L1-1-0.DLL",
    ]) {
      assert.match(`  Name: ${dll}`, dynamicCrtImportRegex);
    }
    for (const dll of [
      "KERNEL32.dll",
      "USER32.dll",
      "api-ms-win-core-file-l1-1-0.dll",
      "MYVCRUNTIME140.dll",
      "VCRUNTIME.dll",
      "VCRUNTIME140.dll.backup",
    ]) {
      assert.doesNotMatch(`  Name: ${dll}`, dynamicCrtImportRegex);
    }
    const stageStep = workflowStep(parsed, "Stage Runtime Artifacts");
    assert.match(stageStep.run, /runtime-artifact-descriptor\.mjs/);
    assert.ok(
      parsed.jobs.build.steps.indexOf(daemonBuildStep) <
        parsed.jobs.build.steps.indexOf(importGateStep) &&
        parsed.jobs.build.steps.indexOf(importGateStep) <
          parsed.jobs.build.steps.indexOf(stageStep),
      "static CRT import gate must run after the daemon build and before descriptor generation",
    );
    assert.match(workflow, /pnpm exec tauri build/);
    assert.doesNotMatch(workflow, /pnpm dlx|@tauri-apps\/cli@\^/);
    assert.match(workflow, /runtime-artifact-descriptor\.mjs/);
    assert.match(workflow, /runnerImageVersion/);
    assert.match(workflow, /workflow_run_identity=/);
    assert.doesNotMatch(workflow, /Format-Table FullName|RUNNER_NAME/);
    assert.equal(
      JSON.parse(read("apps/machine/package.json")).devDependencies[
        "@tauri-apps/cli"
      ],
      "2.11.4",
    );
  });
});
