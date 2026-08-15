import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function writeJson(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function replaceSerialSessionAndUpdateHandoff({
  guestInput,
  handoff,
  handoffPath,
  sessionId,
  control,
  writeJsonFile = writeJson,
}) {
  if (typeof control !== "function") {
    throw new Error("serial session handoff control is required");
  }
  const aborted = await control(
    guestInput,
    `/v1/serial-sessions/${encodeURIComponent(sessionId)}/abort`,
  );
  if (aborted?.aborted !== true) {
    throw new Error("serial session abort did not confirm inactive state");
  }
  const replacement = await control(guestInput, "/v1/serial-sessions/start", {
    runId: required(guestInput.runId, "runId"),
    machineCode: required(guestInput.machineCode, "machineCode"),
    saleCorrelationId: `sale-correlation://${required(guestInput.runId, "runId").toLowerCase()}.handoff-${Date.now()}`,
    targetIdentity: required(
      guestInput.hostControlPlane?.targetIdentity,
      "hostControlPlane.targetIdentity",
    ),
    runtimeBase: required(
      guestInput.hostControlPlane?.runtimeBaseIdentity,
      "hostControlPlane.runtimeBaseIdentity",
    ),
  });
  required(replacement.sessionId, "replacement serial session id");
  const updatedHandoff = {
    ...handoff,
    commissioningSerialSession: replacement,
  };
  try {
    writeJsonFile(handoffPath, updatedHandoff);
  } catch (error) {
    await control(
      guestInput,
      `/v1/serial-sessions/${encodeURIComponent(replacement.sessionId)}/abort`,
    ).catch(() => undefined);
    throw error;
  }
  handoff.commissioningSerialSession = replacement;
  return { aborted, replacement };
}
