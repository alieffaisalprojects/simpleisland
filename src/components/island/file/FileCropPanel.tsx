/**
 * FileCropPanel.tsx
 * Tampilan "Crop Image" untuk menu radial (dibuka dari irisan Crop pada gambar tunggal).
 *
 *   - gambar pratinjau dari Rust (file_crop_preview), area crop diatur dengan 8 pegangan
 *     (4 sudut + 4 sisi) dan digeser dari dalamnya
 *   - Aspect ratio: Free, 1:1, 16:9, 9:16, 4:3, 3:4
 *   - kolom W dan H (px gambar asli); Enter / klik di luar kolom = terapkan
 *   - Reset = kembali ke seluruh gambar, Apply = simpan <nama>_crop.<ext> (useFileIsland.cropRun)
 *
 * Semua ukuran dihitung dalam px gambar ASLI; tampilan hanya mengalikan dengan `scale`.
 * Dipasang oleh RadialOverlay.tsx pada posisi (x, y) = pojok kiri atas panel.
 */

import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, X } from "lucide-react";

// ukuran panel (px), dipakai RadialOverlay untuk menaruh panel di dalam layar
export const CROP_PANEL_W = 440;
export const CROP_PANEL_H = 600;

const PAD = 20;
const BOX_W = CROP_PANEL_W - PAD * 2; // area gambar
const BOX_H = 330;
const MIN = 16; // area crop terkecil (px gambar)
const ACC = "#F26A2E";
const INK = "#1C1C1E";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Preview {
  dataUrl: string;
  width: number;
  height: number;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

const RATIOS: Array<{ label: string; value: number | null }> = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
];

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

// area terbesar dengan rasio tertentu di dalam gambar, berpusat di area sekarang
function fitRatio(cur: Rect, r: number, iw: number, ih: number): Rect {
  const w = Math.min(iw, ih * r);
  const h = w / r;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;

  return {
    x: clamp(cx - w / 2, 0, iw - w),
    y: clamp(cy - h / 2, 0, ih - h),
    w,
    h,
  };
}

// geser / ubah ukuran area dari pegangan `h` (dx, dy dalam px gambar)
function dragRect(
  h: Handle,
  s: Rect,
  dx: number,
  dy: number,
  ratio: number | null,
  iw: number,
  ih: number,
): Rect {
  if (h === "move") {
    return {
      ...s,
      x: clamp(s.x + dx, 0, iw - s.w),
      y: clamp(s.y + dy, 0, ih - s.h),
    };
  }

  // bebas
  if (ratio === null) {
    let l = s.x;
    let t = s.y;
    let r = s.x + s.w;
    let b = s.y + s.h;

    if (h.includes("w")) l = clamp(l + dx, 0, r - MIN);
    if (h.includes("e")) r = clamp(r + dx, l + MIN, iw);
    if (h.includes("n")) t = clamp(t + dy, 0, b - MIN);
    if (h.includes("s")) b = clamp(b + dy, t + MIN, ih);

    return { x: l, y: t, w: r - l, h: b - t };
  }

  // rasio terkunci: lebar dan tinggi sama-sama minimal MIN
  const minW = MIN * Math.max(1, ratio);
  const minH = MIN * Math.max(1, 1 / ratio);

  // sudut: sudut seberangnya jadi jangkar
  if (h.length === 2) {
    const sx = h.includes("w") ? -1 : 1;
    const sy = h.includes("n") ? -1 : 1;
    const ax = sx > 0 ? s.x : s.x + s.w;
    const ay = sy > 0 ? s.y : s.y + s.h;

    const w = s.w + sx * dx;
    const hh = s.h + sy * dy;
    const maxW = Math.min(
      sx > 0 ? iw - ax : ax,
      (sy > 0 ? ih - ay : ay) * ratio,
    );
    const nw = clamp(Math.max(w, hh * ratio), Math.min(minW, maxW), maxW);
    const nh = nw / ratio;

    return {
      x: sx > 0 ? ax : ax - nw,
      y: sy > 0 ? ay : ay - nh,
      w: nw,
      h: nh,
    };
  }

  // rasio terkunci, sisi kiri / kanan: tinggi mengikuti, berpusat vertikal
  if (h === "e" || h === "w") {
    const sx = h === "w" ? -1 : 1;
    const ax = sx > 0 ? s.x : s.x + s.w;
    const cy = s.y + s.h / 2;
    const maxW = Math.min(
      sx > 0 ? iw - ax : ax,
      2 * Math.min(cy, ih - cy) * ratio,
    );
    const nw = clamp(s.w + sx * dx, Math.min(minW, maxW), maxW);
    const nh = nw / ratio;

    return { x: sx > 0 ? ax : ax - nw, y: cy - nh / 2, w: nw, h: nh };
  }

  // rasio terkunci, sisi atas / bawah: lebar mengikuti, berpusat horizontal
  const sy = h === "n" ? -1 : 1;
  const ay = sy > 0 ? s.y : s.y + s.h;
  const cx = s.x + s.w / 2;
  const maxH = Math.min(
    sy > 0 ? ih - ay : ay,
    (2 * Math.min(cx, iw - cx)) / ratio,
  );
  const nh = clamp(s.h + sy * dy, Math.min(minH, maxH), maxH);
  const nw = nh * ratio;

  return { x: cx - nw / 2, y: sy > 0 ? ay : ay - nh, w: nw, h: nh };
}

// pegangan: posisi (persen dari area crop), ukuran, dan kursor
const HANDLES: Array<{
  h: Handle;
  left: string;
  top: string;
  w: number;
  hh: number;
  cursor: string;
}> = [
  { h: "nw", left: "0%", top: "0%", w: 12, hh: 12, cursor: "nwse-resize" },
  { h: "ne", left: "100%", top: "0%", w: 12, hh: 12, cursor: "nesw-resize" },
  { h: "sw", left: "0%", top: "100%", w: 12, hh: 12, cursor: "nesw-resize" },
  { h: "se", left: "100%", top: "100%", w: 12, hh: 12, cursor: "nwse-resize" },
  { h: "n", left: "50%", top: "0%", w: 24, hh: 6, cursor: "ns-resize" },
  { h: "s", left: "50%", top: "100%", w: 24, hh: 6, cursor: "ns-resize" },
  { h: "w", left: "0%", top: "50%", w: 6, hh: 24, cursor: "ew-resize" },
  { h: "e", left: "100%", top: "50%", w: 6, hh: 24, cursor: "ew-resize" },
];

interface FileCropPanelProps {
  path: string; // gambar yang di-crop
  x: number; // pojok kiri atas panel (px CSS di dalam jendela)
  y: number;
  busy: boolean; // Apply sedang berjalan
  message: string | null; // pesan error dari Apply
  onApply: (r: { x: number; y: number; width: number; height: number }) => void;
  onClose: () => void;
}

export const FileCropPanel: React.FC<FileCropPanelProps> = ({
  path,
  x,
  y,
  busy,
  message,
  onApply,
  onClose,
}) => {
  const [pv, setPv] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const [ratio, setRatio] = useState<number | null>(null);
  // isi kolom W / H saat sedang diketik (null = ikut ukuran area)
  const [typed, setTyped] = useState<{ w: string | null; h: string | null }>({
    w: null,
    h: null,
  });

  const drag = useRef<{ h: Handle; sx: number; sy: number; rect: Rect } | null>(
    null,
  );

  // baca pratinjau dari Rust
  useEffect(() => {
    let dead = false;

    setPv(null);
    setErr(null);

    invoke<Preview>("file_crop_preview", { path })
      .then((p) => {
        if (dead) return;
        setPv(p);
        setRect({ x: 0, y: 0, w: p.width, h: p.height });
        setRatio(null);
      })
      .catch((e) => {
        if (!dead) setErr(typeof e === "string" ? e : "Gagal membuka gambar");
      });

    return () => {
      dead = true;
    };
  }, [path]);

  const iw = pv?.width ?? 1;
  const ih = pv?.height ?? 1;
  const scale = Math.min(BOX_W / iw, BOX_H / ih);
  const dispW = iw * scale;
  const dispH = ih * scale;

  const down = (h: Handle) => (e: React.PointerEvent) => {
    if (!pv || busy) return;

    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { h, sx: e.clientX, sy: e.clientY, rect };
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;

    setRect(
      dragRect(
        d.h,
        d.rect,
        (e.clientX - d.sx) / scale,
        (e.clientY - d.sy) / scale,
        ratio,
        iw,
        ih,
      ),
    );
    setTyped({ w: null, h: null });
  };

  const up = () => {
    drag.current = null;
  };

  const pickRatio = (r: number | null) => {
    setRatio(r);
    setTyped({ w: null, h: null });
    if (r !== null) setRect((cur) => fitRatio(cur, r, iw, ih));
  };

  const reset = () => {
    setRatio(null);
    setTyped({ w: null, h: null });
    setRect({ x: 0, y: 0, w: iw, h: ih });
  };

  // terapkan angka W / H yang diketik
  const commit = (axis: "w" | "h") => {
    const raw = typed[axis];
    setTyped((t) => ({ ...t, [axis]: null }));

    const n = Math.round(Number(raw));
    if (raw === null || !Number.isFinite(n) || n < 1) return;

    setRect((cur) => {
      let w = axis === "w" ? n : cur.w;
      let h = axis === "h" ? n : cur.h;

      if (ratio !== null) {
        if (axis === "w") h = w / ratio;
        else w = h * ratio;

        // tidak boleh melebihi gambar
        const k = Math.min(1, iw / w, ih / h);
        w *= k;
        h *= k;
      } else {
        w = Math.min(w, iw);
        h = Math.min(h, ih);
      }

      return {
        x: clamp(cur.x, 0, iw - w),
        y: clamp(cur.y, 0, ih - h),
        w,
        h,
      };
    });
  };

  const apply = () => {
    if (!pv || busy) return;

    const w = clamp(Math.round(rect.w), 1, iw);
    const h = clamp(Math.round(rect.h), 1, ih);

    onApply({
      x: clamp(Math.round(rect.x), 0, iw - w),
      y: clamp(Math.round(rect.y), 0, ih - h),
      width: w,
      height: h,
    });
  };

  const field = (axis: "w" | "h") => (
    <input
      value={typed[axis] ?? String(Math.round(rect[axis]))}
      inputMode="numeric"
      disabled={!pv || busy}
      onChange={(e) =>
        setTyped((t) => ({ ...t, [axis]: e.target.value.replace(/\D/g, "") }))
      }
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => commit(axis)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="h-8 w-[84px] rounded-lg border border-black/10 bg-white/90 text-center text-[14px] font-medium tabular-nums outline-none focus:border-[#F26A2E] disabled:opacity-50"
      style={{ color: INK }}
    />
  );

  const shown = message ?? err;

  return (
    <div
      data-radial-root
      className="fixed flex flex-col rounded-[28px] border border-white/70 shadow-2xl"
      style={{
        left: x,
        top: y,
        width: CROP_PANEL_W,
        height: CROP_PANEL_H,
        padding: PAD,
        color: INK,
        background: "rgba(255,255,255,0.88)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* header */}
      <div className="relative flex h-[38px] shrink-0 items-center justify-center">
        <button
          type="button"
          aria-label="Tutup"
          onClick={onClose}
          className="absolute left-0 flex h-[34px] w-[34px] items-center justify-center rounded-full bg-black/[0.06] text-neutral-600 transition hover:bg-black/10 active:scale-90"
        >
          <X size={17} />
        </button>

        <span className="text-[17px] font-semibold tracking-tight">
          Crop Image
        </span>
      </div>

      {/* gambar + area crop */}
      <div
        className="relative mt-3 flex shrink-0 items-center justify-center rounded-2xl bg-black/[0.04]"
        style={{ width: BOX_W, height: BOX_H }}
      >
        {!pv ? (
          <span className="text-[12px] text-neutral-500">
            {err ? (
              err
            ) : (
              <Loader2 size={20} className="animate-spin text-neutral-500" />
            )}
          </span>
        ) : (
          <div
            className="relative overflow-hidden"
            style={{ width: dispW, height: dispH, touchAction: "none" }}
          >
            <img
              src={pv.dataUrl}
              alt=""
              draggable={false}
              className="pointer-events-none block select-none"
              style={{ width: dispW, height: dispH }}
            />

            {/* area crop: di luarnya digelapkan */}
            <div
              className="absolute"
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.w * scale,
                height: rect.h * scale,
                outline: "2px solid #fff",
                boxShadow: "0 0 0 4000px rgba(28,28,36,0.55)",
                cursor: "move",
              }}
              onPointerDown={down("move")}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
            >
              {[33.33, 66.66].map((p) => (
                <React.Fragment key={p}>
                  <span
                    className="pointer-events-none absolute inset-y-0 w-px bg-white/35"
                    style={{ left: `${p}%` }}
                  />
                  <span
                    className="pointer-events-none absolute inset-x-0 h-px bg-white/35"
                    style={{ top: `${p}%` }}
                  />
                </React.Fragment>
              ))}

              {HANDLES.map((k) => (
                <span
                  key={k.h}
                  className="absolute"
                  style={{
                    left: k.left,
                    top: k.top,
                    width: k.w,
                    height: k.hh,
                    transform: "translate(-50%, -50%)",
                    background: ACC,
                    borderRadius: 3,
                    cursor: k.cursor,
                  }}
                  onPointerDown={down(k.h)}
                  onPointerMove={move}
                  onPointerUp={up}
                  onPointerCancel={up}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* aspect ratio */}
      <div className="mt-4 flex shrink-0 items-center justify-between">
        <span className="text-[13px] font-medium text-neutral-600">
          Aspect ratio
        </span>

        <div className="flex rounded-[10px] bg-black/[0.06] p-[3px]">
          {RATIOS.map((r) => {
            const on = r.value === ratio;

            return (
              <button
                key={r.label}
                type="button"
                disabled={!pv || busy}
                onClick={() => pickRatio(r.value)}
                className="h-[26px] min-w-[42px] rounded-[8px] px-2 text-[12.5px] font-medium transition active:scale-95 disabled:opacity-50"
                style={{
                  background: on ? ACC : "transparent",
                  color: on ? "#fff" : INK,
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ukuran */}
      <div className="mt-3 flex shrink-0 items-center gap-2 text-[13px] font-medium text-neutral-600">
        <span>W</span>
        {field("w")}
        <span className="ml-2">H</span>
        {field("h")}
        <span className="ml-1">px</span>
      </div>

      <div className="min-h-0 flex-1" />

      {shown && (
        <div
          className="mb-2 truncate text-[12px] font-medium"
          style={{ color: "#D92D20" }}
          title={shown}
        >
          {shown}
        </div>
      )}

      {/* Reset / Apply */}
      <div className="flex shrink-0 items-center justify-between">
        <button
          type="button"
          disabled={!pv || busy}
          onClick={reset}
          className="h-[34px] rounded-[10px] bg-black/[0.06] px-4 text-[13px] font-medium text-neutral-600 transition hover:bg-black/10 active:scale-95 disabled:opacity-50"
        >
          Reset
        </button>

        <button
          type="button"
          disabled={!pv || busy}
          onClick={apply}
          className="flex h-[34px] min-w-[84px] items-center justify-center rounded-[10px] px-5 text-[13px] font-semibold text-white transition hover:brightness-105 active:scale-95 disabled:opacity-60"
          style={{ background: ACC }}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : "Apply"}
        </button>
      </div>
    </div>
  );
};

export default FileCropPanel;
