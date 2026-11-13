/**
 * File: PrayerUi.tsx
 * Kegunaan: Tampilan jadwal salat bergaya aplikasi cuaca, latar hitam solid.
 *  - Latar selalu hitam pekat. Warna aksen (progress, kartu berikutnya, titik status)
 *    berganti halus mengikuti waktu salat: Subuh, Terbit, Dzuhur, Ashar, Maghrib, Isya.
 *  - Lima waktu salat ditampilkan di lengkung simetris bertitik; matahari berjalan di
 *    lengkung itu sesuai jam (bulan menggantikannya saat malam).
 *  - Matahari dan bulan di latar juga berjalan mengikuti waktu sebenarnya (terbit -> Maghrib, Maghrib -> terbit).
 *  - Bulan memakai fase asli hari ini; bintang berkedip dan sesekali ada bintang jatuh.
 *  - Saat hujan: awan tipis, tetesan air jatuh, dan tetesan yang mengenai huruf/angka
 *    akan memercik, menempel, lalu menetes lagi dari bagian bawah huruf.
 *  - Suhu (°C) ditampilkan di paling kanan setelah jam.
 * Data cuaca: useWeather.ts. Jadwal salat: prayer.ts (sama seperti sebelumnya).
 */

import React, { useEffect, useMemo, useRef } from "react";
import { Loader2, MapPin, Moon } from "lucide-react";
import {
  FIVE,
  PRAYER_LABEL,
  PrayerState,
  PrayerTimes,
  SkyPhase,
  civilIn,
  fmtTime,
} from "./prayer";
import { RainLevel, useWeather } from "./useWeather";

// ---------------------------------------------------------------------------
// Saklar uji coba (biarkan null / 1 untuk perilaku normal).
// ---------------------------------------------------------------------------

/** Paksa fase langit, mis. "dusk" atau "night". */
export const FORCE_PHASE = null as SkyPhase | null;
/** Paksa hujan: 0 tidak hujan, 1 ringan, 2 sedang, 3 lebat/badai. */
export const FORCE_RAIN = null as RainLevel | null;
/** Percepat waktu untuk melihat matahari bergerak. 1 = waktu nyata, 600 = 10 menit per detik. */
export const TIME_SPEED = 1;

// ---------------------------------------------------------------------------
// Utilitas kecil.
// ---------------------------------------------------------------------------

const ring =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70";

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

const shortDateIn = (d: Date, tz: string) => {
  const c = civilIn(d, tz);
  const weekday = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  return `${DAYS[weekday]}, ${c.d} ${MONTHS[c.m - 1]}`;
};

function countdown(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `dalam ${h} j ${m} mnt` : `dalam ${m} mnt`;
}

function conditionLabel(
  code: number | null,
  rain: RainLevel,
  thunder: boolean,
): string {
  if (rain === 3) return thunder ? "Badai petir" : "Hujan lebat";
  if (rain === 2) return "Hujan sedang";
  if (rain === 1) {
    return code !== null && code >= 51 && code <= 57
      ? "Gerimis"
      : "Hujan ringan";
  }
  switch (code) {
    case null:
      return "";
    case 0:
      return "Cerah";
    case 1:
      return "Cerah berawan";
    case 2:
      return "Berawan sebagian";
    case 3:
      return "Mendung";
    case 45:
    case 48:
      return "Berkabut";
    default:
      return "Berawan";
  }
}

type RGB = [number, number, number];

const rgb = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mixRGB = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
const css = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------
// Warna aksen sepanjang hari (diinterpolasi mulus antar waktu salat).
// Latar tetap hitam; hanya aksen kecil yang berubah.
// ---------------------------------------------------------------------------

interface Stop {
  t: number;
  accent: RGB;
  /** Seberapa terlihat bintang (0..1). */
  star: number;
}

const NIGHT_ACCENT = rgb("#7c8cff");

function accentStops(d: PrayerTimes): Stop[] {
  const m = 60000;
  const f = d.fajr.getTime();
  const s = d.sunrise.getTime();
  const z = d.dhuhr.getTime();
  const a = d.asr.getTime();
  const g = d.maghrib.getTime();
  const i = d.isha.getTime();
  return [
    { t: f - 90 * m, accent: NIGHT_ACCENT, star: 1 },
    { t: f, accent: rgb("#8f9dff"), star: 0.9 },
    { t: s, accent: rgb("#ff9f6b"), star: 0.08 },
    { t: s + 70 * m, accent: rgb("#ffd36b"), star: 0 },
    { t: z, accent: rgb("#5ec2ff"), star: 0 },
    { t: a, accent: rgb("#ffc24d"), star: 0 },
    { t: g - 35 * m, accent: rgb("#ffa24d"), star: 0 },
    { t: g, accent: rgb("#ff6f5e"), star: 0.15 },
    { t: i, accent: rgb("#a58bff"), star: 0.8 },
    { t: i + 90 * m, accent: NIGHT_ACCENT, star: 1 },
  ].sort((x, y) => x.t - y.t);
}

function sampleStops(stops: Stop[], t: number): { accent: RGB; star: number } {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.t) return first;
  if (t >= last.t) return last;
  for (let k = 0; k < stops.length - 1; k++) {
    const a = stops[k];
    const b = stops[k + 1];
    if (t < b.t) {
      const u = (t - a.t) / (b.t - a.t);
      const e = u * u * (3 - 2 * u);
      return {
        accent: mixRGB(a.accent, b.accent, e),
        star: a.star + (b.star - a.star) * e,
      };
    }
  }
  return last;
}

const phaseTime = (phase: SkyPhase, d: PrayerTimes): number => {
  const f = d.fajr.getTime();
  const s = d.sunrise.getTime();
  const z = d.dhuhr.getTime();
  const a = d.asr.getTime();
  const g = d.maghrib.getTime();
  const i = d.isha.getTime();
  const mid = (x: number, y: number) => (x + y) / 2;
  switch (phase) {
    case "night":
      return i + 3 * 3600e3;
    case "dawn":
      return mid(f, s);
    case "morning":
      return mid(s, z);
    case "noon":
      return mid(z, a);
    case "afternoon":
      return mid(a, g);
    case "dusk":
      return mid(g, i);
  }
};

// ---------------------------------------------------------------------------
// Bulan (fase asli) digambar sekali ke sprite lalu dipakai ulang.
// ---------------------------------------------------------------------------

const SYNODIC = 29.530588853;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14);

const moonPhase = (t: number): number => {
  const days = (t - NEW_MOON_REF) / 86400000;
  return (((days % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC;
};

const moonCache = new Map<number, HTMLCanvasElement>();

function moonSprite(phase: number): HTMLCanvasElement {
  const key = Math.round(phase * 60);
  const hit = moonCache.get(key);
  if (hit) return hit;

  const S = 44;
  const c = S / 2;
  const r = 10;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const g = cv.getContext("2d");
  if (!g) return cv;

  // Sisi gelap bulan.
  g.fillStyle = "rgba(210,215,255,0.16)";
  g.beginPath();
  g.arc(c, c, r, 0, Math.PI * 2);
  g.fill();

  // Sisi terang: setengah lingkaran + garis terminator berbentuk elips.
  const p = key / 60;
  const waxing = p < 0.5;
  const k = Math.cos(p * 2 * Math.PI); // 1 = bulan baru, -1 = purnama
  const rx = Math.abs(k) * r;
  const side = waxing ? 1 : -1;
  const bulge = k > 0 ? side : -side;

  g.beginPath();
  g.arc(c, c, r, -Math.PI / 2, Math.PI / 2, side < 0);
  g.ellipse(
    c,
    c,
    Math.max(0.01, rx),
    r,
    0,
    Math.PI / 2,
    -Math.PI / 2,
    bulge > 0,
  );
  g.closePath();
  const fill = g.createLinearGradient(c - r, c - r, c + r, c + r);
  fill.addColorStop(0, "#fbfaff");
  fill.addColorStop(1, "#d9d9f2");
  g.fillStyle = fill;
  g.fill();

  moonCache.set(key, cv);
  return cv;
}

// ---------------------------------------------------------------------------
// Simulasi latar (bintang, matahari/bulan, awan, hujan).
// ---------------------------------------------------------------------------

interface SimInput {
  today: PrayerTimes;
  rain: RainLevel;
  thunder: boolean;
  cloud: number;
  forced: SkyPhase | null;
}

/** Permukaan huruf/angka tempat tetesan air bisa mendarat. */
interface Surface {
  x0: number;
  x1: number;
  top: number;
  base: number;
  /** Kotak/border (kartu, pill) yang memantulkan air lebih keras dari huruf. */
  hard?: boolean;
}

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  front: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
}

/** Air yang menempel di huruf, merayap turun, lalu menetes. */
interface Bead {
  x: number;
  top: number;
  base: number;
  life: number;
  max: number;
  r: number;
}

/** Sambaran petir: garis utama bergerigi + cabang. */
interface Bolt {
  main: [number, number][];
  branches: [number, number][][];
  life: number;
}

const BOLT_TIME = 0.55;

/** Kecerlangan petir: menyambar, redup sesaat, menyambar lagi, lalu padam. */
const boltAlpha = (t: number): number =>
  t < 0.07
    ? 1
    : t < 0.13
      ? 0.25
      : t < 0.22
        ? 0.95
        : Math.max(0, 1 - (t - 0.22) / (BOLT_TIME - 0.22));

function makeBolt(W: number, H: number): Bolt {
  const walk = (
    x: number,
    y: number,
    endY: number,
    spread: number,
    drift: number,
  ): [number, number][] => {
    const pts: [number, number][] = [[x, y]];
    while (y < endY) {
      y = Math.min(endY, y + rand(5, 11));
      x += rand(-spread, spread) + drift;
      pts.push([x, y]);
    }
    return pts;
  };

  const main = walk(W * rand(0.12, 0.88), -4, H * rand(0.7, 1), 9, 0);
  const branches: [number, number][][] = [];
  if (main.length > 6) {
    const n = Math.random() < 0.6 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const at = main[Math.floor(rand(2, main.length - 3))];
      branches.push(
        walk(
          at[0],
          at[1],
          at[1] + H * rand(0.2, 0.4),
          7,
          (Math.random() < 0.5 ? -1 : 1) * rand(2, 4),
        ),
      );
    }
  }
  return { main, branches, life: 0 };
}

const RATE = [0, 30, 70, 130]; // tetes per detik (lebar 400 px)
const RAIN_DIM = [0, 0.5, 0.75, 0.92];
const RAIN_COVER = [0, 0.55, 0.75, 0.9];
const WIND = 36;
const GRAVITY = 900;

const SUN_LOW = rgb("#ff8a4c");
const SUN_HIGH = rgb("#fff2b8");

/** Awan di atas hitam: abu kebiruan tipis, lebih gelap saat hujan. */
const CLOUD_CALM = rgb("#a8b2cd");
const CLOUD_CALM_NIGHT = rgb("#6c78a6");
const CLOUD_RAIN = rgb("#7d879f");
const CLOUD_RAIN_NIGHT = rgb("#505a80");

const CLOUD_BLOBS: [number, number, number][] = [
  [-0.95, 0.15, 0.6],
  [-0.35, -0.2, 0.8],
  [0.35, -0.1, 0.75],
  [1.0, 0.2, 0.55],
];

const GLYPH_TALL = /[A-Z0-9bdfhijklt]/;
const GLYPH = /[A-Za-z0-9]/;

// ---------------------------------------------------------------------------
// Lengkung simetris lima waktu salat + posisi matahari sesuai jam.
// ---------------------------------------------------------------------------

const ARC_W = 224;
const ARC_H = 46;
const ARC_BASE = 42;
const ARC_PEAK = 30;

/** Titik tengah kolom ke-p (0 = Subuh ... 4 = Isya); p boleh pecahan. */
const colX = (p: number) => ((p + 0.5) * ARC_W) / 5;

/** Tinggi lengkung (parabola simetris) pada posisi x. */
const arcY = (x: number) => {
  const c = ARC_W / 2;
  const k = (x - c) / c;
  return ARC_BASE - ARC_PEAK * (1 - k * k);
};

/** Garis lengkung dari x0 ke x1 (untuk titik-titik putus). */
const arcPath = (x0: number, x1: number) => {
  if (x1 <= x0) return "";
  let d = `M${x0.toFixed(1)} ${arcY(x0).toFixed(1)}`;
  for (let x = x0 + 2; x < x1; x += 2) {
    d += `L${x.toFixed(1)} ${arcY(x).toFixed(1)}`;
  }
  return `${d}L${x1.toFixed(1)} ${arcY(x1).toFixed(1)}`;
};

/**
 * Posisi matahari di lengkung: 0 = Subuh ... 4 = Isya, dihitung linear
 * di antara dua waktu salat. Sebelum Subuh dan sesudah Isya = malam.
 */
function arcProgress(
  t: number,
  times: number[],
): { p: number; night: boolean } {
  const last = times.length - 1;
  if (t < times[0]) return { p: 0, night: true };
  if (t >= times[last]) return { p: last, night: true };
  for (let i = 0; i < last; i++) {
    if (t < times[i + 1]) {
      return {
        p: i + (t - times[i]) / (times[i + 1] - times[i]),
        night: false,
      };
    }
  }
  return { p: last, night: true };
}

interface PrayerViewProps {
  now: Date;
  prayer: PrayerState;
  tz: string;
  city: string;
  lat: number;
  lng: number;
  locating: boolean;
  estimate: boolean;
  stale: boolean;
  onLocation: () => void;
  onBack?: () => void;
}

export const PrayerView: React.FC<PrayerViewProps> = ({
  now,
  prayer,
  tz,
  city,
  lat,
  lng,
  locating,
  estimate,
  stale,
  onLocation,
}) => {
  const { today, next, prev } = prayer;
  const nowT = now.getTime();

  const weather = useWeather(lat, lng);
  const rain: RainLevel = FORCE_RAIN ?? weather.rain;
  const thunder = FORCE_RAIN !== null ? FORCE_RAIN >= 3 : weather.thunder;
  const cloud = FORCE_RAIN !== null && FORCE_RAIN > 0 ? 0.8 : weather.cloud;

  const progress = clamp01(
    (nowT - prev.time.getTime()) / (next.time.getTime() - prev.time.getTime()),
  );
  const tempText =
    weather.temp === null ? "--°C" : `${Math.round(weather.temp)}°C`;
  const label = conditionLabel(weather.code, rain, thunder);

  // Waktu simulasi (nyata kecuali diuji) untuk aksen dan matahari di lengkung.
  const startRef = useRef(nowT);
  const tSim = FORCE_PHASE
    ? phaseTime(FORCE_PHASE, today)
    : startRef.current + (nowT - startRef.current) * TIME_SPEED;

  // Warna aksen saat ini (mengikuti waktu salat).
  const fajrKey = today.fajr.getTime();
  const stops = useMemo(() => accentStops(today), [fajrKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const accent = sampleStops(stops, tSim).accent;
  const accentSolid = css(accent);
  const accentRing = css(accent, 0.75);

  // Matahari berjalan di lengkung sesuai jam.
  const times = FIVE.map((k) => today[k].getTime());
  const arc = arcProgress(tSim, times);
  const sunX = colX(arc.p);
  const sunY = arcY(sunX);
  const sunCol = mixRGB(
    SUN_LOW,
    SUN_HIGH,
    clamp01(Math.sin((Math.PI * arc.p) / 4) * 1.8),
  );
  const trailEnd = arc.night ? (arc.p === 0 ? 0 : ARC_W) : sunX;

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const simRef = useRef<SimInput>({
    today,
    rain,
    thunder,
    cloud,
    forced: FORCE_PHASE,
  });
  simRef.current = { today, rain, thunder, cloud, forced: FORCE_PHASE };

  useEffect(() => {
    const root = rootRef.current;
    const back = backRef.current;
    const front = frontRef.current;
    const content = contentRef.current;
    if (!root || !back || !front || !content) return;
    const bctx = back.getContext("2d");
    const fctx = front.getContext("2d");
    if (!bctx || !fctx) return;

    let W = 0;
    let H = 0;
    const setup = (cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(W * dpr));
      cv.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const resize = () => {
      W = root.clientWidth;
      H = root.clientHeight;
      setup(back, bctx);
      setup(front, fctx);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(root);
    resize();

    // --- Isi awal ---
    const stars = Array.from({ length: 55 }, () => ({
      x: Math.random(),
      y: Math.random() * 0.8,
      r: rand(0.5, 1.4),
      sp: rand(0.8, 3.2),
      ph: rand(0, 6.28),
      big: Math.random() < 0.18,
    }));
    const clouds = Array.from({ length: 7 }, (_, i) => ({
      x: i / 7 + rand(-0.05, 0.05),
      y: rand(0.04, 0.55),
      s: rand(0.7, 1.5),
      v: rand(3, 9),
      a: rand(0.55, 1),
    }));
    const drops: Drop[] = [];
    const parts: Particle[] = [];
    const beads: Bead[] = [];
    let surfaces: Surface[] = [];
    let shoot: {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
    } | null = null;
    let nextShoot = rand(4, 10);
    let bolt: Bolt | null = null;
    let nextFlash = rand(3, 8);
    let spawnAcc = 0;
    let starPrev = 0;
    let stopsKey = 0;
    let simStops: Stop[] = [];
    const t0 = Date.now();

    // --- Pindai posisi huruf/angka di tampilan ---
    const range = document.createRange();
    const scan = () => {
      const cr = root.getBoundingClientRect();
      const k = root.offsetWidth ? cr.width / root.offsetWidth : 1;
      const out: Surface[] = [];
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.nodeValue ?? "";
        const el = n.parentElement;
        if (!el || !text.trim()) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize) || 12;
        const pr = el.getBoundingClientRect();
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (!GLYPH.test(ch)) continue;
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const r = range.getBoundingClientRect();
          if (r.width === 0) continue;
          // Lewati huruf yang terpotong (ellipsis).
          if (r.right > pr.right + 1 || r.left < pr.left - 1) continue;
          const base = (r.top + r.height * 0.79 - cr.top) / k;
          const cap = GLYPH_TALL.test(ch) ? 0.72 : 0.52;
          out.push({
            x0: (r.left - cr.left) / k + 0.5,
            x1: (r.right - cr.left) / k - 0.5,
            top: base - cap * fs,
            base,
          });
        }
      }

      // Kotak bertanda data-rain-box (kartu, pill, border) juga jadi permukaan.
      const boxes = content.querySelectorAll<HTMLElement>("[data-rain-box]");
      boxes.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
        // Bagian atas yang rata dimulai setelah lengkungan sudut.
        const inset = Math.min(rad * 0.6, r.width / 3);
        out.push({
          x0: (r.left - cr.left) / k + inset,
          x1: (r.right - cr.left) / k - inset,
          top: (r.top - cr.top) / k,
          base: (r.bottom - cr.top) / k,
          hard: true,
        });
      });

      surfaces = out;
    };
    const firstScan = requestAnimationFrame(scan);
    const scanTimer = window.setInterval(scan, 350);

    // --- Efek ---
    const splash = (x: number, y: number, vy: number, heavy: boolean) => {
      if (parts.length > 160) return;
      const n = 3 + (Math.random() < 0.5 ? 1 : 0) + (heavy ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const ang = -Math.PI * rand(0.15, 0.85);
        const sp = rand(45, 125);
        parts.push({
          x,
          y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp * (0.7 + vy / 900),
          life: 0,
          max: rand(0.28, 0.52),
          r: rand(0.6, 1.3),
        });
      }
    };

    const spawnDrop = () => {
      const isFront = Math.random() < 0.45;
      const vy = isFront ? rand(260, 380) : rand(200, 300);
      const wind = simRef.current.thunder ? WIND * 1.6 : WIND;
      drops.push({
        x: rand(-0.15 * W, W),
        y: -rand(8, 30),
        vx: wind * (isFront ? 1 : 0.9),
        vy,
        front: isFront,
      });
    };

    const drawSun = (
      x: number,
      y: number,
      alt: number,
      vis: number,
      clock: number,
    ) => {
      const col = mixRGB(SUN_LOW, SUN_HIGH, clamp01(alt * 1.8));
      const pulse = 0.9 + 0.1 * Math.sin(clock * 1.7);

      const halo = bctx.createRadialGradient(x, y, 0, x, y, 70);
      halo.addColorStop(0, css(col, 0.3 * vis * pulse));
      halo.addColorStop(1, css(col, 0));
      bctx.fillStyle = halo;
      bctx.beginPath();
      bctx.arc(x, y, 70, 0, Math.PI * 2);
      bctx.fill();

      const glow = bctx.createRadialGradient(x, y, 0, x, y, 26);
      glow.addColorStop(0, css(col, 0.6 * vis));
      glow.addColorStop(1, css(col, 0));
      bctx.fillStyle = glow;
      bctx.beginPath();
      bctx.arc(x, y, 26, 0, Math.PI * 2);
      bctx.fill();

      bctx.save();
      bctx.translate(x, y);
      bctx.rotate(clock * 0.12);
      bctx.lineCap = "round";
      bctx.lineWidth = 1.4;
      for (let i = 0; i < 12; i++) {
        const a = (i * Math.PI) / 6;
        const len = 15 + 3 * Math.sin(clock * 1.3 + i * 2);
        bctx.strokeStyle = css(
          col,
          0.5 * vis * (0.6 + 0.4 * Math.sin(clock * 2 + i)),
        );
        bctx.beginPath();
        bctx.moveTo(Math.cos(a) * 11, Math.sin(a) * 11);
        bctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        bctx.stroke();
      }
      bctx.restore();

      bctx.fillStyle = css(col, vis);
      bctx.beginPath();
      bctx.arc(x, y, 7.4, 0, Math.PI * 2);
      bctx.fill();
    };

    // --- Loop utama ---
    let raf = 0;
    let last = performance.now();

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      const s = simRef.current;

      const busy =
        s.rain > 0 ||
        drops.length > 0 ||
        parts.length > 0 ||
        beads.length > 0 ||
        starPrev > 0.02 ||
        shoot !== null ||
        bolt !== null;
      const elapsed = ts - last;
      if (!busy && elapsed < 66) return; // hemat daya saat siang cerah
      last = ts;
      const dt = Math.min(0.05, elapsed / 1000);
      const clock = ts / 1000;
      if (W === 0 || H === 0) return;

      // Waktu simulasi (nyata kecuali diuji).
      const t = s.forced
        ? phaseTime(s.forced, s.today)
        : t0 + (Date.now() - t0) * TIME_SPEED;

      // Tingkat bintang mengikuti waktu.
      const key = s.today.fajr.getTime();
      if (key !== stopsKey) {
        stopsKey = key;
        simStops = accentStops(s.today);
      }
      const smp = sampleStops(simStops, t);

      const dim = s.rain > 0 ? RAIN_DIM[s.rain] : s.cloud * 0.45;
      const vis = 1 - 0.9 * dim;
      const starLvl = smp.star;
      starPrev = starLvl * (1 - dim);

      bctx.clearRect(0, 0, W, H);

      // Bintang berkedip.
      if (starLvl > 0.02) {
        const base = starLvl * (1 - dim * 0.9);
        for (const st of stars) {
          const tw = 0.5 + 0.5 * Math.sin(clock * st.sp + st.ph);
          const a = base * (0.2 + 0.8 * tw);
          if (a < 0.02) continue;
          const x = st.x * W;
          const y = st.y * H;
          bctx.fillStyle = `rgba(255,250,235,${a})`;
          bctx.beginPath();
          bctx.arc(x, y, st.r * (0.85 + 0.3 * tw), 0, Math.PI * 2);
          bctx.fill();
          if (st.big) {
            const len = 2.5 + 3.5 * tw;
            bctx.strokeStyle = `rgba(255,250,235,${a * 0.8})`;
            bctx.lineWidth = 0.6;
            bctx.beginPath();
            bctx.moveTo(x - len, y);
            bctx.lineTo(x + len, y);
            bctx.moveTo(x, y - len);
            bctx.lineTo(x, y + len);
            bctx.stroke();
          }
        }

        // Bintang jatuh sesekali.
        if (!shoot && starLvl > 0.6 && dim < 0.3 && clock > nextShoot) {
          shoot = {
            x: W * rand(0.35, 0.95),
            y: H * rand(0.05, 0.35),
            vx: -rand(200, 280),
            vy: rand(90, 140),
            life: 0,
          };
        }
      }
      if (shoot) {
        shoot.life += dt;
        shoot.x += shoot.vx * dt;
        shoot.y += shoot.vy * dt;
        const fade = 1 - shoot.life / 0.8;
        if (fade <= 0) {
          shoot = null;
          nextShoot = clock + rand(8, 22);
        } else {
          const tx = shoot.x - shoot.vx * 0.12;
          const ty = shoot.y - shoot.vy * 0.12;
          const gr = bctx.createLinearGradient(shoot.x, shoot.y, tx, ty);
          gr.addColorStop(0, `rgba(255,255,255,${0.9 * fade})`);
          gr.addColorStop(1, "rgba(255,255,255,0)");
          bctx.strokeStyle = gr;
          bctx.lineWidth = 1.3;
          bctx.lineCap = "round";
          bctx.beginPath();
          bctx.moveTo(shoot.x, shoot.y);
          bctx.lineTo(tx, ty);
          bctx.stroke();
        }
      }

      const sr = s.today.sunrise.getTime();
      const ss = s.today.maghrib.getTime();
      const DAY = 86400000;

      // Matahari: terbit -> Maghrib mengikuti waktu sebenarnya.
      const u = (t - sr) / (ss - sr);
      if (u > -0.15 && u < 1.15) {
        const x = W * (0.06 + 0.88 * u);
        const alt = Math.sin(Math.PI * u);
        const y = H * 1.02 - alt * H * 0.86;
        if (y < H + 40) drawSun(x, y, alt, vis, clock);
      }

      // Bulan: Maghrib -> terbit berikutnya, dengan fase asli.
      let ms: number | null = null;
      if (t >= ss) ms = (t - ss) / (sr + DAY - ss);
      else if (t < sr) ms = (t - (ss - DAY)) / (sr - (ss - DAY));
      if (ms !== null && ms > -0.05 && ms < 1.05) {
        const x = W * (0.06 + 0.88 * ms);
        const alt = Math.sin(Math.PI * clamp01(ms));
        const y = H * 1.02 - alt * H * 0.8;
        const aura = bctx.createRadialGradient(x, y, 0, x, y, 40);
        aura.addColorStop(0, `rgba(205,215,255,${0.2 * vis})`);
        aura.addColorStop(1, "rgba(205,215,255,0)");
        bctx.fillStyle = aura;
        bctx.beginPath();
        bctx.arc(x, y, 40, 0, Math.PI * 2);
        bctx.fill();
        bctx.globalAlpha = vis;
        bctx.drawImage(moonSprite(moonPhase(t)), x - 22, y - 22);
        bctx.globalAlpha = 1;
      }

      // Awan melayang (tipis di atas latar hitam).
      const cover = s.rain > 0 ? RAIN_COVER[s.rain] : s.cloud * 0.6;
      if (cover > 0.03) {
        const rainMix = s.rain > 0 ? Math.min(1, 0.5 + 0.2 * s.rain) : 0;
        const col = mixRGB(
          mixRGB(CLOUD_CALM, CLOUD_CALM_NIGHT, starLvl),
          mixRGB(CLOUD_RAIN, CLOUD_RAIN_NIGHT, starLvl),
          rainMix,
        );
        const span = W * 1.5;
        for (const c of clouds) {
          const cx =
            ((((c.x * span + clock * c.v) % span) + span) % span) - W * 0.25;
          const cy = c.y * H;
          const unit = 26 * c.s;
          const alpha = cover * c.a * 0.2;
          for (const [bx, by, br] of CLOUD_BLOBS) {
            const px = cx + bx * unit;
            const py = cy + by * unit;
            const rr = br * unit * 1.4;
            const g = bctx.createRadialGradient(px, py, 0, px, py, rr);
            g.addColorStop(0, css(col, alpha));
            g.addColorStop(1, css(col, 0));
            bctx.fillStyle = g;
            bctx.beginPath();
            bctx.arc(px, py, rr, 0, Math.PI * 2);
            bctx.fill();
          }
        }
      }

      // --- Hujan ---
      fctx.clearRect(0, 0, W, H);

      if (s.rain > 0) {
        spawnAcc += RATE[s.rain] * (W / 400) * dt;
        while (spawnAcc >= 1) {
          spawnAcc -= 1;
          if (drops.length < 260) spawnDrop();
        }
      } else {
        spawnAcc = 0;
      }

      // Petir.
      if (s.thunder && s.rain > 0 && !bolt && clock > nextFlash) {
        bolt = makeBolt(W, H);
        nextFlash = clock + rand(4, 10);
      }
      if (bolt) {
        bolt.life += dt;
        if (bolt.life >= BOLT_TIME) {
          bolt = null;
        } else {
          const a = boltAlpha(bolt.life);

          // Langit hitam ikut berpendar sesaat.
          bctx.fillStyle = `rgba(225,232,255,${a * 0.1})`;
          bctx.fillRect(0, 0, W, H);

          bctx.lineCap = "round";
          bctx.lineJoin = "round";
          for (const path of [bolt.main, ...bolt.branches]) {
            const thin = path !== bolt.main;
            bctx.beginPath();
            bctx.moveTo(path[0][0], path[0][1]);
            for (let i = 1; i < path.length; i++) {
              bctx.lineTo(path[i][0], path[i][1]);
            }
            bctx.strokeStyle = `rgba(160,190,255,${0.35 * a})`;
            bctx.lineWidth = thin ? 3 : 6;
            bctx.stroke();
            bctx.strokeStyle = `rgba(255,255,255,${a})`;
            bctx.lineWidth = thin ? 0.9 : 1.7;
            bctx.stroke();
          }
        }
      }

      const heavy = s.rain >= 3;
      const backPath = new Path2D();
      const frontPath = new Path2D();

      for (let i = drops.length - 1; i >= 0; i--) {
        const d = drops[i];
        const px = d.x;
        const py = d.y;
        d.vy = Math.min(d.vy + GRAVITY * dt, d.front ? 640 : 520);
        d.x += d.vx * dt;
        d.y += d.vy * dt;

        let gone = d.y > H + 12 || d.x > W + 20;

        if (d.front && !gone) {
          // Cari huruf/angka pertama yang dilintasi tetesan.
          let best: Surface | null = null;
          let bestT = 2;
          let bestX = 0;
          for (const sf of surfaces) {
            if (py <= sf.top && d.y > sf.top) {
              const tt = (sf.top - py) / (d.y - py);
              const hx = px + (d.x - px) * tt;
              if (hx >= sf.x0 && hx <= sf.x1 && tt < bestT) {
                bestT = tt;
                best = sf;
                bestX = hx;
              }
            }
          }
          if (best) {
            splash(bestX, best.top, d.vy * (best.hard ? 1.6 : 1), heavy);
            if (beads.length < 70 && Math.random() < 0.55) {
              beads.push({
                x: bestX,
                top: best.top,
                base: best.base,
                life: 0,
                max: rand(0.9, 1.7),
                r: rand(0.9, 1.5),
              });
            }
            gone = true;
          }
        }

        if (gone) {
          drops[i] = drops[drops.length - 1];
          drops.pop();
          continue;
        }

        const tail = d.front ? 0.022 : 0.02;
        const path = d.front ? frontPath : backPath;
        path.moveTo(d.x, d.y);
        path.lineTo(d.x - d.vx * tail, d.y - d.vy * tail);
      }

      // Tetesan latar belakang (tidak mengenai teks).
      bctx.lineCap = "round";
      bctx.lineWidth = 0.8;
      bctx.strokeStyle = "rgba(190,215,250,0.24)";
      bctx.stroke(backPath);

      // Tetesan depan.
      fctx.lineCap = "round";
      fctx.lineWidth = 1.2;
      fctx.strokeStyle = "rgba(215,235,255,0.8)";
      fctx.stroke(frontPath);

      // Percikan.
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        if (p.life >= p.max) {
          parts[i] = parts[parts.length - 1];
          parts.pop();
          continue;
        }
        p.vy += 520 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const a = 1 - p.life / p.max;
        fctx.fillStyle = `rgba(220,238,255,${0.85 * a})`;
        fctx.beginPath();
        fctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        fctx.fill();
      }

      // Air yang menempel lalu merayap turun di huruf, kemudian menetes.
      for (let i = beads.length - 1; i >= 0; i--) {
        const b = beads[i];
        b.life += dt;
        const p = b.life / b.max;
        if (p >= 1) {
          drops.push({ x: b.x, y: b.base, vx: 0, vy: 40, front: true });
          beads[i] = beads[beads.length - 1];
          beads.pop();
          continue;
        }
        const grow = Math.min(1, b.life / 0.1);
        const r = b.r * (0.4 + 0.6 * grow);
        const y = b.top + (b.base - b.top) * Math.pow(p, 2.2) - r * 0.5;
        const fade = p > 0.9 ? (1 - p) / 0.1 : 1;
        fctx.fillStyle = `rgba(200,226,255,${0.6 * fade})`;
        fctx.beginPath();
        fctx.ellipse(b.x, y, r * 0.9, r * 1.15, 0, 0, Math.PI * 2);
        fctx.fill();
        fctx.fillStyle = `rgba(255,255,255,${0.85 * fade})`;
        fctx.beginPath();
        fctx.arc(b.x - r * 0.25, y - r * 0.35, r * 0.32, 0, Math.PI * 2);
        fctx.fill();
      }
    };

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(firstScan);
      window.clearInterval(scanTimer);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative h-full w-full overflow-hidden bg-black"
    >
      <canvas
        ref={backRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      <div
        ref={contentRef}
        className="relative z-10 flex h-full w-full flex-col gap-2 p-[18px] text-white"
      >
        {/* Baris atas: judul, tanggal, jam, suhu */}
        <div className="flex h-[26px] shrink-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-semibold tracking-tight">
              Jadwal Sholat
            </span>
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-[11px] text-white/45">
              {shortDateIn(now, tz)}
            </span>
            <span className="text-[13px] font-semibold tabular-nums">
              {fmtTime(now, tz)}
            </span>
            <div className="relative">
              <span
                data-rain-box
                className="block rounded-full bg-white/[0.1] px-2 py-[1px] text-[12px] font-semibold tabular-nums"
              >
                {tempText}
              </span>
              <div className="absolute right-0 top-full mt-1 flex items-center gap-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={onLocation}
                  title="Ubah lokasi"
                  className={`flex max-w-[130px] items-center gap-1 rounded-full text-[10.5px] text-white/60 transition-colors hover:text-white ${ring}`}
                >
                  {locating ? (
                    <Loader2 size={11} className="shrink-0 animate-spin" />
                  ) : (
                    <MapPin size={11} className="shrink-0" />
                  )}
                  <span className="truncate">
                    {city}
                    {estimate ? " · memuat" : stale ? " · lokasi lama" : ""}
                  </span>
                </button>
                {label && (
                  <span className="text-[10.5px] font-medium text-white/70">
                    {label}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Isi: salat berikutnya + lima waktu */}
        <div className="flex min-h-0 flex-1 items-stretch gap-[18px]">
          <div className="w-[124px] shrink-0 self-center">
            <div className="text-[10.5px] text-white/45">Berikutnya</div>
            <div className="mt-0.5 text-[26px] font-semibold leading-none tracking-tight">
              {PRAYER_LABEL[next.key]}
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
              <span
                className="text-[13px] font-semibold tabular-nums"
                style={{ color: accentSolid }}
              >
                {fmtTime(next.time, tz)}
              </span>
              <span className="text-[10.5px] text-white/45">
                {countdown(next.time.getTime() - nowT)}
              </span>
            </div>
            <div
              data-rain-box
              className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-white/[0.14]"
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${progress * 100}%`,
                  background: accentSolid,
                }}
              />
            </div>
          </div>

          <div className="flex w-[224px] shrink-0 flex-col justify-end">
            <div className="relative" style={{ width: ARC_W, height: ARC_H }}>
              <svg
                width={ARC_W}
                height={ARC_H}
                viewBox={`0 0 ${ARC_W} ${ARC_H}`}
                aria-hidden="true"
                className="absolute inset-0 overflow-visible"
              >
                <path
                  d={arcPath(0, ARC_W)}
                  fill="none"
                  stroke="rgba(255,255,255,0.28)"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeDasharray="0.01 5.5"
                />
                {trailEnd > 0 && (
                  <path
                    d={arcPath(0, trailEnd)}
                    fill="none"
                    stroke={accentSolid}
                    strokeOpacity={0.85}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeDasharray="0.01 5.5"
                  />
                )}
                {FIVE.map((key, i) => {
                  const x = colX(i);
                  const y = arcY(x);
                  const isNext = key === next.key;
                  const passed = times[i] <= tSim;
                  return (
                    <g key={key}>
                      {isNext && (
                        <circle
                          cx={x}
                          cy={y}
                          r={5}
                          fill="none"
                          stroke={accentRing}
                          strokeWidth={1.2}
                        />
                      )}
                      <circle
                        cx={x}
                        cy={y}
                        r={isNext ? 2.8 : 2.6}
                        fill={
                          isNext
                            ? accentSolid
                            : passed
                              ? "rgba(255,255,255,0.75)"
                              : "rgba(255,255,255,0.4)"
                        }
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Matahari (siang) atau bulan (malam) yang berjalan di lengkung. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 top-0 transition-transform duration-1000 ease-linear"
                style={{
                  width: 30,
                  height: 30,
                  transform: `translate(${sunX - 15}px, ${sunY - 15}px)`,
                }}
              >
                {arc.night ? (
                  <div
                    className="flex h-full w-full items-center justify-center"
                    style={{
                      background:
                        "radial-gradient(circle, rgba(205,215,255,0.28) 0%, rgba(205,215,255,0) 70%)",
                    }}
                  >
                    <Moon size={13} className="fill-[#e6e9ff] text-[#e6e9ff]" />
                  </div>
                ) : (
                  <div
                    className="relative h-full w-full"
                    style={{
                      background: `radial-gradient(circle, ${css(sunCol, 0.5)} 0%, ${css(sunCol, 0)} 70%)`,
                    }}
                  >
                    <span
                      className="absolute left-1/2 top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{
                        background: css(sunCol),
                        boxShadow: `0 0 0 2.5px ${css(sunCol, 0.28)}`,
                      }}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="mt-1 grid grid-cols-5">
              {FIVE.map((key, i) => {
                const isNext = key === next.key;
                const passed = times[i] <= tSim;
                return (
                  <div
                    key={key}
                    className="min-w-0 text-center"
                    style={{ opacity: passed && !isNext ? 0.5 : 1 }}
                  >
                    <div
                      className={`text-[9.5px] ${isNext ? "font-semibold text-white" : "text-white/55"}`}
                    >
                      {PRAYER_LABEL[key]}
                    </div>
                    <div
                      className={`text-[12px] tabular-nums ${isNext ? "font-semibold" : "font-medium text-white/75"}`}
                      style={isNext ? { color: accentSolid } : undefined}
                    >
                      {fmtTime(today[key], tz)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <canvas
        ref={frontRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20 h-full w-full"
      />
    </div>
  );
};

export default PrayerView;
