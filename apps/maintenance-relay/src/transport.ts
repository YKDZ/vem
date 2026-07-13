import type { LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { callbackify } from "node:util";

export type RelayTransportStatus =
  | { mode: "https"; health: "healthy"; reason: null }
  | { mode: "insecure-http"; health: "degraded"; reason: string };

const INSECURE_HTTP_REASON =
  "Service API uses explicitly allowed insecure HTTP";

export type RelayDnsAddress = { address: string; family: 4 | 6 };
export type RelayDnsResolver = (hostname: string) => Promise<RelayDnsAddress[]>;
type PinnedDnsLookupResult =
  | { addresses: RelayDnsAddress[] }
  | { address: string; family: 4 | 6 };

export function resolveServiceApiTransport(
  rawUrl: string,
  allowInsecureHttp: boolean,
): RelayTransportStatus {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SERVICE_API_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.username || url.password) {
    throw new Error("SERVICE_API_BASE_URL must not include userinfo");
  }
  if (url.hostname.endsWith(".")) {
    throw new Error(
      "SERVICE_API_BASE_URL hostname must not have a trailing dot",
    );
  }

  if (url.protocol === "https:") {
    return { mode: "https", health: "healthy", reason: null };
  }
  if (url.protocol !== "http:") {
    throw new Error("SERVICE_API_BASE_URL must use HTTP or HTTPS");
  }
  if (!allowInsecureHttp) {
    throw new Error(
      "HTTPS is required; set MAINTENANCE_RELAY_ALLOW_INSECURE_HTTP=true only for a private test destination",
    );
  }
  if (!isPrivateHttpDestination(url.hostname)) {
    throw new Error("insecure HTTP destination is not private");
  }
  return {
    mode: "insecure-http",
    health: "degraded",
    reason: INSECURE_HTTP_REASON,
  };
}

export function serviceApiRequiresPinnedDns(rawUrl: string): boolean {
  const url = new URL(rawUrl);
  const hostname = normalizeHostname(url.hostname);
  return (
    url.protocol === "http:" &&
    isIP(hostname) === 0 &&
    !hostname.includes(".") &&
    !hostname.includes(":")
  );
}

export function createPinnedPrivateDnsLookup(
  resolveDns: RelayDnsResolver = resolveAllDns,
): LookupFunction {
  const resolveLookup = callbackify(
    async (
      hostname: string,
      options: LookupOptions,
    ): Promise<PinnedDnsLookupResult> =>
      await resolvePinnedPrivateDns(hostname, options, resolveDns),
  );
  return (hostname, options, callback) => {
    resolveLookup(hostname, options, (error, result) => {
      if (error) {
        callback(error, []);
        return;
      }
      if ("addresses" in result) {
        callback(null, result.addresses);
        return;
      }
      callback(null, result.address, result.family);
    });
  };
}

async function resolvePinnedPrivateDns(
  hostname: string,
  options: LookupOptions,
  resolveDns: RelayDnsResolver,
): Promise<PinnedDnsLookupResult> {
  const answers = await resolveDns(hostname);
  if (answers.length === 0) {
    throw dnsPolicyError("returned no A or AAAA records");
  }
  const unique = answers.filter(
    (answer, index) =>
      answers.findIndex(
        (candidate) =>
          candidate.address === answer.address &&
          candidate.family === answer.family,
      ) === index,
  );
  if (
    unique.some(
      (answer) =>
        isIP(answer.address) !== answer.family ||
        !isAllowedInsecureIpAddress(answer.address),
    )
  ) {
    throw dnsPolicyError("resolved to a disallowed address");
  }
  const requestedFamily =
    options.family === 4 || options.family === "IPv4"
      ? 4
      : options.family === 6 || options.family === "IPv6"
        ? 6
        : undefined;
  const usable = requestedFamily
    ? unique.filter((answer) => answer.family === requestedFamily)
    : unique;
  const [first] = usable;
  if (!first) {
    throw dnsPolicyError("has no record for the requested family");
  }
  return options.all
    ? { addresses: usable }
    : { address: first.address, family: first.family };
}

async function resolveAllDns(hostname: string): Promise<RelayDnsAddress[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
}

function dnsPolicyError(reason: string): Error & { code: string } {
  return Object.assign(new Error(`insecure HTTP single-label DNS ${reason}`), {
    code: "EACCES",
  });
}

function isPrivateHttpDestination(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family !== 0) return isAllowedInsecureIpAddress(normalized);
  return !normalized.includes(".") && !normalized.includes(":");
}

export function isAllowedInsecureIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isAllowedIpv4(normalized);
  if (family === 6) return isAllowedIpv6(normalized);
  return false;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isAllowedIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] === 127
  );
}

function isAllowedIpv6(hostname: string): boolean {
  const words = parseIpv6Words(hostname);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) {
    return true;
  }
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return isAllowedIpv4(
      [
        (words[6] ?? 0) >> 8,
        (words[6] ?? 0) & 0xff,
        (words[7] ?? 0) >> 8,
        (words[7] ?? 0) & 0xff,
      ].join("."),
    );
  }
  return false;
}

function parseIpv6Words(hostname: string): number[] | undefined {
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  const left = parseIpv6Half(halves[0] ?? "");
  const right = parseIpv6Half(halves[1] ?? "");
  if (!left || !right) return undefined;
  const omitted = 8 - left.length - right.length;
  if (omitted < (halves.length === 2 ? 1 : 0)) return undefined;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function parseIpv6Half(value: string): number[] | undefined {
  if (!value) return [];
  const parts = value.split(":");
  const words: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (part.includes(".")) {
      if (index !== parts.length - 1 || isIP(part) !== 4) return undefined;
      const octets = part.split(".").map(Number);
      words.push(
        ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
        ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
      );
      continue;
    }
    if (!/^[a-f\d]{1,4}$/i.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}
