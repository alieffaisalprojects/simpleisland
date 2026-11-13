/**
 * FileRadialMenu.tsx
 * Menu radial yang muncul di dekat kursor saat file diseret (alternatif dari kotak-kotak).
 * Dipakai oleh RadialOverlay.tsx (jendela transparan layar penuh), bukan oleh island.
 *
 * Tampilan: cincin kaca transparan, irisan bersudut bulat dengan efek 3D
 * (gloss, bevel, bayangan), dan lingkaran tengah yang menampilkan nama aksi
 * yang sedang disorot, mis. "PNG".
 *
 * Dua tema (dipilih di Pengaturan > Umum):
 *   - "light": irisan putih (bawaan).
 *   - "dark" : irisan hitam solid, teks dan ikon putih.
 *
 * Maksimal 7 irisan per halaman. Bila aksi lebih dari 7, tiap halaman memuat 6 aksi
 * dan satu irisan "Lainnya" di kanan bawah untuk pindah ke halaman berikutnya:
 *   - tahan file di irisan itu sebentar (DWELL_MS), atau lepas / klik di sana.
 *   - di halaman terakhir irisan itu menjadi "Kembali" (ke halaman pertama).
 *
 * Isi irisan datang dari catalog.ts (buildActions), jadi menu convert, hapus, salin, dll.
 * sama dengan menu kotak-kotak. Logika drag / drop / klik ada di useFileIsland.ts:
 * hook itu menemukan irisan lewat atribut data-action-id, sama seperti kotak.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronLeft, Loader2, MoreHorizontal, X } from "lucide-react";
import { describeItems } from "./catalog";
import type { FileAction } from "./catalog";
import type { FileIsland } from "./useFileIsland";
import { useSvgMask } from "./svgMask";

// ukuran (px) — R_OUT + HALO harus sama dengan RADIUS_CSS di radial_overlay.rs
const HALO = 10; // cincin kaca di luar irisan
const R_OUT = 150; // radius luar irisan
const R_IN = 62; // radius dalam irisan
const BOX = (R_OUT + HALO) * 2; // lebar & tinggi seluruh lingkaran
const C = BOX / 2;
const R_MID = (R_OUT + R_IN) / 2;
const R_CENTER = R_IN - 8; // lingkaran tengah
const GAP = 6; // jarak antar irisan
const RC = 10; // kelengkungan sudut irisan
const ICON = 22;
const LIFT = 4; // irisan yang disorot terangkat keluar sekian px

// halaman
const MAX_SLOTS = 7;
const PER_PAGE = MAX_SLOTS - 1; // 6 aksi + 1 irisan "Lainnya"
const MORE_ID = "__more";
const DWELL_MS = 600; // tahan di "Lainnya" sekian ms = pindah halaman

// tema warna
export type RadialTheme = "light" | "dark";

interface Palette {
  // warna irisan (idle, lalu saat disorot)
  fill: {
    idle: string;
    accent: string;
    neutral: string;
    danger: string;
    armed: string;
  };
  face: [string, string]; // gradasi muka irisan
  gloss: [number, string, number][]; // [offset, warna, opacity]
  rim: [number, string, number][];
  ring: [number, string, number][]; // cincin kaca luar
  disc: [number, string, number][]; // isi cincin kaca
  ringThin: string; // garis tipis di luar irisan
  ringThinOpacity: number;
  shadow: { color: string; opacity: number };
  ink: string; // teks & ikon
  inkDanger: string;
  inkSub: string; // teks kecil
  spin: string;
  ok: string;
  err: string;
  okText: string;
}

const PALETTES: Record<RadialTheme, Palette> = {
  light: {
    fill: {
      idle: "url(#frm-face)",
      accent: "#E6F1FF",
      neutral: "#EFEFF3",
      danger: "#FFE3E3",
      armed: "#FFC8C8",
    },
    face: ["#FFFFFF", "#ECECF1"],
    gloss: [
      [0, "#FFFFFF", 0.95],
      [0.45, "#FFFFFF", 0],
      [0.6, "#1C1C3C", 0],
      [1, "#1C1C3C", 0.12],
    ],
    rim: [
      [0, "#FFFFFF", 1],
      [0.5, "#FFFFFF", 0.35],
      [1, "#000000", 0.16],
    ],
    ring: [
      [0, "#FFFFFF", 0.95],
      [0.5, "#FFFFFF", 0.25],
      [1, "#FFFFFF", 0.7],
    ],
    disc: [
      [0.55, "#FFFFFF", 0.16],
      [1, "#FFFFFF", 0.42],
    ],
    ringThin: "#FFFFFF",
    ringThinOpacity: 0.25,
    shadow: { color: "#1A1A2E", opacity: 0.3 },
    ink: "#1C1C1E",
    inkDanger: "#D92D20",
    inkSub: "#737373",
    spin: "#404040",
    ok: "#059669",
    err: "#DC2626",
    okText: "#1E8E3E",
  },
  dark: {
    fill: {
      idle: "url(#frm-face)",
      accent: "#12304F",
      neutral: "#2A2A30",
      danger: "#3B1414",
      armed: "#6B1D1D",
    },
    face: ["#08080A", "#08080A"], // rata: hitam solid
    gloss: [
      [0, "#FFFFFF", 0.07],
      [0.45, "#FFFFFF", 0],
      [1, "#000000", 0],
    ],
    rim: [
      [0, "#FFFFFF", 0.3],
      [0.5, "#FFFFFF", 0.1],
      [1, "#FFFFFF", 0.05],
    ],
    ring: [
      [0, "#FFFFFF", 0.4],
      [0.5, "#FFFFFF", 0.08],
      [1, "#FFFFFF", 0.28],
    ],
    disc: [
      [0.55, "#000000", 0.3],
      [1, "#000000", 0.55],
    ],
    ringThin: "#FFFFFF",
    ringThinOpacity: 0.1,
    shadow: { color: "#000000", opacity: 0.55 },
    ink: "#F5F5F7",
    inkDanger: "#FF6A5F",
    inkSub: "#A1A1AA",
    spin: "#D4D4D8",
    ok: "#4ADE80",
    err: "#F87171",
    okText: "#4ADE80",
  },
};

// aksi konversi: tengah menampilkan "Convert ke" + format tujuan
const NOT_CONVERT = new Set(["img_shrink", "img_rmbg", "pdf_shrink"]);
const isConvert = (id: string) =>
  !NOT_CONVERT.has(id) && /^(img_|pdf_|doc_|vid_|aud_)/.test(id);

const rad = (d: number) => (d * Math.PI) / 180;

// titik pada lingkaran; derajat dihitung dari atas searah jarum jam
function polar(r: number, deg: number): [number, number] {
  const a = rad(deg - 90);
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

// titik lokal (x = arah radial, y = arah putar searah jarum jam) pada irisan bersudut th
function local(lx: number, ly: number, th: number): string {
  const a = rad(th - 90);
  const x = C + lx * Math.cos(a) - ly * Math.sin(a);
  const y = C + lx * Math.sin(a) + ly * Math.cos(a);

  return `${x.toFixed(2)} ${y.toFixed(2)}`;
}

// irisan cincin dengan sudut bulat dan jarak antar irisan yang sama rata
function wedgePath(th: number, step: number): string {
  const h = rad(step / 2);
  const g = GAP / 2;
  const fo = h - Math.asin((g + RC) / (R_OUT - RC)); // sudut titik singgung luar
  const fi = h - Math.asin((g + RC) / (R_IN + RC)); // sudut titik singgung dalam
  const nP = [Math.sin(h), -Math.cos(h)]; // normal tepi sisi + (searah jarum jam)
  const nM = [Math.sin(h), Math.cos(h)]; // normal tepi sisi -

  const edge = (c: number[], n: number[]) => [
    c[0] - RC * n[0],
    c[1] - RC * n[1],
  ];
  const co = (s: number) => [
    (R_OUT - RC) * Math.cos(fo),
    s * (R_OUT - RC) * Math.sin(fo),
  ];
  const ci = (s: number) => [
    (R_IN + RC) * Math.cos(fi),
    s * (R_IN + RC) * Math.sin(fi),
  ];
  const P = (p: number[]) => local(p[0], p[1], th);

  const oM = [R_OUT * Math.cos(fo), -R_OUT * Math.sin(fo)];
  const oP = [R_OUT * Math.cos(fo), R_OUT * Math.sin(fo)];
  const iP = [R_IN * Math.cos(fi), R_IN * Math.sin(fi)];
  const iM = [R_IN * Math.cos(fi), -R_IN * Math.sin(fi)];

  return [
    `M${P(oM)}`,
    `A${R_OUT} ${R_OUT} 0 0 1 ${P(oP)}`,
    `A${RC} ${RC} 0 0 1 ${P(edge(co(1), nP))}`,
    `L${P(edge(ci(1), nP))}`,
    `A${RC} ${RC} 0 0 1 ${P(iP)}`,
    `A${R_IN} ${R_IN} 0 0 0 ${P(iM)}`,
    `A${RC} ${RC} 0 0 1 ${P(edge(ci(-1), nM))}`,
    `L${P(edge(co(-1), nM))}`,
    `A${RC} ${RC} 0 0 1 ${P(oM)}`,
    "Z",
  ].join(" ");
}

// letak irisan "Lainnya": kira-kira di kanan bawah (7 irisan -> urutan ke-4)
const moreIndex = (n: number) =>
  Math.max(1, Math.min(n - 1, Math.round(n * 0.43)));

type Slot = { id: string; a: FileAction | null };

function wedgeFill(
  p: Palette,
  a: FileAction | null,
  hovered: boolean,
  armed: boolean,
): string {
  if (armed) return p.fill.armed;
  if (!hovered) return p.fill.idle;
  if (!a) return p.fill.neutral;
  if (a.tone === "danger") return p.fill.danger;
  return a.tone === "accent" ? p.fill.accent : p.fill.neutral;
}

// ikon SVG sebagai cetakan berwarna (lihat svgMask.ts)
const MaskGlyph: React.FC<{ src: string; color: string; size: number }> = ({
  src,
  color,
  size,
}) => {
  const mask = useSvgMask(src);

  if (!mask) return <span style={{ width: size, height: size }} />;

  return (
    <span
      style={{
        display: "block",
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: `url(${mask})`,
        maskImage: `url(${mask})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
};

// gradasi, bevel, dan bayangan 3D (dipakai semua irisan)
const Stops: React.FC<{ list: [number, string, number][] }> = ({ list }) => (
  <>
    {list.map(([offset, color, opacity]) => (
      <stop
        key={offset}
        offset={offset}
        stopColor={color}
        stopOpacity={opacity}
      />
    ))}
  </>
);

const Defs: React.FC<{ p: Palette }> = ({ p }) => (
  <defs>
    <linearGradient id="frm-face" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={p.face[0]} />
      <stop offset="1" stopColor={p.face[1]} />
    </linearGradient>
    <linearGradient id="frm-gloss" x1="0" y1="0" x2="0" y2="1">
      <Stops list={p.gloss} />
    </linearGradient>
    <linearGradient id="frm-rim" x1="0" y1="0" x2="0" y2="1">
      <Stops list={p.rim} />
    </linearGradient>
    <linearGradient id="frm-ring" x1="0" y1="0" x2="1" y2="1">
      <Stops list={p.ring} />
    </linearGradient>
    <radialGradient id="frm-disc">
      <Stops list={p.disc} />
    </radialGradient>
    <filter id="frm-ds" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow
        dx="0"
        dy="4"
        stdDeviation="4"
        floodColor={p.shadow.color}
        floodOpacity={p.shadow.opacity}
      />
    </filter>
  </defs>
);

interface FileRadialMenuProps {
  island: FileIsland;
  // pusat lingkaran (px CSS di dalam jendela), diatur Rust (sudah ikut arah seretan)
  anchor: { x: number; y: number };
  // warna menu: "light" (putih, bawaan) atau "dark" (hitam solid)
  theme?: RadialTheme;
}

export const FileRadialMenu: React.FC<FileRadialMenuProps> = ({
  island,
  anchor,
  theme = "light",
}) => {
  const { actions, items, hoverId, armedId, status, message, run, hovering } =
    island;

  const p = PALETTES[theme] ?? PALETTES.light;

  // posisi pusat diatur Rust (sudah dijaga tetap di dalam layar, ikut kursor)
  const cx = anchor.x;
  const cy = anchor.y;

  // halaman: <= 7 aksi tampil semua, selebihnya 6 aksi + "Lainnya" per halaman
  const paged = actions.length > MAX_SLOTS;
  const pages = paged ? Math.ceil(actions.length / PER_PAGE) : 1;
  const [pageRaw, setPage] = useState(0);
  const page = Math.min(pageRaw, pages - 1);
  const lastPage = page >= pages - 1;

  const flip = () => setPage((n) => (Math.min(n, pages - 1) + 1) % pages);
  const flipRef = useRef(flip);
  flipRef.current = flip;

  // irisan: dibagi rata, irisan pertama berpusat di atas
  const slices = useMemo(() => {
    const list: Slot[] = (
      paged
        ? actions.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
        : actions
    ).map((a) => ({ id: a.id, a }));

    if (paged) {
      list.splice(moreIndex(list.length + 1), 0, { id: MORE_ID, a: null });
    }

    const step = 360 / Math.max(list.length, 3);

    return list.map((s, i) => {
      const th = i * step;
      const [mx, my] = polar(R_MID, th);
      const lx = Math.sin(rad(th)) * LIFT; // arah angkat (keluar dari pusat)
      const ly = -Math.cos(rad(th)) * LIFT;

      return { ...s, path: wedgePath(th, step), mid: [mx, my], lx, ly };
    });
  }, [actions, page, paged]);

  // sorotan: saat diseret dari drag, selebihnya (file sudah dilepas) dari mouse biasa
  const [mouseId, setMouseId] = useState<string | null>(null);
  const mouseRef = useRef<string | null>(null);
  const hid = hovering ? hoverId : mouseId;

  // pindah sorotan dari mouse: bunyi choose seperti saat diseret
  const setMouse = (id: string | null) => {
    if (mouseRef.current === id) return;

    mouseRef.current = id;
    setMouseId(id);

    if (id && !hovering) island.play("choose");
  };
  const hoverProps = (id: string) => ({
    onPointerEnter: () => setMouse(id),
    onPointerMove: () => setMouse(id),
    onPointerLeave: () => {
      if (mouseRef.current === id) setMouse(null);
    },
  });

  const hovered = actions.find((a) => a.id === hid) ?? null;
  const armed = actions.find((a) => a.id === armedId) ?? null;
  const focus = armed ?? hovered;
  const cancelOn = hid === "cancel" && !armed;
  const moreOn = hid === MORE_ID && !armed;
  const hasError = Object.values(status).includes("error");
  const hasDone = Object.values(status).includes("done");

  // tahan file di "Lainnya": pindah halaman (sekali per masuk irisan)
  const flippedRef = useRef(false);
  useEffect(() => {
    if (hoverId !== MORE_ID) {
      flippedRef.current = false;
      return;
    }
    if (flippedRef.current) return;

    const t = window.setTimeout(() => {
      flippedRef.current = true;
      flipRef.current();
    }, DWELL_MS);

    return () => window.clearTimeout(t);
  }, [hoverId, page]);

  // file dilepas di "Lainnya": pindah halaman, menu tetap terbuka
  const overMore = useRef(false);
  const wasHovering = useRef(hovering);
  useEffect(() => {
    if (hovering) overMore.current = hoverId === MORE_ID;
  }, [hoverId, hovering]);
  useEffect(() => {
    if (wasHovering.current && !hovering && overMore.current) {
      overMore.current = false;
      if (!flippedRef.current) flipRef.current();
    }
    wasHovering.current = hovering;
  }, [hovering]);

  // teks bagian tengah
  let title: string;
  let sub = "";
  let subTop = false;
  let tone = p.ink;

  if (cancelOn) {
    title = "Batalkan";
    tone = p.inkDanger;
  } else if (moreOn) {
    title = lastPage ? "Kembali" : "Lainnya";
    sub = `Halaman ${page + 1}/${pages}`;
  } else if (focus) {
    title = focus.label.trim();

    if (armed) {
      sub = "Klik untuk konfirmasi";
    } else if (isConvert(focus.id)) {
      sub = "Convert ke";
      subTop = true;
    }

    if (focus.tone === "danger") tone = p.inkDanger;
  } else if (message) {
    title = message;
    tone = hasError ? p.inkDanger : hasDone ? p.okText : p.ink;
  } else {
    const d = describeItems(items);
    title = d.title;
    sub = paged ? `${d.subtitle} · ${page + 1}/${pages}` : d.subtitle;
  }

  const big = title.length <= 9;
  const hole = (R_CENTER - 2) * 2;

  return (
    <div
      data-radial-root
      className="fixed left-0 top-0"
      style={{
        width: BOX,
        height: BOX,
        transform: `translate3d(${cx - BOX / 2}px, ${cy - BOX / 2}px, 0)`,
        transition: "transform 45ms linear",
        willChange: "transform",
      }}
    >
      <motion.div
        className="relative h-full w-full"
        initial={{ opacity: 0, scale: 0.5 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ type: "spring", stiffness: 460, damping: 28 }}
      >
        <svg
          width={BOX}
          height={BOX}
          viewBox={`0 0 ${BOX} ${BOX}`}
          className="absolute inset-0"
        >
          <Defs p={p} />

          {/* cincin kaca di luar */}
          <circle
            cx={C}
            cy={C}
            r={R_OUT + HALO - 1}
            fill="url(#frm-disc)"
            stroke="url(#frm-ring)"
            strokeWidth={2}
            pointerEvents="none"
          />
          <circle
            cx={C}
            cy={C}
            r={R_OUT + 3}
            fill="none"
            stroke={p.ringThin}
            strokeOpacity={p.ringThinOpacity}
            pointerEvents="none"
          />

          {/* irisan aksi */}
          {slices.map(({ id, a, path, lx, ly }, i) => {
            const on = id === hid || id === armedId;

            return (
              <motion.g
                key={`${page}-${id}`}
                data-action-id={id}
                className="cursor-pointer"
                {...hoverProps(id)}
                initial={{ opacity: 0, x: 0, y: 0 }}
                animate={{ opacity: 1, x: on ? lx : 0, y: on ? ly : 0 }}
                transition={{
                  opacity: { delay: i * 0.012, duration: 0.18 },
                  x: { type: "spring", stiffness: 500, damping: 30 },
                  y: { type: "spring", stiffness: 500, damping: 30 },
                }}
                onClick={() => {
                  if (id === MORE_ID) flip();
                  else if (status[id] !== "running") run(id);
                }}
              >
                <path
                  d={path}
                  filter="url(#frm-ds)"
                  style={{
                    fill: wedgeFill(p, a, id === hid, id === armedId),
                    transition: "fill 100ms",
                  }}
                />
                <path d={path} fill="url(#frm-gloss)" pointerEvents="none" />
                <path
                  d={path}
                  fill="none"
                  stroke="url(#frm-rim)"
                  strokeWidth={1.4}
                  pointerEvents="none"
                />
              </motion.g>
            );
          })}

          {/* lingkaran tengah */}
          <g
            data-action-id="cancel"
            className="cursor-pointer"
            {...hoverProps("cancel")}
            onClick={() => island.clear()}
          >
            <circle
              cx={C}
              cy={C}
              r={R_CENTER}
              filter="url(#frm-ds)"
              style={{
                fill: cancelOn ? p.fill.danger : p.fill.idle,
                transition: "fill 100ms",
              }}
            />
            <circle
              cx={C}
              cy={C}
              r={R_CENTER}
              fill="url(#frm-gloss)"
              pointerEvents="none"
            />
            <circle
              cx={C}
              cy={C}
              r={R_CENTER}
              fill="none"
              stroke="url(#frm-rim)"
              strokeWidth={1.4}
              pointerEvents="none"
            />
          </g>
        </svg>

        {/* ikon + nama tiap irisan */}
        {slices.map(({ id, a, mid, lx, ly }) => {
          const on = id === hid || id === armedId;
          const st = status[id];
          const color = a?.tone === "danger" ? p.inkDanger : p.ink;
          const Icon = a?.Icon;
          const label = a ? a.label.trim() : lastPage ? "Kembali" : "Lainnya";

          return (
            <motion.div
              key={`${page}-${id}`}
              className="pointer-events-none absolute flex flex-col items-center justify-center text-center"
              style={{
                left: mid[0] - 40,
                top: mid[1] - 26,
                width: 80,
                height: 52,
              }}
              animate={{ x: on ? lx : 0, y: on ? ly : 0, scale: on ? 1.08 : 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            >
              <div
                className="flex items-center justify-center"
                style={{ width: ICON, height: ICON }}
              >
                {st === "running" ? (
                  <Loader2 size={20} className="animate-spin" color={p.spin} />
                ) : st === "done" ? (
                  <Check size={20} color={p.ok} />
                ) : st === "error" ? (
                  <X size={20} color={p.err} />
                ) : id === MORE_ID ? (
                  lastPage ? (
                    <ChevronLeft size={20} color={p.ink} />
                  ) : (
                    <MoreHorizontal size={20} color={p.ink} />
                  )
                ) : a?.svg ? (
                  <MaskGlyph src={a.svg} color={color} size={ICON} />
                ) : Icon ? (
                  <Icon size={20} color={color} />
                ) : null}
              </div>

              <span
                className="mt-1 max-w-[76px] text-[9.5px] font-bold uppercase leading-[1.1] tracking-wide"
                style={{
                  color,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  wordBreak: "break-word",
                }}
              >
                {label}
              </span>
            </motion.div>
          );
        })}

        {/* nama aksi di tengah */}
        <div
          className="pointer-events-none absolute flex flex-col items-center justify-center text-center"
          style={{
            left: C - hole / 2,
            top: C - hole / 2,
            width: hole,
            height: hole,
            padding: "0 10px",
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${focus?.id ?? (moreOn ? MORE_ID : "idle")}|${title}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.1 }}
              className="flex max-w-full flex-col items-center"
            >
              {sub && subTop && (
                <span
                  className="mb-0.5 max-w-full truncate text-[11px] font-medium"
                  style={{ color: p.inkSub }}
                >
                  {sub}
                </span>
              )}

              <span
                className="max-w-full font-semibold leading-tight tracking-tight"
                style={{
                  color: tone,
                  fontSize: big ? 20 : 12,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  wordBreak: "break-word",
                }}
              >
                {title}
              </span>

              {sub && !subTop && (
                <span
                  className="mt-0.5 max-w-full truncate text-[10px]"
                  style={{ color: p.inkSub }}
                >
                  {sub}
                </span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
};
