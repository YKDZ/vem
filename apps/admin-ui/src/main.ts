import "antdv-next/dist/reset.css";
import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { installAntdv } from "./plugins/antdv";
import { router } from "./router";
import "./style.css";

const app = createApp(App);

app.use(createPinia());
app.use(router);
installAntdv(app);

app.mount("#app");
