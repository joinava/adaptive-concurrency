export type WaiterHandle = {
  key: symbol;
};

export type EnqueueDirection = "front" | "back";

type LinkedNode<WaiterT extends { handle: WaiterHandle }> = {
  handle: WaiterHandle;
  value: WaiterT;
  prev: LinkedNode<WaiterT> | undefined;
  next: LinkedNode<WaiterT> | undefined;
};

export class LinkedWaiterQueue<WaiterT extends { handle: WaiterHandle }> {
  private head: LinkedNode<WaiterT> | undefined;
  private tail: LinkedNode<WaiterT> | undefined;
  private readonly nodes = new Map<symbol, LinkedNode<WaiterT>>();
  private readonly enqueueDirection: EnqueueDirection;
  private length = 0;

  constructor(enqueueDirection: EnqueueDirection) {
    this.enqueueDirection = enqueueDirection;
  }

  enqueue(
    waiterWithoutHandle: Omit<WaiterT, "handle">,
    enqueueDirection?: EnqueueDirection,
  ): WaiterT {
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

    const direction = enqueueDirection ?? this.enqueueDirection;
    this.nodes.set(handle.key, node);
    if (direction === "front") {
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
