import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomerExperienceEvent } from "@/customer-events/events";

import { emitCustomerEvent } from "@/composables/useCustomerEvents";

import {
  installCustomerAudioCueConsumer,
  resetCustomerAudioCueConsumerForTests,
} from "./customer-audio-consumer";

describe("customer audio cue consumer", () => {
  beforeEach(() => {
    resetCustomerAudioCueConsumerForTests();
  });

  it("forwards customer events to the audio cue consumer", () => {
    const handleCustomerEvent = vi
      .fn<(event: CustomerExperienceEvent) => Promise<boolean>>()
      .mockResolvedValue(true);

    const cleanup = installCustomerAudioCueConsumer({
      consumer: { handleCustomerEvent },
    });
    emitCustomerEvent({
      type: "dispense.succeeded",
      orderKey: "ORDER-1",
    });
    cleanup();
    emitCustomerEvent({
      type: "refund.completed",
      orderKey: "ORDER-1",
    });

    expect(handleCustomerEvent).toHaveBeenCalledOnce();
    expect(handleCustomerEvent).toHaveBeenCalledWith({
      type: "dispense.succeeded",
      orderKey: "ORDER-1",
    });
  });

  it("is idempotent while installed", () => {
    const handleCustomerEvent = vi
      .fn<(event: CustomerExperienceEvent) => Promise<boolean>>()
      .mockResolvedValue(true);
    const consumer = { handleCustomerEvent };

    const firstCleanup = installCustomerAudioCueConsumer({ consumer });
    const secondCleanup = installCustomerAudioCueConsumer({ consumer });
    emitCustomerEvent({
      type: "pickup.completed",
      orderKey: "ORDER-2",
    });
    firstCleanup();
    secondCleanup();

    expect(handleCustomerEvent).toHaveBeenCalledOnce();
  });
});
