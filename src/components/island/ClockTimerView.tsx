/**
 * File: ClockTimerView.tsx
 * Kegunaan: Tampilan timer ala Dynamic Island iPhone — compact (ikon cincin + waktu), pil bulat kecil (aktivitas kedua), dan expanded.
 */
import React, { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play, X } from "lucide-react";
import { ClockTimer } from "../../types";

const ORANGE = "#FF9F0A";
const ORANGE_TRACK = "rgba(255,159,10,.28)"; // bagian cincin yang sudah berlalu
const FONT = `"SF Pro Rounded", "SF Pro Text", "SF Pro Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
const pad = (n: number) => String(n).padStart(2, "0");

export const fmtClock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

// Progress halus 60fps. `clock.remaining` hanya berubah per detik (dibulatkan ke atas),
// jadi nilai sebenarnya ada di (remaining-1, remaining]. Di antara tick, nilai turun
// kontinu via requestAnimationFrame lalu dijepit ke rentang itu -> selalu sinkron
// dengan angka yang tampil. Di-apply langsung ke elemen SVG (tanpa re-render React).
const useSmoothProgress = (
  clock: ClockTimer,
  apply: (p: number) => void,
  ready = true, // false -> elemen belum ada; berubah ke true -> terapkan ulang
) => {
  const live = useRef(clock);
  live.current = clock;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const disp = useRef(clock.remaining);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const { remaining: r, total: t, running: run } = live.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      let d = disp.current;
      if (Math.abs(d - r) > 2)
        d = r; // lompat jauh (timer baru / sinkron ulang)
      else if (run) {
        d = Math.min(r, Math.max(r - 1 + 0.02, d - dt)); // turun halus, tetap dalam rentang tick
      } else {
        d += (r - d) * 0.35; // dijeda: merapat ke nilai pasti
        if (Math.abs(r - d) < 0.002) d = r;
      }
      d = Math.max(0, d);
      disp.current = d;
      applyRef.current(t > 0 ? Math.min(1, d / t) : 0);

      if (run || d !== r) raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [clock.running, clock.remaining, clock.total, ready]);
};

// Atur panjang garis (pathLength = 1) langsung di elemen
const applyDash = (el: SVGGeometryElement | null, p: number) => {
  if (!el) return;
  el.style.strokeDashoffset = String(1 - p);
  el.style.visibility = p <= 0.001 ? "hidden" : "visible"; // cap bulat tidak jadi titik
};

// Bar oren yang mengelilingi tepi island (mulai dari tengah atas, searah jarum jam).
// `progress` 1 -> penuh, 0 -> habis. `radius` default = setengah tinggi (pil penuh).
// Tidak dipakai di tampilan compact baru, tetap diekspor kalau dipakai di tempat lain.
export const TimerBorder: React.FC<{
  w: number;
  h: number;
  clock: ClockTimer;
  radius?: number;
  stroke?: number;
}> = ({ w, h, clock, radius, stroke = 2.5 }) => {
  const barRef = useRef<SVGPathElement>(null);
  useSmoothProgress(
    clock,
    (p) => applyDash(barRef.current, p),
    w >= 8 && h >= 8,
  );
  const running = clock.running;

  if (w < 8 || h < 8) return null;

  const i = stroke / 2; // geser ke dalam agar tidak terpotong
  const r = Math.max(0, Math.min(radius ?? h / 2, w / 2, h / 2) - i);
  const d =
    `M ${w / 2} ${i} H ${w - i - r} A ${r} ${r} 0 0 1 ${w - i} ${i + r} ` +
    `V ${h - i - r} A ${r} ${r} 0 0 1 ${w - i - r} ${h - i} ` +
    `H ${i + r} A ${r} ${r} 0 0 1 ${i} ${h - i - r} ` +
    `V ${i + r} A ${r} ${r} 0 0 1 ${i + r} ${i} H ${w / 2}`;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="pointer-events-none absolute inset-0"
      style={{ overflow: "visible" }}
      aria-hidden
    >
      <path
        d={d}
        fill="none"
        stroke="rgba(255,255,255,.10)"
        strokeWidth={stroke}
        pathLength={1}
      />
      <path
        ref={barRef}
        d={d}
        fill="none"
        stroke={ORANGE}
        strokeWidth={stroke}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1 1"
        style={{
          opacity: running ? 1 : 0.5,
          filter: running ? `drop-shadow(0 0 3px ${ORANGE}99)` : "none",
          transition: "opacity .25s",
        }}
      />
    </svg>
  );
};

// Ikon timer iPhone: cincin tebal yang berkurang + jarum pendek di tengah.
// Cincin mulai dari jam 12 searah jarum jam; jarum selalu menunjuk ujung sisa waktu.
const TimerRingIcon: React.FC<{ clock: ClockTimer; className?: string }> = ({
  clock,
  className = "",
}) => {
  const ringRef = useRef<SVGCircleElement>(null);
  const handRef = useRef<SVGGElement>(null);

  useSmoothProgress(clock, (p) => {
    applyDash(ringRef.current, p);
    handRef.current?.setAttribute("transform", `rotate(${p * 360} 12 12)`);
  });

  return (
    <div className={className}>
      <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
        <g transform="rotate(-90 12 12)">
          <circle
            cx={12}
            cy={12}
            r={9.5}
            fill="none"
            stroke={ORANGE_TRACK}
            strokeWidth={2.7}
          />
          <circle
            ref={ringRef}
            cx={12}
            cy={12}
            r={9.5}
            fill="none"
            stroke={ORANGE}
            strokeWidth={2.7}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1 1"
          />
        </g>
        <g ref={handRef}>
          <line
            x1={12}
            y1={12}
            x2={12}
            y2={7}
            stroke={ORANGE}
            strokeWidth={2.2}
            strokeLinecap="round"
          />
        </g>
      </svg>
    </div>
  );
};

// Pil utama (compact): ikon cincin di kiri, waktu di kanan (tanpa bar di tepi island)
export const TimerCompact: React.FC<{ clock: ClockTimer }> = ({ clock }) => (
  <div
    className="relative flex h-full w-full items-center justify-between pl-[9px] pr-[12px]"
    style={{ opacity: clock.running ? 1 : 0.65, transition: "opacity .25s" }}
  >
    <TimerRingIcon clock={clock} className="aspect-square h-[56%] shrink-0" />
    <span
      className="tabular-nums"
      style={{
        color: ORANGE,
        fontFamily: FONT,
        fontSize: 18,
        fontWeight: 400,
        lineHeight: 1,
        letterSpacing: "-0.01em",
      }}
    >
      {fmtClock(clock.remaining)}
    </span>
  </div>
);

// Pil bulat (aktivitas kedua): ikon cincin timer yang berkurang
export const TimerPill: React.FC<{ clock: ClockTimer }> = ({ clock }) => (
  <div
    className="relative flex h-full w-full items-center justify-center"
    style={{ opacity: clock.running ? 1 : 0.6, transition: "opacity .25s" }}
  >
    <TimerRingIcon clock={clock} className="aspect-square h-[60%]" />
  </div>
);

// Satu digit: angka lama turun keluar cepat, angka baru turun masuk dari atas (ala numericText iOS)
const Digit: React.FC<{ ch: string }> = ({ ch }) => (
  <span className="relative inline-block">
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={ch}
        className="inline-block"
        initial={{ y: "-40%", opacity: 0, filter: "blur(3px)" }}
        animate={{
          y: "0%",
          opacity: 1,
          filter: "blur(0px)",
          transition: {
            type: "spring",
            stiffness: 420,
            damping: 34,
            mass: 0.7,
          },
        }}
        exit={{
          y: "40%",
          opacity: 0,
          filter: "blur(3px)",
          transition: { duration: 0.12, ease: "easeIn" },
        }}
      >
        {ch}
      </motion.span>
    </AnimatePresence>
  </span>
);

// Waktu dengan animasi angka turun (key per posisi dari kanan)
export const RollingTime: React.FC<{
  seconds: number;
  className?: string;
  style?: React.CSSProperties;
}> = ({ seconds, className = "", style }) => {
  const chars = fmtClock(seconds).split("");

  return (
    <span
      className={`inline-flex tabular-nums ${className}`}
      style={style}
      aria-label={fmtClock(seconds)}
    >
      {chars.map((ch, i) => {
        const fromRight = chars.length - 1 - i;

        return ch === ":" ? (
          <span
            key={`c${fromRight}`}
            className="px-[1px]"
            style={{ transform: "translateY(-0.06em)" }}
          >
            :
          </span>
        ) : (
          <Digit key={`d${fromRight}`} ch={ch} />
        );
      })}
    </span>
  );
};

// Tombol bulat (pause / stop)
const RoundButton: React.FC<{
  label: string;
  bg: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ label, bg, onClick, children }) => (
  <motion.button
    type="button"
    aria-label={label}
    whileTap={{ scale: 0.9 }}
    transition={{ type: "spring", stiffness: 500, damping: 28 }}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => {
      e.stopPropagation();
      onClick?.();
    }}
    className="flex h-[48px] w-[48px] shrink-0 items-center justify-center rounded-full"
    style={{ background: bg }}
  >
    {children}
  </motion.button>
);

// Timer expanded: [pause] [x] ............ Timer 11:20
export const TimerExpanded: React.FC<{
  clock: ClockTimer;
  onPause?: () => void;
  onStop?: () => void;
}> = ({ clock, onPause, onStop }) => {
  const hasHours = clock.remaining >= 3600;

  return (
    <div className="flex h-full w-full items-center justify-between gap-3 pl-4 pr-7">
      {/* Tombol kiri */}
      <div className="flex shrink-0 items-center gap-2.5">
        <RoundButton
          label={clock.running ? "Jeda timer" : "Lanjutkan timer"}
          bg="rgba(255,159,10,.28)"
          onClick={onPause}
        >
          {clock.running ? (
            <Pause size={22} color={ORANGE} fill={ORANGE} strokeWidth={0} />
          ) : (
            <Play size={21} color={ORANGE} fill={ORANGE} strokeWidth={0} />
          )}
        </RoundButton>

        <RoundButton
          label="Hentikan timer"
          bg="rgba(255,255,255,.18)"
          onClick={onStop}
        >
          <X size={22} color="#fff" strokeWidth={2.4} />
        </RoundButton>
      </div>

      {/* Label + waktu */}
      <div
        className="flex min-w-0 items-baseline justify-end gap-2.5"
        style={{
          color: ORANGE,
          fontFamily: FONT,
          opacity: clock.running ? 1 : 0.7,
          transition: "opacity .25s",
        }}
      >
        <span className="text-[14px] font-semibold tracking-[.01em]">
          Timer
        </span>

        <RollingTime
          seconds={clock.remaining}
          style={{
            fontSize: hasHours ? 30 : 42,
            fontWeight: 350,
            lineHeight: 1,
            letterSpacing: "-0.015em",
          }}
        />
      </div>
    </div>
  );
};
