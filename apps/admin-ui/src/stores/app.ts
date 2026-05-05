import { defineStore } from "pinia";

export const useAppStore = defineStore("app", {
  state: () => ({
    sidebarCollapsed: false,
  }),
  actions: {
    setSidebarCollapsed(value: boolean): void {
      this.sidebarCollapsed = value;
    },
  },
});
