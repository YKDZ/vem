// @vitest-environment jsdom
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CustomerExperienceEvent } from "@/customer-events/events";

import { useNaturalContextStore } from "@/stores/natural-context";

import {
  installCustomerAudioCueEventSource,
  recordCustomerAudioCueSourceFact,
  resetCustomerAudioCueEventSourceForTests,
} from "./useCustomerAudioCueEventSource";
import { onCustomerExperienceEvent } from "./useCustomerExperienceEvents";

function applyNaturalContext(input: {
  checkedAt: string;
  sunriseAt: string;
  sunsetAt: string;
}): void {
  useNaturalContextStore().applySnapshot({
    status: "ready",
    machineCode: "MACHINE-PRESENCE",
    checkedAt: input.checkedAt,
    degraded: false,
    customerFacingBlocked: false,
    externalEnvironment: {
      status: "ready",
      machineCode: "MACHINE-PRESENCE",
      checkedAt: input.checkedAt,
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: input.checkedAt.slice(0, 10),
        localClock: "12:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: 28,
        conditionText: "晴",
        conditionCode: "100",
        observedAt: input.checkedAt,
        weatherConditionClasses: ["other"],
        primaryWeatherConditionClass: "other",
      },
      sun: {
        status: "ready",
        sunriseAt: input.sunriseAt,
        sunsetAt: input.sunsetAt,
      },
      calendar: {
        status: "ready",
        localDate: input.checkedAt.slice(0, 10),
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
    },
    localSiteSignals: {
      status: "unknown",
    },
  });
}

describe("customer audio cue event source", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    resetCustomerAudioCueEventSourceForTests();
  });

  it("publishes source facts through the existing customer experience event bus", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      event: {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:45:00.000Z",
        nowMs: 1_788_522_300_000,
      },
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:45:00.000Z",
        nowMs: 1_788_522_300_000,
      },
    ]);
  });

  it("installs once and stops publishing after cleanup", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    const cleanup = installCustomerAudioCueEventSource();
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      event: {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:46:00.000Z",
      },
    });
    cleanup();
    recordCustomerAudioCueSourceFact({
      event: {
        type: "idle.sleep",
        requestedAt: "2026-07-05T12:46:30.000Z",
      },
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-07-05T12:46:00.000Z",
      },
    ]);
  });

  it("maps confirmed single-person presence facts to day welcome events", () => {
    applyNaturalContext({
      checkedAt: "2026-06-29T04:00:00.000Z",
      sunriseAt: "2026-06-28T21:53:00.000Z",
      sunsetAt: "2026-06-29T10:02:00.000Z",
    });
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T04:01:00.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.welcome.day",
        requestedAt: "2026-06-29T04:01:00.000Z",
      },
    ]);
  });

  it("does not treat restored or unknown occupancy facts as confirmed single-person presence", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:00:00.000Z",
      restored: true,
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: false,
      occupancyState: "none",
      observedAt: "2026-06-29T12:00:05.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "unknown",
      observedAt: "2026-06-29T12:01:00.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:01:03.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:01:03.000Z",
      },
    ]);
  });

  it("lets crowd presence outrank welcome and suppresses unchanged duplicate presence facts", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:10:00.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "single",
      observedAt: "2026-06-29T12:10:01.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "multiple",
      observedAt: "2026-06-29T12:10:02.000Z",
    });
    recordCustomerAudioCueSourceFact({
      type: "vision.presence",
      personPresent: true,
      occupancyState: "multiple",
      observedAt: "2026-06-29T12:10:03.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "presence.detected",
        requestedAt: "2026-06-29T12:10:00.000Z",
      },
      {
        type: "privacy.crowd_detected",
        requestedAt: "2026-06-29T12:10:02.000Z",
      },
    ]);
  });

  it("maps local awakened facts to interaction awakened events", () => {
    const observed: CustomerExperienceEvent[] = [];
    const unsubscribe = onCustomerExperienceEvent((event) => {
      observed.push(event);
    });
    installCustomerAudioCueEventSource();

    recordCustomerAudioCueSourceFact({
      type: "local.awakened",
      requestedAt: "2026-06-29T12:12:00.000Z",
    });

    unsubscribe();
    expect(observed).toEqual([
      {
        type: "interaction.awakened",
        requestedAt: "2026-06-29T12:12:00.000Z",
      },
    ]);
  });
});
