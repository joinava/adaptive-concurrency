import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdaptiveRejectionError,
  AdaptiveTimeoutError,
  isAdaptiveDropError,
} from "./RunResult.js";

describe("RunResult adaptive drop errors", () => {
  it("identifies adaptive timeout/rejection instances as drop errors", () => {
    assert.equal(isAdaptiveDropError(new AdaptiveTimeoutError("timed out")), true);
    assert.equal(isAdaptiveDropError(new AdaptiveRejectionError("rejected")), true);
  });

  it("identifies legacy code-shaped objects as drop errors", () => {
    assert.equal(isAdaptiveDropError({ code: "ADAPTIVE_TIMEOUT" }), true);
    assert.equal(isAdaptiveDropError({ code: "ADAPTIVE_REJECTION" }), true);
  });

  it("does not classify unrelated values as adaptive drop errors", () => {
    assert.equal(isAdaptiveDropError(new Error("boom")), false);
    assert.equal(isAdaptiveDropError({ code: "OTHER" }), false);
    assert.equal(isAdaptiveDropError("ADAPTIVE_REJECTION"), false);
    assert.equal(isAdaptiveDropError(null), false);
  });
});
