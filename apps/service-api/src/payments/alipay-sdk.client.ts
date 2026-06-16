import { Injectable } from "@nestjs/common";
import { AlipaySdk } from "alipay-sdk";

export type AlipayHttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type AlipayCurlOptions = {
  query?: Record<string, string | number>;
  body?: Record<string, unknown>;
  requestId?: string;
  requestTimeout?: number;
};

export type AlipayCurlResult<T extends Record<string, unknown>> = {
  data: T;
  responseHttpStatus: number;
  traceId?: string;
};

export type AlipaySdkLike = {
  curl<T extends Record<string, unknown>>(
    this: void,
    httpMethod: AlipayHttpMethod,
    path: string,
    options?: AlipayCurlOptions,
  ): Promise<AlipayCurlResult<T>>;
  exec(
    this: void,
    method: string,
    params?: Record<string, unknown>,
    options?: { validateSign?: boolean; traceId?: string },
  ): Promise<Record<string, unknown>>;
  checkNotifySignV2(this: void, postData: Record<string, string>): boolean;
};

export type AlipaySdkCreateOptions = {
  appId: string;
  privateKey: string;
  keyType?: "PKCS1" | "PKCS8";
  gateway?: string;
  endpoint?: string;
  timeout?: number;
  camelcase?: boolean;
  appCertContent?: string;
  alipayPublicCertContent?: string;
  alipayRootCertContent?: string;
};

@Injectable()
export class AlipaySdkClientFactory {
  create(this: void, options: AlipaySdkCreateOptions): AlipaySdkLike {
    return new AlipaySdk(options);
  }
}
