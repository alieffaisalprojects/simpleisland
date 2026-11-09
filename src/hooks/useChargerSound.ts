/**
 * File: useChargerSound.ts
 * Kegunaan: bunyikan charging.wav saat charger dicolok.
 * Dipantau terus selama app berjalan, tidak bergantung menu terbuka.
 */

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import chargingSound from "../assets/sounds/charging.wav";

interface PowerInfo {
  present: boolean;
  plugged: boolean;
}

export function useChargerSound() {
  useEffect(() => {
    let stopped = false;
    // null = belum ada pembacaan pertama (tidak berbunyi saat app baru dibuka)
    let wasPlugged: boolean | null = null;

    const check = async () => {
      try {
        const p = await invoke<PowerInfo>("power_status");
        if (stopped || !p.present) return;

        if (wasPlugged === false && p.plugged) {
          const a = new Audio(chargingSound);
          a.volume = 0.7;
          void a.play().catch(() => {});
        }
        wasPlugged = p.plugged;
      } catch (e) {
        console.error("power_status gagal:", e);
      }
    };

    void check();
    const timer = window.setInterval(check, 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
}
