import React, { useCallback, useEffect, useRef } from "react";
import type { VolumeStatus } from "./useSystemStatus";

// HUD volume: island berubah jadi pil (ikon speaker + garis putus-putus).
// Ukuran pil diatur DynamicIsland lewat VOLUME_HUD_W / VOLUME_HUD_H.

export const VOLUME_HUD_W = 240;
export const VOLUME_HUD_H = 56;

const STEP = 5; // panah keyboard / roda mouse
const DASHES = 20;
const IDLE_MS = 1500; // tanpa aktivitas -> kembali ke menu

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

// Ikon speaker
const SpeakerIcon: React.FC<{
  level: number;
  muted: boolean;
  size?: number;
}> = ({ level, muted, size = 24 }) => {
  const off = muted || level <= 0;
  const waves = off ? 0 : level < 34 ? 1 : level < 67 ? 2 : 3;
  const wave = (n: number): React.CSSProperties => ({
    opacity: waves >= n ? 1 : 0,
    transition: "opacity 160ms ease",
  });
  // Saat senyap, badan speaker digeser ke tengah supaya garis miring simetris
  const body: React.CSSProperties = {
    transform: off ? "translateX(5px)" : "translateX(0)",
    transition: "transform 220ms ease",
  };
  // Garis miring digambar saat senyap
  const slash: React.CSSProperties = {
    strokeDasharray: 1,
    strokeDashoffset: off ? 0 : 1,
    opacity: off ? 1 : 0,
    transition: "stroke-dashoffset 220ms ease, opacity 120ms ease",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M10.5 5 6 9H3v6h3l4.5 4V5z" fill="currentColor" style={body} />
      <path d="M14.8 9.6a3.8 3.8 0 0 1 0 4.8" style={wave(1)} />
      <path d="M17.2 7.2a7.4 7.4 0 0 1 0 9.6" style={wave(2)} />
      <path d="M19.6 4.8a11 11 0 0 1 0 14.4" style={wave(3)} />
      {/* Garis miring 45°, tepat di tengah (12,12); garis gelap memberi celah */}
      <path
        d="M6 6L18 18"
        stroke="#050506"
        strokeWidth={4.2}
        pathLength={1}
        style={slash}
      />
      <path d="M6 6L18 18" strokeWidth={1.9} pathLength={1} style={slash} />
    </svg>
  );
};

interface VolumeHudProps {
  volume: VolumeStatus;
  onChange: (level: number) => void;
  /** Kembali ke menu. */
  onClose: () => void;
}

export const VolumeHud: React.FC<VolumeHudProps> = ({
  volume,
  onChange,
  onClose,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const hovering = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  // Simpan onClose di ref agar timer idle tidak ter-reset
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const shown = volume.muted ? 0 : volume.level;
  const filled = Math.round((shown / 100) * DASHES);

  // Kembali ke menu jika tidak ada aktivitas (dijeda saat hover / geser)
  const arm = useCallback(() => {
    window.clearTimeout(timer.current);
    if (hovering.current || dragging.current) return;
    timer.current = window.setTimeout(() => closeRef.current(), IDLE_MS);
  }, []);

  useEffect(() => {
    arm();
    return () => window.clearTimeout(timer.current);
  }, [arm, shown]);

  // Esc kembali ke menu; panah mengubah volume
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        closeRef.current();
      } else if (e.key === "ArrowUp" || e.key === "ArrowRight") {
        e.preventDefault();
        onChange(clamp(shown + STEP));
      } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
        e.preventDefault();
        onChange(clamp(shown - STEP));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, onChange]);

  // Geser di garis: kiri = 0, kanan = 100
  const fromPointer = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    onChange(clamp(((clientX - r.left) / r.width) * 100));
  };

  return (
    <div
      className="flex h-full w-full items-center gap-4 px-5 text-white"
      data-vol-hud=""
      onPointerEnter={() => {
        hovering.current = true;
        arm();
      }}
      onPointerLeave={() => {
        hovering.current = false;
        arm();
      }}
      onWheel={(e) => {
        onChange(clamp(shown + (e.deltaY < 0 ? STEP : -STEP)));
      }}
      // Cegah efek "ditekan" pada island
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Tombol kembali */}
      <button
        type="button"
        aria-label="Kembali ke menu"
        title="Kembali ke menu"
        onClick={onClose}
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-white/85 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
      >
        <SpeakerIcon level={volume.level} muted={volume.muted} />
      </button>

      {/* Garis volume */}
      <div
        ref={trackRef}
        role="slider"
        aria-label="Volume"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown}
        className="relative flex h-full min-w-0 flex-1 cursor-pointer touch-none items-center justify-between"
        onPointerDown={(e) => {
          dragging.current = true;
          window.clearTimeout(timer.current);
          e.currentTarget.setPointerCapture(e.pointerId);
          fromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) fromPointer(e.clientX);
        }}
        onPointerUp={(e) => {
          dragging.current = false;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* abaikan */
          }
          arm();
        }}
        onPointerCancel={() => {
          dragging.current = false;
          arm();
        }}
      >
        {Array.from({ length: DASHES }, (_, i) => (
          <span
            key={i}
            className={`pointer-events-none h-[3px] w-[5px] rounded-full transition-colors duration-100 ${
              i < filled
                ? volume.muted
                  ? "bg-white/60"
                  : "bg-white"
                : "bg-white/25"
            }`}
          />
        ))}
      </div>
    </div>
  );
};
