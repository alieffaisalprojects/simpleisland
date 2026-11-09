import type { Transition, Variants } from "framer-motion";
import { SPOTIFY_SIZES } from "../SpotifyWidget";
import { PASTE_PILL_WIDTH } from "../file/FilePastePill";

// konstanta & fungsi bantu

export type IslandKind =
  | "file"
  | "paste"
  | "system"
  | "timer"
  | "music"
  | "menu"
  | "idle";
export type SecondaryKind = "timer" | "music" | null;
export type IslandPick = "timer" | "music";

export const S = SPOTIFY_SIZES;
export const COMPACT_HEIGHT = S.compact.height;
export const COMPACT_WINDOW_HEIGHT = 60;

// jarak pil dari atas
export const ISLAND_TOP = 6;

// pause -> mini (ms)
export const IDLE_AFTER_PAUSE_MS = 2000;

// jarak pil utama ke pil kedua
export const SPLIT_GAP = 14;

// padding area klik
export const HIT_PAD = 4;

// bingkai pil musik
export const SEC_FRAME = 4;

// ---- menu (klik kiri saat idle, klik kanan kapan saja) ----
export type MenuView =
  | "home"
  | "prayer"
  | "locate"
  | "calendar"
  | "stopwatch"
  | "notes"
  | "wifi"
  | "bluetooth";

// ukuran island untuk tiap halaman menu (lebar maksimal 394 = player musik)
export const MENU_SIZES: Record<MenuView, { width: number; height: number }> = {
  home: { width: 372, height: 194 },
  prayer: { width: 394, height: 156 },
  locate: { width: 394, height: 196 },
  calendar: { width: 340, height: 262 },
  stopwatch: { width: 340, height: 118 },
  notes: { width: 340, height: 170 },
  wifi: { width: 372, height: 290 },
  bluetooth: { width: 372, height: 290 },
};

export const SPRING_EXPAND = {
  type: "spring",
  stiffness: 320,
  damping: 25,
  mass: 0.85,
} as const;

export const SPRING_COLLAPSE = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.85,
} as const;

// pil kedua keluar
const SEC_ENTER = {
  type: "spring",
  stiffness: 190,
  damping: 17,
  mass: 0.9,
} as const;

// pil kedua masuk
export const SEC_EXIT = {
  type: "spring",
  stiffness: 320,
  damping: 30,
  mass: 0.8,
} as const;

// tetesan air
export const SEC_STRETCH_X = [0.5, 1.3, 1];
export const SEC_SQUASH_Y = [0.5, 0.86, 1];

export const SEC_SHAPE_ENTER: Transition = {
  x: SEC_ENTER,
  scaleX: { duration: 0.6, times: [0, 0.45, 1], ease: "easeOut" },
  scaleY: { duration: 0.6, times: [0, 0.45, 1], ease: "easeOut" },
};

export const SEC_CONTENT_ENTER: Transition = {
  x: SEC_ENTER,
  scale: SEC_ENTER,
  opacity: { delay: 0.16, duration: 0.2 },
};

// ---- HUD volume ----

// ukuran HUD
export const HUD_W = 30;
export const HUD_H = 116;
export const HUD_PAD = 7;

// gundukan
export const BUMP_H = 38;
export const BUMP_OUT = 6; // keluar
export const BUMP_IN = 10; // masuk

// tab kembali: benjolan di kiri atas island saat menu dibuka
export const TAB_OUT = 32; // bagian yang keluar dari island
export const TAB_IN = 16; // bagian yang masuk (menyatu dengan island)
export const TAB_W = TAB_OUT + TAB_IN;
export const TAB_H = 40;
export const TAB_TOP = 10; // jarak dari atas island
export const TAB_ENTER = {
  type: "spring",
  stiffness: 420,
  damping: 30,
  mass: 0.7,
} as const;
// masuk kembali: tween, langsung bergerak tanpa memantul
export const TAB_EXIT = {
  type: "tween",
  duration: 0.2,
  ease: "easeOut",
} as const;

// tujuan tombol kembali (sama dengan Esc)
export function getMenuBack(view: MenuView): MenuView {
  return view === "locate" ? "prayer" : "home";
}

// HUD keluar
const HUD_ENTER = {
  type: "spring",
  stiffness: 210,
  damping: 18,
  mass: 0.85,
} as const;

// HUD masuk
export const HUD_EXIT = {
  type: "spring",
  stiffness: 340,
  damping: 32,
  mass: 0.8,
} as const;

// pil putih
export const HUD_FILL_SPRING = {
  type: "spring",
  stiffness: 520,
  damping: 38,
  mass: 0.6,
} as const;

// tetesan air HUD
export const HUD_STRETCH_X = [0.5, 1.28, 1];
export const HUD_SQUASH_Y = [0.55, 0.94, 1];

export const HUD_SHAPE_ENTER: Transition = {
  x: HUD_ENTER,
  y: HUD_ENTER,
  scaleX: { duration: 0.55, times: [0, 0.45, 1], ease: "easeOut" },
  scaleY: { duration: 0.55, times: [0, 0.45, 1], ease: "easeOut" },
};

export const HUD_CONTENT_ENTER: Transition = {
  x: HUD_ENTER,
  y: HUD_ENTER,
  scale: HUD_ENTER,
  opacity: { delay: 0.14, duration: 0.2 },
};

export const HUD_CONTENT_EXIT: Transition = {
  x: HUD_EXIT,
  scale: HUD_EXIT,
  opacity: { duration: 0.12 },
};

// HUD masuk ke pil compact (naik + menyatu), x lebih pelan dari y
const HUD_ABSORB_X = {
  type: "spring",
  stiffness: 220,
  damping: 26,
  mass: 0.9,
} as const;

const HUD_ABSORB_Y = {
  type: "spring",
  stiffness: 300,
  damping: 28,
  mass: 0.9,
} as const;

export const HUD_ABSORB: Transition = {
  x: HUD_ABSORB_X,
  y: HUD_ABSORB_Y,
  scaleX: HUD_ABSORB_X,
  scaleY: HUD_ABSORB_Y,
};

export const HUD_ABSORB_CONTENT: Transition = {
  x: HUD_ABSORB_X,
  y: HUD_ABSORB_Y,
  scale: HUD_ABSORB_X,
  opacity: { duration: 0.16 },
};

// tujuan HUD saat keluar (dikirim lewat custom AnimatePresence)
export interface HudExit {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  absorb: boolean; // true: island menciut, HUD masuk ke pil compact
}

export const hudShapeVariants: Variants = {
  exit: (e: HudExit) => ({
    x: e.x,
    y: e.y,
    scaleX: e.scaleX,
    scaleY: e.scaleY,
    transition: e.absorb ? HUD_ABSORB : HUD_EXIT,
  }),
};

export const hudContentVariants: Variants = {
  exit: (e: HudExit) => ({
    x: e.x,
    y: e.y,
    scale: 0.6,
    opacity: 0,
    transition: e.absorb ? HUD_ABSORB_CONTENT : HUD_CONTENT_EXIT,
  }),
};

// animasi ganti konten
export const swapFade = {
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

// aktivitas utama
export function getKind(
  hasFile: boolean,
  hasPaste: boolean,
  hasSystem: boolean,
  timerFocused: boolean,
  isMusic: boolean,
): IslandKind {
  if (hasFile) return "file";
  if (hasPaste) return "paste"; // tombol paste
  if (hasSystem) return "system";
  if (timerFocused) return "timer";
  if (isMusic) return "music";
  return "idle";
}

// aktivitas kedua
export function getSecondary(
  kind: IslandKind,
  timerOn: boolean,
  hasMedia: boolean,
): SecondaryKind {
  if (kind === "music" && timerOn) return "timer";
  if (kind === "timer" && hasMedia) return "music";
  return null;
}

// lebar compact
export function getCompactWidth(
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

// ukuran expanded
export function getExpandedSize(
  kind: IslandKind,
  lyricsMode: boolean,
  filePanel: { width: number; height: number },
  menu: { width: number; height: number } = MENU_SIZES.home,
): { width: number; height: number } {
  switch (kind) {
    case "menu":
      return menu;
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

export function getPressScale(pressed: boolean, expanded: boolean): number {
  if (!pressed) return 1;
  return expanded ? 0.988 : 0.96;
}
