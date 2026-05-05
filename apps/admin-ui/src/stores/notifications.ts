import { defineStore } from "pinia";

import { listNotifications } from "@/api/notifications";

export const useNotificationsStore = defineStore("notifications", {
  state: () => ({
    unreadCount: 0,
  }),
  actions: {
    async refreshUnreadCount(): Promise<void> {
      try {
        const result = await listNotifications({
          status: "unread",
          page: 1,
          pageSize: 1,
        });
        this.unreadCount = result.total;
      } catch {
        // silently ignore
      }
    },
  },
});
