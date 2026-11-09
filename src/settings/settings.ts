/**
 * settings.ts
 * Tipe, nilai bawaan, dan hook `useSettings` untuk halaman Pengaturan.
 *
 * Data disimpan oleh Rust (settings.rs). Hook ini dipakai di dua tempat:
 *   - jendela Pengaturan : membaca dan mengubah (`update`)
 *   - island (main)      : hanya membaca; berubah otomatis lewat event "settings-changed"
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type IslandStyle = "pill" | "notch" | "tab";

export interface AppSettings {
  // Umum
  islandEnabled: boolean;
  autostart: boolean;
  fileDrop: boolean;
  fileSounds: boolean;

  // Tampilan
  style: IslandStyle;
  shoulder: number; // lebar bahu pada gaya notch (px)

  // Ukuran island: selisih px dari ukuran bawaan (0 = bawaan)
  pillWidth: number;
  pillHeight: number;
  pillTop: number; // selisih jarak pil dari tepi atas layar
  notchWidth: number;
  notchHeight: number;
  tabWidth: number;
  tabHeight: number;
}

export const SHOULDER_MIN = 8;
export const SHOULDER_MAX = 24;

// Batas slider ukuran (harus sama dengan settings.rs)
export const WIDTH_MIN = -30;
export const WIDTH_MAX = 60;
export const HEIGHT_MIN = -8;
export const HEIGHT_MAX = 20;
export const TOP_MIN = -20;
export const TOP_MAX = 60;

export const DEFAULT_SETTINGS: AppSettings = {
  islandEnabled: false,
  autostart: false,
  fileDrop: true,
  fileSounds: true,
  style: "pill",
  shoulder: 14,
  pillWidth: 0,
  pillHeight: 0,
  pillTop: 0,
  notchWidth: 0,
  notchHeight: 0,
  tabWidth: 0,
  tabHeight: 0,
};

// Pengaturan tampilan saja (untuk tombol "Kembalikan tampilan bawaan")
export const DEFAULT_APPEARANCE: Pick<
  AppSettings,
  | "style"
  | "shoulder"
  | "pillWidth"
  | "pillHeight"
  | "pillTop"
  | "notchWidth"
  | "notchHeight"
  | "tabWidth"
  | "tabHeight"
> = {
  style: DEFAULT_SETTINGS.style,
  shoulder: DEFAULT_SETTINGS.shoulder,
  pillWidth: 0,
  pillHeight: 0,
  pillTop: 0,
  notchWidth: 0,
  notchHeight: 0,
  tabWidth: 0,
  tabHeight: 0,
};

// Nama kunci lebar / tinggi per gaya
export const SIZE_KEYS = {
  pill: { w: "pillWidth", h: "pillHeight" },
  notch: { w: "notchWidth", h: "notchHeight" },
  tab: { w: "tabWidth", h: "tabHeight" },
} as const;

// Selisih lebar / tinggi untuk sebuah gaya (default: gaya aktif)
export function sizeOf(s: AppSettings, style: IslandStyle = s.style) {
  return { w: s[SIZE_KEYS[style].w], h: s[SIZE_KEYS[style].h] };
}

export const STYLE_OPTIONS: { id: IslandStyle; label: string; desc: string }[] = [
  {
    id: "pill",
    label: "Dynamic Island",
    desc: "Melayang di atas layar, berbentuk pil seperti Dynamic Island iPhone.",
  },
  {
    id: "notch",
    label: "Notch",
    desc: "Menempel di tepi atas dengan bahu kiri-kanan, seperti notch MacBook.",
  },
  {
    id: "tab",
    label: "Tab",
    desc: "Menempel di tepi atas, sudut atas rata tanpa bahu.",
  },
];

const errorText = (e: unknown) => (typeof e === "string" ? e : String(e));

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const ref = useRef<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;

    invoke<AppSettings>("settings_get")
      .then((s) => {
        if (!alive) return;
        ref.current = s;
        setSettings(s);
        setReady(true);
      })
      .catch((e) => console.error("Gagal membaca pengaturan:", e));

    // Perubahan dari tempat lain (menu tray, jendela lain).
    // Window tanpa izin event cukup mengabaikan ini.
    listen<AppSettings>("settings-changed", (event) => {
      ref.current = event.payload;
      setSettings(event.payload);
    })
      .then((fn) => (alive ? (stop = fn) : fn()))
      .catch(() => {});

    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  // Ubah sebagian pengaturan. Tampilan langsung berubah, lalu dikoreksi / dikembalikan
  // bila Rust menolak. Mengembalikan pesan error, atau null bila berhasil.
  const update = useCallback(
    async (patch: Partial<AppSettings>): Promise<string | null> => {
      const prev = ref.current;
      const next = { ...prev, ...patch };

      ref.current = next;
      setSettings(next);

      try {
        const saved = await invoke<AppSettings>("settings_save", {
          settings: next,
        });
        ref.current = saved;
        setSettings(saved);
        return null;
      } catch (e) {
        ref.current = prev;
        setSettings(prev);
        return errorText(e);
      }
    },
    [],
  );

  return { settings, ready, update };
}