/**
 * File: stopwatchStore.ts
 * Kegunaan: Status stopwatch yang hidup di luar komponen, supaya tetap berjalan
 * walau halaman menu berpindah, dan island bisa mengunci diri selama stopwatch aktif.
 */

import { useSyncExternalStore } from "react";

let base = 0; // ms yang sudah terkumpul sebelum start terakhir
let startedAt: number | null = null; // null = berhenti
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const stopwatch = {
  elapsed: (): number => base + (startedAt === null ? 0 : performance.now() - startedAt),
  isRunning: (): boolean => startedAt !== null,
  toggle(): void {
    if (startedAt === null) {
      startedAt = performance.now();
    } else {
      base += performance.now() - startedAt;
      startedAt = null;
    }
    emit();
  },
  reset(): void {
    base = 0;
    startedAt = null;
    emit();
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

/** true selama stopwatch berjalan; hanya memicu render saat start/jeda/reset. */
export const useStopwatchRunning = (): boolean =>
  useSyncExternalStore(stopwatch.subscribe, stopwatch.isRunning);
