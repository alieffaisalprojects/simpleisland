/**
 * RadialOverlay.tsx
 * Isi jendela "radial": jendela transparan yang dibesarkan Rust (radial_overlay.rs)
 * saat file diseret dari Explorer / Desktop.
 *
 *   - Rust yang memutuskan posisi lingkaran dan kapan jendela menangkap drag:
 *       radial-start / radial-anchor  -> pusat lingkaran (ikut kursor dengan "tali")
 *       radial-release                -> tombol dilepas (true = di dalam lingkaran)
 *   - kursor keluar lingkaran: Rust membuat jendela tembus klik, drag lanjut ke
 *     Explorer seperti biasa. Event "leave" dari OS diabaikan selama drag berlangsung,
 *     jadi lingkaran tetap aktif.
 *   - dilepas di irisan = aksi langsung jalan; dilepas di tengah = menu tetap terbuka;
 *     dilepas di luar lingkaran = menu ditutup (file sudah dipindah oleh Explorer)
 *   - Rename dan Properti memakai panel yang sama dengan island (FileActionsPanel)
 *   - Salin / Potong: pil Paste menggantung di island lewat event "radial-paste"
 *   - Warna menu (putih / hitam solid) mengikuti pengaturan fileMenuTheme
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../../../settings/settings";
import { FileActionsPanel, getFilePanelSize } from "./FileActionsPanel";
import { FileRadialMenu } from "./FileRadialMenu";
import { CROP_PANEL_H, CROP_PANEL_W, FileCropPanel } from "./FileCropPanel";
import { useFileIsland } from "./useFileIsland";

const EDGE = 8;
// tunggu event drop sebelum menganggap lepasan di dalam lingkaran dibatalkan
const DROP_WAIT_MS = 500;

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), Math.max(min, max));

export const RadialOverlay: React.FC = () => {
  const { settings } = useSettings();

  // true selama tombol mouse masih menahan drag (diatur oleh event dari Rust)
  const draggingRef = useRef(false);
  // true bila drop sudah diterima jendela ini
  const droppedRef = useRef(false);

  const island = useFileIsland({
    enabled: true,
    sounds: settings.fileSounds,
    keepOnLeave: () => draggingRef.current,
    confirmDanger: false, // radial: Hapus langsung jalan, tanpa konfirmasi
    crop: true, // radial: gambar tunggal punya aksi Crop
  });

  const clearRef = useRef(island.clear);
  clearRef.current = island.clear;

  // pusat lingkaran (px CSS di dalam jendela), diatur Rust
  const [anchor, setAnchor] = useState({ x: -9999, y: -9999 });

  // jendela ini transparan: pastikan halaman tidak punya latar
  useEffect(() => {
    const els = [
      document.documentElement,
      document.body,
      document.getElementById("root"),
    ];

    els.forEach((el) =>
      el?.style.setProperty("background", "transparent", "important"),
    );
  }, []);

  // event dari Rust: posisi lingkaran dan pelepasan tombol
  useEffect(() => {
    const stops: Array<() => void> = [];
    let cancelled = false;
    let timer: number | undefined;

    const on = <T,>(name: string, cb: (payload: T) => void) =>
      listen<T>(name, (e) => cb(e.payload))
        .then((stop) => (cancelled ? stop() : stops.push(stop)))
        .catch((e) => console.error(`Gagal mendengarkan ${name}:`, e));

    on<[number, number]>("radial-start", ([x, y]) => {
      window.clearTimeout(timer);
      draggingRef.current = true;
      droppedRef.current = false;
      setAnchor({ x, y });
    });

    on<[number, number]>("radial-anchor", ([x, y]) => setAnchor({ x, y }));

    on<boolean>("radial-release", (inside) => {
      draggingRef.current = false;
      window.clearTimeout(timer);

      // dilepas di luar lingkaran: file sudah dipindah Explorer, tutup menu
      if (!inside) {
        clearRef.current();
        return;
      }

      // dilepas di dalam tapi tidak ada drop (mis. dibatalkan Esc): tutup menu
      timer = window.setTimeout(() => {
        if (!droppedRef.current) clearRef.current();
      }, DROP_WAIT_MS);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stops.forEach((stop) => stop());
    };
  }, []);

  // catat drop yang diterima jendela ini
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        const t = event.payload.type;

        if (t === "enter") droppedRef.current = false;
        if (t === "drop") droppedRef.current = true;
      })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch((e) => console.error("Gagal membaca event drag:", e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // beri tahu Rust kapan jendela boleh dikecilkan
  useEffect(() => {
    invoke("radial_overlay_keep", { on: island.active }).catch(() => {});
  }, [island.active]);

  // salin / potong: serahkan ke island, lalu lepaskan dari jendela ini
  const { paste, pasteDismiss } = island;
  useEffect(() => {
    if (!paste || paste.phase !== "ready") return;

    void emit("radial-paste", { items: paste.items, mode: paste.mode });
    pasteDismiss();
  }, [paste, pasteDismiss]);

  // klik di luar lingkaran / kartu: tutup
  const onPointerDown = (e: React.PointerEvent) => {
    if (!island.active || island.hovering) return;
    if ((e.target as HTMLElement).closest("[data-radial-root]")) return;

    island.clear();
  };

  const menuView = island.view === "menu";

  // kartu Rename / Properti di posisi lingkaran
  const size = getFilePanelSize(island.actions.length) as unknown as {
    width: number;
    height: number;
  };
  const cardX = clamp(
    anchor.x - size.width / 2,
    EDGE,
    window.innerWidth - size.width - EDGE,
  );
  const cardY = clamp(
    anchor.y - size.height / 2,
    EDGE,
    window.innerHeight - size.height - EDGE,
  );

  // panel Crop di posisi lingkaran
  const cropX = clamp(
    anchor.x - CROP_PANEL_W / 2,
    EDGE,
    window.innerWidth - CROP_PANEL_W - EDGE,
  );
  const cropY = clamp(
    anchor.y - CROP_PANEL_H / 2,
    EDGE,
    window.innerHeight - CROP_PANEL_H - EDGE,
  );
  const cropOn = island.active && island.view === "crop";

  return (
    <div className="fixed inset-0" onPointerDown={onPointerDown}>
      <AnimatePresence>
        {island.active && menuView && (
          <FileRadialMenu
            key="radial"
            island={island}
            anchor={anchor}
            theme={settings.fileMenuTheme}
          />
        )}
      </AnimatePresence>

      {cropOn && island.items[0] && (
        <FileCropPanel
          path={island.items[0].path}
          x={cropX}
          y={cropY}
          busy={island.status.crop === "running"}
          message={island.message}
          onApply={island.cropRun}
          onClose={island.clear}
        />
      )}

      {island.active && !menuView && !cropOn && (
        <div
          data-radial-root
          className="fixed overflow-hidden rounded-[28px] bg-[#050506] text-white shadow-2xl"
          style={{
            left: cardX,
            top: cardY,
            width: size.width,
            height: size.height,
          }}
        >
          <FileActionsPanel
            items={island.items}
            actions={island.actions}
            hovering={island.hovering}
            hoverId={island.hoverId}
            armedId={island.armedId}
            status={island.status}
            message={island.message}
            view={island.view}
            propsState={island.propsState}
            onRun={island.run}
            onRename={island.renameRun}
            onBack={island.back}
            onClose={island.clear}
          />
        </div>
      )}
    </div>
  );
};

export default RadialOverlay;
