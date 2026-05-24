import { XMLParser } from "fast-xml-parser";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Agent } from "node:https";

export type WeChatV2SignType = "MD5" | "HMAC-SHA256";
export type WeChatV2Payload = Record<
  string,
  string | number | null | undefined
>;

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createNonceStr(): string {
  return randomBytes(16).toString("hex").slice(0, 32);
}

export function signWechatV2(
  payload: WeChatV2Payload,
  apiV2Key: string,
  signType: WeChatV2SignType,
): string {
  const base = Object.entries(payload)
    .filter(
      ([key, value]) =>
        key !== "sign" &&
        value !== undefined &&
        value !== null &&
        `${value}` !== "",
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const stringSignTemp = `${base}&key=${apiV2Key}`;
  if (signType === "HMAC-SHA256") {
    return createHmac("sha256", apiV2Key)
      .update(stringSignTemp, "utf8")
      .digest("hex")
      .toUpperCase();
  }
  return createHash("md5")
    .update(stringSignTemp, "utf8")
    .digest("hex")
    .toUpperCase();
}

export function toWechatXml(payload: WeChatV2Payload): string {
  const body = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `<${key}><![CDATA[${String(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]></${key}>`,
    )
    .join("");
  return `<xml>${body}</xml>`;
}

export function parseWechatXml(xml: string): Record<string, string> {
  const parsed: unknown = parser.parse(xml);
  if (!isRecord(parsed)) {
    return {};
  }
  const xmlNode: unknown = Reflect.get(parsed, "xml");
  const source = isRecord(xmlNode) ? xmlNode : {};
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? String(value)
        : "",
    ]),
  );
}

export function verifyWechatV2Sign(
  payload: Record<string, string>,
  apiV2Key: string,
  signType: WeChatV2SignType,
): boolean {
  const expected = signWechatV2(payload, apiV2Key, signType);
  return payload["sign"] === expected;
}

export function buildWechatV2ClientAgent(
  certPem: string,
  keyPem: string,
): Agent {
  return new Agent({ cert: certPem, key: keyPem });
}
