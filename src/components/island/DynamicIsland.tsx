import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { MorphLayer, SpotifyWidget, VOLUME_BTN_Y } from "./SpotifyWidget";
import { TimerCompact, TimerExpanded, TimerPill } from "./ClockTimerView";
import { SystemWidget } from "../modules/SystemWidget";
import { FileActionsPanel, getFilePanelSize } from "./file/FileActionsPanel";
import { FilePastePill } from "./file/FilePastePill";
import { useFileIsland } from "./file/useFileIsland";
import { IslandShoulders } from "./IslandShoulders";
import { useSettings } from "../../settings/settings";
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
  HUD_W,
  HUD_H,
  HUD_PAD,
  BUMP_H,
  BUMP_OUT,
  BUMP_IN,
  HudExit,
  hudShapeVariants,
  hudContentVariants,
  HUD_FILL_SPRING,
  HUD_STRETCH_X,
  HUD_SQUASH_Y,
  HUD_SHAPE_ENTER,
  HUD_CONTENT_ENTER,
  swapFade,
  getKind,
  getSecondary,
  getCompactWidth,
  getExpandedSize,
  getPressScale,
} from "./dynamic_island/constants";
import { useIslandVolume } from "./dynamic_island/useIslandVolume";

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
  const [expanded, setExpanded] = useState(false);
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
  const secHit = useRef<number[] | null>(null); // area klik pil kedua

  const hasMedia = Boolean(track.title && track.title !== "Tidak ada media");
  const timerOn = clockTimer.active;

  // pengaturan
  const { settings } = useSettings();

  const fileIsland = useFileIsland({
    enabled: settings.fileDrop,
    sounds: settings.fileSounds,
  });
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

  // ---- gaya island ----
  // pill  : melayang
  // notch : menempel + bahu
  // tab   : menempel tanpa bahu
  const flush = settings.style !== "pill";
  const shoulder = settings.style === "notch" ? settings.shoulder : 0;
  const islandTop = flush ? 0 : ISLAND_TOP;

  // pil kedua turun
  const secTop = islandTop + (flush ? 6 : 0);

  const bottomRadius = flush
    ? expanded
      ? 34
      : Math.min(18, collapsedHeight / 2)
    : expanded
      ? 40
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
  lockedRef.current = locked && expanded && lyricsMode && kind === "music";

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

  // ---- Volume ----

  // HUD hanya saat player terbuka
  const musicExpanded =
    expanded && kind === "music" && !lyricsMode && !forceMini;

  // logika di useIslandVolume
  const {
    volume,
    showVolume,
    volumeWindow,
    bumpAt,
    hudPulseX,
    hudPulseY,
    hudShift,
    bumpGrow,
    handleVolumeStep,
    handleVolumePanelChange,
  } = useIslandVolume(musicExpanded);

  // ---- Window Tauri ----

  const prevExpanded = useRef(expanded);

  // tinggi window
  useEffect(() => {
    const targetHeight = expanded ? expandedHeight + 24 : COMPACT_WINDOW_HEIGHT;

    const apply = () =>
      invoke("island_set_height", { height: targetHeight }).catch((e) =>
        console.error("Gagal mengatur window island:", e),
      );

    const collapsing = prevExpanded.current && !expanded;
    prevExpanded.current = expanded;

    // kecilkan setelah animasi
    if (collapsing) {
      const timer = window.setTimeout(apply, 460);
      return () => window.clearTimeout(timer);
    }

    void apply();
  }, [expanded, expandedHeight]);

  // klik luar -> tutup
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

  // island ke depan
  useEffect(() => {
    if (behind) {
      setExpanded(false);
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

  const gooOn = showSecondary || gooTail || volumeWindow;

  // ---- pil kedua ----

  // lebar = tinggi
  const secW = COMPACT_HEIGHT;

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
        COMPACT_HEIGHT + HIT_PAD * 2,
      ]
    : null;

  const secStyle: React.CSSProperties = {
    top: secTop,
    left: `calc(50% - ${secW / 2}px)`,
    width: secW,
    height: COMPACT_HEIGHT,
    borderRadius: COMPACT_HEIGHT / 2,
    transformOrigin: "left center",
  };

  // ---- HUD volume ----

  // posisi HUD
  const hudRestX = expandedWidth / 2 + SPLIT_GAP;
  const hudHiddenX = expandedWidth / 2 - HUD_W * 0.6;
  const hudTop = islandTop + (expandedHeight - HUD_H) / 2;

  const hudStyle: React.CSSProperties = {
    top: hudTop,
    left: "50%",
    width: HUD_W,
    height: HUD_H,
    transformOrigin: "left center",
  };

  // tujuan HUD saat keluar
  // island menciut: HUD naik dan menyatu ke pil compact
  // masih expanded: HUD masuk ke tepi island
  const hudExit: HudExit = !expanded
    ? {
        x: compactWidth / 2 - HUD_W * 0.6,
        y: (collapsedHeight - expandedHeight) / 2,
        scaleX: 0.5,
        scaleY: Math.min(0.55, (collapsedHeight * 0.8) / HUD_H),
        absorb: true,
      }
    : { x: hudHiddenX, y: 0, scaleX: 0.5, scaleY: 0.55, absorb: false };

  // gundukan
  const bumpCenterY =
    bumpAt === "plus" ? VOLUME_BTN_Y.plus : VOLUME_BTN_Y.minus;

  const bumpStyle: React.CSSProperties = {
    top: islandTop + bumpCenterY - BUMP_H / 2,
    left: `calc(50% + ${expandedWidth / 2 - BUMP_IN}px)`,
    width: BUMP_IN + BUMP_OUT,
    height: BUMP_H,
    borderRadius: BUMP_H / 2,
    transformOrigin: `${BUMP_IN}px 50%`,
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
        height={COMPACT_HEIGHT}
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

  // ---- konten utama ----

  const renderMainContent = (): React.ReactNode => {
    // musik
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

        {/* gundukan */}
        {volumeWindow && (
          <motion.div
            className="absolute bg-[#050506]"
            style={{ ...bumpStyle, scale: bumpGrow }}
          />
        )}

        {/* HUD volume */}
        <AnimatePresence custom={hudExit}>
          {showVolume && (
            <motion.div
              key="volume-shape"
              className="absolute"
              style={hudStyle}
              variants={hudShapeVariants}
              custom={hudExit}
              initial={{ x: hudHiddenX, y: 0, scaleX: 0.5, scaleY: 0.55 }}
              animate={{
                x: hudRestX,
                y: 0,
                scaleX: HUD_STRETCH_X,
                scaleY: HUD_SQUASH_Y,
                transition: HUD_SHAPE_ENTER,
              }}
              exit="exit"
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
          if (kind === "idle" || kind === "paste") return;
          if (lockedRef.current) return; // terkunci
          setExpanded((v) => !v);
        }}
        onPointerDown={() => setPressed(true)}
        onPointerUp={() => setPressed(false)}
        onPointerLeave={() => setPressed(false)}
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

      {/* isi HUD */}
      <AnimatePresence custom={hudExit}>
        {showVolume && (
          <motion.div
            key="volume-content"
            className="pointer-events-none absolute z-40"
            style={hudStyle}
            variants={hudContentVariants}
            custom={hudExit}
            initial={{ x: hudHiddenX, y: 0, scale: 0.6, opacity: 0 }}
            animate={{
              x: hudRestX,
              y: 0,
              scale: 1,
              opacity: 1,
              transition: HUD_CONTENT_ENTER,
            }}
            exit="exit"
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
