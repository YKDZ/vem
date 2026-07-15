import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const environmentCopyPattern = /sandbox|testbed|沙箱|测试环境/i;
const customerChunkPattern =
  /^(?:Catalog|Checkout|Payment|Dispensing|Result|ProductDetail|Home)View-.*\.js$/;

export function assertCustomerPaymentCopy(text, label) {
  if (environmentCopyPattern.test(text)) {
    throw new Error(
      `${label} contains provider environment vocabulary in customer payment copy`,
    );
  }
}

async function filesBelow(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else files.push(path);
  }
  return files;
}

export async function checkMachineCustomerPaymentCopy(
  repoRoot = process.cwd(),
) {
  const sourceRoot = resolve(repoRoot, "apps/machine/src");
  const sourceFiles = (await filesBelow(sourceRoot)).filter((path) => {
    const local = relative(sourceRoot, path).replaceAll("\\", "/");
    return (
      /\.(?:ts|vue)$/.test(local) &&
      !/\.spec\.ts$/.test(local) &&
      !local.startsWith("dev/") &&
      !local.startsWith("daemon/") &&
      !local.includes("Maintenance") &&
      !local.includes("Provisioning")
    );
  });
  for (const path of sourceFiles) {
    assertCustomerPaymentCopy(
      await readFile(path, "utf8"),
      relative(repoRoot, path),
    );
  }

  const assetsRoot = resolve(repoRoot, "apps/machine/dist/assets");
  let builtFiles = [];
  try {
    builtFiles = (await filesBelow(assetsRoot)).filter((path) =>
      customerChunkPattern.test(basename(path)),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const path of builtFiles) {
    assertCustomerPaymentCopy(
      await readFile(path, "utf8"),
      relative(repoRoot, path),
    );
  }
  return { sourceFiles: sourceFiles.length, builtFiles: builtFiles.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await checkMachineCustomerPaymentCopy();
  process.stdout.write(
    `Machine customer payment copy check passed (${result.sourceFiles} source files, ${result.builtFiles} built chunks).\n`,
  );
}
