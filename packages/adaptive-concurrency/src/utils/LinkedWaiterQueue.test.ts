import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LinkedWaiterQueue } from "./LinkedWaiterQueue.js";

type TestWaiter = {
  id: string;
};

function assertHeadMatchesEnqueued(
  queue: LinkedWaiterQueue<TestWaiter>,
  enqueued: { value: TestWaiter; handle: object },
): void {
  const head = queue.peekHead();
  assert.ok(head);
  assert.equal(head.handle, enqueued.handle);
  assert.deepEqual(head.value, enqueued.value);
}

describe("LinkedWaiterQueue", () => {
  it("uses FIFO ordering when enqueue direction is back", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const first = queue.enqueue({ id: "first" }, { direction: "back" });
    const second = queue.enqueue({ id: "second" }, { direction: "back" });

    assertHeadMatchesEnqueued(queue, first);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(first.handle), true);
    assertHeadMatchesEnqueued(queue, second);
    assert.equal(queue.size(), 1);
  });

  it("uses LIFO ordering when enqueue direction is front", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const first = queue.enqueue({ id: "first" }, { direction: "front" });
    const second = queue.enqueue({ id: "second" }, { direction: "front" });

    assertHeadMatchesEnqueued(queue, second);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(second.handle), true);
    assertHeadMatchesEnqueued(queue, first);
    assert.equal(queue.size(), 1);
  });

  it("allows a single enqueue to override back direction with front", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const first = queue.enqueue({ id: "first" }, { direction: "back" });
    const overridden = queue.enqueue(
      { id: "override-front" },
      { direction: "front" },
    );

    assertHeadMatchesEnqueued(queue, overridden);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(overridden.handle), true);
    assertHeadMatchesEnqueued(queue, first);
  });

  it("allows a single enqueue to override front direction with back", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const first = queue.enqueue({ id: "first" }, { direction: "front" });
    const overridden = queue.enqueue(
      { id: "override-back" },
      { direction: "back" },
    );

    assertHeadMatchesEnqueued(queue, first);
    assert.equal(queue.size(), 2);

    assert.equal(queue.removeByHandle(first.handle), true);
    assertHeadMatchesEnqueued(queue, overridden);
  });

  it("supports O(1)-style removal by handle from middle", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const first = queue.enqueue({ id: "first" }, { direction: "back" });
    const middle = queue.enqueue({ id: "middle" }, { direction: "back" });
    const last = queue.enqueue({ id: "last" }, { direction: "back" });

    assert.equal(queue.removeByHandle(middle.handle), true);
    assert.equal(queue.size(), 2);
    assertHeadMatchesEnqueued(queue, first);

    assert.equal(queue.removeByHandle(first.handle), true);
    assertHeadMatchesEnqueued(queue, last);
    assert.equal(queue.size(), 1);
  });

  it("returns false when removing an unknown handle", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();
    queue.enqueue({ id: "first" }, { direction: "back" });

    assert.equal(queue.removeByHandle({}), false);
    assert.equal(queue.size(), 1);
  });

  it("returns object handles from enqueue and peekHead", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();

    const enqueued = queue.enqueue({ id: "first" }, { direction: "back" });
    const head = queue.peekHead();

    assert.equal(typeof enqueued, "object");
    assert.equal(typeof enqueued.handle, "object");
    assert.ok(head);
    assert.equal(typeof head, "object");
    assert.equal(typeof head.handle, "object");
  });

  it("returns false when removing the same waiter twice", () => {
    const queue = new LinkedWaiterQueue<TestWaiter>();
    const waiter = queue.enqueue({ id: "first" }, { direction: "back" });

    assert.equal(queue.removeByHandle(waiter.handle), true);
    assert.equal(queue.removeByHandle(waiter.handle), false);
    assert.equal(queue.size(), 0);
    assert.equal(queue.peekHead(), undefined);
  });
});
