import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LinkedWaiterQueue } from "./LinkedWaiterQueue.js";

type TestWaiter = {
  id: string;
  handle: { key: symbol };
};

describe("LinkedWaiterQueue", () => {
  it("uses FIFO ordering when enqueue direction is back", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("back");

    const first = queue.enqueue({ id: "first" });
    const second = queue.enqueue({ id: "second" });

    assert.equal(queue.peekHead(), first);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(first.handle), true);
    assert.equal(queue.peekHead(), second);
    assert.equal(queue.size(), 1);
  });

  it("uses LIFO ordering when enqueue direction is front", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("front");

    const first = queue.enqueue({ id: "first" });
    const second = queue.enqueue({ id: "second" });

    assert.equal(queue.peekHead(), second);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(second.handle), true);
    assert.equal(queue.peekHead(), first);
    assert.equal(queue.size(), 1);
  });

  it("allows a single enqueue to override back direction with front", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("back");

    const first = queue.enqueue({ id: "first" });
    const overridden = queue.enqueue({ id: "override-front" }, "front");

    assert.equal(queue.peekHead(), overridden);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(overridden.handle), true);
    assert.equal(queue.peekHead(), first);
  });

  it("allows a single enqueue to override front direction with back", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("front");

    const first = queue.enqueue({ id: "first" });
    const overridden = queue.enqueue({ id: "override-back" }, "back");

    assert.equal(queue.peekHead(), first);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(first.handle), true);
    assert.equal(queue.peekHead(), overridden);
  });

  it("supports O(1)-style removal by handle from middle", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("back");

    const first = queue.enqueue({ id: "first" });
    const middle = queue.enqueue({ id: "middle" });
    const last = queue.enqueue({ id: "last" });

    assert.equal(queue.removeByHandle(middle.handle), true);
    assert.equal(queue.size(), 2);
    assert.equal(queue.peekHead(), first);

    assert.equal(queue.removeByHandle(first.handle), true);
    assert.equal(queue.peekHead(), last);
    assert.equal(queue.size(), 1);
  });

  it("returns false when removing an unknown handle", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("back");
    queue.enqueue({ id: "first" });

    assert.equal(queue.removeByHandle({ key: Symbol("unknown") }), false);
    assert.equal(queue.size(), 1);
  });

  it("returns false when removing the same waiter twice", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>("back");
    const waiter = queue.enqueue({ id: "first" });

    assert.equal(queue.removeByHandle(waiter.handle), true);
    assert.equal(queue.removeByHandle(waiter.handle), false);
    assert.equal(queue.size(), 0);
    assert.equal(queue.peekHead(), undefined);
  });
});
