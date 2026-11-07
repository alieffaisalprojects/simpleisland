import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Transition } from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { File, Music } from "lucide-react";
import {
  ActiveWidget,
  ClockTimer,
  DroppedFile,
  LyricsState,
  SpotifyTrack,
} from "../../types";
import { MorphLayer, SPOTIFY_SIZES, SpotifyWidget } from "./SpotifyWidget";
import { TimerCompact, TimerExpanded, TimerPill } from "./ClockTimerView";
import { SystemWidget } from "../modules/SystemWidget";

interface DynamicIslandProps {
  activeWidget: ActiveWidget;
  track: SpotifyTrack;
  onTogglePlay: () => void;
  onNextTrack: () => void;
  onSeek?: (positionSecs: number) => void;
  clockTimer: ClockTimer;
  lyrics: LyricsState;
  droppedFile: DroppedFile | null;
  onFileAction: (action: string) => void;
  systemNotification: {
    type: "volume" | "battery" | "clipboard";
    value: string | number;
  } | null;
  onSelectWidget: (widget: ActiveWidget) => void;
}

type IslandKind = "file" | "system" | "timer" | "music" | "idle";
type SecondaryKind = "timer" | "music" | null;
type Pick = "timer" | "music";

const S = SPOTIFY_SIZES;
const COMPACT_HEIGHT = S.compact.height;
const COMPACT_WINDOW_HEIGHT = 60;

// Jarak pil dari atas window (total = ISLAND_WINDOW_TOP di Rust + ISLAND_TOP)
const ISLAND_TOP = 6;

// Musik pause selama ini -> jadi mini
const IDLE_AFTER_PAUSE_MS = 2000;

// Jarak pil utama ke pil kedua (harus > ~1.7 x stdDeviation GooeyFilter)
const SPLIT_GAP = 14;

// Padding area klik (px)
const HIT_PAD = 4;

// Bingkai hitam pil musik (px), makin besar makin tebal
const SEC_FRAME = 4;

const SPRING_EXPAND = {
  type: "spring",
  stiffness: 320,
  damping: 25,
  mass: 0.85,
} as const;

const SPRING_COLLAPSE = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.85,
} as const;

// Pil kedua keluar: lembut, sedikit membal
const SEC_ENTER = {
  type: "spring",
  stiffness: 190,
  damping: 17,
  mass: 0.9,
} as const;

// Pil kedua masuk: cepat, tanpa membal
const SEC_EXIT = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.8,
} as const;

// Bentuk tetesan air
const SEC_STRETCH_X = [0.5, 1.3, 1];
const SEC_SQUASH_Y = [0.5, 0.86, 1];

const SEC_SHAPE_ENTER: Transition = {
  x: SEC_ENTER,
  scaleX: { duration: 0.6, times: [0, 0.45, 1], ease: "easeOut" },
  scaleY: { duration: 0.6, times: [0, 0.45, 1], ease: "easeOut" },
};

const SEC_CONTENT_ENTER: Transition = {
  x: SEC_ENTER,
  scale: SEC_ENTER,
  opacity: { delay: 0.16, duration: 0.2 },
};

// Animasi ganti konten
const swapFade = {
  initial: { opacity: 0, filter: "blur(8px)" },
  animate: {
    opacity: 1,
    filter: "blur(0px)",
    transition: { duration: 0.22 },
  },
  exit: {
    opacity: 0,
    filter: "blur(8px)",
    transition: { duration: 0.12 },
  },
};

// Aktivitas utama
function getKind(
  hasFile: boolean,
  hasSystem: boolean,
  timerFocused: boolean,
  isMusic: boolean,
): IslandKind {
  if (hasFile) return "file";
  if (hasSystem) return "system";
  if (timerFocused) return "timer";
  if (isMusic) return "music";
  return "idle";
}

// Aktivitas kedua (pil bulat)
function getSecondary(
  kind: IslandKind,
  timerOn: boolean,
  hasMedia: boolean,
): SecondaryKind {
  if (kind === "music" && timerOn) return "timer";
  if (kind === "timer" && hasMedia) return "music";
  return null;
}

// Lebar compact
function getCompactWidth(
  kind: IslandKind,
  isMini: boolean,
  lyricsMode: boolean,
): number {
  if (isMini) return S.mini.width;
  if (kind === "music") {
    return lyricsMode ? S.lyricsMini.width : S.compact.width;
  }
  if (kind === "timer") return 124;
  return 176;
}

// Ukuran expanded
function getExpandedSize(
  kind: IslandKind,
  lyricsMode: boolean,
): { width: number; height: number } {
  switch (kind) {
    case "music": {
      const size = lyricsMode ? S.lyrics : S.expanded;
      return { width: size.width, height: size.height };
    }
    case "file":
      return { width: 340, height: 142 };
    case "timer":
      return { width: 340, height: 80 };
    default:
      return { width: 310, height: 132 };
  }
}

function getPressScale(pressed: boolean, expanded: boolean): number {
  if (!pressed) return 1;
  return expanded ? 0.988 : 0.96;
}

// Kartu file (expanded)
const FileCard: React.FC<{
  file: DroppedFile;
  onAction: (a: string) => void;
}> = ({ file, onAction }) => (
  <div className="flex h-full w-full flex-col justify-center px-5 text-white">
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10">
        <File size={20} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="text-[9px] font-semibold uppercase tracking-[.15em] text-white/45">
          File detected
        </div>
        <div className="truncate text-sm font-semibold">{file.name}</div>
        <div className="text-[10px] text-white/45">
          {file.size} · {file.extension}
        </div>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onAction("open");
        }}
        className="rounded-full bg-white px-3 py-1.5 text-[10px] font-semibold text-black"
      >
        Open
      </button>
    </div>

    <button
      onClick={(e) => {
        e.stopPropagation();
        onAction("dismiss");
      }}
      className="mt-4 self-end text-[10px] text-white/45"
    >
      Dismiss
    </button>
  </div>
);

export const DynamicIsland: React.FC<DynamicIslandProps> = ({
  activeWidget,
  track,
  onTogglePlay,
  onNextTrack,
  onSeek,
  clockTimer,
  lyrics,
  droppedFile,
  onFileAction,
  systemNotification,
  onSelectWidget,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [lyricsMode, setLyricsMode] = useState(false);
  const [pausedIdle, setPausedIdle] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [gooTail, setGooTail] = useState(false);
  const [behind, setBehind] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [locked, setLocked] = useState(false); // kunci island saat lirik expanded

  // Pilihan aktivitas utama (disimpan lokal supaya klik pil bulat selalu berlaku)
  const [pick, setPick] = useState<Pick>(
    activeWidget === "timer" ? "timer" : "music",
  );

  const forceMini = behind || revealing;

  const islandRef = useRef<HTMLDivElement>(null);
  const lockedRef = useRef(false); // dibaca oleh event listener
  const secHit = useRef<number[] | null>(null); // area klik pil kedua

  const hasMedia = Boolean(track.title && track.title !== "Tidak ada media");
  const timerOn = clockTimer.active;

  const file = activeWidget === "file-drop" ? droppedFile : null;
  const system = activeWidget === "system" ? systemNotification : null;

  const timerFocused =
    !file && !system && timerOn && (pick === "timer" || !hasMedia);
  const isMusic = !file && !system && hasMedia && !timerFocused;

  const kind = getKind(Boolean(file), Boolean(system), timerFocused, isMusic);
  const secondary = getSecondary(kind, timerOn, hasMedia);

  const showSecondary = Boolean(secondary) && !expanded && !forceMini;

  const isMini =
    forceMini ||
    kind === "idle" ||
    (kind === "music" && pausedIdle && !lyricsMode);

  const compactWidth = getCompactWidth(kind, isMini, lyricsMode);
  const collapsedHeight = isMini ? S.mini.height : COMPACT_HEIGHT;

  const { width: expandedWidth, height: expandedHeight } = getExpandedSize(
    kind,
    lyricsMode,
  );

  const anim = {
    width: expanded ? expandedWidth : compactWidth,
    height: expanded ? expandedHeight : collapsedHeight,
    borderRadius: expanded ? 40 : collapsedHeight / 2,
    scale: getPressScale(pressed, expanded),
  };

  const spring = expanded ? SPRING_EXPAND : SPRING_COLLAPSE;

  // Kunci hanya berlaku saat lirik sedang expanded
  lockedRef.current = locked && expanded && lyricsMode && kind === "music";

  // Lepas kunci jika keluar dari mode lirik / bukan musik
  useEffect(() => {
    if (!lyricsMode || kind !== "music") setLocked(false);
  }, [lyricsMode, kind]);

  // Ikuti perubahan widget dari luar
  useEffect(() => {
    if (activeWidget === "timer") setPick("timer");
    else if (activeWidget === "spotify") setPick("music");
  }, [activeWidget]);

  // Pilih aktivitas dari pil bulat
  const selectSecondary = () => {
    if (!secondary) return;
    setPick(secondary);
    onSelectWidget(secondary === "timer" ? "timer" : "spotify");
  };

  // ---- Window Tauri ----

  const prevExpanded = useRef(expanded);

  // Atur tinggi window via Rust
  useEffect(() => {
    const targetHeight = expanded ? expandedHeight + 24 : COMPACT_WINDOW_HEIGHT;

    const apply = () =>
      invoke("island_set_height", { height: targetHeight }).catch((e) =>
        console.error("Gagal mengatur window island:", e),
      );

    const collapsing = prevExpanded.current && !expanded;
    prevExpanded.current = expanded;

    // Window dikecilkan setelah animasi selesai
    if (collapsing) {
      const timer = window.setTimeout(apply, 460);
      return () => window.clearTimeout(timer);
    }

    void apply();
  }, [expanded, expandedHeight]);

  // Tutup island saat klik di luar / window kehilangan fokus
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (lockedRef.current) return;
      if (
        islandRef.current &&
        !islandRef.current.contains(event.target as Node)
      ) {
        setExpanded(false);
      }
    };
    const onWindowBlur = () => {
      if (lockedRef.current) return;
      setExpanded(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // Tutup island jika tidak ada aktivitas
  useEffect(() => {
    if (kind === "idle") setExpanded(false);
  }, [kind]);

  // ---- Area klik ke Rust ----

  // Kirim area klik pil utama (dibaca dari layar) dan pil kedua (posisi akhir)
  useEffect(() => {
    let raf = 0;
    let last = "";

    const tick = () => {
      const rects: number[][] = [];

      const el = islandRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          rects.push([
            Math.round(r.left) - 2,
            Math.round(r.top) - 2,
            Math.round(r.width) + 4,
            Math.round(r.height) + 4,
          ]);
        }
      }

      if (secHit.current) rects.push(secHit.current);

      const key = JSON.stringify(rects);
      if (key !== last) {
        last = key;
        invoke("island_set_hit_rects", { rects }).catch((e) =>
          console.error("Gagal mengirim area klik island:", e),
        );
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- Event dari Rust ----

  // Island pindah ke belakang window lain
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<boolean>("island-behind", (event) =>
      setBehind(Boolean(event.payload)),
    )
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch((error) => console.error("island-behind listener failed:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Island kembali ke depan
  useEffect(() => {
    if (behind) {
      setExpanded(false);
      setRevealing(true);
      return;
    }

    const timer = window.setTimeout(() => setRevealing(false), 170);
    return () => window.clearTimeout(timer);
  }, [behind]);

  // ---- Status musik ----

  // Pause lama -> mini
  useEffect(() => {
    if (kind !== "music" || track.isPlaying) {
      setPausedIdle(false);
      return;
    }

    const timer = window.setTimeout(
      () => setPausedIdle(true),
      IDLE_AFTER_PAUSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [kind, track.isPlaying, track.title]);

  // ---- Efek Gooey ----

  useEffect(() => {
    if (showSecondary) {
      setGooTail(true);
      return;
    }

    const t = window.setTimeout(() => setGooTail(false), 800);
    return () => window.clearTimeout(t);
  }, [showSecondary]);

  const gooOn = showSecondary || gooTail;

  // ---- Pil kedua ----

  // Lebar = tinggi supaya bulat
  const secW = COMPACT_HEIGHT;

  // Posisi akhir (titik tengah relatif ke tengah window)
  const secRest = compactWidth / 2 + SPLIT_GAP + secW / 2;

  // Posisi awal: tersembunyi di ujung kanan pil utama
  const secHiddenX = compactWidth / 2 - secW * 0.55;

  // Area klik pil kedua: pakai posisi akhir, bukan posisi saat animasi
  secHit.current = showSecondary
    ? [
        Math.round(window.innerWidth / 2 + secRest - secW / 2) - HIT_PAD,
        ISLAND_TOP - HIT_PAD,
        secW + HIT_PAD * 2,
        COMPACT_HEIGHT + HIT_PAD * 2,
      ]
    : null;

  const secStyle: React.CSSProperties = {
    top: ISLAND_TOP,
    left: `calc(50% - ${secW / 2}px)`,
    width: secW,
    height: COMPACT_HEIGHT,
    borderRadius: COMPACT_HEIGHT / 2,
    transformOrigin: "left center",
  };

  // ---- Layer timer ----

  const renderTimerLayer = (): React.ReactNode => {
    if (expanded) {
      return (
        <MorphLayer
          key="timer-expanded"
          variant="expanded"
          width={expandedWidth}
          height={expandedHeight}
        >
          <TimerExpanded
            clock={clockTimer}
            onPause={() => clockTimer.toggle?.()}
            onStop={() => clockTimer.stop?.()}
          />
        </MorphLayer>
      );
    }

    if (isMini) return null;

    return (
      <MorphLayer
        key="timer-compact"
        variant="compact"
        width={compactWidth}
        height={COMPACT_HEIGHT}
      >
        <TimerCompact clock={clockTimer} />
      </MorphLayer>
    );
  };

  // ---- Layer file ----

  const renderFileLayer = (f: DroppedFile): React.ReactNode => {
    if (expanded) {
      return (
        <MorphLayer
          key="file-expanded"
          variant="expanded"
          width={expandedWidth}
          height={expandedHeight}
        >
          <FileCard file={f} onAction={onFileAction} />
        </MorphLayer>
      );
    }

    if (isMini) return null;

    return (
      <MorphLayer
        key="file-compact"
        variant="compact"
        width={compactWidth}
        height={COMPACT_HEIGHT}
      >
        <div className="flex h-full w-full items-center gap-2 px-[6px] pr-3 text-white">
          <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] bg-white/10">
            <File size={14} />
          </div>
          <div className="min-w-0 flex-1 truncate text-[11px] font-semibold">
            {f.name}
          </div>
        </div>
      </MorphLayer>
    );
  };

  // ---- Konten pil utama ----

  const renderMainContent = (): React.ReactNode => {
    // Musik
    if (kind === "music") {
      return (
        <motion.div
          key="music"
          className="relative h-full w-full"
          {...swapFade}
        >
          <SpotifyWidget
            track={track}
            onTogglePlay={onTogglePlay}
            onNext={onNextTrack}
            onSeek={onSeek}
            isExpanded={expanded}
            isMini={isMini}
            lyrics={lyrics}
            lyricsMode={lyricsMode}
            onLyricsModeChange={setLyricsMode}
            locked={locked}
            onLockedChange={setLocked}
          />
        </motion.div>
      );
    }

    // Timer
    if (kind === "timer") {
      return (
        <motion.div
          key="timer"
          className="relative h-full w-full"
          {...swapFade}
        >
          <AnimatePresence initial={false}>
            {renderTimerLayer()}
          </AnimatePresence>
        </motion.div>
      );
    }

    // File
    if (kind === "file" && file) {
      return (
        <motion.div key="file" className="relative h-full w-full" {...swapFade}>
          <AnimatePresence initial={false}>
            {renderFileLayer(file)}
          </AnimatePresence>
        </motion.div>
      );
    }

    // Notifikasi sistem
    if (kind === "system" && system) {
      return (
        <motion.div
          key="system"
          className="flex h-full w-full items-center"
          {...swapFade}
        >
          <SystemWidget type={system.type} value={system.value} />
        </motion.div>
      );
    }

    return null;
  };

  // Album art / ikon musik
  const renderAlbumArt = (): React.ReactNode => {
    if (track.albumArt) {
      return (
        <img
          src={track.albumArt}
          alt=""
          className="h-full w-full object-cover"
        />
      );
    }

    return (
      <Music size={15} className="absolute inset-0 m-auto text-white/70" />
    );
  };

  // Isi pil kedua
  const renderSecondaryContent = (): React.ReactNode => {
    // Pil timer
    if (secondary === "timer") {
      return <TimerPill clock={clockTimer} />;
    }

    // Pil musik
    return (
      <div
        className="relative h-full w-full bg-[#050506]"
        style={{ padding: SEC_FRAME }}
      >
        <div className="relative h-full w-full overflow-hidden rounded-full bg-white/10">
          {renderAlbumArt()}
          {!track.isPlaying && <div className="absolute inset-0 bg-black/45" />}
        </div>
      </div>
    );
  };

  // ---- Render ----

  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible">
      {/* Bentuk pil + efek Gooey */}
      <div
        className="absolute inset-0"
        style={{ filter: gooOn ? "url(#gooey-effect)" : undefined }}
      >
        {/* Bentuk pil utama */}
        <motion.div
          className="absolute left-1/2 bg-[#050506]"
          style={{
            top: ISLAND_TOP,
            x: "-50%",
            transformOrigin: "top center",
          }}
          initial={false}
          animate={anim}
          transition={spring}
        />

        {/* Bentuk pil kedua (tetesan air) */}
        <AnimatePresence>
          {showSecondary && (
            <motion.div
              key={`shape-${secondary}`}
              className="absolute bg-[#050506]"
              style={secStyle}
              initial={{ x: secHiddenX, scaleX: 0.5, scaleY: 0.5 }}
              animate={{
                x: secRest,
                scaleX: SEC_STRETCH_X,
                scaleY: SEC_SQUASH_Y,
                transition: SEC_SHAPE_ENTER,
              }}
              exit={{
                x: secHiddenX,
                scaleX: 0.5,
                scaleY: 0.5,
                transition: SEC_EXIT,
              }}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Konten pil utama */}
      <motion.div
        ref={islandRef}
        initial={false}
        animate={anim}
        transition={spring}
        onClick={() => {
          if (kind === "idle") return;
          if (lockedRef.current) return; // terkunci: jangan menutup
          setExpanded((v) => !v);
        }}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
        onPointerCancel={() => setPressed(false)}
        className="pointer-events-auto absolute left-1/2 z-50 cursor-pointer overflow-hidden text-white"
        style={{
          top: ISLAND_TOP,
          x: "-50%",
          transformOrigin: "top center",
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {renderMainContent()}
        </AnimatePresence>
      </motion.div>

      {/* Konten pil kedua (bulat) */}
      <AnimatePresence>
        {showSecondary && (
          <motion.div
            key={`sec-${secondary}`}
            className="pointer-events-auto absolute z-50 cursor-pointer overflow-hidden text-white"
            style={secStyle}
            initial={{ x: secHiddenX, scale: 0.55, opacity: 0 }}
            animate={{
              x: secRest,
              scale: 1,
              opacity: 1,
              transition: SEC_CONTENT_ENTER,
            }}
            exit={{
              x: secHiddenX,
              scale: 0.55,
              opacity: 0,
              transition: SEC_EXIT,
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              selectSecondary();
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {renderSecondaryContent()}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DynamicIsland;
