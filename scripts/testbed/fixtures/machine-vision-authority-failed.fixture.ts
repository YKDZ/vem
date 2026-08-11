import { it } from "vitest";

it("negative fixture proves the authority rejects failed tests", () => {
  throw new Error("intentional authority fixture failure");
});
