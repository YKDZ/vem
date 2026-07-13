import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Factory builder definition", () => {
  it("pins its Ubuntu toolchain and copies Node with Corepack from a pinned source", () => {
    const dockerfile = readFileSync("scripts/factory/Dockerfile", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(packageJson.dependencies.ajv, "8.20.0");
    assert.equal(packageJson.devDependencies.ajv, undefined);
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7/m);
    assert.match(
      dockerfile,
      /FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS node-source/,
    );
    assert.match(
      dockerfile,
      /FROM ubuntu:24\.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90 AS toolchain/,
    );
    assert.match(
      dockerfile,
      /COPY --from=node-source \/usr\/local \/usr\/local/,
    );
    assert.match(dockerfile, /--mount=type=cache,target=\/var\/cache\/apt/);
    for (const tool of [
      "genisoimage=9:1.1.11-3.5",
      "7zip=23.01+dfsg-11",
      "xorriso=1:1.5.6-1.1ubuntu3",
      "wimtools=1.14.4-1.1build2",
    ])
      assert.match(dockerfile, new RegExp(tool.replaceAll("+", "\\+")));
    assert.match(dockerfile, /\n\s+openssl \\\n/);
    assert.match(
      dockerfile,
      /FROM node-source AS factory-runtime-dependencies/,
    );
    assert.match(
      dockerfile,
      /COPY package\.json pnpm-lock\.yaml pnpm-workspace\.yaml \.\//,
    );
    assert.match(
      dockerfile,
      /pnpm install --prod --frozen-lockfile --ignore-scripts/,
    );
    assert.match(
      dockerfile,
      /COPY --from=factory-runtime-dependencies \/workspace\/node_modules \/workspace\/node_modules/,
    );
    assert.match(dockerfile, /FROM toolchain AS runtime/);
    assert.match(dockerfile, /RUN corepack enable pnpm/);
    assert.match(dockerfile, /WORKDIR \/workspace\/repo/);
    assert.doesNotMatch(dockerfile, /ENTRYPOINT/);
    assert.match(
      dockerfile,
      /CMD \["node", "\/workspace\/repo\/scripts\/factory\/factory-cli\.mjs"\]/,
    );
  });
});
