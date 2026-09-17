type TimerHandle = NodeJS.Timeout | number;

/**
 * Records the spans during which this thread's event loop was not responsive:
 * blocking JS, GC pauses, or a whole-process freeze (CPU throttling, swap,
 * `SIGSTOP`). A {@link Limiter} uses it to recognise RTT samples that a stall
 * delayed on the client side, so they are not mistaken for downstream latency.
 *
 * Mechanism: a timer is armed every `resolutionMs`. When a tick fires more
 * than `floorMs` late, the loop was not running, so a stall opens. The stall
 * starts at the previous tick, the last moment the loop is known to have been
 * responsive, and it stays open until a tick fires on time again. That end
 * point matters: after a block, the overdue timer fires *before* the I/O
 * callbacks for responses that arrived during the block, and those callbacks
 * can keep the loop busy for a while. Closing the stall at detection would
 * miss exactly the releases the stall delayed.
 *
 * Timestamps come from the supplied `clock`, so a stall span is directly
 * comparable to the sample timestamps of a `Limiter` built on the same clock.
 * The timer handle is unref'd when it supports it, so a running log never
 * keeps the process alive.
 */
export class StallLog {
  private readonly clock: () => number;
  private readonly timer: {
    setTimeout(fn: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
  };
  private readonly resolutionMs: number;
  private readonly floorMs: number;
  private readonly retentionMs: number;

  private closed: { start: number; end: number }[] = [];
  private open: { start: number } | undefined;
  private lastTickAt = 0;
  private expectedAt = 0;
  private handle: TimerHandle | undefined;

  constructor(options: {
    clock: () => number;
    timer: {
      setTimeout(fn: () => void, ms: number): TimerHandle;
      clearTimeout(handle: TimerHandle): void;
    };
    /** Interval between ticks, in milliseconds. Default: 10. */
    resolutionMs?: number;
    /**
     * A tick later than this, in milliseconds, opens a stall, and a tick
     * within it closes one. Must be at least `resolutionMs`. Default: 20.
     */
    floorMs?: number;
    /** How long a closed stall is kept, in milliseconds. Default: 300_000. */
    retentionMs?: number;
  }) {
    this.clock = options.clock;
    this.timer = options.timer;
    this.resolutionMs = options.resolutionMs ?? 10;
    this.floorMs = options.floorMs ?? 20;
    this.retentionMs = options.retentionMs ?? 300_000;

    if (!(this.resolutionMs > 0 && Number.isFinite(this.resolutionMs))) {
      throw new RangeError("resolutionMs must be a finite number > 0");
    }
    if (!(this.floorMs >= this.resolutionMs && Number.isFinite(this.floorMs))) {
      throw new RangeError("floorMs must be a finite number >= resolutionMs");
    }
    if (!(this.retentionMs > 0)) {
      throw new RangeError("retentionMs must be > 0");
    }
  }

  /** Starts ticking. Idempotent. */
  start(): void {
    if (this.handle !== undefined) return;
    this.lastTickAt = this.clock();
    this.arm();
  }

  /** Stops ticking and forgets every recorded stall. Idempotent. */
  stop(): void {
    if (this.handle === undefined) return;
    this.timer.clearTimeout(this.handle);
    this.handle = undefined;
    this.open = undefined;
    this.closed = [];
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /**
   * True when a request that started at `startTime` and was observed to end
   * at `endTime` had either endpoint inside a stall. An end inside a stall
   * means the response was released late. A start inside a stall means the
   * request was admitted just before, or during, a period in which its write
   * could not be sent. A request that started before a stall and ended after
   * it was not delayed by it, and is not reported.
   */
  touched(startTime: number, endTime: number): boolean {
    const inSpan = (t: number, start: number, end: number) =>
      t >= start && t <= end;
    if (this.open !== undefined) {
      const { start } = this.open;
      if (endTime >= start || startTime >= start) return true;
    }
    return this.closed.some(
      ({ start, end }) =>
        inSpan(endTime, start, end) || inSpan(startTime, start, end),
    );
  }

  /** Closed stalls, oldest first. Exposed for tests and diagnostics. */
  get stalls(): readonly { start: number; end: number }[] {
    return this.closed;
  }

  private arm(): void {
    this.expectedAt = this.lastTickAt + this.resolutionMs;
    const handle = this.timer.setTimeout(() => this.tick(), this.resolutionMs);
    this.handle = handle;
    if (typeof handle !== "number") handle.unref();
  }

  private tick(): void {
    const now = this.clock();
    const late = now - this.expectedAt;

    if (this.open !== undefined) {
      if (late <= this.floorMs) {
        this.closed.push({ start: this.open.start, end: now });
        this.open = undefined;
      }
    } else if (late > this.floorMs) {
      this.open = { start: this.lastTickAt };
    }

    const cutoff = now - this.retentionMs;
    if (this.closed.length > 0 && this.closed[0]!.end < cutoff) {
      this.closed = this.closed.filter(({ end }) => end >= cutoff);
    }

    this.lastTickAt = now;
    this.arm();
  }
}
