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

// Gaya menu saat file diseret ke island: kotak-kotak atau radial
export type FileMenuStyle = "tiles" | "radial";

// Kondisi island yang ukurannya bisa diatur:
//   compact : island kecil saat ada aktivitas (musik, timer, file, dll.)
//   mini    : island paling kecil saat idle / tidak ada aktivitas
// Ukuran saat expanded tidak bisa diatur.
export type SizeMode = "compact" | "mini";

export interface AppSettings {
  // Umum
  islandEnabled: boolean;
  autostart: boolean;
  fileDrop: boolean;
  fileSounds: boolean;
  fileMenuStyle: FileMenuStyle;

  // Tampilan
  style: IslandStyle;
  shoulder: number; // lebar bahu pada gaya notch (px)

  // Ukuran island saat compact dan mini, per gaya.
  // Nilainya selisih px dari ukuran bawaan (0 = bawaan).
  pillCompactWidth: number;
  pillCompactHeight: number;
  pillMiniWidth: number;
  pillMiniHeight: number;
  notchCompactWidth: number;
  notchCompactHeight: number;
  notchMiniWidth: number;
  notchMiniHeight: number;
  tabCompactWidth: number;
  tabCompactHeight: number;
  tabMiniWidth: number;
  tabMiniHeight: number;

  pillTop: number; // selisih jarak pil dari tepi atas layar
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

// Nama kunci lebar / tinggi per gaya dan per kondisi
export const SIZE_KEYS = {
  pill: {
    compact: { w: "pillCompactWidth", h: "pillCompactHeight" },
    mini: { w: "pillMiniWidth", h: "pillMiniHeight" },
  },
  notch: {
    compact: { w: "notchCompactWidth", h: "notchCompactHeight" },
    mini: { w: "notchMiniWidth", h: "notchMiniHeight" },
  },
  tab: {
    compact: { w: "tabCompactWidth", h: "tabCompactHeight" },
    mini: { w: "tabMiniWidth", h: "tabMiniHeight" },
  },
} as const;

type SizeKey = (typeof SIZE_KEYS)[IslandStyle][SizeMode]["w" | "h"];

// Semua selisih ukuran = 0 (ukuran bawaan)
const DEFAULT_SIZES: Pick<AppSettings, SizeKey> = {
  pillCompactWidth: 0,
  pillCompactHeight: 0,
  pillMiniWidth: 0,
  pillMiniHeight: 0,
  notchCompactWidth: 0,
  notchCompactHeight: 0,
  notchMiniWidth: 0,
  notchMiniHeight: 0,
  tabCompactWidth: 0,
  tabCompactHeight: 0,
  tabMiniWidth: 0,
  tabMiniHeight: 0,
};

export const DEFAULT_SETTINGS: AppSettings = {
  islandEnabled: false,
  autostart: false,
  fileDrop: true,
  fileSounds: true,
  fileMenuStyle: "tiles",
  style: "pill",
  shoulder: 14,
  pillTop: 0,
  ...DEFAULT_SIZES,
};

// Pengaturan tampilan saja (untuk tombol "Kembalikan tampilan bawaan")
export const DEFAULT_APPEARANCE: Pick<
  AppSettings,
  "style" | "shoulder" | "pillTop" | SizeKey
> = {
  style: DEFAULT_SETTINGS.style,
  shoulder: DEFAULT_SETTINGS.shoulder,
  pillTop: 0,
  ...DEFAULT_SIZES,
};

// Selisih lebar / tinggi untuk sebuah gaya dan kondisi
// (default: gaya aktif, kondisi compact)
export function sizeOf(
  s: AppSettings,
  style: IslandStyle = s.style,
  mode: SizeMode = "compact",
) {
  const keys = SIZE_KEYS[style][mode];
  return { w: s[keys.w], h: s[keys.h] };
}

export const STYLE_OPTIONS: { id: IslandStyle; label: string; desc: string }[] =
  [
    {
      id: "pill",
      label: "Dynamic Island",
      desc: "Melayang di atas layar, berbentuk pil.",
    },
    {
      id: "notch",
      label: "Notch",
      desc: "Menempel di tepi atas dengan bahu kiri-kanan",
    },
    {
      id: "tab",
      label: "Tab",
      desc: "Menempel di tepi atas, sudut atas rata tanpa bahu.",
    },
  ];

export const FILE_MENU_OPTIONS: { id: FileMenuStyle; label: string }[] = [
  { id: "tiles", label: "Kotak" },
  { id: "radial", label: "Radial" },
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
