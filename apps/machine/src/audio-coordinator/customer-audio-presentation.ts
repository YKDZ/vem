import type { CustomerJourneyTransition } from "@/customer-journey/transition-projector";

const VOICE_BASE_PATH = "/audio/voice";

export type CustomerAudioPresentationContext = {
  primaryFestival: string | null;
  solarTerm: string | null;
  temperatureCelsius: number | null;
  weatherConditionClasses: readonly string[];
};

export type CustomerJourneyAudioPresentation = {
  sourceUrl: string;
  priority: number;
};

const FESTIVAL_AUDIO_KEY: Readonly<Record<string, string>> = {
  spring_festival: "spring_festival",
  new_years_day: "new_years_day",
  lantern_festival: "lantern_festival",
  valentines_day: "valentines_day",
  qixi_festival: "qixi_festival",
  labor_day: "labor_day",
  dragon_boat_festival: "dragon_boat",
  mid_autumn_festival: "mid_autumn",
  national_day: "national_day",
};

export function mapCustomerJourneyAudioPresentation(
  transition: CustomerJourneyTransition,
  context: CustomerAudioPresentationContext,
): CustomerJourneyAudioPresentation | null {
  switch (transition.kind) {
    case "touchscreen.awakened":
    case "presence.welcome":
      return presentation(contextualWelcomeSource(context), 30);
    case "privacy.crowd_detected":
      return presentation(`${VOICE_BASE_PATH}/privacy/crowd_detected.mp3`, 80);
    case "presence.departed":
      return presentation(departureSource(context), 60);
    case "category.entered":
      return presentation(productSource(transition.productCategory), 35);
    case "product.selected":
      return null;
    case "payment.prompt":
      return presentation(`${VOICE_BASE_PATH}/payment/prompt.mp3`, 35);
    case "payment.succeeded":
      return presentation(`${VOICE_BASE_PATH}/payment/succeeded.mp3`, 40);
    case "payment.failed":
      return presentation(`${VOICE_BASE_PATH}/payment/failed.mp3`, 90);
    case "dispensing.started":
      return presentation(`${VOICE_BASE_PATH}/dispensing/started.mp3`, 40);
    case "pickup.outlet_opened":
      return presentation(`${VOICE_BASE_PATH}/dispensing/succeeded.mp3`, 40);
    case "pickup.waiting":
    case "pickup.resetting":
      return presentation(`${VOICE_BASE_PATH}/dispensing/started.mp3`, 40);
    case "pickup.warning":
      return presentation(`${VOICE_BASE_PATH}/pickup/reminder_10s.mp3`, 45);
    case "pickup.urgent":
      return presentation(`${VOICE_BASE_PATH}/pickup/reminder_25s.mp3`, 70);
    case "pickup.completed":
      return presentation(`${VOICE_BASE_PATH}/effects/pickup_beep.mp3`, 50);
    case "dispense.succeeded":
      return presentation(`${VOICE_BASE_PATH}/dispensing/succeeded.mp3`, 60);
    case "dispense.failed":
      return presentation(`${VOICE_BASE_PATH}/error/dispense_failed.mp3`, 90);
    case "refund.pending":
      return presentation(`${VOICE_BASE_PATH}/refund/pending.mp3`, 70);
    case "refund.completed":
      return presentation(`${VOICE_BASE_PATH}/refund/completed.mp3`, 70);
    case "manual_handling.required":
      return presentation(`${VOICE_BASE_PATH}/error/hardware_fault.mp3`, 100);
  }
}

function presentation(
  sourceUrl: string,
  priority: number,
): CustomerJourneyAudioPresentation {
  return { sourceUrl, priority };
}

function contextualWelcomeSource(
  context: CustomerAudioPresentationContext,
): string {
  const festivalKey = context.primaryFestival
    ? FESTIVAL_AUDIO_KEY[context.primaryFestival]
    : null;
  if (festivalKey) {
    return `${VOICE_BASE_PATH}/easter_egg/festival/${festivalKey}.mp3`;
  }
  if (context.solarTerm) {
    return `${VOICE_BASE_PATH}/easter_egg/solar_term/${context.solarTerm}.mp3`;
  }
  return `${VOICE_BASE_PATH}/interaction/awakened.mp3`;
}

function productSource(category: string | null): string {
  if (category?.includes("内裤"))
    return `${VOICE_BASE_PATH}/product/underwear.mp3`;
  if (category?.includes("T恤")) return `${VOICE_BASE_PATH}/product/tshirt.mp3`;
  if (category?.includes("袜")) return `${VOICE_BASE_PATH}/product/socks.mp3`;
  return `${VOICE_BASE_PATH}/interaction/product_selected.mp3`;
}

function departureSource(context: CustomerAudioPresentationContext): string {
  const conditions = context.weatherConditionClasses;
  if ((context.temperatureCelsius ?? Number.NEGATIVE_INFINITY) >= 35) {
    return `${VOICE_BASE_PATH}/departure/bad_weather/high_temp.mp3`;
  }
  if (conditions.includes("moderate_or_heavy_rain")) {
    return `${VOICE_BASE_PATH}/departure/bad_weather/heavy_rain.mp3`;
  }
  if (conditions.includes("light_rain")) {
    return `${VOICE_BASE_PATH}/departure/bad_weather/light_rain.mp3`;
  }
  if (conditions.includes("snow")) {
    return `${VOICE_BASE_PATH}/departure/bad_weather/snow.mp3`;
  }
  if (conditions.includes("strong_wind")) {
    return `${VOICE_BASE_PATH}/departure/bad_weather/strong_wind.mp3`;
  }
  if (conditions.includes("hail")) {
    return `${VOICE_BASE_PATH}/departure/bad_forecast/hail.mp3`;
  }
  return `${VOICE_BASE_PATH}/departure/normal_weather/sunny.mp3`;
}
