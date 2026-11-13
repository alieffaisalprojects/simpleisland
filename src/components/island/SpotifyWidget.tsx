import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "framer-motion";
import { Music, Pause, Play, Volume2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LyricsState, SpotifyTrack } from "../../types";
import { LyricsIcon, LyricsView } from "./LyricsView";
import { useActiveLine } from "../../hooks/useLyrics";
import { openUrl } from "@tauri-apps/plugin-opener";

// Props utama SpotifyWidget
interface SpotifyWidgetProps {
  track: SpotifyTrack;
  onTogglePlay?: () => void;
  onNext?: () => void;
  onSeek?: (positionSecs: number) => void;
  isExpanded?: boolean;

  // Menyembunyikan tampilan mini saat musik tidak aktif
  isMini?: boolean;

  // Selisih ukuran pil compact dari Pengaturan (px)
  widthAdjust?: number;
  heightAdjust?: number;

  // Tambahan lebar pil lirik compact saat baris lirik panjang (px)
  extraWidth?: number;

  // Melaporkan lebar yang dibutuhkan baris lirik aktif (px, 0 = tidak perlu)
  onLyricNeedWidth?: (px: number) => void;

  // Data lirik
  lyrics: LyricsState;

  // Mengatur mode lirik
  lyricsMode?: boolean;
  onLyricsModeChange?: (on: boolean) => void;

  // Kunci island saat lirik expanded (tidak menutup otomatis)
  locked?: boolean;
  onLockedChange?: (locked: boolean) => void;

  // Tombol volume ditekan. DynamicIsland yang menampilkan VolumeHud
  // (island berubah jadi pil volume, lalu kembali ke player setelah 1,5 detik)
  onVolumePress?: () => void;
}

// Perintah media dari backend
type MediaCommand = "media_toggle_play" | "media_next" | "media_previous";

// Ukuran setiap tampilan Dynamic Island
export const SPOTIFY_SIZES = {
  compact: { width: 128, height: 38 },
  mini: { width: 60, height: 30 },
  expanded: { width: 394, height: 188 },
  lyrics: { width: 394, height: 232 },
  lyricsMini: { width: 300, height: 38 },
} as const;

// Kurva animasi morphing
const MORPH_EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

// Pegas pelebaran pil lirik compact (dipakai island dan isinya agar sinkron)
export const LYRIC_WIDEN_SPRING = {
  type: "spring",
  stiffness: 230,
  damping: 24,
  mass: 0.9,
} as const;

// Jeda konten compact (album, spektrum, timer, file) setelah island menutup dari
// expand (detik): konten masuk dari blur saat pil mulai mengembang kembali.
// DynamicIsland.tsx memakai nilai yang sama untuk timer dan file.
export const COLLAPSE_CONTENT_DELAY = 0.24;

// Layer konten Dynamic Island.
// Masuk : konten muncul dari blur + kecil, lalu mengembang dengan pegas lembut
// Keluar: konten memudar cepat sambil blur dan mengecil
export const MorphLayer: React.FC<{
  variant: "compact" | "expanded";
  width: number;
  height: number;
  children: React.ReactNode;
  // Jeda sebelum konten muncul (detik); bawaan: 0.07 expanded, 0.1 compact
  delay?: number;
}> = ({ variant, width, height, children, delay }) => {
  // Mengecek apakah layer sedang expanded
  const isExpandedLayer = variant === "expanded";

  // Jeda efektif sebelum konten muncul
  const d = delay ?? (isExpandedLayer ? 0.07 : 0.1);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
      <motion.div
        className="pointer-events-auto relative"
        style={{
          width,
          height,
          // expanded tumbuh dari atas, compact tumbuh dari tengah
          transformOrigin: isExpandedLayer ? "top center" : "center center",
          willChange: "transform, opacity, filter",
        }}
        initial={{
          opacity: 0,
          scale: isExpandedLayer ? 0.9 : 0.78,
          filter: "blur(12px)",
        }}
        animate={{
          opacity: 1,
          scale: 1,
          filter: "blur(0px)",
          width, // berubah halus saat lebar pil berubah (lirik panjang)
          transition: {
            // opacity cepat, blur lebih lama: kesan fokus perlahan menajam
            opacity: { duration: 0.3, delay: d, ease: "easeOut" },
            scale: {
              type: "spring",
              stiffness: 230,
              damping: 21,
              mass: 0.9,
              delay: d,
            },
            filter: { duration: 0.46, delay: d, ease: MORPH_EASE },
            width: LYRIC_WIDEN_SPRING,
          },
        }}
        exit={{
          opacity: 0,
          scale: isExpandedLayer ? 0.9 : 0.8,
          filter: "blur(10px)",
          transition: {
            duration: 0.16,
            ease: [0.4, 0, 1, 1],
          },
        }}
      >
        {children}
      </motion.div>
    </div>
  );
};

// Membatasi angka sesuai nilai minimum dan maksimum
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

// Mengubah detik menjadi format menit:detik
const formatTime = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));

  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
};

// Warna cadangan album
const FALLBACK_PALETTE = ["#9da3ad", "#737b89", "#d2d5dc"];

// Mengambil warna dari gambar album
function useAlbumPalette(src: string) {
  // State warna album
  const [palette, setPalette] = useState<string[]>(FALLBACK_PALETTE);

  useEffect(() => {
    if (!src) {
      setPalette(FALLBACK_PALETTE);
      return;
    }

    // Status pembatalan proses
    let cancelled = false;

    // Memuat gambar album
    const image = new Image();

    // Mengatur CORS untuk gambar eksternal
    if (!src.startsWith("data:")) {
      image.crossOrigin = "anonymous";
    }

    // Mengambil warna setelah gambar selesai dimuat
    image.onload = () => {
      if (cancelled) return;

      try {
        // Membuat canvas untuk membaca warna gambar
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;

        // Context canvas
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        });

        if (!context) return;

        // Menggambar gambar album ke canvas
        context.drawImage(image, 0, 0, 24, 24);

        // Mengambil data pixel gambar
        const pixels = context.getImageData(0, 0, 24, 24).data;

        // Menyimpan kelompok warna
        const buckets = new Map<
          string,
          {
            r: number;
            g: number;
            b: number;
            count: number;
            score: number;
          }
        >();

        // Membaca setiap pixel gambar
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i],
            g = pixels[i + 1],
            b = pixels[i + 2],
            a = pixels[i + 3];

          if (a < 150) continue;

          // Menghitung tingkat warna
          const max = Math.max(r, g, b),
            min = Math.min(r, g, b);

          const saturation = max === 0 ? 0 : (max - min) / max;

          const brightness = (r + g + b) / 3;

          // Mengabaikan warna terlalu gelap atau terang
          if (brightness < 24 || brightness > 246) continue;

          // Mengelompokkan warna
          const key = `${Math.round(r / 32)}-${Math.round(g / 32)}-${Math.round(b / 32)}`;

          const current = buckets.get(key) ?? {
            r: 0,
            g: 0,
            b: 0,
            count: 0,
            score: 0,
          };

          current.r += r;
          current.g += g;
          current.b += b;
          current.count += 1;
          current.score += 0.35 + saturation * 1.8;

          buckets.set(key, current);
        }

        // Mengurutkan dan mengambil tiga warna utama
        const colors = [...buckets.values()]
          .sort(
            (a, b) =>
              b.score * Math.sqrt(b.count) - a.score * Math.sqrt(a.count),
          )
          .slice(0, 3)
          .map((v) => {
            const r = Math.round(v.r / v.count);
            const g = Math.round(v.g / v.count);
            const b = Math.round(v.b / v.count);

            return `rgb(${r}, ${g}, ${b})`;
          });

        // Memperbarui warna album
        if (!cancelled && colors.length) {
          setPalette(colors);
        }
      } catch (error) {
        // Mempertahankan warna cadangan jika canvas gagal
        console.debug("Album palette unavailable:", error);
      }
    };

    // Menggunakan warna cadangan jika gambar gagal dimuat
    image.onerror = () => !cancelled && setPalette(FALLBACK_PALETTE);

    image.src = src;

    // Membersihkan proses ketika sumber gambar berubah
    return () => {
      cancelled = true;
    };
  }, [src]);

  return palette;
}

// Menghitung posisi lagu secara realtime
function useLivePosition(track: SpotifyTrack) {
  // Ref data lagu terbaru
  const trackRef = useRef(track);
  trackRef.current = track;

  // Menghitung posisi lagu saat ini
  const getPosition = useCallback(() => {
    const t = trackRef.current;

    // Posisi terakhir dari backend
    const base = Math.max(0, t.positionSecs || 0);

    // Waktu yang berlalu sejak sinkronisasi
    const elapsed =
      t.isPlaying && t.syncedAt
        ? Math.max(0, (Date.now() - t.syncedAt) / 1000)
        : 0;

    // Durasi total lagu
    const duration = Math.max(0, t.durationSecs || 0);

    const live = base + elapsed;

    // Membatasi posisi agar tidak melebihi durasi
    return duration > 0 ? Math.min(live, duration) : live;
  }, []);

  return { trackRef, getPosition };
}

// ---- Palet spektrum: warna dibuat cerah dan hidup (seperti iPhone) ----

// Luminans relatif (0..1) sesuai persepsi mata: merah dan biru terlihat lebih gelap dari hijau
const srgbToLinear = (value: number) => {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

const relativeLuminance = (r: number, g: number, b: number) =>
  0.2126 * srgbToLinear(r) +
  0.7152 * srgbToLinear(g) +
  0.0722 * srgbToLinear(b);

// Membaca "#rrggbb" atau "rgb(r, g, b)"
function parseRgb(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{6})$/i);

  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

// RGB (0..255) ke HSL (h 0..360, s dan l 0..1)
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;

  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);

  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l];

  const s = d / (1 - Math.abs(2 * l - 1));

  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;

  return [(h * 60 + 360) % 360, s, l];
}

// HSL ke RGB (0..255)
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r = 0,
    g = 0,
    b = 0;

  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// Terangkan warna sampai cukup terlihat di atas island hitam, tanpa mengubah hue-nya.
// minLum = luminans minimum yang dituju (merah dan biru butuh lightness lebih tinggi
// daripada kuning atau hijau untuk terlihat sama terang).
function brightenColor(color: string, minLum: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;

  let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  if (s < 0.12) {
    // Abu-abu / hitam putih: jadikan abu terang yang bersih
    s = 0;
    l = Math.min(0.9, Math.max(l, 0.7));
  } else {
    // Warna berwarna: jaga tetap hidup (tidak pucat), lalu naikkan lightness
    // sampai luminansnya cukup. Batas 0.82 supaya tidak berubah jadi pastel putih.
    s = Math.min(1, Math.max(s, 0.62));
    l = Math.max(l, 0.44);

    while (l < 0.82) {
      const [r, g, b] = hslToRgb(h, s, l);
      if (relativeLuminance(r, g, b) >= minLum) break;
      l += 0.01;
    }
  }

  const [r, g, b] = hslToRgb(h, s, l);
  return `rgb(${r}, ${g}, ${b})`;
}

const vibrantCache = new Map<string, string[]>();

// Palet khusus spektrum: tiga warna yang sudah dicerahkan.
// a = warna utama, b = sedikit lebih dalam, c = lebih terang (untuk gradien bar).
function vibrantPalette(palette: string[]): string[] {
  // Warna cadangan abu-abu dibiarkan apa adanya
  if (palette === FALLBACK_PALETTE || palette.length === 0) return palette;

  const key = palette.join("|");
  const cached = vibrantCache.get(key);
  if (cached) return cached;

  const result = [
    brightenColor(palette[0], 0.26),
    brightenColor(palette[1] ?? palette[0], 0.2),
    brightenColor(palette[2] ?? palette[0], 0.34),
  ];

  if (vibrantCache.size > 60) vibrantCache.clear();
  vibrantCache.set(key, result);

  return result;
}

// Mengatur warna spektrum musik (warna album dicerahkan dulu agar tidak gelap)
const spectrumStyle = (palette: string[]) => {
  const vivid = vibrantPalette(palette);

  return {
    "--spectrum-a": vivid[0] ?? "#aeb4c0",
    "--spectrum-b": vivid[1] ?? "#777f8c",
    "--spectrum-c": vivid[2] ?? "#d4d7de",
  } as React.CSSProperties;
};

// ---- Spektrum audio asli ----

const SPECTRUM_BARS = 5;

// Bar mengecil menjadi titik: lama animasi dan jeda antar bar (ms)
const SPECTRUM_SETTLE_MS = 850;
const SPECTRUM_SETTLE_STAGGER_MS = 55;

// Data terbaru dari backend (event "audio-spectrum"): 5 angka 0..1
const spectrumFeed = {
  levels: [0, 0, 0, 0, 0] as number[],
  stamp: 0,
};

let spectrumUsers = 0;
let spectrumListening = false;

// Pendengar event dipasang sekali saja dan tidak dilepas
function ensureSpectrumListener() {
  if (spectrumListening) return;
  spectrumListening = true;

  listen<number[]>("audio-spectrum", (event) => {
    if (Array.isArray(event.payload)) {
      spectrumFeed.levels = event.payload;
      spectrumFeed.stamp = performance.now();
    }
  }).catch((error) => {
    spectrumListening = false;
    console.debug("audio-spectrum listener failed:", error);
  });
}

// Backend hanya menangkap audio selama ada spektrum yang membutuhkan
function spectrumAcquire() {
  ensureSpectrumListener();
  spectrumUsers += 1;
  if (spectrumUsers === 1) {
    invoke("spectrum_set_active", { active: true }).catch(() => {});
  }
}

function spectrumRelease() {
  spectrumUsers = Math.max(0, spectrumUsers - 1);
  if (spectrumUsers === 0) {
    invoke("spectrum_set_active", { active: false }).catch(() => {});
  }
}

// Tinggi bar mengikuti suara asli. Saat musik berhenti bar mengecil jadi titik.
// Tampilan (lebar, warna, gradien, jarak) tetap dari CSS .island-spectrum;
// hook ini hanya mengatur tinggi bar. Bila data audio tidak tersedia,
// animasi CSS bawaan dipakai kembali.
function useSpectrumDriver(
  ref: React.RefObject<HTMLDivElement | null>,
  playing: boolean,
) {
  const playingRef = useRef(playing);
  const kickRef = useRef<() => void>(() => {});

  // Siapkan bar sekali saat dipasang
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const bars = Array.from(root.children) as HTMLElement[];
    if (bars.length === 0) return;

    // Ukur: lebar bar = ukuran titik, tinggi wadah = tinggi bar maksimum
    bars.forEach((b) => {
      b.style.animation = "none";
      b.style.transform = "none";
      b.style.transition = "none";
      b.style.height = "";
    });

    const barW = parseFloat(getComputedStyle(bars[0]).width) || 3;
    const natural = Math.max(
      root.clientHeight,
      ...bars.map((b) => b.offsetHeight),
    );
    const maxH = natural >= barW * 2 ? natural : Math.max(barW * 5, 14);
    const minH = barW;

    // Kunci tinggi wadah agar tata letak tidak bergeser saat tinggi bar berubah
    root.style.height = `${maxH}px`;
    bars.forEach((b) => (b.style.height = `${minH}px`));

    const shown = bars.map(() => 0);
    let from = bars.map(() => 0); // tinggi bar saat musik berhenti
    let pauseAt = -1e9; // waktu musik berhenti
    let wasPlaying = playingRef.current;
    let css = false; // true = animasi CSS bawaan sedang dipakai
    let startedAt = performance.now();
    let running = false;
    let raf = 0;

    const useCss = (on: boolean) => {
      if (css === on) return;
      css = on;
      bars.forEach((b) => {
        b.style.animation = on ? "" : "none";
        b.style.transform = on ? "" : "none";
        b.style.height = on ? "" : `${minH}px`;
      });
    };

    const step = (now: number) => {
      const isPlaying = playingRef.current;
      const fresh = now - spectrumFeed.stamp < 700;

      // Data audio tidak ada (bukan Windows / gagal menangkap): pakai animasi CSS
      useCss(isPlaying && !fresh && now - startedAt > 1200);

      if (!css) {
        if (isPlaying) {
          wasPlaying = true;

          for (let i = 0; i < bars.length; i++) {
            const target = fresh
              ? Math.min(
                  1,
                  Math.max(0, spectrumFeed.levels[i % SPECTRUM_BARS] ?? 0),
                )
              : 0;

            // naik cepat, turun pelan
            shown[i] += (target - shown[i]) * (target > shown[i] ? 0.5 : 0.14);
            bars[i].style.height =
              `${(minH + (maxH - minH) * shown[i]).toFixed(2)}px`;
          }
        } else {
          // Musik berhenti: tiap bar mengecil perlahan menjadi titik
          // (ease-out, berurutan dari kiri ke kanan, berbasis waktu)
          if (wasPlaying) {
            wasPlaying = false;
            pauseAt = now;
            from = shown.slice();
          }

          let settled = true;

          for (let i = 0; i < bars.length; i++) {
            const t = Math.min(
              1,
              Math.max(
                0,
                (now - pauseAt - i * SPECTRUM_SETTLE_STAGGER_MS) /
                  SPECTRUM_SETTLE_MS,
              ),
            );
            if (t < 1) settled = false;

            const ease = 1 - Math.pow(1 - t, 3);
            shown[i] = from[i] * (1 - ease);
            bars[i].style.height =
              `${(minH + (maxH - minH) * shown[i]).toFixed(2)}px`;
          }

          // Semua bar sudah menjadi titik: selesai
          if (settled) {
            bars.forEach((b) => (b.style.height = `${minH}px`));
            running = false;
            return;
          }
        }
      }

      raf = requestAnimationFrame(step);
    };

    kickRef.current = () => {
      startedAt = performance.now();
      if (running) return;
      running = true;
      raf = requestAnimationFrame(step);
    };

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      kickRef.current = () => {};
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Putar / berhenti: minta data audio hanya saat musik main
  useEffect(() => {
    playingRef.current = playing;
    kickRef.current();

    if (!playing) return;

    spectrumAcquire();
    return () => spectrumRelease();
  }, [playing]);
}

// Spektrum musik (5 bar). Markup dan class sama seperti sebelumnya.
const Spectrum: React.FC<{
  playing: boolean;
  palette: string[];
  extraClass?: string;
}> = ({ playing, palette, extraClass = "" }) => {
  const ref = useRef<HTMLDivElement>(null);
  useSpectrumDriver(ref, playing);

  return (
    <div
      ref={ref}
      className={`island-spectrum ${extraClass}${playing ? " is-playing" : ""}`}
      style={spectrumStyle(palette)}
    >
      {Array.from({ length: SPECTRUM_BARS }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
};

// Style dasar tombol musik
const buttonBase =
  "inline-flex items-center justify-center text-white/90 hover:text-white active:scale-90 transition-transform duration-150 focus:outline-none";

// Satu segitiga ikon skip (menghadap kanan), dipakai sebagai "gerbong" animasi
const SKIP_TRIANGLE =
  "M5 3.5L24.5 14.2C25.8 14.9 25.8 17.1 24.5 17.8L5 28.5C3.7 29.2 2 28.3 2 26.7V5.3C2 3.7 3.7 2.8 5 3.5Z";

// Jarak antar segitiga pada ikon (satuan viewBox)
const SKIP_STEP = 20;

// Pegas animasi skip, ada sedikit overshoot seperti Apple Music
const SKIP_SPRING = {
  type: "spring",
  stiffness: 330,
  damping: 21,
  mass: 0.75,
} as const;

// Pegas efek tekan tombol
const SKIP_PRESS_SPRING = {
  type: "spring",
  stiffness: 520,
  damping: 28,
} as const;

// Varian efek tekan: tombol mengecil dan lingkaran highlight muncul
const skipButtonVariants = {
  rest: { scale: 1, transition: SKIP_PRESS_SPRING },
  pressed: { scale: 0.86, transition: SKIP_PRESS_SPRING },
};

const skipHighlightVariants = {
  rest: { opacity: 0, scale: 0.7, transition: { duration: 0.22 } },
  pressed: { opacity: 1, scale: 1, transition: { duration: 0.1 } },
};

// Membatasi nilai opacity 0..1
const unit = (v: number) => Math.min(1, Math.max(0, v));

// Tombol next/prev dengan animasi segitiga maju berganti ala Apple Music
const SkipButton: React.FC<{
  direction: "next" | "prev";
  label: string;
  onPress: () => void;
}> = ({ direction, label, onPress }) => {
  // Progress animasi, naik 1 setiap klik (tidak dibatasi, supaya klik cepat tetap mulus)
  const progress = useMotionValue(0);

  // Target progress saat ini
  const target = useRef(0);

  // Bagian pecahan progress (0..1) yang menggerakkan segitiga
  const frac = useTransform(progress, (v) => ((v % 1) + 1) % 1);

  // Segitiga baru: masuk dari belakang lalu muncul perlahan
  const xIn = useTransform(frac, (f) => (f - 1) * SKIP_STEP);
  const opIn = useTransform(frac, (f) => unit(f * 1.25));

  // Segitiga tengah: bergeser maju mengisi posisi berikutnya
  const xMid = useTransform(frac, (f) => f * SKIP_STEP);

  // Segitiga depan: keluar ke depan lalu menghilang
  const xOut = useTransform(frac, (f) => (f + 1) * SKIP_STEP);
  const opOut = useTransform(frac, (f) => unit(1 - f * 1.25));

  // Menjalankan animasi setiap tombol diklik
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    target.current += 1;

    animate(progress, target.current, SKIP_SPRING);

    onPress();
  };

  return (
    <motion.button
      aria-label={label}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()}
      className="relative inline-flex items-center justify-center text-white/90 hover:text-white focus:outline-none"
      variants={skipButtonVariants}
      initial="rest"
      animate="rest"
      whileTap="pressed"
    >
      {/* Lingkaran highlight saat ditekan */}
      <motion.span
        className="pointer-events-none absolute -inset-[7px] rounded-full bg-white/[0.16]"
        variants={skipHighlightVariants}
      />

      <svg
        width="32"
        height="28"
        viewBox="0 0 48 32"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        style={{ overflow: "visible" }}
      >
        {/* Untuk prev, seluruh ikon dicerminkan secara horizontal */}
        <g
          transform={
            direction === "prev" ? "translate(48 0) scale(-1 1)" : undefined
          }
        >
          <motion.g style={{ x: xIn, opacity: opIn }}>
            <path d={SKIP_TRIANGLE} />
          </motion.g>

          <motion.g style={{ x: xMid }}>
            <path d={SKIP_TRIANGLE} />
          </motion.g>

          <motion.g style={{ x: xOut, opacity: opOut }}>
            <path d={SKIP_TRIANGLE} />
          </motion.g>
        </g>
      </svg>
    </motion.button>
  );
};

// ---- Sumber media: musik atau video ----

// Lompatan tombol maju/mundur saat yang diputar adalah video (detik).
// 10 = sama seperti tombol J (mundur) dan L (maju) di YouTube.
export const VIDEO_SKIP_SECONDS = 10;

type MediaSourceKind = "music" | "video";

// Payload event "media-source-update" dari Rust
interface MediaSourcePayload {
  kind: MediaSourceKind;
  app: string;
}

const mediaSourceStore = {
  kind: "music" as MediaSourceKind,
  listening: false,
  subscribers: new Set<(kind: MediaSourceKind) => void>(),
};

// Pendengar event dipasang sekali saja dan tidak dilepas
function ensureMediaSourceListener() {
  if (mediaSourceStore.listening) return;
  mediaSourceStore.listening = true;

  listen<MediaSourcePayload>("media-source-update", (event) => {
    const payload = event.payload;

    // Tidak ada sesi media: pertahankan jenis terakhir supaya tombol tidak berkedip
    if (!payload || !payload.app) return;

    const next: MediaSourceKind = payload.kind === "video" ? "video" : "music";
    if (next === mediaSourceStore.kind) return;

    mediaSourceStore.kind = next;
    mediaSourceStore.subscribers.forEach((notify) => notify(next));
  }).catch((error) => {
    mediaSourceStore.listening = false;
    console.debug("media-source-update listener failed:", error);
  });
}

// Jenis media yang sedang diputar. Tanpa backend baru, hasilnya tetap "music"
function useMediaSourceKind(): MediaSourceKind {
  const [kind, setKind] = useState<MediaSourceKind>(mediaSourceStore.kind);

  useEffect(() => {
    ensureMediaSourceListener();
    mediaSourceStore.subscribers.add(setKind);
    setKind(mediaSourceStore.kind);

    return () => {
      mediaSourceStore.subscribers.delete(setKind);
    };
  }, []);

  return kind;
}

// Panah melingkar ala iOS (gobackward / goforward), digambar untuk arah maju.
// Lingkaran terbuka 300° dengan celah di atas; ujung panah ada di sisi kiri celah.
const SEEK_ARC = "M21.50 6.47A11 11 0 1 1 10.50 6.47";
const SEEK_HEAD = "M10.86 10.30L12.58 5.27L7.36 4.24";

// Pegas putaran panah: berputar satu lingkaran penuh lalu berhenti halus
const SEEK_SPIN = {
  type: "spring",
  stiffness: 150,
  damping: 19,
  mass: 0.9,
} as const;

// Tombol maju / mundur beberapa detik untuk video, dengan panah yang berputar ala iOS
const SeekButton: React.FC<{
  direction: "back" | "forward";
  seconds: number;
  label: string;
  onPress: () => void;
}> = ({ direction, seconds, label, onPress }) => {
  // Sudut putaran panah (derajat), naik 360 setiap klik supaya klik cepat tetap mulus
  const rotation = useMotionValue(0);
  const target = useRef(0);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    target.current += 360;
    animate(rotation, target.current, SEEK_SPIN);

    onPress();
  };

  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()}
      className="relative inline-flex h-[30px] w-[30px] items-center justify-center text-white/90 hover:text-white focus:outline-none"
      variants={skipButtonVariants}
      initial="rest"
      animate="rest"
      whileTap="pressed"
    >
      {/* Lingkaran highlight saat ditekan */}
      <motion.span
        className="pointer-events-none absolute -inset-[7px] rounded-full bg-white/[0.16]"
        variants={skipHighlightVariants}
      />

      {/* Untuk mundur, panah dicerminkan: putaran positif jadi berlawanan arah jarum jam */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{ transform: direction === "back" ? "scaleX(-1)" : undefined }}
      >
        <motion.span
          className="absolute inset-0 flex items-center justify-center"
          style={{ rotate: rotation }}
        >
          <svg
            width="30"
            height="30"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.3}
            strokeLinecap="round"
            strokeLinejoin="round"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d={SEEK_ARC} />
            <path d={SEEK_HEAD} />
          </svg>
        </motion.span>
      </span>

      {/* Angka di tengah tidak ikut berputar */}
      <span
        className="pointer-events-none relative text-[10.5px] font-bold leading-none tabular-nums"
        style={{ paddingTop: 1 }}
      >
        {seconds}
      </span>
    </motion.button>
  );
};

// ---- Teks berjalan (judul panjang) ----

// Kecepatan geser (px per detik): pelan
const MARQUEE_SPEED = 26;

// Diam dulu setelah island dibuka / judul berganti (ms)
const MARQUEE_START_DELAY = 1800;

// Diam sebentar di awal setiap putaran berikutnya (ms)
const MARQUEE_LOOP_DELAY = 1400;

// Jarak antara akhir teks dan salinan berikutnya (px)
const MARQUEE_GAP = 36;

// Teks satu baris. Muat -> diam. Terlalu panjang -> diam sebentar, lalu berjalan
// pelan ke kiri berulang-ulang, dengan tepi kiri/kanan memudar
const MarqueeText: React.FC<{ text: string; className?: string }> = ({
  text,
  className = "",
}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const x = useMotionValue(0);

  const [textWidth, setTextWidth] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [moving, setMoving] = useState(false);

  // Ukur teks dan wadah. Diukur ulang saat ukuran berubah (mis. panel volume dibuka)
  useLayoutEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;

    const measure = () => {
      const width = el.offsetWidth;
      setTextWidth(width);
      setOverflow(width > box.clientWidth + 1);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(el);

    return () => observer.disconnect();
  }, [text]);

  // Jalankan: diam -> geser satu putaran -> diam -> ulangi
  useEffect(() => {
    x.set(0);
    setMoving(false);

    if (!overflow || textWidth <= 0) return;

    const distance = textWidth + MARQUEE_GAP;

    let cancelled = false;
    let timer: number | undefined;
    let controls: { stop: () => void } | undefined;

    const cycle = (delay: number) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;

        setMoving(true);

        controls = animate(x, -distance, {
          duration: distance / MARQUEE_SPEED,
          ease: "linear",
          onComplete: () => {
            if (cancelled) return;

            // Salinan kedua kini tepat di posisi awal, jadi reset tidak terlihat
            x.set(0);
            setMoving(false);
            cycle(MARQUEE_LOOP_DELAY);
          },
        });
      }, delay);
    };

    cycle(MARQUEE_START_DELAY);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controls?.stop();
      x.set(0);
    };
  }, [overflow, textWidth, text, x]);

  // Tepi kanan selalu memudar saat teks terpotong; tepi kiri hanya saat bergerak
  const mask = !overflow
    ? undefined
    : moving
      ? "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 16px), transparent 100%)"
      : "linear-gradient(to right, #000 calc(100% - 16px), transparent 100%)";

  return (
    <div
      ref={boxRef}
      className={`relative overflow-hidden whitespace-nowrap ${className}`}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      <motion.div className="flex w-max" style={{ x }}>
        <span ref={textRef} className="shrink-0">
          {text}
        </span>

        {/* Salinan kedua agar putaran tersambung mulus */}
        {overflow && (
          <span
            aria-hidden
            className="shrink-0"
            style={{ paddingLeft: MARQUEE_GAP }}
          >
            {text}
          </span>
        )}
      </motion.div>
    </div>
  );
};

// Tampilan Spotify compact
const CompactView: React.FC<{
  track: SpotifyTrack;
  palette: string[];
}> = ({ track, palette }) => (
  <div className="flex h-full w-full items-center justify-between px-[8px] text-white">
    {/* Kontainer album */}
    <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-white/10">
      {track.albumArt ? (
        <img
          src={track.albumArt}
          alt=""
          className="h-full w-full object-cover"
        />
      ) : (
        <Music size={14} className="text-white/70" />
      )}
    </div>

    {/* Kontainer spektrum musik */}
    <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center">
      <Spectrum playing={track.isPlaying} palette={palette} />
    </div>
  </div>
);

// Tampilan Spotify expanded
const ExpandedView: React.FC<{
  track: SpotifyTrack;
  palette: string[];
  sourceKind: MediaSourceKind;
  runCommand: (command: MediaCommand) => void;
  onSeek: (positionSecs: number) => void;
  onOpenLyrics: () => void;
  onVolumePress?: () => void;
}> = ({
  track,
  palette,
  sourceKind,
  runCommand,
  onSeek,
  onOpenLyrics,
  onVolumePress,
}) => {
  // Warna utama album
  const accent = palette[0] ?? FALLBACK_PALETTE[0];

  // Posisi lagu realtime
  const { trackRef, getPosition } = useLivePosition(track);

  // Status tombol play/pause bertahan sebentar setelah diklik, supaya ikon
  // tidak berkedip bolak-balik saat data dari backend belum sinkron
  const [forcedPlaying, setForcedPlaying] = useState<boolean | null>(null);
  const forcedTimer = useRef(0);
  const playing = forcedPlaying ?? track.isPlaying;

  const handleTogglePlay = () => {
    setForcedPlaying(!playing);
    window.clearTimeout(forcedTimer.current);
    forcedTimer.current = window.setTimeout(() => setForcedPlaying(null), 900);
    runCommand("media_toggle_play");
  };

  useEffect(() => () => window.clearTimeout(forcedTimer.current), []);

  // Lompat maju / mundur beberapa detik (dipakai saat yang diputar adalah video)
  const lastSkip = useRef<{ at: number; target: number } | null>(null);

  const skipBy = useCallback(
    (deltaSecs: number) => {
      const duration = Math.max(0, trackRef.current.durationSecs || 0);

      // Siaran langsung / durasi tidak diketahui: tidak bisa dilompati
      if (duration <= 0) return;

      // Klik beruntun: lanjutkan dari target terakhir, bukan dari posisi lama yang belum tersinkron
      const last = lastSkip.current;
      const base =
        last && performance.now() - last.at < 800 ? last.target : getPosition();

      const target = clamp(base + deltaSecs, 0, duration);

      lastSkip.current = { at: performance.now(), target };
      onSeek(target);
    },
    [getPosition, onSeek, trackRef],
  );

  // Ref progress bar
  const barRef = useRef<HTMLDivElement>(null);

  // Ref waktu berjalan
  const elapsedRef = useRef<HTMLSpanElement>(null);

  // Ref sisa waktu
  const remainingRef = useRef<HTMLSpanElement>(null);

  // Ref area drag progress
  const scrubAreaRef = useRef<HTMLDivElement>(null);

  // Menyimpan teks waktu sebelumnya
  const labelsRef = useRef({
    elapsed: "",
    remaining: "",
  });

  // Status drag dan posisi seek
  const scrub = useRef({
    dragging: false,
    pending: false,
    position: 0,
  });

  // Membuka pencarian artis di aplikasi Spotify desktop
  const openArtist = (e: React.MouseEvent) => {
    e.stopPropagation();

    const artist = track.artist?.trim();

    if (!artist) return;

    openUrl(`spotify:search:${encodeURIComponent(artist)}`).catch((error) =>
      console.error("Gagal membuka artis di Spotify:", error),
    );
  };

  // State status drag
  const [scrubbing, setScrubbing] = useState(false);

  // Memperbarui progress bar dan waktu
  const paint = useCallback(() => {
    const t = trackRef.current;
    const s = scrub.current;

    // Durasi lagu
    const duration = Math.max(0, t.durationSecs || 0);

    // Posisi lagu yang ditampilkan
    const position = s.dragging || s.pending ? s.position : getPosition();

    // Menghitung persentase progress
    const percent =
      duration > 0
        ? clamp((position / duration) * 100, 0, 100)
        : clamp(t.progress ?? 0, 0, 100);

    // Mengatur lebar progress bar
    if (barRef.current) {
      barRef.current.style.width = `${percent}%`;
    }

    // Format waktu berjalan
    const elapsedText = formatTime(position);

    if (elapsedRef.current && elapsedText !== labelsRef.current.elapsed) {
      elapsedRef.current.textContent = elapsedText;
      labelsRef.current.elapsed = elapsedText;
    }

    // Format sisa waktu
    const remainingText =
      duration > 0 ? `-${formatTime(duration - position)}` : "--:--";

    if (remainingRef.current && remainingText !== labelsRef.current.remaining) {
      remainingRef.current.textContent = remainingText;
      labelsRef.current.remaining = remainingText;
    }
  }, [getPosition, trackRef]);

  // Menjalankan update progress secara realtime
  useLayoutEffect(() => {
    let raf = 0;

    // Melepas status pending setelah posisi baru masuk
    if (!scrub.current.dragging && scrub.current.pending) {
      scrub.current.pending = false;
    }

    // Loop update progress
    const loop = () => {
      paint();

      if (trackRef.current.isPlaying || scrub.current.dragging) {
        raf = requestAnimationFrame(loop);
      }
    };

    loop();

    // Membersihkan animation frame
    return () => cancelAnimationFrame(raf);
  }, [
    track.isPlaying,
    track.syncedAt,
    track.positionSecs,
    track.durationSecs,
    track.title,
    paint,
    trackRef,
  ]);

  // Menghitung posisi lagu dari pointer
  const positionFromPointer = (clientX: number) => {
    const el = scrubAreaRef.current;

    const duration = Math.max(0, trackRef.current.durationSecs || 0);

    if (!el || duration <= 0) return null;

    const rect = el.getBoundingClientRect();

    if (rect.width <= 0) return null;

    return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
  };

  // Memulai drag progress bar
  const onScrubStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const position = positionFromPointer(e.clientX);

    if (position === null) return;

    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);

    scrub.current = {
      dragging: true,
      pending: false,
      position,
    };

    setScrubbing(true);
    paint();
  };

  // Memperbarui posisi ketika progress digeser
  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrub.current.dragging) return;

    const position = positionFromPointer(e.clientX);

    if (position === null) return;

    scrub.current.position = position;
    paint();
  };

  // Mengakhiri drag progress bar
  const onScrubEnd = (
    e: React.PointerEvent<HTMLDivElement>,
    commit: boolean,
  ) => {
    const s = scrub.current;

    if (!s.dragging) return;

    s.dragging = false;
    setScrubbing(false);

    // Melepaskan pointer
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (commit) {
      const position = positionFromPointer(e.clientX);

      if (position !== null) {
        s.position = position;
      }

      s.pending = true;

      // Mengirim posisi seek
      onSeek(s.position);

      // Melepas status pending jika posisi baru belum masuk
      window.setTimeout(() => {
        scrub.current.pending = false;
        paint();
      }, 500);
    } else {
      paint();
    }
  };

  return (
    <div
      className="relative flex h-full w-full flex-col justify-between overflow-hidden px-[22px] pb-[17px] pt-[19px] text-white"
      style={{
        background: "#000000",
        ["--album-accent" as string]: accent,
      }}
    >
      {/* Informasi lagu */}
      <div className="relative flex min-w-0 items-center gap-3.5">
        {/* Kontainer album */}
        <motion.div
          className="h-[58px] w-[58px] shrink-0"
          style={{ transformOrigin: "center" }}
          initial={false}
          animate={{
            scale: track.isPlaying ? 1 : 0.86,
          }}
          transition={{
            type: "spring",
            stiffness: 420,
            damping: 26,
            mass: 0.7,
          }}
        >
          <div className="relative h-full w-full overflow-hidden rounded-[12px] bg-white/10 ring-1 ring-white/10">
            {track.albumArt ? (
              <img
                src={track.albumArt}
                alt="Album artwork"
                className="h-full w-full object-cover"
              />
            ) : (
              <Music size={25} className="m-4 text-white/60" />
            )}

            {/* Overlay hitam ketika musik pause */}
            <motion.div
              className="pointer-events-none absolute inset-0 bg-black"
              initial={false}
              animate={{
                opacity: track.isPlaying ? 0 : 0.45,
              }}
              transition={{
                duration: 0.26,
                ease: "easeOut",
              }}
            />
          </div>
        </motion.div>

        {/* Kontainer informasi lagu */}
        <div className="min-w-0 flex-1">
          {/* Judul lagu + spektrum, satu baris (spektrum sejajar judul) */}
          <div className="flex items-center gap-2.5">
            <MarqueeText
              text={track.title || "Memutar Musik..."}
              className="min-w-0 flex-1 text-[15px] font-semibold leading-[1.2] tracking-[-0.035em] text-white"
            />

            {/* Tinggi sama dengan satu baris judul (15px x 1.2 = 18px) */}
            <div className="flex h-[18px] shrink-0 items-center">
              <Spectrum
                playing={track.isPlaying}
                palette={palette}
                extraClass="expanded-spectrum "
              />
            </div>
          </div>

          {/* Nama artis */}
          <div
            role="button"
            onClick={openArtist}
            onMouseDown={(e) => e.preventDefault()}
            className="mt-1 cursor-pointer truncate text-[12px] font-normal tracking-[-0.01em] text-white/55 transition hover:text-white"
          >
            {track.artist || "Unknown Artist"}
          </div>
        </div>
      </div>

      {/* Kontainer progress lagu: waktu kiri | bar | waktu kanan */}
      <div className="relative mt-3 flex items-center gap-2">
        {/* Waktu berjalan (kiri): abu-abu, putih saat progress digeser */}
        <span
          ref={elapsedRef}
          className={`min-w-[34px] text-left text-[13px] font-normal leading-none tabular-nums tracking-[-0.01em] transition-colors duration-150 ${
            scrubbing ? "text-white" : "text-white/55"
          }`}
        >
          0:00
        </span>

        {/* Area drag progress bar */}
        <div
          ref={scrubAreaRef}
          className="flex h-4 min-w-0 flex-1 cursor-pointer touch-none items-center"
          onPointerDown={onScrubStart}
          onPointerMove={onScrubMove}
          onPointerUp={(e) => onScrubEnd(e, true)}
          onPointerCancel={(e) => onScrubEnd(e, false)}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Background progress bar */}
          <div
            className={`w-full overflow-hidden rounded-full bg-white/[0.19] transition-[height] duration-150 ease-out ${
              scrubbing ? "h-[10px]" : "h-[6px]"
            }`}
          >
            {/* Progress berjalan */}
            <div
              ref={barRef}
              className="h-full rounded-full"
              style={{
                background: "#ffffff",
                boxShadow: "0 0 9px #ffffff70",
              }}
            />
          </div>
        </div>

        {/* Sisa waktu (kanan): abu-abu, putih saat progress digeser */}
        <span
          ref={remainingRef}
          className={`min-w-[34px] text-right text-[13px] font-normal leading-none tabular-nums tracking-[-0.01em] transition-colors duration-150 ${
            scrubbing ? "text-white" : "text-white/55"
          }`}
        >
          --:--
        </span>
      </div>

      {/* Kontainer tombol kontrol musik */}
      <div className="relative mt-3 flex items-center justify-between px-1">
        {/* Tombol membuka lirik */}
        <button
          aria-label="Lirik"
          onClick={(e) => {
            e.stopPropagation();
            onOpenLyrics();
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white active:scale-90"
        >
          <LyricsIcon size={19} />
        </button>

        {/* Tombol kontrol lagu */}
        <div className="flex items-center gap-[34px]">
          {/* Musik: lagu sebelumnya. Video: mundur beberapa detik */}
          {sourceKind === "video" ? (
            <SeekButton
              direction="back"
              seconds={VIDEO_SKIP_SECONDS}
              label={`Mundur ${VIDEO_SKIP_SECONDS} detik`}
              onPress={() => skipBy(-VIDEO_SKIP_SECONDS)}
            />
          ) : (
            <SkipButton
              direction="prev"
              label="Previous track"
              onPress={() => runCommand("media_previous")}
            />
          )}

          {/* Tombol play dan pause */}
          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={(e) => {
              e.stopPropagation();
              handleTogglePlay();
            }}
            onMouseDown={(e) => e.preventDefault()}
            className={`${buttonBase} h-9 w-9`}
          >
            {playing ? (
              <Pause size={31} fill="currentColor" strokeWidth={1.4} />
            ) : (
              // geser optik pakai transform (bukan margin) supaya tata letak tidak berubah
              <Play
                size={30}
                fill="currentColor"
                strokeWidth={1.4}
                style={{ transform: "translateX(2px)" }}
              />
            )}
          </button>

          {/* Musik: lagu berikutnya. Video: maju beberapa detik */}
          {sourceKind === "video" ? (
            <SeekButton
              direction="forward"
              seconds={VIDEO_SKIP_SECONDS}
              label={`Maju ${VIDEO_SKIP_SECONDS} detik`}
              onPress={() => skipBy(VIDEO_SKIP_SECONDS)}
            />
          ) : (
            <SkipButton
              direction="next"
              label="Next track"
              onPress={() => runCommand("media_next")}
            />
          )}
        </div>

        {/* Tombol volume (kanan bawah, selebar tombol lirik): memanggil VolumeHud */}
        <button
          type="button"
          aria-label="Volume"
          onClick={(e) => {
            e.stopPropagation();
            onVolumePress?.();
          }}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white active:scale-90"
        >
          <Volume2 size={19} />
        </button>
      </div>
    </div>
  );
};

// Animasi perpindahan antara player dan lirik
const viewVariants = {
  initial: (d: number) => ({
    opacity: 0,
    x: 26 * d,
    scale: 0.96,
    filter: "blur(12px)",
  }),

  animate: {
    opacity: 1,
    x: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      duration: 0.38,
      ease: MORPH_EASE,
    },
  },

  exit: (d: number) => ({
    opacity: 0,
    x: -26 * d,
    scale: 0.96,
    filter: "blur(12px)",
    transition: {
      duration: 0.22,
      ease: "easeIn" as const,
    },
  }),
};

// Tampilan lirik pada mode mini
// Lebar di luar teks lirik: padding, album, jarak, spektrum, dan margin pudar
const LYRIC_MINI_CHROME = 116;

const LyricMiniView: React.FC<{
  track: SpotifyTrack;
  palette: string[];
  lyrics: LyricsState;
  index: number;
  onNeedWidth?: (px: number) => void;
}> = ({ track, palette, lyrics, index, onNeedWidth }) => {
  // Menentukan teks lirik yang ditampilkan
  const text =
    lyrics.status === "ready"
      ? index >= 0
        ? lyrics.lines[index].text || "♪"
        : "♪"
      : lyrics.status === "loading"
        ? "Memuat lirik…"
        : track.title;

  // Ukur lebar baris lirik, lalu laporkan agar pil bisa melebar
  const measureRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const textWidth = measureRef.current?.offsetWidth ?? 0;

    // Hanya baris lirik asli yang melebarkan pil
    onNeedWidth?.(
      lyrics.status === "ready" && textWidth > 0
        ? Math.ceil(textWidth) + LYRIC_MINI_CHROME
        : 0,
    );
  }, [text, lyrics.status, onNeedWidth]);

  return (
    <div className="relative flex h-full w-full items-center gap-2 overflow-hidden px-[8px] text-white">
      {/* Pengukur lebar teks (tidak terlihat) */}
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-[12.5px] font-semibold tracking-[-0.01em]"
      >
        {text}
      </span>

      {/* Kontainer album */}
      <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-white/10">
        {track.albumArt ? (
          <img
            src={track.albumArt}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <Music size={14} className="text-white/70" />
        )}
      </div>

      {/* Kontainer teks lirik */}
      <div
        className="relative h-full min-w-0 flex-1 overflow-hidden"
        style={{
          WebkitMaskImage:
            "linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)",
          maskImage:
            "linear-gradient(to right, transparent, #000 8%, #000 92%, transparent)",
        }}
      >
        {/* Animasi pergantian baris lirik */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={`${index}:${text}`}
            className="absolute inset-0 flex items-center justify-center px-1"
            initial={{
              opacity: 0,
              y: 10,
              filter: "blur(6px)",
            }}
            animate={{
              opacity: 1,
              y: 0,
              filter: "blur(0px)",
              transition: {
                duration: 0.3,
                ease: MORPH_EASE,
              },
            }}
            exit={{
              opacity: 0,
              y: -10,
              filter: "blur(6px)",
              transition: {
                duration: 0.18,
              },
            }}
          >
            <span className="truncate text-[12.5px] font-semibold tracking-[-0.01em]">
              {text}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Kontainer spektrum musik */}
      <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center">
        <Spectrum playing={track.isPlaying} palette={palette} />
      </div>
    </div>
  );
};

// Komponen utama SpotifyWidget
// Ikon kunci. Saat tidak terkunci, ada strip miring di atasnya
const LockIcon: React.FC<{ size?: number; slashed?: boolean }> = ({
  size = 17,
  slashed = false,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {slashed && (
      <mask
        id="lock-slash-mask"
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="24"
        height="24"
      >
        <rect width="24" height="24" fill="white" />
        {/* Celah di sekitar strip supaya garis terlihat jelas */}
        <line x1="3" y1="3" x2="21" y2="21" stroke="black" strokeWidth={5} />
      </mask>
    )}
    <g mask={slashed ? "url(#lock-slash-mask)" : undefined}>
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </g>
    {slashed && <line x1="3" y1="3" x2="21" y2="21" />}
  </svg>
);

export const SpotifyWidget: React.FC<SpotifyWidgetProps> = ({
  track,
  onTogglePlay,
  onNext,
  onSeek,
  isExpanded = false,
  isMini = false,
  widthAdjust = 0,
  heightAdjust = 0,
  extraWidth = 0,
  onLyricNeedWidth,
  lyrics,
  lyricsMode = false,
  onLyricsModeChange,
  locked = false,
  onLockedChange,
  onVolumePress,
}) => {
  // Mengambil warna album
  const palette = useAlbumPalette(track.albumArt);

  // Musik atau video yang sedang diputar (menentukan jenis tombol prev/next)
  const sourceKind = useMediaSourceKind();

  // Mengambil posisi lagu realtime
  const { getPosition } = useLivePosition(track);

  // Mengambil indeks baris lirik aktif
  const activeIndex = useActiveLine(
    getPosition,
    lyrics.lines,
    lyricsMode && lyrics.status === "ready",
  );

  // State untuk menampilkan terjemahan
  const [showTranslation, setShowTranslation] = useState(false);

  // Mereset terjemahan ketika lagu berubah
  useEffect(() => setShowTranslation(false), [track.title]);

  // Menjalankan perintah media
  const runCommand = useCallback(
    (command: MediaCommand) => {
      // Memperbarui UI langsung ketika play atau pause
      if (command === "media_toggle_play") {
        onTogglePlay?.();
      }

      // Memanggil lagu berikutnya
      if (command === "media_next") {
        onNext?.();
      }

      // Mengirim perintah ke backend Tauri
      invoke(command).catch((error) => {
        console.error(`Media command ${command} failed:`, error);

        // Mengembalikan UI jika perintah gagal
        if (command === "media_toggle_play") {
          onTogglePlay?.();
        }
      });
    },
    [onTogglePlay, onNext],
  );

  // Menjalankan seek lagu
  const handleSeek = useCallback(
    (positionSecs: number) => {
      // Memperbarui posisi UI langsung
      onSeek?.(positionSecs);

      // Mengirim posisi seek ke backend
      invoke("media_seek", { positionSecs }).catch((error) => {
        console.error(
          "Media seek failed (apakah command `media_seek` sudah ada di Rust?):",
          error,
        );
      });
    },
    [onSeek],
  );

  // Island baru menutup dari expand: konten compact menunggu pil selesai menciut
  const wasExpanded = useRef(isExpanded);
  const collapsing = wasExpanded.current && !isExpanded;

  useEffect(() => {
    wasExpanded.current = isExpanded;
  });

  // Arah animasi perpindahan tampilan
  const dir = lyricsMode ? 1 : -1;

  // Menentukan ukuran tampilan mini
  const baseSize = lyricsMode
    ? SPOTIFY_SIZES.lyricsMini
    : SPOTIFY_SIZES.compact;

  const miniSize = {
    width: baseSize.width + widthAdjust + (lyricsMode ? extraWidth : 0),
    height: baseSize.height + heightAdjust,
  };

  return (
    <div className="relative h-full w-full">
      <AnimatePresence initial={false}>
        {/* Tampilan expanded */}
        {isExpanded ? (
          <MorphLayer
            key="spotify-expanded"
            variant="expanded"
            width={SPOTIFY_SIZES.expanded.width}
            height={SPOTIFY_SIZES.lyrics.height}
          >
            <AnimatePresence initial={false} custom={dir}>
              {/* Tampilan halaman lirik */}
              {lyricsMode ? (
                <motion.div
                  key="lyrics"
                  custom={1}
                  variants={viewVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="absolute inset-x-0 top-0"
                  style={{
                    height: SPOTIFY_SIZES.lyrics.height,
                  }}
                >
                  <LyricsView
                    track={track}
                    palette={palette}
                    lyrics={lyrics}
                    activeIndex={activeIndex}
                    showTranslation={showTranslation}
                    onToggleTranslation={() => setShowTranslation((v) => !v)}
                    onBack={() => onLyricsModeChange?.(false)}
                    onTogglePlay={() => runCommand("media_toggle_play")}
                    onSeekTo={handleSeek}
                  />

                  {/* Tombol kunci (kanan bawah) */}
                  <button
                    type="button"
                    aria-label={locked ? "Buka kunci island" : "Kunci island"}
                    aria-pressed={locked}
                    onClick={(e) => {
                      e.stopPropagation();
                      onLockedChange?.(!locked);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.preventDefault()}
                    className={`absolute bottom-[20px] right-[16px] z-20 flex h-8 w-8 items-center justify-center rounded-full transition active:scale-90 ${
                      locked
                        ? "bg-white/10 text-white"
                        : "text-white hover:bg-white/10"
                    }`}
                  >
                    <LockIcon slashed={!locked} />
                  </button>
                </motion.div>
              ) : (
                // Tampilan player expanded
                <motion.div
                  key="player"
                  custom={-1}
                  variants={viewVariants}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="absolute inset-x-0 top-0"
                  style={{
                    height: SPOTIFY_SIZES.expanded.height,
                  }}
                >
                  <ExpandedView
                    track={track}
                    palette={palette}
                    sourceKind={sourceKind}
                    runCommand={runCommand}
                    onSeek={handleSeek}
                    onOpenLyrics={() => onLyricsModeChange?.(true)}
                    onVolumePress={onVolumePress}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </MorphLayer>
        ) : isMini ? null : ( // Menyembunyikan widget ketika mode mini tidak aktif
          // Tampilan compact
          <MorphLayer
            key="spotify-compact"
            variant="compact"
            width={miniSize.width}
            height={miniSize.height}
            delay={collapsing ? COLLAPSE_CONTENT_DELAY : undefined}
          >
            {lyricsMode ? (
              // Tampilan lirik dalam pil mini
              <LyricMiniView
                track={track}
                palette={palette}
                lyrics={lyrics}
                index={activeIndex}
                onNeedWidth={onLyricNeedWidth}
              />
            ) : (
              // Tampilan musik dalam pil mini
              <CompactView track={track} palette={palette} />
            )}
          </MorphLayer>
        )}
      </AnimatePresence>
    </div>
  );
};
