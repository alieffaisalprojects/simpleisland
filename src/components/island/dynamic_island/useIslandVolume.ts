import { useCallback, useEffect, useRef, useState } from "react";
import { animate, useMotionValue } from "framer-motion";
import type { MotionValue } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";

// logika HUD volume

// langkah volume
const VOLUME_STEP = 1 / 16;

// HUD hilang (ms)
const VOLUME_HIDE_MS = 1500;

// dorong pil volume
const HUD_PUSH = 10;

// denyut pil
const PULSE_UP = { duration: 0.09, ease: "easeOut" } as const;

const PULSE_BACK = {
  type: "spring",
  stiffness: 480,
  damping: 15,
  mass: 0.7,
} as const;

// pil kembali
const SHIFT_BACK = {
  type: "spring",
  stiffness: 320,
  damping: 15,
  mass: 0.8,
} as const;

// gundukan surut
const BUMP_BACK = {
  type: "spring",
  stiffness: 230,
  damping: 24,
  mass: 0.8,
} as const;

interface HudMotion {
  pulseX: MotionValue<number>;
  pulseY: MotionValue<number>;
  shift: MotionValue<number>;
  grow: MotionValue<number>;
}

// satu tekanan tombol
function hudPush({ pulseX, pulseY, shift, grow }: HudMotion) {
  animate(shift, HUD_PUSH, {
    ...PULSE_UP,
    onComplete: () => animate(shift, 0, SHIFT_BACK),
  });
  animate(grow, 1, {
    ...PULSE_UP,
    onComplete: () => animate(grow, 0, BUMP_BACK),
  });
  animate(pulseX, 1.1, {
    ...PULSE_UP,
    onComplete: () => animate(pulseX, 1, PULSE_BACK),
  });
  animate(pulseY, 1.03, {
    ...PULSE_UP,
    onComplete: () => animate(pulseY, 1, PULSE_BACK),
  });
}

// musicExpanded: player musik terbuka
export function useIslandVolume(musicExpanded: boolean) {
  const [volume, setVolume] = useState(0.5); // 0..1
  const [volumeActive, setVolumeActive] = useState(false); // HUD tampil
  const [volTail, setVolTail] = useState(false); // HUD keluar
  const volumeRef = useRef(0.5);
  const volumeBusy = useRef(0); // perintah berjalan
  const volumeHideTimer = useRef<number | undefined>(undefined);

  // animasi HUD
  const hudPulseX = useMotionValue(1);
  const hudPulseY = useMotionValue(1);
  const hudShift = useMotionValue(0); // dorong kanan
  const bumpGrow = useMotionValue(0); // tinggi gundukan

  const [bumpAt, setBumpAt] = useState<"plus" | "minus">("plus");

  const showVolume = volumeActive && musicExpanded;
  const volumeWindow = showVolume || volTail;

  const applyVolume = useCallback((value: number) => {
    volumeRef.current = value;
    setVolume(value);
  }, []);

  // baca volume sistem
  useEffect(() => {
    if (!musicExpanded) return;

    let cancelled = false;

    invoke<number>("volume_get")
      .then((value) => {
        if (!cancelled && volumeBusy.current === 0) applyVolume(value);
      })
      .catch((e) => console.error("Gagal membaca volume:", e));

    return () => {
      cancelled = true;
    };
  }, [musicExpanded, applyVolume]);

  // player ditutup -> HUD hilang
  useEffect(() => {
    if (musicExpanded) return;
    window.clearTimeout(volumeHideTimer.current);
    setVolumeActive(false);
  }, [musicExpanded]);

  // tunggu animasi HUD
  useEffect(() => {
    if (showVolume) {
      setVolTail(true);
      return;
    }

    const t = window.setTimeout(() => setVolTail(false), 800);
    return () => window.clearTimeout(t);
  }, [showVolume]);

  useEffect(() => () => window.clearTimeout(volumeHideTimer.current), []);

  // button plus/minus
  const handleVolumeStep = useCallback(
    (direction: 1 | -1) => {
      const delta = direction * VOLUME_STEP;

      // ubah tampilan dulu
      applyVolume(Math.min(1, Math.max(0, volumeRef.current + delta)));
      setVolumeActive(true);

      // gundukan + dorong pil
      setBumpAt(direction > 0 ? "plus" : "minus");
      hudPush({
        pulseX: hudPulseX,
        pulseY: hudPulseY,
        shift: hudShift,
        grow: bumpGrow,
      });

      window.clearTimeout(volumeHideTimer.current);
      volumeHideTimer.current = window.setTimeout(
        () => setVolumeActive(false),
        VOLUME_HIDE_MS,
      );

      volumeBusy.current += 1;

      invoke<number>("volume_step", { delta })
        .then((value) => {
          // pakai hasil Rust
          if (volumeBusy.current === 1) applyVolume(value);
        })
        .catch((e) => console.error("Gagal mengubah volume:", e))
        .finally(() => {
          volumeBusy.current -= 1;
        });
    },
    [applyVolume, hudPulseX, hudPulseY, hudShift, bumpGrow],
  );

  // panel ditutup -> HUD hilang
  const handleVolumePanelChange = useCallback((open: boolean) => {
    if (open) return;
    window.clearTimeout(volumeHideTimer.current);
    setVolumeActive(false);
  }, []);

  return {
    volume,
    showVolume,
    volumeWindow,
    bumpAt,
    hudPulseX,
    hudPulseY,
    hudShift,
    bumpGrow,
    handleVolumeStep,
    handleVolumePanelChange,
  };
}
