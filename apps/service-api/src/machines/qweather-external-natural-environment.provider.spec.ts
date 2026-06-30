import { afterEach, describe, expect, it, vi } from "vitest";

import { QWeatherClient } from "./qweather-external-natural-environment.provider";

const configuredQWeatherClient = {
  apiKey: "secret-qweather-api-key",
  apiHost: "abcxyz.qweatherapi.com",
  weatherNowPath: "/v7/weather/now",
  sunPath: "/v7/astronomy/sun",
};

const machineGeoLocationInput = {
  geoLocation: {
    latitude: 31.2304,
    longitude: 121.4737,
    timezone: "Asia/Shanghai",
  },
  checkedAt: new Date("2026-06-30T14:00:00.000Z"),
};

function validWeatherNowResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: "200",
    updateTime: "2026-06-30T22:00+08:00",
    fxLink: "https://qweather.example/weather",
    now: {
      obsTime: "2026-06-30T21:50+08:00",
      temp: "28",
      text: "晴",
    },
    refer: {
      sources: ["QWeather"],
      license: ["QWeather Developers License"],
    },
    ...overrides,
  };
}

function validSunResponse(overrides: Record<string, unknown> = {}) {
  return {
    code: "200",
    updateTime: "2026-06-30T11:00+08:00",
    fxLink: "https://qweather.example/sun",
    sunrise: "2026-06-30T05:53+08:00",
    sunset: "2026-06-30T18:02+08:00",
    refer: {
      sources: ["QWeather"],
      license: ["QWeather Developers License"],
    },
    ...overrides,
  };
}

describe("QWeatherClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches QWeather weather and sun data from stored WGS84 geo location and normalizes the response", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(validWeatherNowResponse())
      .mockResolvedValueOnce(validSunResponse());
    const client = new QWeatherClient(
      {
        ...configuredQWeatherClient,
        weatherNowPath: "/v7/weather/now",
        sunPath: "/v7/astronomy/sun",
      },
      fetchJson,
    );

    const result = await client.fetchExternalNaturalEnvironment(
      machineGeoLocationInput,
    );

    expect(fetchJson).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://abcxyz.qweatherapi.com/v7/weather/now?location=121.47%2C31.23&unit=m",
        headers: { "X-QW-Api-Key": "secret-qweather-api-key" },
      }),
    );
    expect(fetchJson).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://abcxyz.qweatherapi.com/v7/astronomy/sun?location=121.47%2C31.23&date=20260630",
        headers: { "X-QW-Api-Key": "secret-qweather-api-key" },
      }),
    );
    expect(result).toEqual({
      localTime: {
        timezone: "Asia/Shanghai",
        localDate: "2026-06-30",
        localClock: "22:00:00",
      },
      weather: {
        temperatureCelsius: 28,
        conditionText: "晴",
        observedAt: "2026-06-30T13:50:00.000Z",
      },
      sun: {
        sunriseAt: "2026-06-29T21:53:00.000Z",
        sunsetAt: "2026-06-30T10:02:00.000Z",
      },
    });
  });

  it("reports unavailable when QWeather returns a non-200 provider code", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(validWeatherNowResponse({ code: "401" }))
      .mockResolvedValueOnce(validSunResponse());
    const client = new QWeatherClient(configuredQWeatherClient, fetchJson);

    await expect(
      client.fetchExternalNaturalEnvironment(machineGeoLocationInput),
    ).rejects.toThrow("QWeather provider unavailable");
  });

  it("reports unavailable when QWeather returns malformed provider bodies", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ code: "200", now: null })
      .mockResolvedValueOnce(validSunResponse());
    const client = new QWeatherClient(configuredQWeatherClient, fetchJson);

    await expect(
      client.fetchExternalNaturalEnvironment(machineGeoLocationInput),
    ).rejects.toThrow("QWeather provider unavailable");
  });

  it.each([
    {
      name: "temperature",
      weather: validWeatherNowResponse({
        now: { obsTime: "2026-06-30T21:50+08:00", temp: "hot", text: "晴" },
      }),
      sun: validSunResponse(),
    },
    {
      name: "weather observation time",
      weather: validWeatherNowResponse({
        now: { obsTime: "not-a-time", temp: "28", text: "晴" },
      }),
      sun: validSunResponse(),
    },
    {
      name: "sunrise time",
      weather: validWeatherNowResponse(),
      sun: validSunResponse({ sunrise: "not-a-time" }),
    },
  ])(
    "reports unavailable for invalid QWeather $name fields",
    async (response) => {
      const fetchJson = vi
        .fn()
        .mockResolvedValueOnce(response.weather)
        .mockResolvedValueOnce(response.sun);
      const client = new QWeatherClient(configuredQWeatherClient, fetchJson);

      await expect(
        client.fetchExternalNaturalEnvironment(machineGeoLocationInput),
      ).rejects.toThrow("QWeather provider unavailable");
    },
  );

  it.each([
    { name: "API key", config: { apiHost: "abcxyz.qweatherapi.com" } },
    { name: "API host", config: { apiKey: "secret-qweather-api-key" } },
  ])(
    "reports unavailable when QWeather $name config is missing",
    async (case_) => {
      const fetchJson = vi.fn();
      const client = new QWeatherClient(
        {
          ...case_.config,
          weatherNowPath: "/v7/weather/now",
          sunPath: "/v7/astronomy/sun",
        },
        fetchJson,
      );

      await expect(
        client.fetchExternalNaturalEnvironment(machineGeoLocationInput),
      ).rejects.toThrow("QWeather provider is not configured");
      expect(fetchJson).not.toHaveBeenCalled();
    },
  );

  it("redacts QWeather credentials from provider error diagnostics", async () => {
    const fetchJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret-qweather-api-key"));
    const client = new QWeatherClient(configuredQWeatherClient, fetchJson);

    const promise = client.fetchExternalNaturalEnvironment(
      machineGeoLocationInput,
    );

    await expect(promise).rejects.toThrow("QWeather provider unavailable");
    await expect(promise).rejects.not.toThrow("secret-qweather-api-key");
  });

  it("times out hung QWeather fetches with the configured provider timeout", async () => {
    vi.useFakeTimers();
    const fetchJson = vi.fn(() => new Promise<unknown>(() => undefined));
    const client = new QWeatherClient(
      {
        ...configuredQWeatherClient,
        timeoutMs: 25,
      },
      fetchJson,
    );

    const promise = client.fetchExternalNaturalEnvironment(
      machineGeoLocationInput,
    );
    let settled = false;
    void promise
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(25);

    expect(settled).toBe(true);
    await expect(promise).rejects.toThrow("QWeather provider unavailable");
  });
});
