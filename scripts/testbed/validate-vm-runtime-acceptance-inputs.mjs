const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_SSH_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function requiredEnvironmentVariable(name) {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable is required: ${name}`);
  return value;
}

function validateInput(name, pattern) {
  if (!pattern.test(requiredEnvironmentVariable(name))) {
    throw new Error(`workflow input is invalid: ${name}`);
  }
}

function canonicalControlPlaneUrl() {
  const rawUrl = requiredEnvironmentVariable("MAINTENANCE_CONTROL_PLANE_URL");
  if (/[\u0000-\u0020\u007f\\\\?#]/.test(rawUrl) || /%5c/i.test(rawUrl)) {
    throw new Error(
      "MAINTENANCE_CONTROL_PLANE_URL contains an ambiguous delimiter",
    );
  }

  const url = new URL(rawUrl);
  const transportAllowed =
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      process.env.MAINTENANCE_ALLOW_INSECURE_HTTP === "true");
  if (
    !transportAllowed ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MAINTENANCE_CONTROL_PLANE_URL must be credential-free HTTPS unless protected testbed HTTP is explicitly enabled",
    );
  }

  return url.toString().replace(/\/$/, "");
}

function main() {
  validateInput("RUN_ID", RUN_ID_PATTERN);
  validateInput("WINDOWS_SSH_USER", WINDOWS_SSH_USER_PATTERN);

  for (const name of [
    "MAINTENANCE_RUNNER_PEER_ID",
    "MAINTENANCE_TARGET_MACHINE_ID",
  ]) {
    if (!UUID_PATTERN.test(requiredEnvironmentVariable(name))) {
      throw new Error(`protected environment variable must be a UUID: ${name}`);
    }
  }

  process.stdout.write(
    `MAINTENANCE_CONTROL_PLANE_CANONICAL_URL=${canonicalControlPlaneUrl()}\n`,
  );
}

main();
