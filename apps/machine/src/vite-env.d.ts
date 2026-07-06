/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_MOCK_PAYMENT_CONTROLS?: string;
  readonly VITE_ENABLE_ADVANCED_MAINTENANCE_CONFIG?: string;
  readonly VITE_ENABLE_PAYMENT_CODE_DEV_SCAN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<
    Record<string, never>,
    Record<string, never>,
    unknown
  >;
  export default component;
}
