import { createHash } from "node:crypto";
import { Agent } from "node:https";
import { describe, expect, it } from "vitest";

import {
  buildWechatV2ClientAgent,
  parseWechatXml,
  signWechatV2,
  toWechatXml,
  verifyWechatV2Sign,
} from "./wechat-pay-v2.util";

describe("wechat-pay-v2.util", () => {
  it("signs payloads with stable key ordering", () => {
    const payload = {
      mch_id: "1900000109",
      appid: "wx1234567890abcdef",
      nonce_str: "nonce-001",
      body: "VEM order",
    };
    const key = "0123456789abcdef0123456789abcdef";
    const manual = createHash("md5")
      .update(
        "appid=wx1234567890abcdef&body=VEM order&mch_id=1900000109&nonce_str=nonce-001&key=0123456789abcdef0123456789abcdef",
        "utf8",
      )
      .digest("hex")
      .toUpperCase();

    expect(signWechatV2(payload, key, "MD5")).toBe(manual);
  });

  it("roundtrips xml payloads", () => {
    const xml = toWechatXml({
      return_code: "SUCCESS",
      result_code: "SUCCESS",
      trade_type: "MICROPAY",
    });
    expect(parseWechatXml(xml)).toEqual({
      return_code: "SUCCESS",
      result_code: "SUCCESS",
      trade_type: "MICROPAY",
    });
  });

  it("returns false when sign verification fails", () => {
    expect(
      verifyWechatV2Sign(
        {
          return_code: "SUCCESS",
          result_code: "SUCCESS",
          sign: "BAD_SIGN",
        },
        "0123456789abcdef0123456789abcdef",
        "HMAC-SHA256",
      ),
    ).toBe(false);
  });

  it("builds a client certificate https agent", () => {
    const agent = buildWechatV2ClientAgent("cert-pem", "key-pem");
    expect(agent).toBeInstanceOf(Agent);
  });
});
