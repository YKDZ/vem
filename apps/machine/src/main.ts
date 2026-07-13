import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { installCustomerAudioCueConsumer } from "./audio-cues/customer-audio-consumer";
import { installKioskBrowserGuards } from "./kiosk-browser-guards";
import { installTouchKeyboardPolicy } from "./native/touch-keyboard";
import { router } from "./router";
import "./style.css";

async function installDevTools(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const { installUiDebugDaemon, shouldInstallUiDebugDaemon } =
    await import("./dev/ui-debug-daemon");
  if (shouldInstallUiDebugDaemon()) {
    installUiDebugDaemon();
  }
}

async function bootstrap(): Promise<void> {
  installKioskBrowserGuards();
  await installDevTools();
  const app = createApp(App);

  app.use(createPinia());
  app.use(router);
  installTouchKeyboardPolicy({
    isAllowed: () => router.currentRoute.value.meta.touchKeyboard === "allowed",
    afterEach: (handler) => router.afterEach(handler),
  });
  installCustomerAudioCueConsumer();

  await router.isReady();
  app.mount("#app");
}

void bootstrap();
