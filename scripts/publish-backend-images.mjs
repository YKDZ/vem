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

const args = process.argv.slice(2);
const head = run("git", ["rev-parse", "HEAD"]);
const requested = option(args, "--commit", process.env.GIT_COMMIT ?? head);
const commit = run("git", ["rev-parse", "--verify", `${requested}^{commit}`]);
if (commit !== head) {
  throw new Error(
    `checked-out HEAD ${head} does not match requested commit ${commit}`,
  );
}
if (run("git", ["status", "--porcelain", "--untracked-files=normal"]) !== "") {
  throw new Error(
    "backend images must be published from a clean commit checkout",
  );
}
const registry = option(
  args,
  "--registry",
  process.env.IMAGE_REGISTRY ?? "ghcr.io/ykdz",
).replace(/\/+$/, "");
const tag = `sha-${commit}`;
const images = [];

for (const app of ["service-api", "admin-ui"]) {
  const image = `${registry}/vem-${app}:${tag}`;
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
  images.push(image);
}

process.stdout.write(`${JSON.stringify({ commit, images }, null, 2)}\n`);
