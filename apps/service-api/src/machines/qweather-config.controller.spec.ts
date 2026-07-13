import { describe, expect, it } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { QweatherConfigController } from "./qweather-config.controller";

describe("QweatherConfigController", () => {
  it("读取和写入分别要求机器读写权限", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        QweatherConfigController.prototype.getConfig,
      ),
    ).toEqual(["machines.read"]);
    expect(
      Reflect.getMetadata(
        REQUIRED_PERMISSIONS_KEY,
        QweatherConfigController.prototype.updateConfig,
      ),
    ).toEqual(["machines.write"]);
  });
});
