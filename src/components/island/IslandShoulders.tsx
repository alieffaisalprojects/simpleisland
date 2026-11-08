/**
 * IslandShoulders.tsx
 * "Bahu" kiri dan kanan pada gaya notch (seperti notch MacBook): lengkung cekung di
 * pertemuan tepi atas layar dan sisi island, jadi island terlihat menyatu dengan layar.
 *
 * Pakai sebagai anak dari bentuk hitam island (elemen yang `position: absolute`):
 * bahu digambar DI LUAR sisi kiri / kanan bentuk itu, tepat di tepi atas.
 *
 * Cara kerja: kotak size x size dengan radial-gradient. Titik pusat lingkaran ada di
 * sudut bawah-luar kotak; bagian dalam lingkaran transparan, sisanya hitam.
 */

import React from "react";

export const ISLAND_COLOR = "#050506";

interface IslandShouldersProps {
  size: number; // lebar = tinggi bahu (px)
  color?: string;
}

export const IslandShoulders: React.FC<IslandShouldersProps> = ({
  size,
  color = ISLAND_COLOR,
}) => {
  if (size <= 0) return null;

  const make = (side: "left" | "right") => (
    <span
      key={side}
      aria-hidden
      className="pointer-events-none absolute"
      style={{
        top: 0,
        [side]: -size,
        // +1 px masuk ke dalam badan island, supaya tidak ada garis tipis di sambungan
        width: size + 1,
        height: size,
        background: `radial-gradient(circle at ${
          side === "left" ? "0 100%" : "100% 100%"
        }, transparent ${size - 0.6}px, ${color} ${size + 0.4}px)`,
      }}
    />
  );

  return (
    <>
      {make("left")}
      {make("right")}
    </>
  );
};

export default IslandShoulders;