import type { MaintenancePeerRole } from "@vem/shared";

export type MaintenanceAddressPoolInput = Record<MaintenancePeerRole, string>;

export type MaintenanceAddressPool = {
  cidr: string;
  firstHost: number;
  lastHost: number;
};

export type MaintenanceAddressPools = Record<
  MaintenancePeerRole,
  MaintenanceAddressPool
>;

const IPV4_CIDR_PATTERN =
  /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/;

function ipv4ToNumber(address: string): number {
  const parts = address.split(".").map(Number);
  return parts[0] * 2 ** 24 + parts[1] * 2 ** 16 + parts[2] * 2 ** 8 + parts[3];
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(value / 2 ** shift) % 256)
    .join(".");
}

function parsePool(
  role: MaintenancePeerRole,
  cidr: string,
): MaintenanceAddressPool {
  const match = IPV4_CIDR_PATTERN.exec(cidr);
  if (!match)
    throw new Error(`Maintenance ${role} address pool is not IPv4 CIDR`);

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new Error(`Maintenance ${role} address pool is not IPv4 CIDR`);
  }
  const prefixLength = Number(match[5]);
  const minimumPrefixLength = role === "machine" ? 16 : 24;
  if (prefixLength < minimumPrefixLength) {
    throw new Error(
      `Maintenance ${role} address pool must use prefix /${minimumPrefixLength} or narrower`,
    );
  }
  if (prefixLength > 30) {
    throw new Error(
      `Maintenance ${role} address pool must contain usable host addresses`,
    );
  }

  const addressNumber = ipv4ToNumber(octets.join("."));
  const blockSize = 2 ** (32 - prefixLength);
  const network = Math.floor(addressNumber / blockSize) * blockSize;
  const broadcast = network + blockSize - 1;
  if (addressNumber !== network) {
    throw new Error(
      `Maintenance ${role} address pool must use its network address`,
    );
  }

  return {
    cidr,
    firstHost: network + 1,
    lastHost: broadcast - 1,
  };
}

function overlaps(
  a: MaintenanceAddressPool,
  b: MaintenanceAddressPool,
): boolean {
  return a.firstHost - 1 <= b.lastHost + 1 && b.firstHost - 1 <= a.lastHost + 1;
}

export function parseMaintenanceAddressPools(
  input: MaintenanceAddressPoolInput,
): MaintenanceAddressPools {
  const pools = {
    relay: parsePool("relay", input.relay),
    runner: parsePool("runner", input.runner),
    maintainer: parsePool("maintainer", input.maintainer),
    machine: parsePool("machine", input.machine),
  } satisfies MaintenanceAddressPools;

  const entries = [
    ["relay", pools.relay],
    ["runner", pools.runner],
    ["maintainer", pools.maintainer],
    ["machine", pools.machine],
  ] satisfies Array<[MaintenancePeerRole, MaintenanceAddressPool]>;
  for (let index = 0; index < entries.length; index += 1) {
    for (
      let otherIndex = index + 1;
      otherIndex < entries.length;
      otherIndex += 1
    ) {
      const [role, pool] = entries[index];
      const [otherRole, otherPool] = entries[otherIndex];
      if (overlaps(pool, otherPool)) {
        throw new Error(
          `Maintenance address pools ${role} and ${otherRole} must not overlap`,
        );
      }
    }
  }

  return pools;
}

export function allocateTunnelAddress(
  pool: MaintenanceAddressPool,
  usedAddresses: ReadonlySet<string>,
): string {
  for (
    let candidate = pool.firstHost;
    candidate <= pool.lastHost;
    candidate += 1
  ) {
    const address = numberToIpv4(candidate);
    if (!usedAddresses.has(address)) return address;
  }
  throw new Error(`Maintenance address pool ${pool.cidr} is exhausted`);
}

export function maintenanceAddressPoolContains(
  pool: MaintenanceAddressPool,
  address: string,
): boolean {
  const parsed = address.split(".").map(Number);
  if (
    parsed.length !== 4 ||
    parsed.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const value = ipv4ToNumber(address);
  return value >= pool.firstHost && value <= pool.lastHost;
}
