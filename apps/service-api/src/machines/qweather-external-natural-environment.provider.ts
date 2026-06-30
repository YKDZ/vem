import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";

import type {
  ExternalNaturalEnvironmentProvider,
  ExternalNaturalEnvironmentProviderInput,
  ExternalNaturalEnvironmentProviderResult,
} from "./external-natural-environment.provider";

import { AppConfigService } from "../config/app-config.service";

type QWeatherClientConfig = {
  apiToken?: string;
  apiBaseUrl: string;
  weatherNowPath: string;
  sunPath: string;
};

type QWeatherRequest = {
  url: string;
  authorization: string;
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
    if (!this.config.apiToken) {
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
    const url = buildUrl(this.config.apiBaseUrl, this.config.weatherNowPath, {
      location,
      unit: "m",
    });
    const parsed = qweatherWeatherNowResponseSchema.safeParse(
      await this.fetchJson({
        url,
        authorization: `Bearer ${this.config.apiToken ?? ""}`,
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
    const url = buildUrl(this.config.apiBaseUrl, this.config.sunPath, {
      location,
      date,
    });
    const parsed = qweatherSunResponseSchema.safeParse(
      await this.fetchJson({
        url,
        authorization: `Bearer ${this.config.apiToken ?? ""}`,
      }),
    );
    if (parsed.success && parsed.data.code === "200") {
      return parsed.data;
    }
    throw new QWeatherProviderError();
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
      apiToken: this.config.qweatherApiToken,
      apiBaseUrl: this.config.qweatherApiBaseUrl,
      weatherNowPath: this.config.qweatherWeatherNowPath,
      sunPath: this.config.qweatherSunPath,
    }).fetchExternalNaturalEnvironment(input);
  }
}

async function defaultFetchJson(request: QWeatherRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    headers: { Authorization: request.authorization },
  });
  if (!response.ok) {
    throw new QWeatherProviderError();
  }
  return response.json();
}

function buildUrl(
  apiBaseUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(
    path,
    apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`,
  );
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
