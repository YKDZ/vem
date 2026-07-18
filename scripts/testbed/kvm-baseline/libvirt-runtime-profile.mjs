const MiB = 1024 * 1024;

export const DEFAULT_RUNTIME_PROFILE = Object.freeze({
  vcpus: 8,
  memoryMiB: 16 * 1024,
  display: Object.freeze({
    width: 1080,
    height: 1920,
    scalePercent: 100,
    videoMemoryKiB: 65536,
  }),
  serialRoles: Object.freeze(["lower-controller", "scanner"]),
  serialUsbPorts: Object.freeze([1, 2]),
  audio: Object.freeze({
    model: "ich9",
    defaultDevice: true,
    capturePath: null,
  }),
});

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createRuntimeProfile(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("runtime profile options must be an object");
  }
  const vcpus = positiveInteger(
    options.vcpus ?? DEFAULT_RUNTIME_PROFILE.vcpus,
    "vcpus",
  );
  const memoryMiB = positiveInteger(
    options.memoryMiB ?? DEFAULT_RUNTIME_PROFILE.memoryMiB,
    "memoryMiB",
  );
  const display = {
    ...DEFAULT_RUNTIME_PROFILE.display,
    ...(options.display ?? {}),
  };
  for (const key of ["width", "height", "scalePercent", "videoMemoryKiB"]) {
    positiveInteger(display[key], `display.${key}`);
  }
  const serialRoles = options.serialRoles ?? [
    ...DEFAULT_RUNTIME_PROFILE.serialRoles,
  ];
  if (
    !Array.isArray(serialRoles) ||
    serialRoles.length !== 2 ||
    new Set(serialRoles).size !== serialRoles.length ||
    serialRoles.some((role) => !/^[a-z][a-z-]{1,63}$/.test(role))
  ) {
    throw new Error("serialRoles must contain two unique lowercase roles");
  }
  const serialUsbPorts = options.serialUsbPorts ?? [
    ...DEFAULT_RUNTIME_PROFILE.serialUsbPorts,
  ];
  if (
    !Array.isArray(serialUsbPorts) ||
    serialUsbPorts.length !== serialRoles.length ||
    new Set(serialUsbPorts).size !== serialUsbPorts.length ||
    serialUsbPorts.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 15,
    )
  ) {
    throw new Error(
      "serialUsbPorts must contain two unique QEMU USB controller ports",
    );
  }
  const audio = { ...DEFAULT_RUNTIME_PROFILE.audio, ...(options.audio ?? {}) };
  if (audio.model !== "ich9" || audio.defaultDevice !== true) {
    throw new Error("audio must use the default ich9 device");
  }
  const defaultAudioCapturePath = `${requiredString(options.systemDiskPath, "systemDiskPath")}.default-audio.wav`;
  audio.capturePath = requiredString(
    audio.capturePath ?? defaultAudioCapturePath,
    "audio.capturePath",
  );
  const macAddress = requiredString(
    options.macAddress,
    "macAddress",
  ).toLowerCase();
  if (!/^52:54:00(?::[0-9a-f]{2}){3}$/.test(macAddress)) {
    throw new Error(
      "macAddress must be a stable libvirt locally administered MAC",
    );
  }

  return {
    vmName: requiredString(options.vmName, "vmName"),
    vcpus,
    memoryMiB,
    display,
    serialRoles: [...serialRoles],
    serialUsbPorts: [...serialUsbPorts],
    audio,
    disks: {
      system: {
        path: requiredString(options.systemDiskPath, "systemDiskPath"),
        target: "sda",
        bus: "sata",
        resettable: true,
      },
      cache: {
        path: requiredString(options.cacheDiskPath, "cacheDiskPath"),
        target: "sdb",
        bus: "sata",
        persistent: true,
      },
    },
    network: {
      name: requiredString(options.networkName, "networkName"),
      macAddress,
    },
  };
}

export function renderLibvirtDomainXml(profile, { cdromPaths = [] } = {}) {
  if (!profile || typeof profile !== "object") {
    throw new Error("profile must be an object");
  }
  if (!Array.isArray(cdromPaths))
    throw new Error("cdromPaths must be an array");
  const cdroms = cdromPaths
    .map((path, index) => {
      requiredString(path, `cdromPaths[${index}]`);
      return `    <disk type="file" device="cdrom">
      <driver name="qemu" type="raw"/>
      <source file="${xml(path)}"/>
      <target dev="sd${String.fromCharCode(99 + index)}" bus="sata"/>
      <readonly/>
    </disk>`;
    })
    .join("\n");
  const serial = profile.serialRoles
    .map(
      (role, index) => `    <serial type="pty">
      <target type="usb-serial" port="${index}"/>
      <address type="usb" bus="0" port="${profile.serialUsbPorts[index]}"/>
      <alias name="serial-${xml(role)}"/>
    </serial>`,
    )
    .join("\n");
  return `<domain type="kvm">
  <name>${xml(profile.vmName)}</name>
  <memory unit="MiB">${profile.memoryMiB}</memory>
  <currentMemory unit="MiB">${profile.memoryMiB}</currentMemory>
  <vcpu placement="static">${profile.vcpus}</vcpu>
  <os><type arch="x86_64" machine="q35">hvm</type>${cdroms ? '<boot dev="cdrom"/>' : ""}</os>
  <features><acpi/><apic/><hyperv mode="custom"><relaxed state="on"/><vapic state="on"/><spinlocks state="on" retries="8191"/></hyperv></features>
  <cpu mode="host-passthrough" check="none" migratable="on"/>
  <devices>
    <controller type="usb" model="qemu-xhci" ports="15"/>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2" cache="none" io="native"/>
      <source file="${xml(profile.disks.system.path)}"/>
      <target dev="sda" bus="sata"/>
    </disk>
    <disk type="file" device="disk">
      <driver name="qemu" type="qcow2" cache="none" io="native"/>
      <source file="${xml(profile.disks.cache.path)}"/>
      <target dev="sdb" bus="sata"/>
    </disk>
${cdroms}${cdroms ? "\n" : ""}    <interface type="network"><mac address="${xml(profile.network.macAddress)}"/><source network="${xml(profile.network.name)}"/><model type="e1000e"/></interface>
    <graphics type="vnc" autoport="yes" listen="127.0.0.1"><listen type="address" address="127.0.0.1"/></graphics>
    <video><model type="virtio" vram="${profile.display.videoMemoryKiB}" heads="1" primary="yes"><resolution x="${profile.display.width}" y="${profile.display.height}"/></model></video>
    <audio id="1" type="file"><output file="${xml(profile.audio.capturePath)}"/></audio>
    <sound model="ich9"><audio id="1"/></sound>
${serial}
    <memballoon model="virtio"/>
  </devices>
</domain>
`;
}

export function requiredHostMemoryBytes(profile) {
  return profile.memoryMiB * MiB;
}
