class ItemHandle {}

export type EnqueueDirection = "front" | "back";
export type EnqueueOptions = {
  direction: EnqueueDirection;
  priority?: number | undefined;
};

type LinkedNode<T extends object> = {
  handle: ItemHandle;
  value: T;
  priority: number;
  prev: LinkedNode<T> | undefined;
  next: LinkedNode<T> | undefined;
  bucket: PriorityBucket<T>;
};

type PriorityBucket<T extends object> = {
  priority: number;
  head: LinkedNode<T> | undefined;
  tail: LinkedNode<T> | undefined;
  size: number;
};

export class LinkedWaiterQueue<T extends object> {
  private readonly buckets = new Map<number, PriorityBucket<T>>();
  private readonly nodes = new Map<ItemHandle, LinkedNode<T>>();
  private maxPriority: number | undefined;
  private length = 0;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;
  private resolveShutdown: (() => void) | undefined;

  enqueue(
    value: T,
    options: EnqueueOptions,
  ): { value: T; handle: ItemHandle } {
    if (this.shuttingDown) {
      throw new Error("queue has been shut down");
    }

    const handle = new ItemHandle();
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) {
      throw new RangeError("priority must be a finite number");
    }

    const bucket = this.getOrCreateBucket(priority);
    const node: LinkedNode<T> = {
      handle,
      value: value,
      priority,
      prev: undefined,
      next: undefined,
      bucket,
    };

    this.nodes.set(handle, node);
    this.insertInBucket(node, options.direction);
    if (this.maxPriority === undefined || priority > this.maxPriority) {
      this.maxPriority = priority;
    }
    this.length += 1;
    return { value, handle };
  }

  peekHead(): { value: T; handle: ItemHandle } | undefined {
    if (this.maxPriority === undefined) {
      return undefined;
    }
    const bucket = this.buckets.get(this.maxPriority);
    if (!bucket || !bucket.head) {
      return undefined;
    }
    return {
      value: bucket.head.value,
      handle: bucket.head.handle,
    };
  }

  removeByHandle(handle: ItemHandle): boolean {
    const node = this.nodes.get(handle);
    if (!node) return false;
    this.nodes.delete(handle);

    this.unlinkFromBucket(node);

    node.prev = undefined;
    node.next = undefined;
    this.length -= 1;
    this.maybeResolveShutdown();
    return true;
  }

  shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownPromise = new Promise<void>((resolve) => {
        this.resolveShutdown = resolve;
      });
      this.maybeResolveShutdown();
    }

    return this.shutdownPromise!;
  }

  size(): number {
    return this.length;
  }

  private getOrCreateBucket(priority: number): PriorityBucket<T> {
    const existing = this.buckets.get(priority);
    if (existing) {
      return existing;
    }
    const created: PriorityBucket<T> = {
      priority,
      head: undefined,
      tail: undefined,
      size: 0,
    };
    this.buckets.set(priority, created);
    return created;
  }

  private insertInBucket(node: LinkedNode<T>, direction: EnqueueDirection): void {
    const bucket = node.bucket;
    if (direction === "front") {
      if (!bucket.head) {
        bucket.head = node;
        bucket.tail = node;
      } else {
        node.next = bucket.head;
        bucket.head.prev = node;
        bucket.head = node;
      }
    } else {
      if (!bucket.tail) {
        bucket.head = node;
        bucket.tail = node;
      } else {
        node.prev = bucket.tail;
        bucket.tail.next = node;
        bucket.tail = node;
      }
    }
    bucket.size += 1;
  }

  private unlinkFromBucket(node: LinkedNode<T>): void {
    const bucket = node.bucket;
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      bucket.head = node.next;
    }
    if (node.next) {
      node.next.prev = node.prev;
    } else {
      bucket.tail = node.prev;
    }
    bucket.size -= 1;

    if (bucket.size > 0) {
      return;
    }

    this.buckets.delete(bucket.priority);
    if (this.maxPriority !== bucket.priority) {
      return;
    }

    let newMax: number | undefined;
    for (const priority of this.buckets.keys()) {
      if (newMax === undefined || priority > newMax) {
        newMax = priority;
      }
    }
    this.maxPriority = newMax;
  }

  private maybeResolveShutdown(): void {
    if (!this.shuttingDown || this.length !== 0 || !this.resolveShutdown) {
      return;
    }

    this.resolveShutdown();
    this.resolveShutdown = undefined;
  }
}
