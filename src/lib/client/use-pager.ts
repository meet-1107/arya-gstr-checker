"use client";
import { useCallback, useState } from "react";

/**
 * Cursor pagination state with a history stack so "Previous" works with opaque cursors.
 * State is keyed by `resetKey` (filters/search), so changing filters naturally starts again from page 1
 * without any effect-driven resets.
 */
export function usePager(resetKey: string) {
  const [stacks, setStacks] = useState<Record<string, (string | undefined)[]>>({});
  const stack = stacks[resetKey] ?? [undefined];
  const cursor = stack[stack.length - 1];
  const set = useCallback((fn: (s: (string | undefined)[]) => (string | undefined)[]) =>
    setStacks((all) => ({ ...all, [resetKey]: fn(all[resetKey] ?? [undefined]) })), [resetKey]);
  return {
    cursor,
    page: stack.length,
    hasPrev: stack.length > 1,
    next: (nextCursor: string) => set((s) => [...s, nextCursor]),
    prev: () => set((s) => (s.length > 1 ? s.slice(0, -1) : s)),
  };
}
