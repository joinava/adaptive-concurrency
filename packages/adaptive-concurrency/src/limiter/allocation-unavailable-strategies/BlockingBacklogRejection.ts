import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";

type Waiter<ContextT> = {
  context: ContextT;
  retry: (context: ContextT) => AcquireResult;
  handle: WaiterHandle;
  resolve: (allotment: LimitAllotment | undefined) => void;
};

export const MAX_TIMEOUT = 60 * 60 * 1000; // 1 hour

export type BlockingBacklogRejectionOptions<ContextT> = {
  backlogSize: number;
  backlogTimeout: number | ((context: ContextT) => number);
  queue: WaiterQueue<Waiter<ContextT>>;
};

export type WaiterQueue<WaiterT extends Waiter<any>> = {
  enqueue: (waiter: Omit<WaiterT, "handle">) => WaiterT;
  peekHead: () => WaiterT | undefined;
  removeByHandle: (handle: WaiterHandle) => boolean;
  size: () => number;
};

export type WaiterHandle = {
  key: symbol;
};

export class BlockingBacklogRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly backlogSize: number;
  private readonly getBacklogTimeout: (context: ContextT) => number;
  private readonly queue: WaiterQueue<Waiter<ContextT>>;
  private drainInProgress = false;

  constructor(options: BlockingBacklogRejectionOptions<ContextT>) {
    const backlogSize = options.backlogSize;
    if (
      backlogSize !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(backlogSize) || backlogSize < 0)
    ) {
      throw new RangeError(
        "BlockingBacklogRejection: backlogSize must be a finite number greater than or equal to 0, or Infinity",
      );
    }

    this.backlogSize = backlogSize;
    this.queue = options.queue;

    const backlogTimeout = options.backlogTimeout;

    if (typeof backlogTimeout === "number") {
      this.assertTimeoutWithinBounds(backlogTimeout);
      this.getBacklogTimeout = () => backlogTimeout;
      return;
    }

    this.getBacklogTimeout = (context) => {
      const contextTimeout = backlogTimeout(context);
      this.assertTimeoutWithinBounds(contextTimeout);
      return contextTimeout;
    };
  }

  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }

    if (this.queue.size() >= this.backlogSize) {
      return Promise.resolve(undefined);
    }

    return this.waitInBacklog(context, retry, signal);
  }

  async onAllotmentReleased(): Promise<void> {
    if (this.drainInProgress || this.queue.size() === 0) {
      return;
    }

    this.drainInProgress = true;
    try {
      while (this.queue.size() > 0) {
        const waiter = this.queue.peekHead();
        if (!waiter) {
          return;
        }

        const allotment = await waiter.retry(waiter.context);
        if (!allotment) {
          return;
        }

        if (!this.queue.removeByHandle(waiter.handle)) {
          // Waiter expired while retry was in-flight. Release the acquired slot
          // so future retries can serve active queued waiters.
          await allotment.releaseAndIgnore();
          continue;
        }

        waiter.resolve(allotment);
      }
    } finally {
      this.drainInProgress = false;
    }
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    if (newLimit > oldLimit) {
      queueMicrotask(() => {
        void this.onAllotmentReleased();
      });
    }
  }

  private waitInBacklog(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    const timeout = this.getBacklogTimeout(context);
    return new Promise<LimitAllotment | undefined>((resolve) => {
      let settled = false;
      const settle = (allotment: LimitAllotment | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(allotment);
      };

      const waiter = this.queue.enqueue({
        context,
        retry,
        resolve: (allotment) => settle(allotment),
      });

      const timer = setTimeout(
        () => settle(undefined),
        timeout,
      );
      const onAbort = (): void => settle(undefined);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.queue.removeByHandle(waiter.handle);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private assertTimeoutWithinBounds(timeout: number): void {
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new RangeError(
        "Timeout must be a finite number greater than or equal to 0",
      );
    }
    if (timeout > MAX_TIMEOUT) {
      throw new RangeError(`Timeout cannot be greater than ${MAX_TIMEOUT} ms`);
    }
  }
}

export class ArrayWaiterQueue<
  WaiterT extends Waiter<any>,
> implements WaiterQueue<WaiterT> {
  private head: LinkedNode<WaiterT> | undefined;
  private tail: LinkedNode<WaiterT> | undefined;
  private readonly nodes = new Map<symbol, LinkedNode<WaiterT>>();
  private readonly enqueueDirection: "front" | "back";
  private length = 0;

  constructor(enqueueDirection: "front" | "back") {
    this.enqueueDirection = enqueueDirection;
  }

  enqueue(waiterWithoutHandle: Omit<WaiterT, "handle">): WaiterT {
    const handle: WaiterHandle = { key: Symbol("waiter-node") };
    const waiter: WaiterT = {
      ...waiterWithoutHandle,
      handle,
    } as WaiterT;
    const node: LinkedNode<WaiterT> = {
      handle,
      value: waiter,
      prev: undefined,
      next: undefined,
    };

    this.nodes.set(handle.key, node);
    if (this.enqueueDirection === "front") {
      this.pushFront(node);
    } else {
      this.pushBack(node);
    }
    this.length += 1;
    return waiter;
  }

  peekHead(): WaiterT | undefined {
    return this.head?.value;
  }

  removeByHandle(handle: WaiterHandle): boolean {
    const node = this.nodes.get(handle.key);
    if (!node) return false;
    this.nodes.delete(handle.key);

    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }

    node.prev = undefined;
    node.next = undefined;
    this.length -= 1;
    return true;
  }

  size(): number {
    return this.length;
  }

  private pushFront(node: LinkedNode<WaiterT>): void {
    if (!this.head) {
      this.head = node;
      this.tail = node;
      return;
    }

    node.next = this.head;
    this.head.prev = node;
    this.head = node;
  }

  private pushBack(node: LinkedNode<WaiterT>): void {
    if (!this.tail) {
      this.head = node;
      this.tail = node;
      return;
    }

    node.prev = this.tail;
    this.tail.next = node;
    this.tail = node;
  }
}

type LinkedNode<WaiterT extends Waiter<any>> = {
  handle: WaiterHandle;
  value: WaiterT;
  prev: LinkedNode<WaiterT> | undefined;
  next: LinkedNode<WaiterT> | undefined;
};
