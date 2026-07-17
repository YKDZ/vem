import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  publishVerifiedBaselineRelease,
  runtimeProfileForPublishedRelease,
} from "./linux-kvm-baseline.mjs";

function stagedRelease(config, label, contents) {
  const systemDirectory = join(
    dirname(config.storage.baselinePath),
    `.release-kill-system-${label}-${process.pid}`,
  );
  const cacheDirectory = join(
    dirname(config.storage.cacheDiskPath),
    `.release-kill-cache-${label}-${process.pid}`,
  );
  return {
    systemDirectory,
    cacheDirectory,
    system: join(systemDirectory, "system.qcow2"),
    cache: join(cacheDirectory, "cache.qcow2"),
    domainXml: join(systemDirectory, "runtime-profile.xml"),
    diagnostic: join(systemDirectory, "diagnostic.json"),
  };
}

async function writeFakeDefinition(statePath, releaseId) {
  const prior = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(
    statePath,
    `${JSON.stringify({
      ...prior,
      definedReleaseId: releaseId,
      history: [...prior.history, releaseId],
    })}\n`,
  );
}

async function main() {
  const [configurationPath, faultStage, statePath] = process.argv.slice(2);
  if (!configurationPath || !faultStage || !statePath) {
    throw new Error("usage: child <config> <stage> <fake-libvirt-state>");
  }
  const config = JSON.parse(await readFile(configurationPath, "utf8"));
  const releaseId = "release-new-sigkill";
  const staged = stagedRelease(config, faultStage, "new");
  await mkdir(staged.systemDirectory, { recursive: true });
  await mkdir(staged.cacheDirectory, { recursive: true });
  await Promise.all([
    writeFile(staged.system, "new-system"),
    writeFile(staged.cache, "new-cache"),
    writeFile(staged.domainXml, "<domain>new</domain>"),
    writeFile(staged.diagnostic, '{"contents":"new"}\n'),
  ]);
  await publishVerifiedBaselineRelease({
    config,
    releaseId,
    stagedSystemPath: staged.system,
    stagedCachePath: staged.cache,
    stagedDomainXmlPath: staged.domainXml,
    stagedDiagnosticPath: staged.diagnostic,
    profile: runtimeProfileForPublishedRelease(config, releaseId),
    verified: true,
    commitDefinition: async (release) =>
      writeFakeDefinition(statePath, release.releaseId),
    rollbackDefinition: async (release) =>
      writeFakeDefinition(statePath, release?.releaseId ?? null),
    onStage: async (stage) => {
      if (stage === faultStage) {
        process.kill(process.pid, "SIGKILL");
      }
    },
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
