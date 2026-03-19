import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { squareRoot, squareRootWithBaseline } from "./index.js";

describe("squareRoot", () => {
  it("should return floor(sqrt(n)) for small values", () => {
    assert.equal(squareRoot(4), 2);
    assert.equal(squareRoot(9), 3);
    assert.equal(squareRoot(100), 10);
  });

  it("should return at least 1", () => {
    assert.equal(squareRoot(0), 1);
    assert.equal(squareRoot(1), 1);
  });

  it("should handle values above lookup table", () => {
    assert.equal(squareRoot(10000), 100);
    assert.equal(squareRoot(1000000), 1000);
  });
});

describe("squareRootWithBaseline", () => {
  it("should return max(baseline, sqrt(n))", () => {
    const fn = squareRootWithBaseline(5);
    assert.equal(fn(4), 5);   // sqrt(4)=2 < 5
    assert.equal(fn(100), 10); // sqrt(100)=10 > 5
  });
});

