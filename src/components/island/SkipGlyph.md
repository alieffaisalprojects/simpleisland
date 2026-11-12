// SkipGlyph.tsx
// ikon skip (dua segitiga) yang sama dengan tombol next / prev di SpotifyWidget,
// tetapi animasinya dikendalikan nilai luar (0..1) sehingga bisa mengikuti tarikan swipe.
//
// - 0 dan 1 tampak sama: dua segitiga diam
// - di antaranya: segitiga baru masuk dari belakang, segitiga tengah maju,
//   segitiga depan keluar lalu memudar (persis animasi klik di SpotifyWidget)

import React from "react";
import { motion, useTransform, type MotionValue } from "framer-motion";

// Satu segitiga ikon skip (menghadap kanan), dipakai sebagai "gerbong" animasi
// (sama dengan SKIP_TRIANGLE di SpotifyWidget)
export const SKIP_TRIANGLE =
  "M5 3.5L24.5 14.2C25.8 14.9 25.8 17.1 24.5 17.8L5 28.5C3.7 29.2 2 28.3 2 26.7V5.3C2 3.7 3.7 2.8 5 3.5Z";

// Jarak antar segitiga pada ikon (satuan viewBox)
export const SKIP_STEP = 20;

// Membatasi nilai opacity 0..1
const unit = (v: number) => Math.min(1, Math.max(0, v));

export const SkipGlyph: React.FC<{
  direction: "next" | "prev";
  /** 0..1 */
  progress: MotionValue<number>;
  width?: number;
  height?: number;
}> = ({ direction, progress, width = 32, height = 28 }) => {
  // Segitiga baru: masuk dari belakang lalu muncul perlahan
  const xIn = useTransform(progress, (f) => (f - 1) * SKIP_STEP);
  const opIn = useTransform(progress, (f) => unit(f * 1.25));

  // Segitiga tengah: bergeser maju mengisi posisi berikutnya
  const xMid = useTransform(progress, (f) => f * SKIP_STEP);

  // Segitiga depan: keluar ke depan lalu menghilang
  const xOut = useTransform(progress, (f) => (f + 1) * SKIP_STEP);
  const opOut = useTransform(progress, (f) => unit(1 - f * 1.25));

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 48 32"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      style={{ overflow: "visible" }}
      aria-hidden="true"
    >
      {/* Untuk prev, seluruh ikon dicerminkan secara horizontal */}
      <g
        transform={
          direction === "prev" ? "translate(48 0) scale(-1 1)" : undefined
        }
      >
        <motion.g style={{ x: xIn, opacity: opIn }}>
          <path d={SKIP_TRIANGLE} />
        </motion.g>

        <motion.g style={{ x: xMid }}>
          <path d={SKIP_TRIANGLE} />
        </motion.g>

        <motion.g style={{ x: xOut, opacity: opOut }}>
          <path d={SKIP_TRIANGLE} />
        </motion.g>
      </g>
    </svg>
  );
};
