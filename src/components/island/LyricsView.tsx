import React, { useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Languages, Music, Pause, Play } from "lucide-react";
import { LyricsState, SpotifyTrack } from "../../types";

// Ikon lirik
export const LyricsIcon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.2 4v-4h-.3A2.5 2.5 0 0 1 4 13.5z" />
    <path d="M8 8h8M8 11.5h5" />
  </svg>
);

// Tombol pada bagian header
const HeaderButton: React.FC<{
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, active, onClick, children }) => (
  <button
    aria-label={label}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    onMouseDown={(e) => e.preventDefault()}
    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition active:scale-90 ${
      active
        ? "bg-white text-black"
        : "bg-white/10 text-white/85 hover:bg-white/20"
    }`}
  >
    {children}
  </button>
);

// Efek gradasi pada area lirik
const maskStyle: React.CSSProperties = {
  WebkitMaskImage:
    "linear-gradient(to bottom, transparent 0, #000 22%, #000 76%, transparent 100%)",
  maskImage:
    "linear-gradient(to bottom, transparent 0, #000 22%, #000 76%, transparent 100%)",
};

// Properti tampilan lirik
interface LyricsViewProps {
  track: SpotifyTrack;
  palette: string[];
  lyrics: LyricsState;
  activeIndex: number;
  showTranslation: boolean;
  onToggleTranslation: () => void;
  onBack: () => void;
  onTogglePlay: () => void;
  onSeekTo: (secs: number) => void;
}

// Tampilan utama lirik
export const LyricsView: React.FC<LyricsViewProps> = ({
  track,
  palette,
  lyrics,
  activeIndex,
  showTranslation,
  onToggleTranslation,
  onBack,
  onTogglePlay,
  onSeekTo,
}) => {
  // Referensi area lirik dan setiap baris
  const viewportRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Posisi vertikal lirik
  const [offset, setOffset] = useState(0);

  // Status terjemahan
  const canTranslate = lyrics.isForeign && Boolean(lyrics.translated);

  // Hitung ulang posisi baris aktif ketika ukuran area berubah
  useLayoutEffect(() => {
    const vp = viewportRef.current;

    if (!vp || lyrics.status !== "ready") return;

    // Menghitung posisi baris aktif
    const updateOffset = () => {
      const el = lineRefs.current[Math.max(0, activeIndex)];

      if (!el || !vp.clientHeight) return;

      const targetPosition = vp.clientHeight * 0.4;
      const linePosition = el.offsetTop + el.offsetHeight / 2;

      setOffset(targetPosition - linePosition);
    };

    // Hitung posisi saat pertama kali dijalankan
    updateOffset();

    // Pantau perubahan ukuran area lirik
    const resizeObserver = new ResizeObserver(() => {
      updateOffset();
    });

    resizeObserver.observe(vp);

    // Bersihkan observer ketika komponen berubah atau dilepas
    return () => {
      resizeObserver.disconnect();
    };
  }, [
    activeIndex,
    showTranslation,
    lyrics.lines,
    lyrics.translated,
    lyrics.status,
  ]);

  // Pesan ketika lirik belum tersedia
  const empty =
    lyrics.status === "loading"
      ? "Memuat lirik…"
      : lyrics.status === "none"
        ? "Lirik tidak tersedia untuk lagu ini"
        : lyrics.status === "idle"
          ? "Tidak ada lagu"
          : "";

  return (
    <div
      className="relative h-full w-full overflow-hidden text-white"
      style={{
        background: `radial-gradient(ellipse at 15% 0%, ${palette[0]}30 0%, transparent 50%), radial-gradient(ellipse at 100% 100%, ${palette[1] ?? palette[0]}22 0%, transparent 48%)`,
      }}
    >
      {/* Header lagu */}
      <div className="relative flex items-center gap-3 px-[20px] pt-[16px]">
        <div className="h-[38px] w-[38px] shrink-0 overflow-hidden rounded-[9px] bg-white/10 ring-1 ring-white/10">
          {track.albumArt ? (
            <img
              src={track.albumArt}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <Music size={18} className="m-[10px] text-white/60" />
          )}
        </div>

        {/* Judul dan artis */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold tracking-[-0.02em]">
            {track.title}
          </div>
          <div className="truncate text-[11px] font-medium text-white/55">
            {track.artist}
          </div>
        </div>

        {/* Tombol terjemahan */}
        {canTranslate && (
          
          <HeaderButton
            label="Terjemahan"
            active={showTranslation}
            onClick={onToggleTranslation}
          >
            <Languages size={15} />
          </HeaderButton>
        )}

        {/* Tombol play dan pause */}
        <HeaderButton
          label={track.isPlaying ? "Pause" : "Play"}
          onClick={onTogglePlay}
        >
          {track.isPlaying ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" className="ml-[1px]" />
          )}
        </HeaderButton>

        {/* Tombol kembali ke pemutar musik */}
        <HeaderButton label="Pemutar musik" onClick={onBack}>
          <Music size={15} />
        </HeaderButton>
      </div>

      {/* Area daftar lirik */}
      <div
        ref={viewportRef}
        className="absolute inset-x-0 bottom-[6px] top-[62px] overflow-hidden"
        style={maskStyle}
      >
        {lyrics.status !== "ready" ? (
          // Pesan ketika lirik belum siap
          <div className="flex h-full items-center justify-center text-[13px] font-medium text-white/45">
            {empty}
          </div>
        ) : (
          // Kontainer lirik yang mengikuti baris aktif
          <motion.div
            className="relative"
            initial={false}
            animate={{ y: offset }}
            transition={{
              type: "spring",
              stiffness: 140,
              damping: 22,
              mass: 0.9,
            }}
          >
            {lyrics.lines.map((line, i) => {
              // Status setiap baris lirik
              const d = Math.abs(i - activeIndex);
              const active = i === activeIndex;
              const before = activeIndex < 0;
              const tr = lyrics.translated?.[i];

              return (
                <motion.div
                  key={i}
                  ref={(el) => {
                    lineRefs.current[i] = el;
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSeekTo(line.time);
                  }}
                  initial={false}
                  animate={{
                    scale: active ? 1 : 0.8,
                    opacity: active
                      ? 1
                      : before
                        ? i === 0
                          ? 0.6
                          : 0.3
                        : Math.max(0.16, 0.5 - d * 0.1),
                    filter: `blur(${active || before || d > 6 ? 0 : Math.min(0.5 + d * 0.6, 3)}px)`,
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 210,
                    damping: 26,
                    mass: 0.8,
                  }}
                  className="origin-left cursor-pointer px-[22px] py-[5px]"
                >
                  {/* Teks lirik */}
                  <div className="text-[21px] font-bold leading-[1.22] tracking-[-0.02em]">
                    {line.text || "♪"}
                  </div>

                  {/* Terjemahan lirik */}
                  {showTranslation && tr && (
                    <div className="mt-[2px] text-[13.5px] font-semibold leading-snug text-white/60">
                      {tr}
                    </div>
                  )}
                </motion.div>
              );
            })}

            {/* Ruang tambahan di bawah lirik */}
            <div className="h-[110px]" />
          </motion.div>
        )}
      </div>
    </div>
  );
};
