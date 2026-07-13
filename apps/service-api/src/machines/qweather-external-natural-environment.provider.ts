import { Inject, Injectable } from "@nestjs/common";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

import type {
  ExternalNaturalEnvironmentProvider,
  ExternalNaturalEnvironmentProviderInput,
  ExternalNaturalEnvironmentProviderResult,
  ExternalNaturalEnvironmentSun,
  ExternalNaturalEnvironmentWeather,
} from "./external-natural-environment.provider";

import { QweatherConfigService } from "./qweather-config.service";

type QWeatherClientConfig = {
  apiHost?: string;
  jwtKeyId?: string;
  jwtProjectId?: string;
  jwtPrivateKey?: string;
  jwtPrivateKeyPath?: string;
  weatherNowPath: string;
  sunPath: string;
  timeoutMs?: number;
  jwtTtlSeconds?: number;
};

type QWeatherRequest = {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
};

type FetchJson = (request: QWeatherRequest) => Promise<unknown>;

const qweatherWeatherNowResponseSchema = z.object({
  code: z.string(),
  now: z
    .object({
      obsTime: z.string(),
      temp: z.string(),
      icon: z.string(),
      text: z.string(),
      windScale: z.string().optional(),
      windSpeed: z.string().optional(),
    })
    .optional(),
});

const qweatherSunResponseSchema = z.object({
  code: z.string(),
  sunrise: z.string(),
  sunset: z.string(),
});

const DEFAULT_QWEATHER_TIMEOUT_MS = 3_000;
const DEFAULT_QWEATHER_JWT_TTL_SECONDS = 15 * 60;
const QWEATHER_JWT_IAT_SKEW_SECONDS = 30;

export class QWeatherProviderError extends Error {
  constructor(message = "QWeather provider unavailable") {
    super(message);
  }
}

export class QWeatherClient {
  constructor(
    private readonly config: QWeatherClientConfig,
    private readonly fetchJson: FetchJson = defaultFetchJson,
  ) {}

  async fetchExternalNaturalEnvironment(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentProviderResult> {
    const [weather, sun] = await Promise.all([
      this.fetchWeatherNow(input),
      this.fetchSun(input),
    ]);
    return {
      localTime: formatLocalTime(input.checkedAt, input.geoLocation.timezone),
      weather,
      sun,
    };
  }

  async fetchWeatherNow(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentWeather> {
    this.assertConfigured();

    const location = formatQWeatherLocation(
      input.geoLocation.longitude,
      input.geoLocation.latitude,
    );
    const weatherNow = await this.requestWeatherNow(location);

    return {
      temperatureCelsius: Number(weatherNow.now.temp),
      conditionText: weatherNow.now.text,
      conditionCode: weatherNow.now.icon,
      observedAt: parseProviderIso(weatherNow.now.obsTime),
      windScale:
        weatherNow.now.windScale === undefined
          ? undefined
          : Number(weatherNow.now.windScale),
      windSpeedKph:
        weatherNow.now.windSpeed === undefined
          ? undefined
          : Number(weatherNow.now.windSpeed),
    };
  }

  async fetchSun(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentSun> {
    this.assertConfigured();

    const location = formatQWeatherLocation(
      input.geoLocation.longitude,
      input.geoLocation.latitude,
    );
    const sun = await this.requestSun(
      location,
      localDateYmd(input.checkedAt, input.geoLocation.timezone),
    );

    return {
      sunriseAt: parseProviderIso(sun.sunrise),
      sunsetAt: parseProviderIso(sun.sunset),
    };
  }

  private async requestWeatherNow(location: string) {
    const url = buildUrl(this.apiHost(), this.config.weatherNowPath, {
      location,
      unit: "m",
    });
    const parsed = qweatherWeatherNowResponseSchema.safeParse(
      await this.fetchProviderJson({
        url,
        headers: this.authHeaders(),
      }),
    );
    if (!parsed.success || parsed.data.code !== "200" || !parsed.data.now) {
      throw new QWeatherProviderError();
    }
    const temperature = Number(parsed.data.now.temp);
    const windScale =
      parsed.data.now.windScale === undefined
        ? undefined
        : Number(parsed.data.now.windScale);
    const windSpeed =
      parsed.data.now.windSpeed === undefined
        ? undefined
        : Number(parsed.data.now.windSpeed);
    if (
      !Number.isFinite(temperature) ||
      (windScale !== undefined &&
        (!Number.isInteger(windScale) || windScale < 0)) ||
      (windSpeed !== undefined &&
        (!Number.isFinite(windSpeed) || windSpeed < 0))
    ) {
      throw new QWeatherProviderError();
    }
    return {
      ...parsed.data,
      now: {
        ...parsed.data.now,
        temp: String(temperature),
        windScale:
          windScale === undefined ? undefined : String(Math.trunc(windScale)),
        windSpeed: windSpeed === undefined ? undefined : String(windSpeed),
      },
    };
  }

  private async requestSun(location: string, date: string) {
    const url = buildUrl(this.apiHost(), this.config.sunPath, {
      location,
      date,
    });
    const parsed = qweatherSunResponseSchema.safeParse(
      await this.fetchProviderJson({
        url,
        headers: this.authHeaders(),
      }),
    );
    if (parsed.success && parsed.data.code === "200") {
      return parsed.data;
    }
    throw new QWeatherProviderError();
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.jwt()}` };
  }

  private apiHost(): string {
    const apiHost = this.config.apiHost;
    if (!apiHost) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }
    return apiHost;
  }

  private jwt(): string {
    const { jwtKeyId, jwtProjectId } = this.config;
    if (!jwtKeyId || !jwtProjectId) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }
    const privateKey = this.privateKey();
    const iat = Math.floor(Date.now() / 1000) - QWEATHER_JWT_IAT_SKEW_SECONDS;
    const exp =
      iat + (this.config.jwtTtlSeconds ?? DEFAULT_QWEATHER_JWT_TTL_SECONDS);
    return createQWeatherJwt({
      keyId: jwtKeyId,
      projectId: jwtProjectId,
      privateKey,
      iat,
      exp,
    });
  }

  private privateKey(): string {
    if (this.config.jwtPrivateKey) {
      return this.config.jwtPrivateKey;
    }
    if (this.config.jwtPrivateKeyPath) {
      try {
        return readFileSync(this.config.jwtPrivateKeyPath, "utf8");
      } catch {
        throw new QWeatherProviderError("QWeather provider is not configured");
      }
    }
    throw new QWeatherProviderError("QWeather provider is not configured");
  }

  private assertConfigured(): void {
    if (
      !this.config.apiHost ||
      !this.config.jwtKeyId ||
      !this.config.jwtProjectId ||
      (!this.config.jwtPrivateKey && !this.config.jwtPrivateKeyPath)
    ) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }
  }

  private async fetchProviderJson(
    request: Omit<QWeatherRequest, "signal">,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_QWEATHER_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new QWeatherProviderError());
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        this.fetchJson({ ...request, signal: controller.signal }),
        timeout,
      ]);
    } catch {
      throw new QWeatherProviderError();
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

@Injectable()
export class QWeatherExternalNaturalEnvironmentProvider implements ExternalNaturalEnvironmentProvider {
  constructor(
    @Inject(QweatherConfigService)
    private readonly config: QweatherConfigService,
  ) {}

  async fetchWeatherNow(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentWeather> {
    return await (await this.client()).fetchWeatherNow(input);
  }

  async fetchSun(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentSun> {
    return await (await this.client()).fetchSun(input);
  }

  private async client(): Promise<QWeatherClient> {
    return new QWeatherClient(await this.config.resolveRuntimeConfig());
  }
}

async function defaultFetchJson(request: QWeatherRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    headers: request.headers,
    signal: request.signal,
  });
  if (!response.ok) {
    throw new QWeatherProviderError();
  }
  return response.json();
}

function buildUrl(
  apiHost: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(path, `https://${apiHost}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function formatQWeatherLocation(longitude: number, latitude: number): string {
  return `${longitude.toFixed(2)},${latitude.toFixed(2)}`;
}

export function createQWeatherJwt(input: {
  keyId: string;
  projectId: string;
  privateKey: string;
  iat: number;
  exp: number;
}): string {
  const header = base64UrlJson({
    alg: "EdDSA",
    kid: input.keyId,
  });
  const payload = base64UrlJson({
    sub: input.projectId,
    iat: input.iat,
    exp: input.exp,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(signingInput),
    createPrivateKey(input.privateKey),
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function localDateYmd(checkedAt: Date, timezone: string): string {
  return formatLocalTime(checkedAt, timezone).localDate.replaceAll("-", "");
}

function formatLocalTime(checkedAt: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(checkedAt);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return {
    timezone,
    localDate: `${part("year")}-${part("month")}-${part("day")}`,
    localClock: `${part("hour")}:${part("minute")}:${part("second")}`,
  };
}

function parseProviderIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new QWeatherProviderError();
  }
  return parsed.toISOString();
}
