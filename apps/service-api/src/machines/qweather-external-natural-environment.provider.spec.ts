import { describe, expect, it, vi } from "vitest";

import { QWeatherClient } from "./qweather-external-natural-environment.provider";

describe("QWeatherClient", () => {
  it("fetches QWeather weather and sun data from stored WGS84 geo location and normalizes the response", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        code: "200",
        updateTime: "2026-06-30T11:00+08:00",
        fxLink: "https://qweather.example/sun",
        sunrise: "2026-06-30T05:53+08:00",
        sunset: "2026-06-30T18:02+08:00",
        refer: {
          sources: ["QWeather"],
          license: ["QWeather Developers License"],
        },
      });
    const client = new QWeatherClient(
      {
        apiToken: "secret-qweather-token",
        apiBaseUrl: "https://api.qweather.example",
        weatherNowPath: "/v7/weather/now",
        sunPath: "/v7/astronomy/sun",
      },
      fetchJson,
    );

    const result = await client.fetchExternalNaturalEnvironment({
      geoLocation: {
        latitude: 31.2304,
        longitude: 121.4737,
        timezone: "Asia/Shanghai",
      },
      checkedAt: new Date("2026-06-30T14:00:00.000Z"),
    });

    expect(fetchJson).toHaveBeenNthCalledWith(1, {
      url: "https://api.qweather.example/v7/weather/now?location=121.47%2C31.23&unit=m",
      authorization: "Bearer secret-qweather-token",
    });
    expect(fetchJson).toHaveBeenNthCalledWith(2, {
      url: "https://api.qweather.example/v7/astronomy/sun?location=121.47%2C31.23&date=20260630",
      authorization: "Bearer secret-qweather-token",
    });
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
});
