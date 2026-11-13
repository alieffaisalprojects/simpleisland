import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue } from "framer-motion";

// ---- Teks berjalan (judul panjang) ----
// Dipakai di: judul player expanded, judul lirik expanded, dan judul pil lirik compact

// Kecepatan geser (px per detik): pelan
const MARQUEE_SPEED = 26;

// Diam dulu setelah island dibuka / judul berganti (ms)
const MARQUEE_START_DELAY = 1800;

// Diam sebentar di awal setiap putaran berikutnya (ms)
const MARQUEE_LOOP_DELAY = 1400;

// Jarak antara akhir teks dan salinan berikutnya (px)
const MARQUEE_GAP = 36;

// Teks satu baris. Muat -> diam. Terlalu panjang -> diam sebentar, lalu berjalan
// pelan ke kiri berulang-ulang, dengan tepi kiri/kanan memudar.
// center = teks yang muat ditaruh di tengah wadah (dipakai di pil lirik compact);
// bila tidak muat, teks tetap mulai dari tepi kiri lalu berjalan.
export const MarqueeText: React.FC<{
  text: string;
  className?: string;
  center?: boolean;
}> = ({ text, className = "", center = false }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const x = useMotionValue(0);

  const [textWidth, setTextWidth] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [moving, setMoving] = useState(false);

  // Ukur teks dan wadah. Diukur ulang saat ukuran berubah (mis. panel volume dibuka,
  // atau pil lirik compact sedang melebar)
  useLayoutEffect(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;

    const measure = () => {
      const width = el.offsetWidth;
      setTextWidth(width);
      setOverflow(width > box.clientWidth + 1);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(el);

    return () => observer.disconnect();
  }, [text]);

  // Jalankan: diam -> geser satu putaran -> diam -> ulangi
  useEffect(() => {
    x.set(0);
    setMoving(false);

    if (!overflow || textWidth <= 0) return;

    const distance = textWidth + MARQUEE_GAP;

    let cancelled = false;
    let timer: number | undefined;
    let controls: { stop: () => void } | undefined;

    const cycle = (delay: number) => {
      timer = window.setTimeout(() => {
        if (cancelled) return;

        setMoving(true);

        controls = animate(x, -distance, {
          duration: distance / MARQUEE_SPEED,
          ease: "linear",
          onComplete: () => {
            if (cancelled) return;

            // Salinan kedua kini tepat di posisi awal, jadi reset tidak terlihat
            x.set(0);
            setMoving(false);
            cycle(MARQUEE_LOOP_DELAY);
          },
        });
      }, delay);
    };

    cycle(MARQUEE_START_DELAY);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controls?.stop();
      x.set(0);
    };
  }, [overflow, textWidth, text, x]);

  // Tepi kanan selalu memudar saat teks terpotong; tepi kiri hanya saat bergerak
  const mask = !overflow
    ? undefined
    : moving
      ? "linear-gradient(to right, transparent 0, #000 12px, #000 calc(100% - 16px), transparent 100%)"
      : "linear-gradient(to right, #000 calc(100% - 16px), transparent 100%)";

  return (
    <div
      ref={boxRef}
      className={`relative overflow-hidden whitespace-nowrap ${className}`}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      <motion.div
        className={`flex w-max ${center && !overflow ? "mx-auto" : ""}`}
        style={{ x }}
      >
        <span ref={textRef} className="shrink-0">
          {text}
        </span>

        {/* Salinan kedua agar putaran tersambung mulus */}
        {overflow && (
          <span
            aria-hidden
            className="shrink-0"
            style={{ paddingLeft: MARQUEE_GAP }}
          >
            {text}
          </span>
        )}
      </motion.div>
    </div>
  );
};

export default MarqueeText;
