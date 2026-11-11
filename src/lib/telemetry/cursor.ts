interface CursorSnapshot {
  active: number | null;
  ghost: number | null;
}

const EMPTY_CURSOR: CursorSnapshot = { active: null, ghost: null };

export function createCursorSignal() {
  let snapshot = EMPTY_CURSOR;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_CURSOR,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(active: number | null, ghost: number | null = active) {
      if (snapshot.active === active && snapshot.ghost === ghost) return;
      snapshot = { active, ghost };
      listeners.forEach((listener) => listener());
    },
  };
}

export type CursorSignal = ReturnType<typeof createCursorSignal>;
