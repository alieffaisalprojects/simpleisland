/**
 * svgMask.ts
 * Mengubah ikon SVG menu menjadi "cetakan" (mask) yang pasti terbaca.
 *
 * Masalah lama: ikon dipakai langsung sebagai CSS mask-image, yang hanya membaca
 * kanal alpha. SVG yang berisi kotak penuh dengan glyph putih, tanpa viewBox, atau
 * memakai currentColor jadi blok polos / kosong (hanya ikon sederhana seperti ico dan
 * webp yang lolos).
 *
 * Sekarang tiap SVG: dibaca -> dinormalkan (viewBox, ukuran, currentColor) -> digambar
 * ke canvas -> siluetnya dihitung (alpha, atau alpha x gelap-terang bila ikon memuat
 * warna gelap dan terang sekaligus) -> hasilnya PNG hitam transparan untuk mask.
 * Hasil di-cache per sumber.
 */

import { useEffect, useState } from "react";

const SIZE = 96;

const cache = new Map<string, Promise<string>>();

function normalize(text: string): string {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;

  if (
    !svg ||
    svg.nodeName.toLowerCase() !== "svg" ||
    doc.querySelector("parsererror")
  ) {
    return text;
  }

  const w = parseFloat(svg.getAttribute("width") ?? "");
  const h = parseFloat(svg.getAttribute("height") ?? "");

  if (!svg.getAttribute("viewBox") && w > 0 && h > 0) {
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  if (!svg.getAttribute("xmlns")) {
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  }

  svg.setAttribute("width", String(SIZE));
  svg.setAttribute("height", String(SIZE));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  return new XMLSerializer()
    .serializeToString(svg)
    .replace(/currentColor/gi, "#000000");
}

const toDataUrl = (svg: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  return img;
}

async function build(src: string): Promise<string> {
  let img: HTMLImageElement;

  try {
    const text = await (await fetch(src)).text();
    img = await loadImage(toDataUrl(normalize(text)));
  } catch {
    // fetch diblokir / SVG rusak: coba langsung dari sumber asli
    img = await loadImage(src);
  }

  const cv = document.createElement("canvas");
  cv.width = SIZE;
  cv.height = SIZE;

  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  const data = ctx.getImageData(0, 0, SIZE, SIZE);
  const px = data.data;
  const total = SIZE * SIZE;

  let dark = 0;
  let light = 0;

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 204) continue;

    const lum =
      (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

    if (lum < 0.4) dark += 1;
    else if (lum > 0.6) light += 1;
  }

  // gelap dan terang sama-sama ada (mis. kotak gelap + huruf putih): terang = lubang
  const luma = dark > total * 0.02 && light > total * 0.02;

  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255;
    const lum =
      (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;

    px[i] = 0;
    px[i + 1] = 0;
    px[i + 2] = 0;
    px[i + 3] = Math.round(255 * (luma ? a * (1 - lum) : a));
  }

  ctx.putImageData(data, 0, 0);
  return cv.toDataURL("image/png");
}

export function svgMask(src: string): Promise<string> {
  let p = cache.get(src);

  if (!p) {
    p = build(src).catch((e) => {
      console.error("Gagal membaca ikon SVG:", e);
      return src;
    });
    cache.set(src, p);
  }

  return p;
}

// URL mask siap pakai untuk `src` (null selama masih diproses)
export function useSvgMask(src?: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setUrl(null);
      return;
    }

    let dead = false;

    void svgMask(src).then((u) => {
      if (!dead) setUrl(u);
    });

    return () => {
      dead = true;
    };
  }, [src]);

  return url;
}
