// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { CustomerExperienceEvent } from "@/customer-events/events";

import { onCustomerExperienceEvent } from "./useCustomerExperienceEvents";

import {
  installCustomerAudioCueEventSource,
  recordCustomerAudioCueSourceFact,
  resetCustomerAudioCueEventSourceForTests,
} from "./useCustomerAudioCueEventSource";

describe("customer audio cue event source", () => {
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
});
