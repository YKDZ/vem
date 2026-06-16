import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
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
  await installDevTools();
  const app = createApp(App);

  app.use(createPinia());
  app.use(router);

  await router.isReady();
  app.mount("#app");
}

void bootstrap();
