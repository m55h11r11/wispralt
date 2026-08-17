/* happy-dom v20 registers a method-less `localStorage` stub under vitest.
   The app only needs string-map semantics, so back it with a real Map. */
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

Object.defineProperty(globalThis, "localStorage", {
  value: makeStorage(),
  writable: true,
  configurable: true,
});
