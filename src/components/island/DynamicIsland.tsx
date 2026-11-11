import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type MotionStyle } from "framer-motion";
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
import { MorphLayer, SpotifyWidget } from "./SpotifyWidget";
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

  const isMini =
    forceMini ||
    kind === "idle" ||
    (kind === "music" && pausedIdle && !lyricsMode);

  // ukuran dari Pengaturan (selisih dari ukuran bawaan, sesuai gaya aktif)
  // compact dan mini punya pengaturan sendiri; expanded tidak ikut diubah
  const adj = sizeOf(settings, settings.style, isMini ? "mini" : "compact");
  const compactH = Math.max(20, COMPACT_HEIGHT + adj.h);
  const compactWidth = Math.max(
    36,
    getCompactWidth(kind, isMini, lyricsMode) + adj.w,
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

  // pil kedua turun
  const secTop = islandTop + (flush ? 6 : 0);

  // pil HUD volume: sudut penuh seperti kapsul
  const hudRadius = VOLUME_HUD_H / 2;

  const bottomRadius = flush
    ? expanded
      ? hudMode
        ? hudRadius
        : 34
      : Math.min(18, collapsedHeight / 2)
    : expanded
      ? hudMode
        ? hudRadius
        : 40
      : collapsedHeight / 2;

  const topRadius = flush ? 0 : bottomRadius;

  const anim = {
    width: expanded ? expandedWidth : compactWidth,
    height: expanded ? expandedHeight : collapsedHeight,
    // 4 sudut
    borderTopLeftRadius: topRadius,
    borderTopRightRadius: topRadius,
    borderBottomLeftRadius: bottomRadius,
    borderBottomRightRadius: bottomRadius,
    // paste tidak mengecil
    scale: getPressScale(pressed && kind !== "paste", expanded),
  };

  const spring = expanded ? SPRING_EXPAND : SPRING_COLLAPSE;

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

  const prevExpanded = useRef(expanded);
  const appliedHeight = useRef(0); // tinggi window yang terakhir diterapkan

  // selisih tinggi terbesar antara compact dan mini (untuk tinggi window)
  const adjCompactH = sizeOf(settings, settings.style, "compact").h;
  const adjMiniH = sizeOf(settings, settings.style, "mini").h;
  const windowAdjH = Math.max(0, adjCompactH, adjMiniH);

  // tinggi window
  useEffect(() => {
    // tambahan tinggi window saat pil diturunkan / dipertinggi
    const extra =
      Math.max(0, islandTop - ISLAND_TOP) + (expanded ? 0 : windowAdjH);

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
      const timer = window.setTimeout(apply, 460);
      return () => window.clearTimeout(timer);
    }

    void apply();
  }, [expanded, expandedHeight, islandTop, windowAdjH]);

  // mouse keluar dari jendela -> sembunyikan tab
  useEffect(() => {
    const onOut = (event: MouseEvent) => {
      if (!event.relatedTarget) setMenuHover(false);
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
        style={{ filter: gooOn ? "url(#gooey-effect)" : undefined }}
      >
        {/* pil utama */}
        <motion.div
          className="absolute left-1/2 bg-[#050506]"
          style={{
            top: islandTop,
            x: "-50%",
            transformOrigin: "top center",
          }}
          initial={false}
          animate={anim}
          transition={spring}
        >
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
        transition={spring}
        onClick={() => {
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
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerEnter={hoverIn}
        onPointerMove={hoverIn}
        onPointerLeave={(e) => {
          setPressed(false);
          hoverOut(e);
        }}
        onPointerCancel={() => setPressed(false)}
        className="pointer-events-auto absolute left-1/2 z-50 cursor-pointer overflow-hidden text-white"
        style={{
          top: islandTop,
          x: "-50%",
          transformOrigin: "top center",
        }}
      >
        <AnimatePresence mode="wait" initial={false}>
          {renderMainContent()}
        </AnimatePresence>
      </motion.div>

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
