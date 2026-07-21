import { describe, expect, it } from "vitest";

import type {
  CustomerJourneyTransition,
  CustomerJourneyTransitionKind,
} from "@/customer-journey/transition-projector";

import { mapCustomerJourneyAudioPresentation } from "./customer-audio-presentation";

const VOICE_BASE_PATH = "/audio/voice";
const defaultContext = {
  primaryFestival: null,
  solarTerm: null,
  temperatureCelsius: null,
  weatherConditionClasses: [],
} as const;

function transition(
  kind: CustomerJourneyTransitionKind,
  input: Partial<CustomerJourneyTransition> = {},
): CustomerJourneyTransition {
  return {
    transitionId: `transition:${kind}`,
    kind,
    category:
      kind === "touchscreen.awakened" ||
      kind === "presence.welcome" ||
      kind === "privacy.crowd_detected" ||
      kind === "presence.departed"
        ? "presence"
        : "transaction",
    orderNo: null,
    occurredAt: "2026-07-18T08:00:00.000Z",
    productCategory: null,
    ...input,
  };
}

describe("customer journey audio presentation", () => {
  it.each([
    ["touchscreen.awakened", "interaction/awakened.mp3", 30],
    ["presence.welcome", "interaction/awakened.mp3", 30],
    ["privacy.crowd_detected", "privacy/crowd_detected.mp3", 80],
    ["presence.departed", "departure/normal_weather/sunny.mp3", 60],
    ["category.entered", "interaction/product_selected.mp3", 35],
    ["payment.prompt", "payment/prompt.mp3", 35],
    ["payment.succeeded", "payment/succeeded.mp3", 40],
    ["payment.failed", "payment/failed.mp3", 90],
    ["dispensing.started", "dispensing/started.mp3", 40],
    ["pickup.outlet_opened", "dispensing/succeeded.mp3", 40],
    ["pickup.waiting", "dispensing/started.mp3", 40],
    ["pickup.warning", "pickup/reminder_10s.mp3", 45],
    ["pickup.urgent", "pickup/reminder_25s.mp3", 70],
    ["pickup.resetting", "dispensing/started.mp3", 40],
    ["pickup.completed", "effects/pickup_beep.mp3", 50],
    ["dispense.succeeded", "dispensing/succeeded.mp3", 60],
    ["dispense.failed", "error/dispense_failed.mp3", 90],
    ["refund.pending", "refund/pending.mp3", 70],
    ["refund.completed", "refund/completed.mp3", 70],
    ["manual_handling.required", "error/hardware_fault.mp3", 100],
  ] as const)(
    "maps %s to its local cue and priority",
    (kind, path, priority) => {
      expect(
        mapCustomerJourneyAudioPresentation(transition(kind), defaultContext),
      ).toEqual({ sourceUrl: `${VOICE_BASE_PATH}/${path}`, priority });
    },
  );

  it("lets the terminal dispense success cue supersede pickup completion", () => {
    const pickupCompleted = mapCustomerJourneyAudioPresentation(
      transition("pickup.completed"),
      defaultContext,
    );
    const dispenseSucceeded = mapCustomerJourneyAudioPresentation(
      transition("dispense.succeeded"),
      defaultContext,
    );

    expect(dispenseSucceeded?.priority).toBeGreaterThan(
      pickupCompleted?.priority ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([
    "spring_festival",
    "new_years_day",
    "lantern_festival",
    "valentines_day",
    "qixi_festival",
    "labor_day",
    "dragon_boat_festival",
    "mid_autumn_festival",
    "national_day",
  ])(
    "uses the %s festival variant without changing welcome identity",
    (festival) => {
      const welcome = transition("presence.welcome", {
        transitionId: "vision:VISION-1:welcome",
      });
      const presentation = mapCustomerJourneyAudioPresentation(welcome, {
        ...defaultContext,
        primaryFestival: festival,
      });

      const expectedAsset =
        festival === "dragon_boat_festival"
          ? "dragon_boat"
          : festival === "mid_autumn_festival"
            ? "mid_autumn"
            : festival;
      expect(presentation).toMatchObject({
        sourceUrl: `${VOICE_BASE_PATH}/easter_egg/festival/${expectedAsset}.mp3`,
      });
      expect(welcome.transitionId).toBe("vision:VISION-1:welcome");
    },
  );

  it.each([
    "autumn_equinox",
    "awakening_of_insects",
    "clear_and_bright",
    "cold_dew",
    "end_of_heat",
    "frost_descent",
    "grain_buds",
    "grain_in_ear",
    "grain_rain",
    "major_cold",
    "major_heat",
    "major_snow",
    "minor_cold",
    "minor_heat",
    "minor_snow",
    "rain_water",
    "spring_equinox",
    "start_of_autumn",
    "start_of_spring",
    "start_of_summer",
    "start_of_winter",
    "summer_solstice",
    "white_dew",
    "winter_solstice",
  ])("uses the %s solar-term variant when no festival applies", (solarTerm) => {
    expect(
      mapCustomerJourneyAudioPresentation(transition("presence.welcome"), {
        ...defaultContext,
        solarTerm,
      }),
    ).toMatchObject({
      sourceUrl: `${VOICE_BASE_PATH}/easter_egg/solar_term/${solarTerm}.mp3`,
    });
  });

  it.each([
    ["内裤", "product/underwear.mp3"],
    ["T恤", "product/tshirt.mp3"],
    ["袜子", "product/socks.mp3"],
    ["其他", "interaction/product_selected.mp3"],
  ])(
    "uses the category variant for %s without changing category entry identity",
    (category, path) => {
      const selected = transition("category.entered", {
        transitionId: "category:entry-1",
        productCategory: category,
      });
      expect(
        mapCustomerJourneyAudioPresentation(selected, defaultContext),
      ).toMatchObject({ sourceUrl: `${VOICE_BASE_PATH}/${path}` });
      expect(selected.transitionId).toBe("category:entry-1");
    },
  );

  it("does not defer a category introduction to product detail selection", () => {
    expect(
      mapCustomerJourneyAudioPresentation(
        transition("product.selected", { productCategory: "袜子" }),
        defaultContext,
      ),
    ).toBeNull();
  });

  it.each([
    [null, [], "departure/normal_weather/sunny.mp3"],
    [35, [], "departure/bad_weather/high_temp.mp3"],
    [null, ["moderate_or_heavy_rain"], "departure/bad_weather/heavy_rain.mp3"],
    [null, ["light_rain"], "departure/bad_weather/light_rain.mp3"],
    [null, ["snow"], "departure/bad_weather/snow.mp3"],
    [null, ["strong_wind"], "departure/bad_weather/strong_wind.mp3"],
    [null, ["hail"], "departure/bad_forecast/hail.mp3"],
  ] as const)(
    "uses departure context %s %s only as a source variant",
    (temperatureCelsius, weatherConditionClasses, path) => {
      const departed = transition("presence.departed", {
        transitionId: "vision:VISION-1:departed",
      });
      expect(
        mapCustomerJourneyAudioPresentation(departed, {
          ...defaultContext,
          temperatureCelsius,
          weatherConditionClasses,
        }),
      ).toMatchObject({ sourceUrl: `${VOICE_BASE_PATH}/${path}` });
      expect(departed.transitionId).toBe("vision:VISION-1:departed");
    },
  );
});
