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
import { Minus, Music, Pause, Play, Plus, Volume2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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

  // Data lirik
  lyrics: LyricsState;

  // Mengatur mode lirik
  lyricsMode?: boolean;
  onLyricsModeChange?: (on: boolean) => void;

  // Kunci island saat lirik expanded (tidak menutup otomatis)
  locked?: boolean;
  onLockedChange?: (locked: boolean) => void;

  // Tombol volume -/+ (1 = naik, -1 = turun). HUD-nya digambar oleh DynamicIsland
  onVolumeStep?: (direction: 1 | -1) => void;

  // Panel volume dibuka / ditutup (HUD ikut hilang saat ditutup)
  onVolumePanelChange?: (open: boolean) => void;
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

// Posisi tengah tombol volume (px dari atas island). Dipakai juga oleh
// DynamicIsland untuk menaruh gundukan hitam tepat di sisi tombol yang ditekan
export const VOLUME_BTN_Y = { plus: 50, minus: 103 } as const;

// Konten judul + progress bergeser sejauh ini ke kiri saat panel volume terbuka
const VOLUME_COL_SHIFT = 48;

// Kurva animasi morphing
const MORPH_EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

// Layer konten Dynamic Island
export const MorphLayer: React.FC<{
  variant: "compact" | "expanded";
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({ variant, width, height, children }) => {
  // Mengecek apakah layer sedang expanded
  const isExpandedLayer = variant === "expanded";

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
      <motion.div
        className="pointer-events-auto relative"
        style={{
          width,
          height,
          transformOrigin: "top center",
        }}
        initial={{
          opacity: 0,
          scale: isExpandedLayer ? 0.94 : 0.9,
          filter: "blur(6px)",
        }}
        animate={{
          opacity: 1,
          scale: 1,
          filter: "blur(0px)",
          transition: {
            duration: isExpandedLayer ? 0.3 : 0.22,
            delay: isExpandedLayer ? 0.07 : 0.1,
            ease: MORPH_EASE,
          },
        }}
        exit={{
          opacity: 0,
          scale: isExpandedLayer ? 0.95 : 0.9,
          filter: "blur(6px)",
          transition: {
            duration: 0.14,
            ease: "easeIn",
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

// Mengatur warna spektrum musik
const spectrumStyle = (palette: string[]) =>
  ({
    "--spectrum-a": palette[0] ?? "#aeb4c0",
    "--spectrum-b": palette[1] ?? "#777f8c",
    "--spectrum-c": palette[2] ?? "#d4d7de",
  }) as React.CSSProperties;

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

// Konten bergeser ke kiri / kembali
const VOLUME_SHIFT_SPRING = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.8,
} as const;

// Tombol + dan - muncul
const VOLUME_BTN_SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 24,
} as const;

// Tombol volume: tahan untuk mengulang
const VOLUME_REPEAT_DELAY = 380;
const VOLUME_REPEAT_EVERY = 110;

// Tombol volume (-/+) dengan efek tekan yang sama seperti tombol skip
const VolumeButton: React.FC<{
  direction: 1 | -1;
  label: string;
  onStep: (direction: 1 | -1) => void;
}> = ({ direction, label, onStep }) => {
  // Selalu memakai onStep terbaru, termasuk di dalam interval
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  const delayTimer = useRef<number | undefined>(undefined);
  const repeatTimer = useRef<number | undefined>(undefined);

  const stop = useCallback(() => {
    window.clearTimeout(delayTimer.current);
    window.clearInterval(repeatTimer.current);
  }, []);

  // Hentikan pengulangan saat tombol hilang (island ditutup)
  useEffect(() => stop, [stop]);

  // Tekan: langsung 1 langkah, lalu berulang jika ditahan
  const handlePointerDown = (e: React.PointerEvent) => {
    // Jangan ikut menekan island
    e.stopPropagation();

    if (e.button !== 0) return;

    stop();
    stepRef.current(direction);

    delayTimer.current = window.setTimeout(() => {
      repeatTimer.current = window.setInterval(
        () => stepRef.current(direction),
        VOLUME_REPEAT_EVERY,
      );
    }, VOLUME_REPEAT_DELAY);
  };

  return (
    <motion.button
      type="button"
      aria-label={label}
      onPointerDown={handlePointerDown}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={(e) => {
        // Jangan menutup island. detail === 0 = lewat keyboard (Enter/Space)
        e.stopPropagation();
        if (e.detail === 0) onStep(direction);
      }}
      onMouseDown={(e) => e.preventDefault()}
      className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-white/70 hover:text-white focus:outline-none"
      variants={skipButtonVariants}
      initial="rest"
      animate="rest"
      whileTap="pressed"
    >
      {/* Lingkaran highlight saat ditekan */}
      <motion.span
        className="pointer-events-none absolute inset-0 rounded-full bg-white/[0.16]"
        variants={skipHighlightVariants}
      />

      {direction > 0 ? (
        <Plus size={19} strokeWidth={2.4} className="relative" />
      ) : (
        <Minus size={19} strokeWidth={2.4} className="relative" />
      )}
    </motion.button>
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
      <div
        className={`island-spectrum ${track.isPlaying ? "is-playing" : ""}`}
        style={spectrumStyle(palette)}
      >
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} />
        ))}
      </div>
    </div>
  </div>
);

// Tampilan Spotify expanded
const ExpandedView: React.FC<{
  track: SpotifyTrack;
  palette: string[];
  runCommand: (command: MediaCommand) => void;
  onSeek: (positionSecs: number) => void;
  onOpenLyrics: () => void;
  onVolumeStep?: (direction: 1 | -1) => void;
  onVolumePanelChange?: (open: boolean) => void;
}> = ({
  track,
  palette,
  runCommand,
  onSeek,
  onOpenLyrics,
  onVolumeStep,
  onVolumePanelChange,
}) => {
  // Panel volume (+ / -) terbuka. Tertutup lagi otomatis saat island ditutup
  const [volumeOpen, setVolumeOpen] = useState(false);

  const toggleVolume = () => {
    const next = !volumeOpen;
    setVolumeOpen(next);
    onVolumePanelChange?.(next);
  };

  // Warna utama album
  const accent = palette[0] ?? FALLBACK_PALETTE[0];

  // Posisi lagu realtime
  const { trackRef, getPosition } = useLivePosition(track);

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
      {/* Informasi lagu (bergeser ke kiri saat panel volume terbuka) */}
      <motion.div
        className="relative flex min-w-0 items-center gap-3.5"
        initial={false}
        animate={{ paddingRight: volumeOpen ? VOLUME_COL_SHIFT : 0 }}
        transition={VOLUME_SHIFT_SPRING}
      >
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
          {/* Judul lagu */}
          <div className="truncate text-[15px] font-semibold leading-[1.2] tracking-[-0.035em] text-white">
            {track.title || "Memutar Musik..."}
          </div>

          {/* Nama artis */}
          <div
            role="button"
            onClick={openArtist}
            onMouseDown={(e) => e.preventDefault()}
            className="mt-1 cursor-pointer truncate text-[12px] font-medium tracking-[-0.01em] text-white/55 transition hover:text-white"
          >
            {track.artist || "Unknown Artist"}
          </div>
        </div>

        {/* Spektrum musik */}
        <div
          className={`island-spectrum expanded-spectrum ${track.isPlaying ? "is-playing" : ""}`}
          style={spectrumStyle(palette)}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      </motion.div>

      {/* Kontainer progress lagu: waktu kiri | bar | waktu kanan */}
      <motion.div
        className="relative mt-3 flex items-center gap-2"
        initial={false}
        animate={{ paddingRight: volumeOpen ? VOLUME_COL_SHIFT : 0 }}
        transition={VOLUME_SHIFT_SPRING}
      >
        {/* Waktu berjalan (kiri) */}
        <span
          ref={elapsedRef}
          className="min-w-[34px] text-left text-[13px] font-semibold leading-none tabular-nums tracking-[-0.01em] text-white/90"
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

        {/* Sisa waktu (kanan) */}
        <span
          ref={remainingRef}
          className="min-w-[34px] text-right text-[13px] font-semibold leading-none tabular-nums tracking-[-0.01em] text-white/90"
        >
          --:--
        </span>
      </motion.div>

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
          {/* Tombol lagu sebelumnya */}
          <SkipButton
            direction="prev"
            label="Previous track"
            onPress={() => runCommand("media_previous")}
          />

          {/* Tombol play dan pause */}
          <button
            aria-label={track.isPlaying ? "Pause" : "Play"}
            onClick={(e) => {
              e.stopPropagation();
              runCommand("media_toggle_play");
            }}
            onMouseDown={(e) => e.preventDefault()}
            className={`${buttonBase} h-9 w-9`}
          >
            {track.isPlaying ? (
              <Pause size={31} fill="currentColor" strokeWidth={1.4} />
            ) : (
              <Play
                size={30}
                fill="currentColor"
                strokeWidth={1.4}
                className="ml-1"
              />
            )}
          </button>

          {/* Tombol lagu berikutnya */}
          <SkipButton
            direction="next"
            label="Next track"
            onPress={() => runCommand("media_next")}
          />
        </div>

        {/* Tombol membuka panel volume (kanan bawah, selebar tombol lirik) */}
        <button
          type="button"
          aria-label={volumeOpen ? "Tutup volume" : "Buka volume"}
          aria-pressed={volumeOpen}
          onClick={(e) => {
            e.stopPropagation();
            toggleVolume();
          }}
          onMouseDown={(e) => e.preventDefault()}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition active:scale-90 ${
            volumeOpen
              ? "bg-white/15 text-white"
              : "text-white/55 hover:bg-white/10 hover:text-white"
          }`}
        >
          <Volume2 size={19} />
        </button>
      </div>

      {/* Panel volume: + di atas, - di bawah, sejajar dengan tombol di baris bawah */}
      <AnimatePresence>
        {volumeOpen && (
          <motion.div
            key="volume-plus"
            className="absolute z-10"
            style={{ right: 26, top: VOLUME_BTN_Y.plus - 16 }}
            initial={{ opacity: 0, scale: 0.5, x: 10 }}
            animate={{
              opacity: 1,
              scale: 1,
              x: 0,
              transition: { ...VOLUME_BTN_SPRING, delay: 0.05 },
            }}
            exit={{
              opacity: 0,
              scale: 0.5,
              x: 10,
              transition: { duration: 0.12 },
            }}
          >
            <VolumeButton
              direction={1}
              label="Volume naik"
              onStep={(d) => onVolumeStep?.(d)}
            />
          </motion.div>
        )}

        {volumeOpen && (
          <motion.div
            key="volume-minus"
            className="absolute z-10"
            style={{ right: 26, top: VOLUME_BTN_Y.minus - 16 }}
            initial={{ opacity: 0, scale: 0.5, x: 10 }}
            animate={{
              opacity: 1,
              scale: 1,
              x: 0,
              transition: { ...VOLUME_BTN_SPRING, delay: 0.1 },
            }}
            exit={{
              opacity: 0,
              scale: 0.5,
              x: 10,
              transition: { duration: 0.12 },
            }}
          >
            <VolumeButton
              direction={-1}
              label="Volume turun"
              onStep={(d) => onVolumeStep?.(d)}
            />
          </motion.div>
        )}
      </AnimatePresence>
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
const LyricMiniView: React.FC<{
  track: SpotifyTrack;
  palette: string[];
  lyrics: LyricsState;
  index: number;
}> = ({ track, palette, lyrics, index }) => {
  // Menentukan teks lirik yang ditampilkan
  const text =
    lyrics.status === "ready"
      ? index >= 0
        ? lyrics.lines[index].text || "♪"
        : "♪"
      : lyrics.status === "loading"
        ? "Memuat lirik…"
        : track.title;

  return (
    <div className="flex h-full w-full items-center gap-2 px-[8px] text-white">
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
        <div
          className={`island-spectrum ${track.isPlaying ? "is-playing" : ""}`}
          style={spectrumStyle(palette)}
        >
          {Array.from({ length: 5 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
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
  lyrics,
  lyricsMode = false,
  onLyricsModeChange,
  locked = false,
  onLockedChange,
  onVolumeStep,
  onVolumePanelChange,
}) => {
  // Mengambil warna album
  const palette = useAlbumPalette(track.albumArt);

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

  // Arah animasi perpindahan tampilan
  const dir = lyricsMode ? 1 : -1;

  // Menentukan ukuran tampilan mini
  const baseSize = lyricsMode
    ? SPOTIFY_SIZES.lyricsMini
    : SPOTIFY_SIZES.compact;

  const miniSize = {
    width: baseSize.width + widthAdjust,
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
                    runCommand={runCommand}
                    onSeek={handleSeek}
                    onOpenLyrics={() => onLyricsModeChange?.(true)}
                    onVolumeStep={onVolumeStep}
                    onVolumePanelChange={onVolumePanelChange}
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
          >
            {lyricsMode ? (
              // Tampilan lirik dalam pil mini
              <LyricMiniView
                track={track}
                palette={palette}
                lyrics={lyrics}
                index={activeIndex}
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