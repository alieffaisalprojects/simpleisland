import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
} from "framer-motion";
import type { MotionValue, Transition } from "framer-motion";
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
import {
  MorphLayer,
  SPOTIFY_SIZES,
  SpotifyWidget,
  VOLUME_BTN_Y,
} from "./SpotifyWidget";
import { TimerCompact, TimerExpanded, TimerPill } from "./ClockTimerView";
import { SystemWidget } from "../modules/SystemWidget";
import { FileActionsPanel, getFilePanelSize } from "./file/FileActionsPanel";
import { FilePastePill, PASTE_PILL_WIDTH } from "./file/FilePastePill";
import { useFileIsland } from "./file/useFileIsland";

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

type IslandKind = "file" | "paste" | "system" | "timer" | "music" | "idle";
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

// ---- HUD volume (pil vertikal di kanan island) ----

// Satu langkah volume (16 langkah, sama seperti iOS)
const VOLUME_STEP = 1 / 16;

// HUD hilang setelah sekian ms tanpa tekanan
const VOLUME_HIDE_MS = 1500;

// Ukuran pil hitam HUD dan jarak pil putih ke tepinya
const HUD_W = 30;
const HUD_H = 116;
const HUD_PAD = 7;

// Gundukan kecil di tepi island, berpusat di tombol yang ditekan.
// Sengaja pendek supaya tidak menyentuh pil volume.
const BUMP_H = 38;
const BUMP_OUT = 6; // menonjol keluar dari tepi island (px)
const BUMP_IN = 10; // bagian yang tersembunyi di dalam island (px)

// Pil volume terdorong sejauh ini ke kanan saat tombol ditekan
const HUD_PUSH = 10;

// HUD keluar: lembut, sedikit membal
const HUD_ENTER = {
  type: "spring",
  stiffness: 210,
  damping: 18,
  mass: 0.85,
} as const;

// HUD masuk kembali ke island: cepat, tanpa membal
const HUD_EXIT = {
  type: "spring",
  stiffness: 340,
  damping: 32,
  mass: 0.8,
} as const;

// Pil putih mengikuti level volume
const HUD_FILL_SPRING = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.6,
} as const;

// Bentuk tetesan air saat HUD keluar (menetes ke kanan)
const HUD_STRETCH_X = [0.5, 1.28, 1];
const HUD_SQUASH_Y = [0.55, 0.94, 1];

const HUD_SHAPE_ENTER: Transition = {
  x: HUD_ENTER,
  scaleX: { duration: 0.55, times: [0, 0.45, 1], ease: "easeOut" },
  scaleY: { duration: 0.55, times: [0, 0.45, 1], ease: "easeOut" },
};

const HUD_CONTENT_ENTER: Transition = {
  x: HUD_ENTER,
  scale: HUD_ENTER,
  opacity: { delay: 0.14, duration: 0.2 },
};

const HUD_CONTENT_EXIT: Transition = {
  x: HUD_EXIT,
  scale: HUD_EXIT,
  opacity: { duration: 0.12 },
};

// Denyut pil volume: melebar cepat, lalu membal kembali
const PULSE_UP = { duration: 0.09, ease: "easeOut" } as const;

const PULSE_BACK = {
  type: "spring",
  stiffness: 480,
  damping: 15,
  mass: 0.7,
} as const;

// Pil kembali dari posisi terdorong: membal sedikit
const SHIFT_BACK = {
  type: "spring",
  stiffness: 320,
  damping: 15,
  mass: 0.8,
} as const;

// Gundukan surut lagi setelah pil terdorong
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

// Satu tekanan: pil terdorong ke kanan dan melebar, gundukan kecil muncul di
// tepi island (tidak menyentuh pil), lalu semuanya kembali
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
  hasPaste: boolean,
  hasSystem: boolean,
  timerFocused: boolean,
  isMusic: boolean,
): IslandKind {
  if (hasFile) return "file";
  if (hasPaste) return "paste"; // tombol Paste menggantung sampai ditekan
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
  if (kind === "paste") return PASTE_PILL_WIDTH;
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
  filePanel: { width: number; height: number },
): { width: number; height: number } {
  switch (kind) {
    case "music": {
      const size = lyricsMode ? S.lyrics : S.expanded;
      return { width: size.width, height: size.height };
    }
    case "file":
      return filePanel;
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

export const DynamicIsland: React.FC<DynamicIslandProps> = ({
  activeWidget,
  track,
  onTogglePlay,
  onNextTrack,
  onSeek,
  clockTimer,
  lyrics,
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

  // Volume
  const [volume, setVolume] = useState(0.5); // 0..1
  const [volumeActive, setVolumeActive] = useState(false); // HUD diminta tampil
  const [volTail, setVolTail] = useState(false); // HUD masih bergerak keluar
  const volumeRef = useRef(0.5);
  const volumeBusy = useRef(0); // jumlah perintah volume yang belum selesai
  const volumeHideTimer = useRef<number | undefined>(undefined);

  // Denyut pil volume + gundukan hitam di sisi tombol yang ditekan
  const hudPulseX = useMotionValue(1);
  const hudPulseY = useMotionValue(1);
  const hudShift = useMotionValue(0); // pil terdorong ke kanan (px)
  const bumpGrow = useMotionValue(0); // tinggi gundukan 0..1

  const [bumpAt, setBumpAt] = useState<"plus" | "minus">("plus");

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

  // File diseret / dilepas ke island (logika & tampilan ada di ./file)
  const fileIsland = useFileIsland();
  const file = fileIsland.active ? fileIsland : null;
  const system = activeWidget === "system" ? systemNotification : null;

  const timerFocused =
    !file && !system && timerOn && (pick === "timer" || !hasMedia);
  const isMusic = !file && !system && hasMedia && !timerFocused;

  const kind = getKind(
    Boolean(file),
    Boolean(fileIsland.paste),
    Boolean(system),
    timerFocused,
    isMusic,
  );
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
    getFilePanelSize(fileIsland.actions.length),
  );

  const anim = {
    width: expanded ? expandedWidth : compactWidth,
    height: expanded ? expandedHeight : collapsedHeight,
    borderRadius: expanded ? 40 : collapsedHeight / 2,
    // Pil Paste tidak ikut mengecil saat tombolnya ditekan
    scale: getPressScale(pressed && kind !== "paste", expanded),
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

  // ---- Volume ----

  // HUD hanya untuk tampilan player musik yang terbuka
  const musicExpanded =
    expanded && kind === "music" && !lyricsMode && !forceMini;
  const showVolume = volumeActive && musicExpanded;
  const volumeWindow = showVolume || volTail;

  const applyVolume = useCallback((value: number) => {
    volumeRef.current = value;
    setVolume(value);
  }, []);

  // Baca volume sistem setiap player dibuka
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

  // Player ditutup -> HUD ikut hilang (tidak muncul lagi saat dibuka ulang)
  useEffect(() => {
    if (musicExpanded) return;
    window.clearTimeout(volumeHideTimer.current);
    setVolumeActive(false);
  }, [musicExpanded]);

  // Window dibiarkan besar sampai animasi HUD selesai
  useEffect(() => {
    if (showVolume) {
      setVolTail(true);
      return;
    }

    const t = window.setTimeout(() => setVolTail(false), 800);
    return () => window.clearTimeout(t);
  }, [showVolume]);

  useEffect(() => () => window.clearTimeout(volumeHideTimer.current), []);

  // Tombol -/+ ditekan
  const handleVolumeStep = useCallback(
    (direction: 1 | -1) => {
      const delta = direction * VOLUME_STEP;

      // Tampilan langsung berubah, nilai sebenarnya menyusul dari Rust
      applyVolume(Math.min(1, Math.max(0, volumeRef.current + delta)));
      setVolumeActive(true);

      // Gundukan tumbuh di sisi tombol yang ditekan dan menyambung ke pil,
      // pil terdorong ke kanan. Island sendiri tidak ikut bergerak.
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
          // Hanya percaya hasil Rust jika tidak ada tekanan lain yang menyusul
          if (volumeBusy.current === 1) applyVolume(value);
        })
        .catch((e) => console.error("Gagal mengubah volume:", e))
        .finally(() => {
          volumeBusy.current -= 1;
        });
    },
    [applyVolume, hudPulseX, hudPulseY, hudShift, bumpGrow],
  );

  // Panel volume ditutup lewat ikon -> HUD ikut hilang
  const handleVolumePanelChange = useCallback((open: boolean) => {
    if (open) return;
    window.clearTimeout(volumeHideTimer.current);
    setVolumeActive(false);
  }, []);

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

  // Tutup island jika tidak ada aktivitas (pil Paste selalu compact)
  useEffect(() => {
    if (kind === "idle" || kind === "paste") setExpanded(false);
  }, [kind]);

  // ---- File diseret ke island ----

  const fileWasActive = useRef(false);
  const wasExpanded = useRef(false);

  // File mulai diseret / dilepas -> island mengembang. Selesai / batal -> menutup.
  useEffect(() => {
    if (fileIsland.active) setExpanded(true);
    else if (fileWasActive.current) setExpanded(false);

    fileWasActive.current = fileIsland.active;
  }, [fileIsland.active]);

  // Island ditutup (klik di luar / kehilangan fokus) saat menu file terbuka -> buang file
  useEffect(() => {
    if (
      wasExpanded.current &&
      !expanded &&
      fileIsland.active &&
      !fileIsland.hovering
    ) {
      fileIsland.clear();
    }

    wasExpanded.current = expanded;
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const gooOn = showSecondary || gooTail || volumeWindow;

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

  // ---- HUD volume ----

  // Pil vertikal di kanan island, di tengah tinggi island.
  // Posisi akhir: di luar tepi kanan. Posisi awal: terselip di dalam island
  const hudRestX = expandedWidth / 2 + SPLIT_GAP;
  const hudHiddenX = expandedWidth / 2 - HUD_W * 0.6;
  const hudTop = ISLAND_TOP + (expandedHeight - HUD_H) / 2;

  const hudStyle: React.CSSProperties = {
    top: hudTop,
    left: "50%",
    width: HUD_W,
    height: HUD_H,
    transformOrigin: "left center",
  };

  // Gundukan kecil: tumbuh dari tepi kanan island, setinggi tombol
  const bumpCenterY =
    bumpAt === "plus" ? VOLUME_BTN_Y.plus : VOLUME_BTN_Y.minus;

  const bumpStyle: React.CSSProperties = {
    top: ISLAND_TOP + bumpCenterY - BUMP_H / 2,
    left: `calc(50% + ${expandedWidth / 2 - BUMP_IN}px)`,
    width: BUMP_IN + BUMP_OUT,
    height: BUMP_H,
    borderRadius: BUMP_H / 2,
    transformOrigin: `${BUMP_IN}px 50%`,
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

  const renderFileLayer = (): React.ReactNode => {
    if (expanded) {
      return (
        <MorphLayer
          key="file-expanded"
          variant="expanded"
          width={expandedWidth}
          height={expandedHeight}
        >
          <FileActionsPanel
            items={fileIsland.items}
            actions={fileIsland.actions}
            hovering={fileIsland.hovering}
            hoverId={fileIsland.hoverId}
            armedId={fileIsland.armedId}
            status={fileIsland.status}
            message={fileIsland.message}
            view={fileIsland.view}
            propsState={fileIsland.propsState}
            onRun={fileIsland.run}
            onRename={fileIsland.renameRun}
            onBack={fileIsland.back}
            onClose={fileIsland.clear}
          />
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
            {fileIsland.items[0]?.name ?? "File"}
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
            onVolumeStep={handleVolumeStep}
            onVolumePanelChange={handleVolumePanelChange}
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
            {renderFileLayer()}
          </AnimatePresence>
        </motion.div>
      );
    }

    // File sudah disalin / dipotong: tombol Paste menggantung
    if (kind === "paste" && fileIsland.paste && !isMini) {
      return (
        <motion.div key="paste" className="relative h-full w-full" {...swapFade}>
          <FilePastePill
            paste={fileIsland.paste}
            onPaste={fileIsland.pasteRun}
            onDismiss={fileIsland.pasteDismiss}
          />
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

        {/* Gundukan hitam di tepi island (menyatu lewat efek gooey) */}
        {volumeWindow && (
          <motion.div
            className="absolute bg-[#050506]"
            style={{ ...bumpStyle, scale: bumpGrow }}
          />
        )}

        {/* Bentuk HUD volume (tetesan air keluar dari sisi kanan island) */}
        <AnimatePresence>
          {showVolume && (
            <motion.div
              key="volume-shape"
              className="absolute"
              style={hudStyle}
              initial={{ x: hudHiddenX, scaleX: 0.5, scaleY: 0.55 }}
              animate={{
                x: hudRestX,
                scaleX: HUD_STRETCH_X,
                scaleY: HUD_SQUASH_Y,
                transition: HUD_SHAPE_ENTER,
              }}
              exit={{
                x: hudHiddenX,
                scaleX: 0.5,
                scaleY: 0.55,
                transition: HUD_EXIT,
              }}
            >
              <motion.div
                className="h-full w-full bg-[#050506]"
                style={{
                  borderRadius: HUD_W / 2,
                  x: hudShift,
                  scaleX: hudPulseX,
                  scaleY: hudPulseY,
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

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
          if (kind === "idle" || kind === "paste") return;
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

      {/* Isi HUD volume: pil putih di dalam pil hitam */}
      <AnimatePresence>
        {showVolume && (
          <motion.div
            key="volume-content"
            className="pointer-events-none absolute z-40"
            style={hudStyle}
            initial={{ x: hudHiddenX, scale: 0.6, opacity: 0 }}
            animate={{
              x: hudRestX,
              scale: 1,
              opacity: 1,
              transition: HUD_CONTENT_ENTER,
            }}
            exit={{
              x: hudHiddenX,
              scale: 0.6,
              opacity: 0,
              transition: HUD_CONTENT_EXIT,
            }}
          >
            <motion.div
              className="h-full w-full"
              style={{
                padding: HUD_PAD,
                x: hudShift,
                scaleX: hudPulseX,
                scaleY: hudPulseY,
              }}
            >
              <div className="relative h-full w-full overflow-hidden rounded-full bg-white/[0.2]">
                <motion.div
                  className="h-full w-full rounded-full bg-white"
                  initial={false}
                  animate={{ y: `${(1 - volume) * 100}%` }}
                  transition={HUD_FILL_SPRING}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
