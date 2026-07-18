import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { installKioskBrowserGuards } from "./kiosk-browser-guards";
import { router } from "./router";
import { installTransactionRouteAuthority } from "./router/transaction-route-authority";
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
  const pinia = createPinia();

  app.use(pinia);
  installTransactionRouteAuthority(router, pinia);
  app.use(router);

  await router.isReady();
  app.mount("#app");
}

void bootstrap();
