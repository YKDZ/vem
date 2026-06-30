import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import type {
  ExternalNaturalEnvironmentProvider,
  ExternalNaturalEnvironmentProviderInput,
  ExternalNaturalEnvironmentProviderResult,
} from "./external-natural-environment.provider";

import { AppConfigService } from "../config/app-config.service";

type QWeatherClientConfig = {
  apiKey?: string;
  apiHost?: string;
  weatherNowPath: string;
  sunPath: string;
  timeoutMs?: number;
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
      text: z.string(),
    })
    .optional(),
});

const qweatherSunResponseSchema = z.object({
  code: z.string(),
  sunrise: z.string(),
  sunset: z.string(),
});

const DEFAULT_QWEATHER_TIMEOUT_MS = 3_000;

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
    if (!this.config.apiKey || !this.config.apiHost) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }

    const location = formatQWeatherLocation(
      input.geoLocation.longitude,
      input.geoLocation.latitude,
    );
    const [weatherNow, sun] = await Promise.all([
      this.fetchWeatherNow(location),
      this.fetchSun(
        location,
        localDateYmd(input.checkedAt, input.geoLocation.timezone),
      ),
    ]);

    return {
      localTime: formatLocalTime(input.checkedAt, input.geoLocation.timezone),
      weather: {
        temperatureCelsius: Number(weatherNow.now.temp),
        conditionText: weatherNow.now.text,
        observedAt: parseProviderIso(weatherNow.now.obsTime),
      },
      sun: {
        sunriseAt: parseProviderIso(sun.sunrise),
        sunsetAt: parseProviderIso(sun.sunset),
      },
    };
  }

  private async fetchWeatherNow(location: string) {
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
    if (!Number.isFinite(temperature)) {
      throw new QWeatherProviderError();
    }
    return {
      ...parsed.data,
      now: {
        ...parsed.data.now,
        temp: String(temperature),
      },
    };
  }

  private async fetchSun(location: string, date: string) {
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
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }
    return { "X-QW-Api-Key": apiKey };
  }

  private apiHost(): string {
    const apiHost = this.config.apiHost;
    if (!apiHost) {
      throw new QWeatherProviderError("QWeather provider is not configured");
    }
    return apiHost;
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
    @Inject(AppConfigService)
    private readonly config: AppConfigService,
  ) {}

  async fetch(
    input: ExternalNaturalEnvironmentProviderInput,
  ): Promise<ExternalNaturalEnvironmentProviderResult> {
    return await new QWeatherClient({
      apiKey: this.config.qweatherApiKey,
      apiHost: this.config.qweatherApiHost,
      weatherNowPath: this.config.qweatherWeatherNowPath,
      sunPath: this.config.qweatherSunPath,
      timeoutMs: this.config.qweatherTimeoutMs,
    }).fetchExternalNaturalEnvironment(input);
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
