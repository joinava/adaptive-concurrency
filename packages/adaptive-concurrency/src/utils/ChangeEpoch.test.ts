import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChangeEpoch } from "./ChangeEpoch.js";

describe("ChangeEpoch", () => {
  it("allows the first change", () => {
    const epoch = new ChangeEpoch();
    assert.equal(epoch.tryChange(0, 10), true);
  });

  it("refuses samples that started before the last change", () => {
    const epoch = new ChangeEpoch();
    assert.equal(epoch.tryChange(0, 100), true);
    // Started at 50, before the change at 100: admitted under the old limit.
    assert.equal(epoch.tryChange(50, 150), false);
    assert.equal(epoch.tryChange(99, 160), false);
  });

  it("allows a sample that started at or after the last change", () => {
    const epoch = new ChangeEpoch();
    assert.equal(epoch.tryChange(0, 100), true);
    assert.equal(epoch.tryChange(100, 200), true);
    assert.equal(epoch.tryChange(150, 250), false);
    assert.equal(epoch.tryChange(200, 300), true);
  });

  it("a refused attempt does not move the epoch", () => {
    const epoch = new ChangeEpoch();
    assert.equal(epoch.tryChange(0, 100), true);
    assert.equal(epoch.tryChange(10, 500), false);
    // Epoch still starts at 100, not 500.
    assert.equal(epoch.tryChange(100, 600), true);
  });
});
