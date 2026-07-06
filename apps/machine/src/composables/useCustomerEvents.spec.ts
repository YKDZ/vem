// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApp, defineComponent } from "vue";

import {
  emitCustomerEvent,
  onCustomerEvent,
  useCustomerEvents,
} from "./useCustomerEvents";

describe("customer experience event bus", () => {
  it("lets feature code subscribe to semantic customer events", () => {
    const listener = vi.fn();
    const unsubscribe = onCustomerEvent(listener);

    emitCustomerEvent({
      type: "interaction.awakened",
      requestedAt: "2026-07-02T13:00:00.000Z",
    });
    unsubscribe();
    emitCustomerEvent({
      type: "idle.sleep",
      requestedAt: "2026-07-02T13:00:30.000Z",
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      type: "interaction.awakened",
      requestedAt: "2026-07-02T13:00:00.000Z",
    });
  });

  it("cleans composable subscriptions when the component unmounts", () => {
    const listener = vi.fn();
    const host = document.createElement("div");
    const App = defineComponent({
      setup() {
        useCustomerEvents().on(listener);
        return () => null;
      },
    });
    const app = createApp(App);

    app.mount(host);
    emitCustomerEvent({ type: "product.selected" });
    app.unmount();
    emitCustomerEvent({ type: "payment.prompt", orderKey: "ORDER-1" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ type: "product.selected" });
  });
});
