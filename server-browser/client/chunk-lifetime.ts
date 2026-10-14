/** The entry owns teardown; only the evaluated UI chunk owns its frame cache. */
export function createChunkLifetime() {
  let stopped = false;
  let cleanup: (() => void) | undefined;
  return {
    attach(dispose: () => void) {
      if (stopped) { dispose(); return false; }
      cleanup = dispose;
      return true;
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      cleanup?.();
      cleanup = undefined;
    },
  };
}
export type ChunkLifetime = ReturnType<typeof createChunkLifetime>;
