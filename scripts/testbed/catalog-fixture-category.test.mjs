import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { categoryKeyForFixtureProduct } from "./local-testbed.mjs";

describe("testbed catalog fixture category", () => {
  it("uses the same keyword classification as the Machine Catalog", () => {
    assert.equal(
      categoryKeyForFixtureProduct({ category: "内衣", name: "基础款" }),
      "underwear",
    );
    assert.equal(
      categoryKeyForFixtureProduct({ category: "上装", name: "短袖上衣" }),
      "tshirts",
    );
    assert.equal(
      categoryKeyForFixtureProduct({ category: null, name: "男士平角裤" }),
      "underwear",
    );
    assert.equal(
      categoryKeyForFixtureProduct({ category: "", name: "女款短袖" }),
      "tshirts",
    );
  });
});
