#!/usr/bin/env node

import { execFileSync } from "node:child_process";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

export function validateCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? "")) {
    throw new Error(
      "--commit must be exactly a 40-character lowercase commit SHA",
    );
  }
  return value;
}

export function imageNames(registry, commit) {
  const tag = `sha-${validateCommit(commit)}`;
  return ["service-api", "admin-ui"].map(
    (app) => `${registry.replace(/\/+$/, "")}/vem-${app}:${tag}`,
  );
}

export function publish(args = process.argv.slice(2)) {
  const head = run("git", ["rev-parse", "HEAD"]);
  const commit = validateCommit(option(args, "--commit"));
  const checkedOut = run("git", [
    "rev-parse",
    "--verify",
    `${commit}^{commit}`,
  ]);
  if (checkedOut !== head) {
    throw new Error(
      `checked-out HEAD ${head} does not match requested commit ${commit}`,
    );
  }
  if (
    run("git", ["status", "--porcelain", "--untracked-files=normal"]) !== ""
  ) {
    throw new Error(
      "backend images must be published from a clean commit checkout",
    );
  }
  const registry = option(
    args,
    "--registry",
    process.env.IMAGE_REGISTRY ?? "ghcr.io/ykdz",
  );
  const images = imageNames(registry, commit);

  for (const [index, app] of ["service-api", "admin-ui"].entries()) {
    const image = images[index];
    run(
      "docker",
      [
        "buildx",
        "build",
        "--push",
        "--tag",
        image,
        "--file",
        `apps/${app}/Dockerfile`,
        ".",
      ],
      { inherit: true },
    );
  }
  return { commit, images };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(publish(), null, 2)}\n`);
}
