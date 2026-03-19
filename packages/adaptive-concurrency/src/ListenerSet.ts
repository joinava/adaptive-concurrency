/**
 * Fan-out for numeric change notifications with the same subscribe contract as
 * {@link StreamingLimit.subscribe}.
 */
export class ListenerSet<T extends (this: void, ...args: any[]) => any> {
  private readonly listeners: Array<T> = [];

  subscribe(
    consumer: T,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    if (options.signal?.aborted) {
      return () => {};
    }

    this.listeners.push(consumer);

    let unsubscribed = false;
    const onAbort = (): void => {
      unsubscribe();
    };

    const unsubscribe = (): void => {
      if (unsubscribed) {
        return;
      }
      unsubscribed = true;

      const idx = this.listeners.indexOf(consumer);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    return unsubscribe;
  }

  notify(...args: Parameters<T>): void {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}
