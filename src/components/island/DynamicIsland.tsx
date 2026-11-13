import React, { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
  type MotionStyle,
} from "framer-motion";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, File, Music } from "lucide-react";
import {
  ActiveWidget,
  ClockTimer,
  DroppedFile,
  LyricsState,
  SpotifyTrack,
} from "../../types";
import {
  COLLAPSE_CONTENT_DELAY,
  LYRIC_WIDEN_SPRING,
  MorphLayer,
  SPOTIFY_SIZES,
  SpotifyWidget,
} from "./SpotifyWidget";
import { TimerCompact, TimerExpanded, TimerPill } from "./ClockTimerView";
import { SystemWidget } from "../modules/SystemWidget";
import { FileActionsPanel, getFilePanelSize } from "./file/FileActionsPanel";
import { FilePastePill } from "./file/FilePastePill";
import type { FileItem } from "./file/catalog";
import { useFileIsland } from "./file/useFileIsland";
import { IslandShoulders } from "./IslandShoulders";
import { sizeOf, useSettings } from "../../settings/settings";
import {
  IslandPick,
  S,
  COMPACT_HEIGHT,
  COMPACT_WINDOW_HEIGHT,
  ISLAND_TOP,
  IDLE_AFTER_PAUSE_MS,
  SPLIT_GAP,
  HIT_PAD,
  SEC_FRAME,
  SPRING_EXPAND,
  SPRING_COLLAPSE,
  SEC_EXIT,
  SEC_STRETCH_X,
  SEC_SQUASH_Y,
  SEC_SHAPE_ENTER,
  SEC_CONTENT_ENTER,
  TAB_OUT,
  TAB_W,
  TAB_H,
  TAB_TOP,
  TAB_ENTER,
  TAB_EXIT,
  getMenuBack,
  swapFade,
  getKind,
  getSecondary,
  getCompactWidth,
  getExpandedSize,
  getPressScale,
  MENU_SIZES,
  type IslandKind,
  type MenuView,
} from "./dynamic_island/constants";
import { useIslandVolume } from "./dynamic_island/useIslandVolume";
import { IslandMenu } from "./menu/IslandMenu";
import { VOLUME_HUD_H, VOLUME_HUD_W, VolumeHud } from "./menu/VolumeHud";
import { useStopwatchRunning } from "./menu/stopwatchStore";

//hover saat idle: pill nyembul halus (ala Dynamic Island MacBook), pointer tertelan
// naikkan BULGE_X / BULGE_Y kalau ingin reaksi lebih terasa
const BULGE_X = 1.06;
const BULGE_Y = 1.12;
const BULGE_MS = 300;
const BULGE_SNAP_MS = 80; // lama transisi "snap" scaleX/scaleY ke 1 setelah dibatalkan
// pegas lembut: naik pelan, hampir tanpa pantulan
const SWALLOW_POP = {
  type: "spring",
  stiffness: 380,
  damping: 26,
  mass: 0.8,
} as const;

// ---- expand -> compact (ala iOS Dynamic Island) ----
// Dua fase berurutan:
//  1. squeeze : pil menciut, jadi lebih SEMPIT dari ukuran compact dan
//               NYEMBUL ke atas (lebih tinggi; tepi bawah diam, tepi atas naik)
//  2. release : pil dilepas: MELEBAR ke lebar compact dengan sedikit pantulan,
//               tinggi turun halus
// Konten berganti dengan blur (lihat MorphLayer di SpotifyWidget.tsx).
// Atur rasa animasi lewat konstanta di bawah ini.

type CollapsePhase = "none" | "squeeze" | "release";

const COLLAPSE_SQUEEZE_MS = 120; // lama fase squeeze sebelum melebar (ms)
const COLLAPSE_RELEASE_MS = 350; // lama fase release sampai selesai (ms)
const COLLAPSE_NARROW = 24; // seberapa sempit dari lebar compact (px)
const COLLAPSE_POP_H = 3; // seberapa nyembul ke atas (px)
const COLLAPSE_WINDOW_DELAY = 950; // window dikecilkan setelah animasi (ms)

// Fase squeeze: menciut cepat dan halus (hampir tanpa pantulan).
// Tinggi lebih cepat dari lebar supaya nyembulnya terlihat sebelum melebar.
const SQUEEZE_WIDTH = {
  type: "spring",
  stiffness: 260,
  damping: 2 * 0.95 * Math.sqrt(260),
  mass: 1,
} as const;

const SQUEEZE_HEIGHT = {
  type: "spring",
  stiffness: 340,
  damping: 2 * 0.95 * Math.sqrt(340),
  mass: 1,
} as const;

// Properti lain (radius, scale tekan) saat menutup: halus tanpa pantulan
const COLLAPSE_BASE = {
  type: "spring",
  stiffness: 240,
  damping: 2 * Math.sqrt(240),
  mass: 1,
} as const;

// Fase release: lebar melebar dengan pantulan lembut (terasa hidup)
const RELEASE_WIDTH = {
  type: "spring",
  stiffness: 170,
  damping: 11,
  mass: 0.9,
} as const;

// Fase release: tinggi dan posisi turun dengan pantulan sangat tipis
const RELEASE_HEIGHT = {
  type: "spring",
  stiffness: 230,
  damping: 17,
  mass: 0.9,
} as const;

//lirik compact melebar saat baris panjang
const LYRIC_MAX_WIDTH = 420; // lebar maksimal pil (window 600)

//swipe kiri / kanan: next / prev
const SWIPE_START = 8; // jarak awal dianggap drag (px)
const SWIPE_DIST = 56; // jarak minimal untuk next / prev (px)
const SWIPE_MAX = 26; // island ikut bergeser maksimal (px)
const SWIPE_BACK = { type: "spring", stiffness: 520, damping: 22 } as const;

// ---- border tipis saat latar belakang gelap (ala Dynamic Island iPhone) ----
// Rust (modul `backdrop`) mengukur seberapa gelap area di sekeliling island lalu
// mengirim event "island-backdrop" berisi angka 0..1 (0 = terang, 1 = hitam pekat).
// Border dibuat makin terlihat seiring latar makin gelap, dan memudar halus
// ketika latar terang (island sudah cukup kontras, tidak butuh border).
const EDGE_WIDTH = 1; // tebal border (px)
const EDGE_RGB = "150, 152, 160"; // warna abu-abu (R, G, B); putih murni = "255, 255, 255"
const EDGE_MAX_ALPHA = 0.34; // keterlihatan maksimal border (0..1), naikkan bila ingin lebih tegas
const EDGE_FADE_S = 0.45; // lama border muncul / menghilang (detik)

// ---- latar pil di halaman utama menu (gaya radial) ----
// Di atas hitam solid (tempat status bar), makin ke bawah makin transparan.
// Atur titik-titiknya di GLASS_GRADIENT: angka pertama = alpha (1 solid, 0 transparan),
// persen = posisi dari atas ke bawah panel. Warna tombol ada di IslandMenu.tsx (TILE_GLASS).
const GLASS_FADE_S = 0.25; // latar belakang menu
const GLASS_GRADIENT =
  "linear-gradient(to bottom, " +
  "rgba(5, 5, 6, 1) 0%, " +
  "rgba(5, 5, 6, 1) 28%, " +
  "rgba(5, 5, 6, 0.80) 50%, " +
  "rgba(5, 5, 6, 0.6) 75%, " +
  "rgba(5, 5, 6, 0.20) 100%)";

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
  const [expandedBase, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // menu klik kanan
  const [menuView, setMenuView] = useState<MenuView>("home");
  const [menuHud, setMenuHud] = useState(false); // HUD volume dari menu
  const expanded = expandedBase || menuOpen;
  const stopwatchRunning = useStopwatchRunning();
  const [lyricsMode, setLyricsMode] = useState(false);
  const [pausedIdle, setPausedIdle] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [gooTail, setGooTail] = useState(false);
  const [behind, setBehind] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [locked, setLocked] = useState(false); // kunci

  // fase animasi menutup (expand -> compact)
  const [collapsePhase, setCollapsePhase] = useState<CollapsePhase>("none");

  // pilihan aktivitas
  const [pick, setPick] = useState<IslandPick>(
    activeWidget === "timer" ? "timer" : "music",
  );

  const forceMini = behind || revealing;

  const islandRef = useRef<HTMLDivElement>(null);
  const lockedRef = useRef(false); // dibaca listener
  const menuBusyRef = useRef(false); // menu menunggu izin lokasi
  const secHit = useRef<number[] | null>(null); // area klik pil kedua

  // tab kembali (menu)
  const tabRef = useRef<HTMLButtonElement>(null);
  const [menuHover, setMenuHover] = useState(false); // mouse di island / tab
  const [tabTail, setTabTail] = useState(false); // gooey tetap nyala saat tab keluar

  //pointer tertelan
  const [overIsland, setOverIsland] = useState(false);
  const [cursorBack, setCursorBack] = useState(false); // klik: pointer muncul lagi
  const [bulge, setBulge] = useState(false);
  const [bulgeSnap, setBulgeSnap] = useState(false); // bulge dibatalkan: scaleX/Y langsung ke 1
  const bulgeTimer = useRef(0);
  const snapTimer = useRef(0);

  //lebar yang dibutuhkan baris lirik compact
  const [lyricNeed, setLyricNeed] = useState(0);

  //swipe next / prev
  const swipeX = useMotionValue(0);
  const islandX = useTransform(swipeX, (v) => `calc(-50% + ${v}px)`);

  // latar pil ikut bergeser saat swipe (semua mode musik: compact, lirik, dan
  // player expanded) supaya latar, konten, dan border bergerak sebagai satu bentuk
  const bgFollow = useRef(false);
  const bgX = useTransform(
    swipeX,
    (v) => `calc(-50% + ${bgFollow.current ? v : 0}px)`,
  );
  const swipe = useRef<{
    id: number;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  const swipeDidDrag = useRef(false); // setelah drag, klik tidak diproses

  // border adaptif: 0 = latar terang (tanpa border), 1 = latar hitam (border penuh)
  // dianimasikan lewat motion value supaya tidak memicu render ulang React
  const edgeDark = useMotionValue(0);
  const edgeColor = useTransform(
    edgeDark,
    (v) => `rgba(${EDGE_RGB}, ${(v * EDGE_MAX_ALPHA).toFixed(3)})`,
  );

  const hoverIn = () => setMenuHover(true);

  // keluar dari island/tab: sembunyikan langsung,
  // kecuali pindah antara island dan tab (keduanya menempel)
  const hoverOut = (e: React.PointerEvent) => {
    const to = e.relatedTarget;
    if (
      to instanceof Node &&
      (islandRef.current?.contains(to) || tabRef.current?.contains(to))
    )
      return;
    setMenuHover(false);
  };

  const hasMedia = Boolean(track.title && track.title !== "Tidak ada media");
  const timerOn = clockTimer.active;

  // pengaturan
  const { settings } = useSettings();

  // Gaya Radial: menu muncul di kursor lewat jendela "radial", jadi island tidak ikut
  // mendengarkan drag file (kalau ikut, dua menu muncul sekaligus)
  const fileIsland = useFileIsland({
    enabled: settings.fileDrop && settings.fileMenuStyle !== "radial",
    sounds: settings.fileSounds,
  });
  const file = fileIsland.active ? fileIsland : null;
  const system = activeWidget === "system" ? systemNotification : null;

  // dibaca listener (salinan dari menu radial)
  const fileIslandRef = useRef(fileIsland);
  fileIslandRef.current = fileIsland;

  const timerFocused =
    !file && !system && timerOn && (pick === "timer" || !hasMedia);
  const isMusic = !file && !system && hasMedia && !timerFocused;

  const baseKind = getKind(
    Boolean(file),
    Boolean(fileIsland.paste),
    Boolean(system),
    timerFocused,
    isMusic,
  );
  const kind: IslandKind = menuOpen ? "menu" : baseKind;

  // tab kembali: hanya gaya notch / tab (bukan pill), di sub-halaman menu,
  // dan hanya saat mouse di dalam
  const menuTabOn =
    settings.style !== "pill" &&
    kind === "menu" &&
    menuView !== "home" &&
    menuHover;
  const secondary = getSecondary(kind, timerOn, hasMedia);

  const showSecondary = Boolean(secondary) && !expanded && !forceMini;

  // pause lama -> mini, berlaku sama untuk player maupun lirik compact
  // (jedanya IDLE_AFTER_PAUSE_MS, dihitung di efek "pause lama -> mini" di bawah)
  const isMini =
    forceMini || kind === "idle" || (kind === "music" && pausedIdle);

  //pointer tertelan hanya saat idle (tidak ada aktivitas, island tertutup)
  const swallowOn = isMini && !forceMini && !expanded && !menuOpen;
  const swallowed = swallowOn && overIsland && !cursorBack;

  // efek nyembul yang benar-benar dipakai untuk animasi.
  // langsung mati begitu pointer ditekan (cursorBack) atau island terbuka
  // (swallowOn false), tanpa menunggu timer BULGE_MS selesai.
  const bulgeOn = bulge && swallowOn && !cursorBack;

  const popBulge = () => {
    window.clearTimeout(bulgeTimer.current);
    setBulge(true);
    bulgeTimer.current = window.setTimeout(() => setBulge(false), BULGE_MS);
  };

  // batalkan nyembul di tengah jalan (klik cepat): sisa lonjakan scaleX/Y
  // di-snap ke 1 supaya tidak ikut terbawa ke animasi expand / menu
  const cancelBulge = () => {
    window.clearTimeout(bulgeTimer.current);
    if (!bulge) return;
    setBulge(false);
    setBulgeSnap(true);
    window.clearTimeout(snapTimer.current);
    snapTimer.current = window.setTimeout(
      () => setBulgeSnap(false),
      BULGE_SNAP_MS,
    );
  };

  const leaveIsland = () => {
    window.clearTimeout(bulgeTimer.current);
    setBulge(false);
    setOverIsland(false);
    setCursorBack(false);
  };

  // idle lagi saat pointer sudah di dalam: nyembul sekali, lainnya batal
  useEffect(() => {
    if (swallowOn && overIsland && !cursorBack) {
      popBulge();
      return;
    }
    window.clearTimeout(bulgeTimer.current);
    setBulge(false);
  }, [swallowOn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      window.clearTimeout(bulgeTimer.current);
      window.clearTimeout(snapTimer.current);
    },
    [],
  );

  // jalankan fase menutup: squeeze -> release -> selesai
  const phaseExpandedRef = useRef(expanded);
  useEffect(() => {
    const was = phaseExpandedRef.current;
    phaseExpandedRef.current = expanded;

    // dibuka lagi di tengah animasi: batalkan semuanya
    if (expanded) {
      setCollapsePhase("none");
      return;
    }
    if (!was) return;

    setCollapsePhase("squeeze");
    const toRelease = window.setTimeout(
      () => setCollapsePhase("release"),
      COLLAPSE_SQUEEZE_MS,
    );
    const toDone = window.setTimeout(
      () => setCollapsePhase("none"),
      COLLAPSE_SQUEEZE_MS + COLLAPSE_RELEASE_MS,
    );

    return () => {
      window.clearTimeout(toRelease);
      window.clearTimeout(toDone);
    };
  }, [expanded]);

  // ukuran dari Pengaturan (selisih dari ukuran bawaan, sesuai gaya aktif)
  // compact dan mini punya pengaturan sendiri; expanded tidak ikut diubah
  const adj = sizeOf(settings, settings.style, isMini ? "mini" : "compact");
  const compactH = Math.max(20, COMPACT_HEIGHT + adj.h);

  // lirik compact: pil melebar bila baris lirik panjang
  const lyricCompact =
    kind === "music" && lyricsMode && !expanded && !isMini && !forceMini;

  // latar pil selalu ikut bergeser saat swipe di mode musik (lihat bgFollow di atas)
  bgFollow.current = kind === "music" && !forceMini;

  const lyricBase = SPOTIFY_SIZES.lyricsMini.width + adj.w;
  const lyricExtra = lyricCompact
    ? Math.min(
        Math.max(0, lyricNeed - lyricBase),
        Math.max(0, LYRIC_MAX_WIDTH - lyricBase),
      )
    : 0;

  const compactWidth = Math.max(
    36,
    getCompactWidth(kind, isMini, lyricsMode) + adj.w + lyricExtra,
  );
  const collapsedHeight = Math.max(
    20,
    (isMini ? S.mini.height : COMPACT_HEIGHT) + adj.h,
  );

  // ---- Volume ----

  // tombol volume hanya ada saat player terbuka
  const musicExpanded =
    expanded && kind === "music" && !lyricsMode && !forceMini;

  // logika di useIslandVolume
  const {
    volumeStatus,
    volumeHudOpen,
    openVolumeHud,
    closeVolumeHud,
    setVolumeLevel,
  } = useIslandVolume(musicExpanded);

  // HUD volume: island menjadi pil horizontal (VolumeHud)
  // - dari menu: menu disembunyikan
  // - dari player musik: player disembunyikan, kembali setelah 1,5 detik idle
  const musicHudOn = musicExpanded && volumeHudOpen;
  const hudMode =
    (kind === "menu" && menuView === "home" && menuHud) || musicHudOn;

  const { width: expandedWidth, height: expandedHeight } = hudMode
    ? { width: VOLUME_HUD_W, height: VOLUME_HUD_H }
    : getExpandedSize(
        kind,
        lyricsMode,
        getFilePanelSize(fileIsland.actions.length),
        MENU_SIZES[menuView],
      );

  // ---- gaya island ----
  // pill  : melayang
  // notch : menempel + bahu
  // tab   : menempel tanpa bahu
  const flush = settings.style !== "pill";
  const shoulder = settings.style === "notch" ? settings.shoulder : 0;
  const islandTop = flush ? 0 : Math.max(0, ISLAND_TOP + settings.pillTop);

  // halaman utama menu: panel island transparan (gaya radial). Hanya tombol
  // (hitam transparan) dan status bar (hitam solid) yang terlihat di atas wallpaper.
  // Berlaku di halaman utama saja; sub-halaman dan HUD volume tetap hitam solid.
  const menuGlass = kind === "menu" && menuView === "home" && !hudMode;

  // pil kedua turun
  const secTop = islandTop + (flush ? 6 : 0);

  // ---- fase menutup: expand -> compact ----

  // ref ini juga dipakai efek tinggi window di bawah
  const prevExpanded = useRef(expanded);

  // hover idle (pil nyembul + pointer tertelan) punya animasinya sendiri,
  // jadi fase squeeze / release tidak dipakai saat itu
  const suppressCollapse = bulge || swallowed;

  // render pertama setelah expanded berubah true -> false (efek fase belum jalan)
  const collapsingNow = prevExpanded.current && !expanded && !suppressCollapse;

  const squeezeOn =
    !expanded &&
    !suppressCollapse &&
    (collapsePhase === "squeeze" || collapsingNow);
  const releaseOn =
    !expanded && !suppressCollapse && collapsePhase === "release";
  const collapseActive = squeezeOn || releaseOn;

  // tambahan tinggi saat nyembul
  const popH = squeezeOn ? COLLAPSE_POP_H : 0;

  // jeda konten compact (timer, file) setelah menutup:
  // muncul dari blur saat pil mulai melebar
  const contentDelay = collapseActive ? COLLAPSE_CONTENT_DELAY : undefined;

  // pil HUD volume: sudut penuh seperti kapsul
  const hudRadius = VOLUME_HUD_H / 2;

  // tinggi pil saat tertutup (termasuk nyembul), untuk radius kapsul
  const shownCollapsedH = collapsedHeight + popH;

  const bottomRadius = flush
    ? expanded
      ? hudMode
        ? hudRadius
        : 34
      : Math.min(18, shownCollapsedH / 2)
    : expanded
      ? hudMode
        ? hudRadius
        : 40
      : shownCollapsedH / 2;

  const topRadius = flush ? 0 : bottomRadius;

  const anim = {
    // squeeze: lebih sempit dari compact, lalu release melebar ke compactWidth
    width: expanded
      ? expandedWidth
      : Math.max(30, compactWidth - (squeezeOn ? COLLAPSE_NARROW : 0)),
    // squeeze: lebih tinggi (nyembul), lalu release turun ke tinggi compact
    height: expanded ? expandedHeight : shownCollapsedH,
    // pada gaya pill (melayang), pil naik sebesar tambahan tingginya sehingga
    // tepi bawah diam dan tepi atas yang nyembul ke atas
    // (gaya notch / tab menempel di tepi layar, jadi tumbuh ke bawah)
    y: squeezeOn && !flush ? -COLLAPSE_POP_H : 0,
    // 4 sudut
    borderTopLeftRadius: topRadius,
    borderTopRightRadius: topRadius,
    borderBottomLeftRadius: bottomRadius,
    borderBottomRightRadius: bottomRadius,
    // paste tidak mengecil
    scale: getPressScale(pressed && kind !== "paste", expanded),
    // nyembul saat hover idle (mati langsung saat diklik / island terbuka)
    scaleX: bulgeOn ? BULGE_X : 1,
    scaleY: bulgeOn ? BULGE_Y : 1,
  };

  const spring = bulgeOn
    ? SWALLOW_POP
    : expanded
      ? SPRING_EXPAND
      : SPRING_COLLAPSE;

  // kunci hanya saat lirik expanded
  // terkunci juga selama stopwatch berjalan: klik luar dan blur tidak menutup menu
  lockedRef.current =
    (locked && expanded && lyricsMode && kind === "music") ||
    (menuOpen && stopwatchRunning);

  // lepas kunci
  useEffect(() => {
    if (!lyricsMode || kind !== "music") setLocked(false);
  }, [lyricsMode, kind]);

  // ikuti widget luar
  useEffect(() => {
    if (activeWidget === "timer") setPick("timer");
    else if (activeWidget === "spotify") setPick("music");
  }, [activeWidget]);

  // pilih pil kedua
  const selectSecondary = () => {
    if (!secondary) return;
    setPick(secondary);
    onSelectWidget(secondary === "timer" ? "timer" : "spotify");
  };

  // ---- swipe next / prev (musik, compact dan expanded) ----

  const swipeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    swipeDidDrag.current = false;
    if (e.button !== 0 || kind !== "music" || forceMini) return;
    if (lockedRef.current) return;
    // slider, tombol, dan input tetap bekerja sendiri
    const target = e.target as HTMLElement;
    if (target.closest('button, input, [role="slider"], [data-no-swipe]'))
      return;
    swipe.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      active: false,
    };
  };

  const swipeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId || !(e.buttons & 1)) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;

    if (!s.active) {
      if (Math.abs(dx) < SWIPE_START) return;
      // geser vertikal: bukan swipe
      if (Math.abs(dy) > Math.abs(dx)) {
        swipe.current = null;
        return;
      }
      s.active = true;
      swipeDidDrag.current = true;
      setPressed(false);
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    swipeX.set(Math.max(-SWIPE_MAX, Math.min(SWIPE_MAX, dx * 0.4)));
  };

  const swipeEnd = (e: React.PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    swipe.current = null;
    if (!s.active) return;

    animate(swipeX, 0, SWIPE_BACK);
    const dx = e.clientX - s.x;
    if (cancel || Math.abs(dx) < SWIPE_DIST) return;

    // kiri = next, kanan = prev
    if (dx < 0) {
      onNextTrack();
      invoke("media_next").catch((err) =>
        console.error("media_next gagal:", err),
      );
    } else {
      invoke("media_previous").catch((err) =>
        console.error("media_previous gagal:", err),
      );
    }
  };

  // ---- menu klik kanan ----

  // buka menu ke layar utama
  const openMenu = () => {
    if (lockedRef.current || forceMini) return;
    setExpanded(false);
    setMenuView("home");
    setMenuHud(false);
    setMenuOpen(true);
  };

  // menu tertutup (klik luar, blur, klik kanan, dll.): HUD volume ikut reset
  useEffect(() => {
    if (!menuOpen) setMenuHud(false);
  }, [menuOpen]);

  // klik kanan pada island: buka menu (kapan saja), klik kanan lagi: tutup
  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (lockedRef.current || forceMini) return;

    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    openMenu();
  };

  // ---- Window Tauri ----

  // Menutup (expand -> compact):
  //  - squeeze : lebar menyempit, tinggi naik (nyembul), pegas cepat dan halus
  //  - release : lebar melebar dengan pantulan lembut, tinggi turun halus
  const mainSpring = squeezeOn
    ? {
        ...COLLAPSE_BASE,
        width: SQUEEZE_WIDTH,
        height: SQUEEZE_HEIGHT,
        y: SQUEEZE_HEIGHT,
      }
    : releaseOn
      ? {
          ...COLLAPSE_BASE,
          width: RELEASE_WIDTH,
          height: RELEASE_HEIGHT,
          y: RELEASE_HEIGHT,
        }
      : spring;

  // pelebaran lirik pakai pegas sendiri; buka / tutup island pakai pegas di atas
  // dipakai latar pil dan konten supaya selalu sinkron
  // (saat menutup, pegas squeeze / release tidak boleh ditimpa)
  const baseTransition =
    lyricCompact && !collapseActive && prevExpanded.current === expanded
      ? { ...mainSpring, width: LYRIC_WIDEN_SPRING }
      : mainSpring;

  // nyembul dibatalkan karena klik cepat: scaleX/Y langsung ke 1 (tanpa pegas),
  // properti lain (width, height, radius) tetap memakai transisi normal
  const islandTransition = bulgeSnap
    ? { ...baseTransition, scaleX: { duration: 0 }, scaleY: { duration: 0 } }
    : baseTransition;

  const appliedHeight = useRef(0); // tinggi window yang terakhir diterapkan

  // selisih tinggi terbesar antara compact dan mini (untuk tinggi window)
  const adjCompactH = sizeOf(settings, settings.style, "compact").h;
  const adjMiniH = sizeOf(settings, settings.style, "mini").h;
  const windowAdjH = Math.max(0, adjCompactH, adjMiniH);

  // tinggi window
  useEffect(() => {
    // tambahan tinggi window saat pil diturunkan / dipertinggi
    // (+ ruang untuk pil yang nyembul saat menutup)
    const extra =
      Math.max(0, islandTop - ISLAND_TOP) +
      (expanded ? 0 : windowAdjH + COLLAPSE_POP_H);

    const targetHeight =
      (expanded ? expandedHeight + 24 : COMPACT_WINDOW_HEIGHT) + extra;

    const apply = () => {
      appliedHeight.current = targetHeight;
      return invoke("island_set_height", { height: targetHeight }).catch((e) =>
        console.error("Gagal mengatur window island:", e),
      );
    };

    const collapsing = prevExpanded.current && !expanded;
    prevExpanded.current = expanded;

    // window lebih kecil dari sebelumnya (menutup, atau menu -> HUD volume)
    const shrinking = targetHeight < appliedHeight.current;

    // kecilkan setelah animasi
    if (collapsing || shrinking) {
      const timer = window.setTimeout(apply, COLLAPSE_WINDOW_DELAY);
      return () => window.clearTimeout(timer);
    }

    void apply();
  }, [expanded, expandedHeight, islandTop, windowAdjH]);

  // mouse keluar dari jendela -> sembunyikan tab
  useEffect(() => {
    const onOut = (event: MouseEvent) => {
      if (!event.relatedTarget) {
        setMenuHover(false);
        setOverIsland(false);
      }
    };
    document.addEventListener("mouseout", onOut);
    return () => document.removeEventListener("mouseout", onOut);
  }, []);

  // gooey tetap nyala sampai animasi tab keluar selesai
  useEffect(() => {
    if (menuTabOn) {
      setTabTail(true);
      return;
    }
    const t = window.setTimeout(() => setTabTail(false), 500);
    return () => window.clearTimeout(t);
  }, [menuTabOn]);

  // klik luar -> tutup
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (lockedRef.current) return;
      if (
        islandRef.current &&
        !islandRef.current.contains(event.target as Node) &&
        !tabRef.current?.contains(event.target as Node)
      ) {
        setExpanded(false);
        setMenuOpen(false);
      }
    };
    const onWindowBlur = () => {
      if (lockedRef.current || menuBusyRef.current) return;
      setExpanded(false);
      setMenuOpen(false);
    };
    // matikan menu bawaan browser (Refresh, Save as, Print, Inspect, dll.)
    const blockNativeMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", blockNativeMenu);

    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("contextmenu", blockNativeMenu);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  // idle / paste -> tutup
  useEffect(() => {
    if (kind === "idle" || kind === "paste") setExpanded(false);
  }, [kind]);

  // ---- file drag ----

  const fileWasActive = useRef(false);
  const wasExpanded = useRef(false);

  // file drag -> expand
  useEffect(() => {
    if (fileIsland.active) setExpanded(true);
    else if (fileWasActive.current) setExpanded(false);

    fileWasActive.current = fileIsland.active;
  }, [fileIsland.active]);

  // island tutup -> buang file
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

  // ---- area klik ----

  // kirim area klik
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
      const tb = tabRef.current;
      if (tb) {
        const r = tb.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          rects.push([
            Math.round(r.left) - HIT_PAD,
            Math.round(r.top) - HIT_PAD,
            Math.round(r.width) + HIT_PAD * 2 + 4,
            Math.round(r.height) + HIT_PAD * 2,
          ]);
        }
      }

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

  // ---- event Rust ----

  // island ke belakang
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

  // seberapa gelap latar di sekeliling island (0..1) -> border putih tipis
  // Rust mengirim nilai ini berkala; di sini hanya dihaluskan lalu dipakai.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let controls: { stop: () => void } | undefined;

    listen<number>("island-backdrop", (event) => {
      const raw = Number(event.payload);
      const dark = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 0));

      // perubahan sangat kecil diabaikan supaya tidak menganimasikan terus-menerus
      if (Math.abs(edgeDark.get() - dark) < 0.01) return;

      controls?.stop();
      controls = animate(edgeDark, dark, {
        duration: EDGE_FADE_S,
        ease: "easeOut",
      });
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch((error) =>
        console.error("island-backdrop listener failed:", error),
      );

    return () => {
      cancelled = true;
      unlisten?.();
      controls?.stop();
    };
  }, [edgeDark]);

  // salin / potong dari menu radial (jendela lain): pil Paste menggantung di island
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<{ items: FileItem[]; mode: "copy" | "cut" }>(
      "radial-paste",
      (event) =>
        fileIslandRef.current.adoptPaste(
          event.payload.items,
          event.payload.mode,
        ),
    )
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch((error) => console.error("radial-paste listener failed:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // island ke depan
  useEffect(() => {
    if (behind) {
      setExpanded(false);
      setMenuOpen(false);
      setRevealing(true);
      return;
    }

    const timer = window.setTimeout(() => setRevealing(false), 170);
    return () => window.clearTimeout(timer);
  }, [behind]);

  // ---- musik ----

  // pause lama -> mini
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

  // ---- gooey ----

  useEffect(() => {
    if (showSecondary) {
      setGooTail(true);
      return;
    }

    const t = window.setTimeout(() => setGooTail(false), 800);
    return () => window.clearTimeout(t);
  }, [showSecondary]);

  const gooOn = showSecondary || gooTail || menuTabOn || tabTail;

  // ---- pil kedua ----

  // lebar = tinggi
  const secW = compactH;

  // posisi akhir
  const secRest = compactWidth / 2 + SPLIT_GAP + secW / 2;

  // posisi awal
  const secHiddenX = compactWidth / 2 - secW * 0.55;

  // area klik pil kedua
  secHit.current = showSecondary
    ? [
        Math.round(window.innerWidth / 2 + secRest - secW / 2) - HIT_PAD,
        secTop - HIT_PAD,
        secW + HIT_PAD * 2,
        compactH + HIT_PAD * 2,
      ]
    : null;

  const secStyle: React.CSSProperties = {
    top: secTop,
    left: `calc(50% - ${secW / 2}px)`,
    width: secW,
    height: compactH,
    borderRadius: compactH / 2,
    transformOrigin: "left center",
  };

  // ---- tab kembali ----

  // posisi dihitung relatif terhadap tepi kiri island yang sedang beranimasi,
  // supaya tab ikut menyempit/melebar bersama island
  // (tab hanya tampil pada gaya notch / tab, jadi island selalu menempel di atas)
  const tabTop = Math.max(TAB_TOP, shoulder + 6);

  const tabFrameStyle: MotionStyle = {
    top: islandTop,
    height: 0,
    x: "-50%",
    transformOrigin: "top center",
  };

  const tabShapeStyle: React.CSSProperties = {
    top: tabTop,
    left: -TAB_OUT,
    width: TAB_W,
    height: TAB_H,
    borderRadius: TAB_H / 2,
    transformOrigin: `${TAB_OUT}px 50%`,
  };

  // ---- border adaptif ----

  // Lapisan border terpisah di atas konten (bukan border di pil / konten itu sendiri):
  //  - pil utama berada di dalam filter gooey, border di sana ikut terdistorsi
  //  - konten player punya latar hitam penuh sehingga akan menutupi border / inset shadow
  // Lapisan ini memakai `anim` dan `islandTransition` yang sama, jadi ukuran, radius,
  // squeeze / release, dan nyembul-nya selalu sinkron dengan pil.
  // Gaya notch / tab menempel di tepi layar, jadi sisi atas tidak diberi border.
  const edgeStyle: MotionStyle = {
    top: islandTop,
    x: islandX,
    transformOrigin: "top center",
    boxSizing: "border-box",
    borderStyle: "solid",
    borderColor: edgeColor,
    borderWidth: flush
      ? `0px ${EDGE_WIDTH}px ${EDGE_WIDTH}px ${EDGE_WIDTH}px`
      : `${EDGE_WIDTH}px`,
  };

  // ---- timer ----

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
        height={compactH}
        delay={contentDelay}
      >
        <TimerCompact clock={clockTimer} />
      </MorphLayer>
    );
  };

  // ---- file ----

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
        height={compactH}
        delay={contentDelay}
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

  // ---- konten utama ----

  const renderMainContent = (): React.ReactNode => {
    // menu klik kanan
    if (kind === "menu") {
      return (
        <motion.div key="menu" className="relative h-full w-full" {...swapFade}>
          <AnimatePresence initial={false}>
            <MorphLayer
              key="menu-expanded"
              variant="expanded"
              width={expandedWidth}
              height={expandedHeight}
            >
              <IslandMenu
                view={menuView}
                onViewChange={setMenuView}
                onClose={() => setMenuOpen(false)}
                onBusyChange={(busy) => {
                  menuBusyRef.current = busy;
                }}
                hud={menuHud}
                onHudChange={setMenuHud}
              />
            </MorphLayer>
          </AnimatePresence>
        </motion.div>
      );
    }

    // musik
    if (kind === "music") {
      // VolumeHud: dipanggil dari tombol volume, menutup sendiri setelah 1,5 detik
      if (musicHudOn) {
        return (
          <motion.div
            key="music-volume-hud"
            className="relative h-full w-full"
            {...swapFade}
          >
            <MorphLayer
              key="music-volume-hud-layer"
              variant="expanded"
              width={expandedWidth}
              height={expandedHeight}
            >
              <VolumeHud
                volume={volumeStatus}
                onChange={setVolumeLevel}
                onClose={closeVolumeHud}
              />
            </MorphLayer>
          </motion.div>
        );
      }

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
            onVolumePress={openVolumeHud}
            widthAdjust={adj.w}
            heightAdjust={adj.h}
            extraWidth={lyricExtra}
            onLyricNeedWidth={setLyricNeed}
          />
        </motion.div>
      );
    }

    // timer
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

    // file
    if (kind === "file" && file) {
      return (
        <motion.div key="file" className="relative h-full w-full" {...swapFade}>
          <AnimatePresence initial={false}>{renderFileLayer()}</AnimatePresence>
        </motion.div>
      );
    }

    // tombol paste
    if (kind === "paste" && fileIsland.paste && !isMini) {
      return (
        <motion.div
          key="paste"
          className="relative h-full w-full"
          {...swapFade}
        >
          <FilePastePill
            paste={fileIsland.paste}
            onPaste={fileIsland.pasteRun}
            onBrowse={fileIsland.pasteBrowse}
            onDismiss={fileIsland.pasteDismiss}
          />
        </motion.div>
      );
    }

    // notifikasi
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

  // album art
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

  // isi pil kedua
  const renderSecondaryContent = (): React.ReactNode => {
    // pil timer
    if (secondary === "timer") {
      return <TimerPill clock={clockTimer} />;
    }

    // pil musik
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
      {/* pil + gooey */}
      <div
        className="absolute inset-0"
        // filter gooey mengeraskan alpha, jadi dimatikan saat latar gradien dipakai
        style={{
          filter: gooOn && !menuGlass ? "url(#gooey-effect)" : undefined,
        }}
      >
        {/* pil utama */}
        <motion.div
          className="absolute left-1/2"
          style={{
            top: islandTop,
            x: bgX,
            transformOrigin: "top center",
          }}
          initial={false}
          animate={anim}
          transition={islandTransition}
        >
          {/* latar hitam solid (semua tampilan kecuali halaman utama menu) */}
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-[#050506]"
            style={{ borderRadius: "inherit" }}
            initial={false}
            animate={{ opacity: menuGlass ? 0 : 1 }}
            transition={{ duration: GLASS_FADE_S }}
          />

          {/* latar gradien halaman utama menu: solid di atas, transparan di bawah */}
          <motion.div
            aria-hidden
            className="absolute inset-0"
            style={{ borderRadius: "inherit", background: GLASS_GRADIENT }}
            initial={false}
            animate={{ opacity: menuGlass ? 1 : 0 }}
            transition={{ duration: GLASS_FADE_S }}
          />

          {/* bahu notch */}
          <IslandShoulders size={shoulder} />
        </motion.div>

        {/* tab kembali (menyatu dengan island lewat gooey) */}
        <motion.div
          className="pointer-events-none absolute left-1/2"
          style={tabFrameStyle}
          initial={false}
          animate={{ width: anim.width, scale: anim.scale }}
          transition={spring}
        >
          <AnimatePresence>
            {menuTabOn && (
              <motion.div
                key="menu-tab-shape"
                className="absolute bg-[#050506]"
                style={tabShapeStyle}
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1, transition: TAB_ENTER }}
                exit={{ scaleX: 0, transition: TAB_EXIT }}
              />
            )}
          </AnimatePresence>
        </motion.div>

        {/* pil kedua */}
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

      {/* konten utama */}
      <motion.div
        ref={islandRef}
        initial={false}
        animate={anim}
        transition={islandTransition}
        onClick={() => {
          if (swipeDidDrag.current) {
            swipeDidDrag.current = false;
            return;
          }
          if (kind === "paste" || kind === "menu") return;
          if (lockedRef.current) return; // terkunci
          // tidak ada aktivitas lain: klik kiri langsung membuka menu
          if (kind === "idle") {
            openMenu();
            return;
          }
          setExpanded((v) => !v);
        }}
        onContextMenu={handleContextMenu}
        onPointerDown={(e) => {
          cancelBulge(); // klik saat masih nyembul: batalkan agar tidak ikut ke animasi buka
          setPressed(true);
          setCursorBack(true); // klik kiri / kanan: pointer muncul lagi
          swipeStart(e);
        }}
        onPointerUp={(e) => {
          setPressed(false);
          swipeEnd(e, false);
        }}
        onPointerEnter={() => {
          hoverIn();
          setOverIsland(true);
          if (swallowOn) popBulge();
        }}
        onPointerMove={(e) => {
          hoverIn();
          swipeMove(e);
        }}
        onPointerLeave={(e) => {
          setPressed(false);
          leaveIsland();
          hoverOut(e);
        }}
        onPointerCancel={(e) => {
          setPressed(false);
          swipeEnd(e, true);
        }}
        className={`pointer-events-auto absolute left-1/2 z-50 overflow-hidden text-white ${
          swallowed ? "cursor-none [&_*]:cursor-none" : "cursor-pointer"
        }`}
        style={{
          top: islandTop,
          x: islandX,
          transformOrigin: "top center",
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {renderMainContent()}
        </AnimatePresence>
      </motion.div>

      {/* border putih tipis adaptif (hanya terlihat bila latar gelap / hitam;
          disembunyikan di halaman utama menu karena panelnya transparan) */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute left-1/2 z-[55]"
        style={edgeStyle}
        initial={false}
        animate={{ ...anim, opacity: menuGlass ? 0 : 1 }}
        transition={islandTransition}
      />

      {/* tombol kembali menu: di luar island, menempel di kiri atas */}
      <motion.div
        className="pointer-events-none absolute left-1/2 z-50"
        style={tabFrameStyle}
        initial={false}
        animate={{ width: anim.width, scale: anim.scale }}
        transition={spring}
      >
        <AnimatePresence>
          {menuTabOn && (
            <motion.button
              key="menu-tab"
              ref={tabRef}
              type="button"
              aria-label="Kembali"
              className="pointer-events-auto absolute flex cursor-pointer items-center justify-center rounded-l-[20px] text-white outline-none transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
              style={{
                top: tabTop,
                left: -TAB_OUT,
                width: TAB_OUT,
                height: TAB_H,
              }}
              initial={{ x: TAB_OUT, opacity: 0 }}
              animate={{ x: 0, opacity: 1, transition: TAB_ENTER }}
              exit={{
                x: TAB_OUT,
                opacity: 0,
                transition: { ...TAB_EXIT, opacity: { duration: 0.12 } },
              }}
              onPointerEnter={hoverIn}
              onPointerLeave={hoverOut}
              onClick={() => {
                setMenuHover(false);
                setMenuView(getMenuBack(menuView));
              }}
            >
              <ChevronLeft size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </motion.div>

      {/* isi pil kedua */}
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
