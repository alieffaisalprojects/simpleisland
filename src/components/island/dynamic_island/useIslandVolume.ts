import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VolumeStatus } from "../menu/useSystemStatus";

// logika volume player musik
// tombol volume di player -> island berubah jadi VolumeHud (pil horizontal).
// VolumeHud sendiri yang menutup dirinya setelah 1,5 detik tanpa aktivitas
// (IDLE_MS di VolumeHud.tsx), lalu island kembali ke player musik.

// musicExpanded: player musik terbuka
export function useIslandVolume(musicExpanded: boolean) {
  const [volume, setVolume] = useState(0.5); // 0..1
  const [volumeHudOpen, setVolumeHudOpen] = useState(false); // VolumeHud tampil
  const volumeRef = useRef(0.5);
  const volumeBusy = useRef(0); // perintah berjalan

  const applyVolume = useCallback((value: number) => {
    volumeRef.current = value;
    setVolume(value);
  }, []);

  // baca volume sistem
  const syncFromSystem = useCallback(() => {
    invoke<number>("volume_get")
      .then((value) => {
        if (volumeBusy.current === 0) applyVolume(value);
      })
      .catch((e) => console.error("Gagal membaca volume:", e));
  }, [applyVolume]);

  // player terbuka -> baca volume, player ditutup -> HUD hilang
  useEffect(() => {
    if (musicExpanded) syncFromSystem();
    else setVolumeHudOpen(false);
  }, [musicExpanded, syncFromSystem]);

  // tombol volume di player
  const openVolumeHud = useCallback(() => {
    syncFromSystem();
    setVolumeHudOpen(true);
  }, [syncFromSystem]);

  // VolumeHud selesai (idle 1,5 detik / Esc / klik ikon) -> kembali ke player
  const closeVolumeHud = useCallback(() => setVolumeHudOpen(false), []);

  // VolumeHud mengirim level 0..100
  const setVolumeLevel = useCallback(
    (level: number) => {
      const target = Math.min(1, Math.max(0, level / 100));
      const delta = target - volumeRef.current;
      if (Math.abs(delta) < 0.0001) return;

      // ubah tampilan dulu
      applyVolume(target);

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
    [applyVolume],
  );

  // bentuk yang dibaca VolumeHud
  const volumeStatus = useMemo(
    () => ({ level: Math.round(volume * 100), muted: false }) as VolumeStatus,
    [volume],
  );

  return {
    volumeStatus,
    volumeHudOpen,
    openVolumeHud,
    closeVolumeHud,
    setVolumeLevel,
  };
}
