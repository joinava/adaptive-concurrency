class ItemHandle {}

export type EnqueueDirection = "front" | "back";
export type EnqueueOptions = {
  direction: EnqueueDirection;
};

type LinkedNode<T extends object> = {
  handle: ItemHandle;
  value: T;
  prev: LinkedNode<T> | undefined;
  next: LinkedNode<T> | undefined;
};

export class LinkedWaiterQueue<T extends object> {
  private head: LinkedNode<T> | undefined;
  private tail: LinkedNode<T> | undefined;
  private readonly nodes = new Map<ItemHandle, LinkedNode<T>>();
  private length = 0;

  enqueue(
    value: T,
    options: EnqueueOptions,
  ): { value: T; handle: ItemHandle } {
    const handle = new ItemHandle();

    const node: LinkedNode<T> = {
      handle,
      value: value,
      prev: undefined,
      next: undefined,
    };

    this.nodes.set(handle, node);
    if (options.direction === "front") {
      this.pushFront(node);
    } else {
      this.pushBack(node);
    }
    this.length += 1;
    return { value, handle };
  }

  peekHead(): { value: T; handle: ItemHandle } | undefined {
    if (!this.head) {
      return undefined;
    }
    return {
      value: this.head.value,
      handle: this.head.handle,
    };
  }

  removeByHandle(handle: ItemHandle): boolean {
    const node = this.nodes.get(handle);
    if (!node) return false;
    this.nodes.delete(handle);

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

  private pushFront(node: LinkedNode<T>): void {
    if (!this.head) {
      this.head = node;
      this.tail = node;
      return;
    }

    node.next = this.head;
    this.head.prev = node;
    this.head = node;
  }

  private pushBack(node: LinkedNode<T>): void {
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
