import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeMultiplicativeDecrease } from "./multiplicativeDecrease.js";

describe("makeMultiplicativeDecrease", () => {
  it("multiplies by the ratio and floors", () => {
    const decrease = makeMultiplicativeDecrease({ ratio: 0.9, jitter: 0 });
    assert.equal(decrease(100), 90);
    assert.equal(decrease(15), 13);
  });

  it("defaults to ratio 0.9 with jitter 0.02", () => {
    const decrease = makeMultiplicativeDecrease(undefined);
    const observed = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const next = decrease(1000);
      assert.ok(next >= 880 && next <= 920, `got ${next}`);
      observed.add(next);
    }
    assert.ok(observed.size > 1, "jitter should vary the result");
  });

  it("rejects invalid ratios", () => {
    assert.throws(
      () => makeMultiplicativeDecrease({ ratio: 1.0 }),
      /decrease\.ratio must be in the range/,
    );
    assert.throws(
      () => makeMultiplicativeDecrease({ ratio: 0.4 }),
      /decrease\.ratio must be in the range/,
    );
    assert.throws(
      () => makeMultiplicativeDecrease({ ratio: Number.NaN }),
      /decrease\.ratio must be in the range/,
    );
  });

  it("rejects invalid jitter", () => {
    assert.throws(
      () => makeMultiplicativeDecrease({ jitter: -0.01 }),
      /decrease\.jitter must be in the range/,
    );
    assert.throws(
      () => makeMultiplicativeDecrease({ jitter: 0.06 }),
      /decrease\.jitter must be in the range/,
    );
  });

  it("rejects a ratio and jitter that could reach 1.0", () => {
    assert.throws(
      () => makeMultiplicativeDecrease({ ratio: 0.98, jitter: 0.02 }),
      /must be < 1\.0/,
    );
  });
});
