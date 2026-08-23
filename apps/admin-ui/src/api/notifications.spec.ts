import {
  adminListNotificationsContract,
  adminMarkNotificationReadContract,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { listNotifications, markNotificationRead } from "./notifications";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("notifications api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callAdminEndpointContract).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it("uses complete shared endpoint contracts for list and read", async () => {
    const notificationId = "550e8400-e29b-41d4-a716-446655440000";

    await listNotifications({ status: "unread", page: 3 });
    await markNotificationRead(notificationId);

    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminListNotificationsContract,
      { query: expect.objectContaining({ status: "unread", page: 3 }) },
    );
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminMarkNotificationReadContract,
      { pathParams: { id: notificationId } },
    );
  });
});
