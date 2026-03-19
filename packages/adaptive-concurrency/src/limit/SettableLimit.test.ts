import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SettableLimit } from "./SettableLimit.js";

describe("SettableLimit subscriptions", () => {
  it("should allow unsubscribing from limit updates", () => {
    const limit = new SettableLimit(10);
    const observed: Array<number> = [];

    const unsubscribe = limit.subscribe((newLimit) => observed.push(newLimit));
    limit.setLimit(11);
    unsubscribe();
    limit.setLimit(12);

    assert.deepEqual(observed, [11]);
  });

  it("should unsubscribe automatically when abort signal is triggered", () => {
    const limit = new SettableLimit(10);
    const observed: Array<number> = [];
    const controller = new AbortController();

    limit.subscribe((newLimit) => observed.push(newLimit), {
      signal: controller.signal,
    });

    limit.setLimit(11);
    controller.abort();
    limit.setLimit(12);

    assert.deepEqual(observed, [11]);
  });
});
