/**
 * useFileIsland.ts
 * Pengganti useFileDragDrop. Menangani seluruh alur file di island:
 *
 *   enter -> baca isi yang diseret (file / folder / banyak) -> island mengembang, menu muncul
 *   over  -> kotak di bawah kursor menyala (hoverId)
 *   drop  -> dilepas di kotak = aksi langsung jalan; dilepas di tempat lain = menu tetap terbuka
 *   leave -> dibatalkan, island menutup
 *
 * Kotak ditemukan lewat atribut data-action-id di DOM (lihat FileActionsPanel),
 * jadi hook ini tidak perlu tahu bentuk tampilannya.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  buildActions,
  classify,
  type FileAction,
  type FileItem,
  type FileTools,
} from "./catalog";

export type TileStatus = "running" | "done" | "error";

interface RawMeta {
  path: string;
  name: string;
  ext: string;
  isDir: boolean;
  size: number | null;
  children: number | null;
  exists: boolean;
}

interface ActionResult {
  message: string;
  output?: string | null;
}

const NO_TOOLS: FileTools = { rar: false, sevenZip: false, ffmpeg: false };

// Setelah aksi sukses, island menutup sendiri setelah jeda singkat
const CLOSE_AFTER_DONE_MS = 1100;

async function inspect(paths: string[]): Promise<FileItem[]> {
  const metas = await invoke<RawMeta[]>("file_inspect", { paths });

  return metas
    .filter((m) => m.exists)
    .map((m) => ({
      path: m.path,
      name: m.name,
      ext: m.ext,
      isDir: m.isDir,
      size: m.size,
      children: m.children,
      kind: classify(m.ext, m.isDir),
    }));
}

const samePaths = (items: FileItem[], paths: string[]) =>
  items.length === paths.length && items.every((it, i) => it.path === paths[i]);

// Kotak aksi di bawah titik (koordinat fisik dari Tauri)
function actionAt(pos: { x: number; y: number }): string | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);

  return el?.closest<HTMLElement>("[data-action-id]")?.dataset.actionId ?? null;
}

export function useFileIsland() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [hovering, setHovering] = useState(false); // masih diseret, belum dilepas
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, TileStatus>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [tools, setTools] = useState<FileTools>(NO_TOOLS);

  // Penanda urutan drag, supaya hasil async yang basi dibuang
  const seq = useRef(0);
  const closeTimer = useRef<number | undefined>(undefined);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const actions: FileAction[] = useMemo(
    () => buildActions(items, tools),
    [items, tools],
  );

  // Tutup dan buang semua
  const clear = useCallback(() => {
    seq.current += 1;
    window.clearTimeout(closeTimer.current);
    setItems([]);
    setHovering(false);
    setHoverId(null);
    setArmedId(null);
    setStatus({});
    setMessage(null);
  }, []);

  // Jalankan satu aksi di Rust
  const execute = useCallback(
    async (actionId: string, list: FileItem[]) => {
      const action = buildActions(list, toolsRef.current).find(
        (a) => a.id === actionId,
      );
      if (!action || list.length === 0) return;

      window.clearTimeout(closeTimer.current);
      setArmedId(null);
      setMessage(null);
      setStatus({ [actionId]: "running" });

      try {
        const res = await invoke<ActionResult>("file_action", {
          action: actionId,
          paths: list.map((i) => i.path),
        });

        setStatus({ [actionId]: "done" });
        setMessage(res.message);
        closeTimer.current = window.setTimeout(clear, CLOSE_AFTER_DONE_MS);
      } catch (e) {
        setStatus({ [actionId]: "error" });
        setMessage(typeof e === "string" ? e : "Aksi gagal");
      }
    },
    [clear],
  );

  const executeRef = useRef(execute);
  executeRef.current = execute;

  // Klik kotak
  const run = useCallback(
    (actionId: string) => {
      void execute(actionId, itemsRef.current);
    },
    [execute],
  );

  // Cek alat tambahan (WinRAR, 7-Zip, ffmpeg) sekali saja
  useEffect(() => {
    invoke<FileTools>("file_tools")
      .then(setTools)
      .catch((e) => console.error("Gagal membaca alat file:", e));
  }, []);

  // Event drag & drop dari Windows
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWindow()
      .onDragDropEvent(async (event) => {
        const p = event.payload;

        switch (p.type) {
          case "enter": {
            if (p.paths.length === 0) return;

            window.clearTimeout(closeTimer.current);
            const id = ++seq.current;

            try {
              const list = await inspect(p.paths);
              if (id !== seq.current || list.length === 0) return; // sudah dibatalkan / dilepas

              setItems(list);
              setStatus({});
              setMessage(null);
              setArmedId(null);
              setHovering(true);
              setHoverId(actionAt(p.position));
            } catch (e) {
              console.error("Gagal membaca file yang diseret:", e);
            }
            break;
          }

          case "over":
            setHoverId(actionAt(p.position));
            break;

          case "leave":
            clear();
            break;

          case "drop": {
            if (p.paths.length === 0) {
              clear();
              return;
            }

            window.clearTimeout(closeTimer.current);
            const id = ++seq.current;

            try {
              let list = itemsRef.current;
              if (!samePaths(list, p.paths)) list = await inspect(p.paths);
              if (id !== seq.current || list.length === 0) return;

              setItems(list);
              setStatus({});
              setMessage(null);
              setHovering(false);
              setHoverId(null);

              // Beri fokus supaya klik di luar menutup island seperti biasa
              invoke("island_focus").catch(() => {});

              const target = actionAt(p.position);
              if (!target) break; // dilepas di luar kotak: menu tetap terbuka

              const action = buildActions(list, toolsRef.current).find(
                (a) => a.id === target,
              );
              if (!action) break;

              // Aksi berbahaya tidak langsung jalan saat dilepas: harus diklik
              if (action.tone === "danger") setArmedId(target);
              else void executeRef.current(target, list);
            } catch (e) {
              console.error("Gagal memproses file yang dilepas:", e);
            }
            break;
          }
        }
      })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch((e) => console.error("Gagal mendengarkan drag & drop:", e));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [clear]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return {
    items,
    actions,
    hovering,
    hoverId,
    armedId,
    status,
    message,
    active: hovering || items.length > 0,
    run,
    clear,
  };
}

export type FileIsland = ReturnType<typeof useFileIsland>;
