import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StallLog } from "./StallLog.js";

/** Fake clock + timer: `advance(ms)` moves time and fires due timers in order. */
function fakeTime() {
  let now = 0;
  let nextHandle = 1;
  const tasks = new Map<number, { fn: () => void; at: number }>();
  const timer = {
    setTimeout: (fn: () => void, ms: number): number => {
      const handle = nextHandle++;
      tasks.set(handle, { fn, at: now + ms });
      return handle;
    },
    clearTimeout: (handle: number): void => {
      tasks.delete(handle);
    },
  };
  /**
   * Advance the clock by `ms`, firing every timer that comes due, each at
   * its own scheduled time (so an on-time tick observes no lateness).
   */
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      let next: [number, { fn: () => void; at: number }] | undefined;
      for (const entry of tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at))
          next = entry;
      }
      if (!next) break;
      tasks.delete(next[0]);
      // A timer never fires early, but a frozen clock (a stall) makes
      // it fire late: at whatever the clock says now.
      now = Math.max(now, next[1].at);
      next[1].fn();
    }
    now = target;
  };
  /** Jump the clock by `ms` without letting any timer fire: a stall. */
  const freeze = (ms: number) => {
    now += ms;
  };
  return {
    clock: () => now,
    timer,
    advance,
    freeze,
    pending: () => tasks.size,
  };
}

describe("StallLog", () => {
  it("records nothing while ticks are on time", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer });
    log.start();
    t.advance(1000);
    assert.deepEqual(log.stalls, []);
    assert.equal(log.touched(100, 500), false);
  });

  it("opens a stall at the last responsive tick and closes it at the next on-time tick", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer });
    log.start();
    t.advance(100); // last tick at 100, next due at 110
    t.freeze(300); // now 400; the tick due at 110 fires 290ms late
    t.advance(0);
    assert.equal(log.touched(50, 400), true, "still open");
    t.advance(10); // tick at 410 is on time -> closes
    assert.deepEqual(log.stalls, [{ start: 100, end: 410 }]);
  });

  it("keeps a stall open while ticks stay late (release burst)", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer });
    log.start();
    t.advance(100);
    t.freeze(300);
    t.advance(0); // late tick opens the stall
    // The loop keeps stumbling: each tick, due 10ms after the last one
    // fired, fires 30ms late.
    for (let i = 0; i < 3; i++) {
      t.freeze(40);
      t.advance(0);
    }
    assert.equal(log.stalls.length, 0, "not closed yet");
    t.advance(10); // finally on time
    assert.equal(log.stalls.length, 1);
    assert.equal(log.stalls[0]!.start, 100);
  });

  it("reports samples whose end or start fell inside a stall, not spanning ones", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer });
    log.start();
    t.advance(100);
    t.freeze(300);
    t.advance(10); // stall [100, 410]
    // Ended inside the stall: released late.
    assert.equal(log.touched(0, 405), true);
    // Started inside the stall: its write may have been held.
    assert.equal(log.touched(105, 700), true);
    // Started before, ended after: not delayed by this stall.
    assert.equal(log.touched(50, 450), false);
    // Entirely before or after.
    assert.equal(log.touched(10, 90), false);
    assert.equal(log.touched(420, 600), false);
  });

  it("does not open a stall for lateness within the floor", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer, floorMs: 20 });
    log.start();
    t.advance(100);
    t.freeze(15);
    t.advance(10);
    assert.deepEqual(log.stalls, []);
  });

  it("forgets closed stalls older than the retention", () => {
    const t = fakeTime();
    const log = new StallLog({
      clock: t.clock,
      timer: t.timer,
      retentionMs: 1000,
    });
    log.start();
    t.advance(100);
    t.freeze(300);
    t.advance(10);
    assert.equal(log.stalls.length, 1);
    t.advance(2000);
    assert.equal(log.stalls.length, 0);
  });

  it("stop() cancels the timer and clears state; start() is idempotent", () => {
    const t = fakeTime();
    const log = new StallLog({ clock: t.clock, timer: t.timer });
    log.start();
    log.start();
    assert.equal(t.pending(), 1);
    t.advance(100);
    t.freeze(300);
    t.advance(10);
    assert.equal(log.stalls.length, 1);
    log.stop();
    assert.equal(t.pending(), 0);
    assert.equal(log.running, false);
    assert.equal(log.touched(0, 405), false);
  });

  it("validates its options", () => {
    const t = fakeTime();
    assert.throws(
      () => new StallLog({ clock: t.clock, timer: t.timer, resolutionMs: 0 }),
      /resolutionMs/,
    );
    assert.throws(
      () =>
        new StallLog({
          clock: t.clock,
          timer: t.timer,
          resolutionMs: 10,
          floorMs: 5,
        }),
      /floorMs/,
    );
  });
});
