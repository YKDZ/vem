import { z } from "zod";

export const qweatherConfigNoBodySchema = z.strictObject({});

export const qweatherConfigResponseSchema = z.strictObject({
  source: z.enum(["database", "environment", "unconfigured"]),
  enabled: z.boolean(),
  apiHost: z.string(),
  jwtKeyId: z.string(),
  jwtProjectId: z.string(),
  privateKeyConfigured: z.boolean(),
  weatherNowPath: z.string(),
  sunPath: z.string(),
  timeoutMs: z.int().min(500).max(30_000),
  updatedAt: z.iso.datetime().nullable(),
});

export const updateQweatherConfigSchema = z.strictObject({
  enabled: z.boolean(),
  apiHost: z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) =>
        ![
          "api.qweather.com",
          "devapi.qweather.com",
          "geoapi.qweather.com",
        ].includes(value),
      "必须填写账户专属 API Host",
    ),
  jwtKeyId: z.string().trim().min(1),
  jwtProjectId: z.string().trim().min(1),
  privateKey: z.string().trim().min(1).optional(),
  weatherNowPath: z.string().regex(/^\/.+/),
  sunPath: z.string().regex(/^\/.+/),
  timeoutMs: z.int().min(500).max(30_000),
});

export type QweatherConfigResponse = z.infer<
  typeof qweatherConfigResponseSchema
>;
export type UpdateQweatherConfigInput = z.infer<
  typeof updateQweatherConfigSchema
>;
