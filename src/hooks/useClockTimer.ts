import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ClockTimer } from "../types";

type ClockPayload = {
  state: "none" | "minimized" | "visible";
  timers: number[];
  running?: boolean[];
};

type Snap = {
  active: boolean;
  running: boolean;
  remaining: number;
  total: number;
  at: number;
};

type Controls = {
  toggle: () => void;
  stop: () => void;
};

const IDLE: Snap = {
  active: false,
  running: false,
  remaining: 0,
  total: 0,
  at: 0,
};

// Pengaturan timer
const MAX_STEP = 15; // Batas perubahan waktu antar pemeriksaan
const STALE_UP = 15; // Toleransi waktu yang lebih tinggi
const TOL_DOWN = 3; // Toleransi waktu yang lebih rendah
const PAUSE_AFTER_MS = 1300; // Waktu untuk mendeteksi jeda otomatis
const CLOSE_PAUSE_MS = 900; // Waktu deteksi jeda sebelum Clock ditutup
const MISSING_MS = 2500; // Batas waktu timer tidak terdeteksi
const DETECT_REMOVAL = true;
const GONE_PAUSED_MS = 60000; // Batas waktu jeda saat Clock tidak terbaca
const DISMISS_QUIET_MS = 1500; // Waktu tunggu setelah timer disembunyikan
const CONFIRM_POLLS = 3; // Jumlah pemeriksaan untuk memastikan timer baru
const CONFIRM_MS = 600; // Waktu minimum konfirmasi timer baru
const GRACE_MS = 1200; // Waktu tunggu sinkronisasi setelah tombol island ditekan

const remainingAt = (s: Snap, now: number) =>
  s.running
    ? Math.max(0, Math.ceil(s.remaining - (now - s.at) / 1000))
    : s.remaining;

// Mendeteksi nilai timer yang mengalami penurunan.
function fallingValues(old: number[], cur: number[]): number[] {
  const inRange = (o: number, v: number) => o > v && o - v <= MAX_STEP;
  if (old.length === cur.length) {
    return cur.filter((v, i) => inRange(old[i], v));
  }
  return cur.filter((v) => old.some((o) => inRange(o, v)));
}

function closest(values: number[], target: number): number | null {
  let best: number | null = null;
  for (const v of values) {
    if (best === null || Math.abs(v - target) < Math.abs(best - target))
      best = v;
  }
  return best;
}

export function useClockTimer(): ClockTimer & Controls {
  const [snap, setSnap] = useState<Snap>(IDLE);
  const [, setTick] = useState(0);
  const ref = useRef<Snap>(IDLE);
  const prev = useRef<number[] | null>(null);
  const tracked = useRef<number | null>(null); // Nilai timer terakhir
  const changedAt = useRef(0); // Waktu perubahan terakhir
  const seenAt = useRef(0); // Waktu timer terakhir terdeteksi
  const lastVisibleAt = useRef(0); // Waktu Clock terakhir terbaca
  const goneAt = useRef<number | null>(null); // Waktu Clock mulai tidak terbaca
  const flagsSeen = useRef(false); // Status timer dari Rust sudah diterima
  const islandPause = useRef(false); // Jeda berasal dari island
  const graceUntil = useRef(0); // Batas waktu tunggu sinkronisasi
  const dismissed = useRef(false); // Timer disembunyikan dari island
  const fallAt = useRef(0); // Waktu terakhir timer berjalan

  // Menyimpan timer baru sebelum dikonfirmasi.
  const pend = useRef<{ v: number; at: number; n: number } | null>(null);

  const commit = (next: Snap) => {
    ref.current = next;
    setSnap(next);
  };

  // Menghapus timer dari island.
  const release = () => {
    tracked.current = null;
    pend.current = null;
    islandPause.current = false;
    commit(IDLE);
  };

  // Mengubah status timer di Clock jika diperlukan.
  const sendToggle = (remaining: number, wantRunning: boolean) =>
    invoke("clock_timer_toggle", { remaining, wantRunning }).catch((e) =>
      console.warn("Clock:", e),
    );

  // Menjeda atau melanjutkan timer.
  const toggle = () => {
    const s = ref.current;
    if (!s.active) return;

    const now = Date.now();
    const rem = remainingAt(s, now);

    graceUntil.current = now + GRACE_MS;
    changedAt.current = now;
    tracked.current = rem;
    islandPause.current = s.running;

    commit({ ...s, running: !s.running, remaining: rem, at: now });
    void sendToggle(rem, !s.running);
  };

  // Menjeda Clock dan menyembunyikan timer.
  const stop = () => {
    const s = ref.current;
    if (!s.active) return;

    const now = Date.now();
    if (s.running) void sendToggle(remainingAt(s, now), false);

    dismissed.current = true;
    fallAt.current = now;
    release();
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;

    listen<ClockPayload>("clock-timer-update", (e) => {
      const { state, timers } = e.payload;
      const flags = e.payload.running;
      const hasFlags = Array.isArray(flags) && flags.length === timers.length;
      if (Array.isArray(flags)) flagsSeen.current = true;

      const now = Date.now();
      const s = ref.current;

      // Menangani Clock yang ditutup atau disembunyikan.
      if (state !== "visible") {
        const justLeft = goneAt.current === null;
        prev.current = null;
        pend.current = null;
        goneAt.current ??= now;

        if (!s.active) return;

        if (s.running) {
          // Menghapus timer jika sebelumnya sudah dijeda.
          if (
            justLeft &&
            !flagsSeen.current &&
            now >= graceUntil.current &&
            tracked.current !== null &&
            lastVisibleAt.current - changedAt.current >= CLOSE_PAUSE_MS
          ) {
            release();
          }

          // Timer yang berjalan tetap dihitung.
          return;
        }

        // Menyembunyikan timer yang dijeda.
        if (!islandPause.current || now - goneAt.current > GONE_PAUSED_MS) {
          release();
        }
        return;
      }

      goneAt.current = null;
      lastVisibleAt.current = now;

      const old = prev.current;
      prev.current = timers;

      // Mendeteksi timer yang sedang berjalan.
      const runningVals = hasFlags
        ? timers.filter((_, i) => flags![i])
        : old
          ? fallingValues(old, timers)
          : [];

      // Mengabaikan timer sampai tidak ada timer lain yang berjalan.
      if (dismissed.current) {
        if (runningVals.length > 0) {
          fallAt.current = now;
        } else if (
          (hasFlags || old) &&
          now - fallAt.current > DISMISS_QUIET_MS
        ) {
          dismissed.current = false;
        }
        return;
      }

      // Menunggu Clock mengikuti perubahan dari island.
      if (now < graceUntil.current) return;

      // Menghitung perkiraan sisa waktu.
      const projected = s.running
        ? s.remaining - (now - s.at) / 1000
        : s.remaining;

      // Memeriksa kecocokan waktu timer.
      const matches = (v: number) =>
        s.running
          ? v >= projected - TOL_DOWN && v <= projected + STALE_UP
          : v <= s.remaining + 2 && v >= s.remaining - MAX_STEP;

      // Menampilkan timer yang sedang berjalan.
      if (runningVals.length > 0) {
        let pick = runningVals[0];
        let same = false;
        if (s.active) {
          const near = closest(runningVals.filter(matches), projected);
          if (near !== null) {
            pick = near;
            same = true;
          }
        }

        // Memastikan timer baru terbaca secara konsisten.
        if (!same) {
          const p = pend.current;
          const expected = p ? p.v - (now - p.at) / 1000 : 0;
          if (!p || Math.abs(pick - expected) > TOL_DOWN + 1) {
            pend.current = { v: pick, at: now, n: 1 };
            return;
          }
          p.n += 1;
          if (p.n < CONFIRM_POLLS || now - p.at < CONFIRM_MS) return;
        }
        pend.current = null;

        seenAt.current = now;
        islandPause.current = false;

        // Memperbarui timer saat terjadi perubahan.
        if (!same || !s.running || pick !== tracked.current) {
          if (pick !== tracked.current) changedAt.current = now;
          tracked.current = pick;
          commit({
            active: true,
            running: true,
            remaining: pick,
            total: same ? Math.max(s.total, pick) : pick,
            at: now,
          });
        }
        return;
      }

      pend.current = null;
      if (!s.active) return;

      // Menyesuaikan timer saat Clock kembali terlihat.
      if (!old && !hasFlags) {
        seenAt.current = now;
        const near = closest(
          timers.filter((v) => Math.abs(v - projected) <= MAX_STEP),
          projected,
        );
        if (near !== null) {
          tracked.current = near;
          changedAt.current = now;
          commit({
            ...s,
            remaining: near,
            total: Math.max(s.total, near),
            at: now,
          });
        }
        return;
      }

      // Memeriksa timer yang sedang dijeda.
      const seen = closest(timers.filter(matches), projected);
      if (seen !== null) {
        seenAt.current = now;

        // Mengikuti status jeda dari Clock.
        if (hasFlags) {
          islandPause.current = false;
          if (seen !== tracked.current) {
            tracked.current = seen;
            changedAt.current = now;
          }
          if (s.running || s.remaining !== seen) {
            commit({ ...s, running: false, remaining: seen, at: now });
          }
          return;
        }

        // Mendeteksi perubahan timer tanpa status dari Rust.
        if (
          DETECT_REMOVAL &&
          s.running &&
          tracked.current !== null &&
          seen > tracked.current
        ) {
          release();
          return;
        }

        if (seen !== tracked.current) {
          tracked.current = seen;
          changedAt.current = now;
        }
        if (!s.running) islandPause.current = false;

        if (s.running && now - changedAt.current >= PAUSE_AFTER_MS) {
          commit({ ...s, running: false, remaining: seen, at: now });
        }
        return;
      }

      // Menghapus timer yang tidak lagi terdeteksi.
      if (DETECT_REMOVAL && now - seenAt.current >= MISSING_MS) {
        release();
      }
    })
      .then((fn) => (dead ? fn() : (unlisten = fn)))
      .catch((err) => console.error("clock-timer listener failed:", err));

    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  // Memperbarui tampilan setiap 250 ms.
  useEffect(() => {
    if (!snap.running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [snap.running]);

  const remaining = remainingAt(snap, Date.now());
  const done = snap.active && remaining <= 0;

  // Menghapus timer setelah waktu habis.
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(release, 1500);
    return () => window.clearTimeout(t);
  }, [done]);

  return {
    active: snap.active,
    running: snap.running,
    remaining,
    total: snap.total,
    toggle,
    stop,
  };
}
