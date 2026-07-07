export type EasterEggType =
  | "spring_festival"
  | "new_years_day"
  | "lantern_festival"
  | "valentines_day"
  | "qixi_festival"
  | "labor_day"
  | "dragon_boat"
  | "mid_autumn"
  | "national_day"
  | "minor_cold"
  | "major_cold"
  | "start_of_spring"
  | "rain_water"
  | "awakening_of_insects"
  | "spring_equinox"
  | "clear_and_bright"
  | "grain_rain"
  | "start_of_summer"
  | "grain_buds"
  | "grain_in_ear"
  | "summer_solstice"
  | "minor_heat"
  | "major_heat"
  | "start_of_autumn"
  | "end_of_heat"
  | "white_dew"
  | "autumn_equinox"
  | "cold_dew"
  | "frost_descent"
  | "start_of_winter"
  | "minor_snow"
  | "major_snow"
  | "winter_solstice"
  | "spring"
  | "summer"
  | "autumn"
  | "winter";

export type DepartureWeatherType =
  | "high_temp"
  | "light_rain"
  | "heavy_rain"
  | "thunder"
  | "snow"
  | "strong_wind"
  | "bad_air"
  | "sunny"
  | "cloudy";

export type DepartureForecastType =
  | "light_rain"
  | "heavy_rain"
  | "snow"
  | "strong_wind"
  | "hail";

export type ProductCategory = "socks" | "underwear" | "tshirt";

export type ProductId = string;

const VOICE_BASE_PATH = "/audio/voice";

export const EASTER_EGG_SOURCES: Record<EasterEggType, string> = {
  spring_festival: `${VOICE_BASE_PATH}/easter_egg/festival/spring_festival.mp3`,
  new_years_day: `${VOICE_BASE_PATH}/easter_egg/festival/new_years_day.mp3`,
  lantern_festival: `${VOICE_BASE_PATH}/easter_egg/festival/lantern_festival.mp3`,
  valentines_day: `${VOICE_BASE_PATH}/easter_egg/festival/valentines_day.mp3`,
  qixi_festival: `${VOICE_BASE_PATH}/easter_egg/festival/qixi_festival.mp3`,
  labor_day: `${VOICE_BASE_PATH}/easter_egg/festival/labor_day.mp3`,
  dragon_boat: `${VOICE_BASE_PATH}/easter_egg/festival/dragon_boat.mp3`,
  mid_autumn: `${VOICE_BASE_PATH}/easter_egg/festival/mid_autumn.mp3`,
  national_day: `${VOICE_BASE_PATH}/easter_egg/festival/national_day.mp3`,
  minor_cold: `${VOICE_BASE_PATH}/easter_egg/solar_term/minor_cold.mp3`,
  major_cold: `${VOICE_BASE_PATH}/easter_egg/solar_term/major_cold.mp3`,
  start_of_spring: `${VOICE_BASE_PATH}/easter_egg/solar_term/start_of_spring.mp3`,
  rain_water: `${VOICE_BASE_PATH}/easter_egg/solar_term/rain_water.mp3`,
  awakening_of_insects: `${VOICE_BASE_PATH}/easter_egg/solar_term/awakening_of_insects.mp3`,
  spring_equinox: `${VOICE_BASE_PATH}/easter_egg/solar_term/spring_equinox.mp3`,
  clear_and_bright: `${VOICE_BASE_PATH}/easter_egg/solar_term/clear_and_bright.mp3`,
  grain_rain: `${VOICE_BASE_PATH}/easter_egg/solar_term/grain_rain.mp3`,
  start_of_summer: `${VOICE_BASE_PATH}/easter_egg/solar_term/start_of_summer.mp3`,
  grain_buds: `${VOICE_BASE_PATH}/easter_egg/solar_term/grain_buds.mp3`,
  grain_in_ear: `${VOICE_BASE_PATH}/easter_egg/solar_term/grain_in_ear.mp3`,
  summer_solstice: `${VOICE_BASE_PATH}/easter_egg/solar_term/summer_solstice.mp3`,
  minor_heat: `${VOICE_BASE_PATH}/easter_egg/solar_term/minor_heat.mp3`,
  major_heat: `${VOICE_BASE_PATH}/easter_egg/solar_term/major_heat.mp3`,
  start_of_autumn: `${VOICE_BASE_PATH}/easter_egg/solar_term/start_of_autumn.mp3`,
  end_of_heat: `${VOICE_BASE_PATH}/easter_egg/solar_term/end_of_heat.mp3`,
  white_dew: `${VOICE_BASE_PATH}/easter_egg/solar_term/white_dew.mp3`,
  autumn_equinox: `${VOICE_BASE_PATH}/easter_egg/solar_term/autumn_equinox.mp3`,
  cold_dew: `${VOICE_BASE_PATH}/easter_egg/solar_term/cold_dew.mp3`,
  frost_descent: `${VOICE_BASE_PATH}/easter_egg/solar_term/frost_descent.mp3`,
  start_of_winter: `${VOICE_BASE_PATH}/easter_egg/solar_term/start_of_winter.mp3`,
  minor_snow: `${VOICE_BASE_PATH}/easter_egg/solar_term/minor_snow.mp3`,
  major_snow: `${VOICE_BASE_PATH}/easter_egg/solar_term/major_snow.mp3`,
  winter_solstice: `${VOICE_BASE_PATH}/easter_egg/solar_term/winter_solstice.mp3`,
  spring: `${VOICE_BASE_PATH}/easter_egg/season/spring.mp3`,
  summer: `${VOICE_BASE_PATH}/easter_egg/season/summer.mp3`,
  autumn: `${VOICE_BASE_PATH}/easter_egg/season/autumn.mp3`,
  winter: `${VOICE_BASE_PATH}/easter_egg/season/winter.mp3`,
};

export const INTERACTION_SOURCES: Record<string, string> = {
  awakened: `${VOICE_BASE_PATH}/interaction/awakened.mp3`,
  product_selected: `${VOICE_BASE_PATH}/interaction/product_selected.mp3`,
};

export const PAYMENT_SOURCES: Record<string, string> = {
  prompt: `${VOICE_BASE_PATH}/payment/prompt.mp3`,
  succeeded: `${VOICE_BASE_PATH}/payment/succeeded.mp3`,
};

export const DISPENSING_SOURCES: Record<string, string> = {
  started: `${VOICE_BASE_PATH}/dispensing/started.mp3`,
  succeeded: `${VOICE_BASE_PATH}/dispensing/succeeded.mp3`,
};

export const PICKUP_SOURCES: Record<string, string> = {
  reminder_10s: `${VOICE_BASE_PATH}/pickup/reminder_10s.mp3`,
  reminder_25s: `${VOICE_BASE_PATH}/pickup/reminder_25s.mp3`,
};

export const DEPARTURE_BAD_WEATHER_SOURCES: Record<DepartureWeatherType, string> = {
  high_temp: `${VOICE_BASE_PATH}/departure/bad_weather/high_temp.mp3`,
  light_rain: `${VOICE_BASE_PATH}/departure/bad_weather/light_rain.mp3`,
  heavy_rain: `${VOICE_BASE_PATH}/departure/bad_weather/heavy_rain.mp3`,
  thunder: `${VOICE_BASE_PATH}/departure/bad_weather/thunder.mp3`,
  snow: `${VOICE_BASE_PATH}/departure/bad_weather/snow.mp3`,
  strong_wind: `${VOICE_BASE_PATH}/departure/bad_weather/strong_wind.mp3`,
  bad_air: `${VOICE_BASE_PATH}/departure/bad_air.mp3`,
  sunny: "",
  cloudy: "",
};

export const DEPARTURE_BAD_FORECAST_SOURCES: Record<DepartureForecastType, string> = {
  light_rain: `${VOICE_BASE_PATH}/departure/bad_forecast/light_rain.mp3`,
  heavy_rain: `${VOICE_BASE_PATH}/departure/bad_forecast/heavy_rain.mp3`,
  snow: `${VOICE_BASE_PATH}/departure/bad_forecast/snow.mp3`,
  strong_wind: `${VOICE_BASE_PATH}/departure/bad_forecast/strong_wind.mp3`,
  hail: `${VOICE_BASE_PATH}/departure/bad_forecast/hail.mp3`,
};

export const DEPARTURE_NORMAL_WEATHER_SOURCES: Record<string, string> = {
  sunny: `${VOICE_BASE_PATH}/departure/normal_weather/sunny.mp3`,
  cloudy: `${VOICE_BASE_PATH}/departure/normal_weather/cloudy.mp3`,
};

export const PRIVACY_SOURCES: Record<string, string> = {
  crowd_detected: `${VOICE_BASE_PATH}/privacy/crowd_detected.mp3`,
};

export const ERROR_SOURCES: Record<string, string> = {
  dispense_failed: `${VOICE_BASE_PATH}/error/dispense_failed.mp3`,
  hardware_fault: `${VOICE_BASE_PATH}/error/hardware_fault.mp3`,
  idle_timeout: `${VOICE_BASE_PATH}/error/idle_timeout.mp3`,
};

export const EFFECT_SOURCES: Record<string, string> = {
  pickup_beep: `${VOICE_BASE_PATH}/effects/pickup_beep.mp3`,
};

export const PRODUCT_INTRO_SOURCES: Record<string, string> = {
  socks: `${VOICE_BASE_PATH}/product/socks.mp3`,
  underwear: `${VOICE_BASE_PATH}/product/underwear.mp3`,
  tshirt: `${VOICE_BASE_PATH}/product/tshirt.mp3`,
};

export function getEasterEggSource(type: EasterEggType): string {
  return EASTER_EGG_SOURCES[type];
}

export function getInteractionSource(type: string): string {
  return INTERACTION_SOURCES[type] || "";
}

export function getPaymentSource(type: string): string {
  return PAYMENT_SOURCES[type] || "";
}

export function getDispensingSource(type: string): string {
  return DISPENSING_SOURCES[type] || "";
}

export function getPickupSource(type: string): string {
  return PICKUP_SOURCES[type] || "";
}

export function getDepartureBadWeatherSource(type: DepartureWeatherType): string {
  return DEPARTURE_BAD_WEATHER_SOURCES[type] || "";
}

export function getDepartureBadForecastSource(type: DepartureForecastType): string {
  return DEPARTURE_BAD_FORECAST_SOURCES[type] || "";
}

export function getDepartureNormalWeatherSource(type: string): string {
  return DEPARTURE_NORMAL_WEATHER_SOURCES[type] || "";
}

export function getPrivacySource(type: string): string {
  return PRIVACY_SOURCES[type] || "";
}

export function getErrorSource(type: string): string {
  return ERROR_SOURCES[type] || "";
}

export function getEffectSource(type: string): string {
  return EFFECT_SOURCES[type] || "";
}

export function getProductIntroSource(category: string): string {
  return PRODUCT_INTRO_SOURCES[category] || "";
}