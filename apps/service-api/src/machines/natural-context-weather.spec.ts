import { describe, expect, it } from "vitest";

import { weatherConditionClassesFor } from "./natural-context-weather";

describe("weatherConditionClassesFor", () => {
  it("classifies QWeather condition code and wind force into prioritized current-weather classes", () => {
    expect(
      weatherConditionClassesFor({ conditionCode: "305", windScale: 8 }),
    ).toEqual({
      weatherConditionClasses: ["strong_wind", "light_rain"],
      primaryWeatherConditionClass: "strong_wind",
    });
    expect(
      weatherConditionClassesFor({ conditionCode: "304", windScale: 3 }),
    ).toEqual({
      weatherConditionClasses: ["hail"],
      primaryWeatherConditionClass: "hail",
    });
    expect(
      weatherConditionClassesFor({ conditionCode: "405", windScale: 2 }),
    ).toEqual({
      weatherConditionClasses: ["snow"],
      primaryWeatherConditionClass: "snow",
    });
    expect(
      weatherConditionClassesFor({ conditionCode: "315", windScale: 2 }),
    ).toEqual({
      weatherConditionClasses: ["moderate_or_heavy_rain"],
      primaryWeatherConditionClass: "moderate_or_heavy_rain",
    });
  });

  it("uses other only when no special current-weather class matches", () => {
    expect(
      weatherConditionClassesFor({ conditionCode: "100", windScale: 3 }),
    ).toEqual({
      weatherConditionClasses: ["other"],
      primaryWeatherConditionClass: "other",
    });
  });
});
