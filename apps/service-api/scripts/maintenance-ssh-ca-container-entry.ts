import { MaintenanceSshCaSigner } from "../src/maintenance-access/maintenance-ssh-ca-signer";

const [caPrivateKeyPath, expectedCaFingerprint] = process.argv.slice(2);
if (!caPrivateKeyPath || !expectedCaFingerprint) {
  throw new Error("CA path and fingerprint are required");
}

const signer = new MaintenanceSshCaSigner({
  caPrivateKeyPath,
  expectedCaFingerprint,
  profile: "production",
  requireReadOnlyMount: true,
  temporaryRoot: "/tmp",
});
signer.close();
