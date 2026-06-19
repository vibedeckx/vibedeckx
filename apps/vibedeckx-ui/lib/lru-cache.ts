/**
 * A small least-recently-used cache backed by a Map.
 *
 * A Map iterates its keys in insertion order, so the first key is always the
 * least-recently-used entry. Reading or writing a key moves it to the end
 * (most-recently-used); once the size exceeds `capacity`, the oldest entries
 * are evicted from the front.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error("LRUCache capacity must be at least 1");
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Re-insert to mark as most-recently-used.
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Evict every key for which `predicate` returns true. */
  deleteWhere(predicate: (key: K) => boolean): void {
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
