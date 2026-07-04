import type { ExternalNaturalEnvironmentWeather } from "./external-natural-environment.provider";

export type WeatherConditionClass =
  | "hail"
  | "snow"
  | "strong_wind"
  | "moderate_or_heavy_rain"
  | "light_rain"
  | "other";

const HAIL_CODES = new Set(["304"]);
const LIGHT_RAIN_CODES = new Set(["305", "309"]);
const MODERATE_OR_HEAVY_RAIN_CODES = new Set([
  "306",
  "307",
  "308",
  "310",
  "311",
  "312",
  "314",
  "315",
  "316",
  "317",
  "318",
]);
const SNOW_CODES = new Set([
  "400",
  "401",
  "402",
  "403",
  "404",
  "405",
  "406",
  "407",
  "408",
  "409",
  "410",
  "456",
  "457",
  "499",
]);

const PRIORITY: WeatherConditionClass[] = [
  "hail",
  "snow",
  "strong_wind",
  "moderate_or_heavy_rain",
  "light_rain",
];

export function weatherConditionClassesFor(
  weather: Pick<
    ExternalNaturalEnvironmentWeather,
    "conditionCode" | "windScale"
  >,
): {
  weatherConditionClasses: WeatherConditionClass[];
  primaryWeatherConditionClass: WeatherConditionClass;
} {
  const matched = new Set<WeatherConditionClass>();
  if (HAIL_CODES.has(weather.conditionCode)) {
    matched.add("hail");
  }
  if (SNOW_CODES.has(weather.conditionCode)) {
    matched.add("snow");
  }
  if (
    weather.windScale !== undefined &&
    Number.isFinite(weather.windScale) &&
    weather.windScale >= 8
  ) {
    matched.add("strong_wind");
  }
  if (MODERATE_OR_HEAVY_RAIN_CODES.has(weather.conditionCode)) {
    matched.add("moderate_or_heavy_rain");
  }
  if (LIGHT_RAIN_CODES.has(weather.conditionCode)) {
    matched.add("light_rain");
  }

  const weatherConditionClasses = PRIORITY.filter((item) => matched.has(item));
  if (weatherConditionClasses.length === 0) {
    return {
      weatherConditionClasses: ["other"],
      primaryWeatherConditionClass: "other",
    };
  }
  return {
    weatherConditionClasses,
    primaryWeatherConditionClass: weatherConditionClasses[0],
  };
}
