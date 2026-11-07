/**
 * useFileIsland.ts
 * Pengganti useFileDragDrop. Menangani seluruh alur file di island:
 *
 *   enter -> baca isi yang diseret (file / folder / banyak) -> island mengembang, menu muncul
 *   over  -> kotak di bawah kursor menyala (hoverId)
 *   drop  -> dilepas di kotak = aksi langsung jalan; dilepas di tempat lain = menu tetap terbuka
 *   leave -> dibatalkan, island menutup
 *
 * Salin / Potong tidak langsung menutup island: island mengecil jadi pil dengan tombol
 * Paste yang menggantung sampai ditekan. Paste membuka dialog pilih folder, lalu
 * file ditempel ke folder itu (lihat `paste` dan `pasteRun`).
 *
 * Rename dan Properti membuka tampilan sendiri di dalam panel (`view`):
 *   "menu"   -> kotak-kotak aksi
 *   "rename" -> kolom ganti nama (`renameRun`)
 *   "props"  -> info properti (`propsState`)
 *
 * Suara (lihat sounds.ts): choose saat kotak disorot, drop saat file dilepas,
 * checklist saat proses selesai.
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
import { playSound, preloadSounds } from "./sounds";

export type TileStatus = "running" | "done" | "error";

// Tampilan panel
export type PanelView = "menu" | "rename" | "props";

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

interface RenameResult {
  message: string;
  paths: string[];
}

// Properti dari Rust (file_properties)
export interface FileProps {
  count: number;
  name: string;
  location: string; // "" bila item berasal dari folder berbeda
  isDir: boolean;
  ext: string;
  size: number;
  files: number;
  folders: number;
  approx: boolean;
  createdMs: number | null;
  modifiedMs: number | null;
  accessedMs: number | null;
  readOnly: boolean;
  hidden: boolean;
  extra: string | null; // dimensi gambar / jumlah halaman PDF
}

export interface PropsState {
  loading: boolean;
  data?: FileProps;
  error?: string;
}

export type PastePhase = "ready" | "picking" | "running" | "done" | "error";

// File yang sudah disalin / dipotong dan menunggu tombol Paste ditekan
export interface PendingPaste {
  items: FileItem[];
  mode: "copy" | "cut";
  phase: PastePhase;
  dest?: string; // folder tujuan yang dipilih
  message?: string; // pesan hasil / error
}

const NO_TOOLS: FileTools = { rar: false, sevenZip: false, ffmpeg: false };

// Setelah aksi sukses, island menutup sendiri setelah jeda singkat
const CLOSE_AFTER_DONE_MS = 1100;

// Salin / potong: ceklis sebentar, lalu island mengecil jadi pil Paste
const COPY_HOLD_MS = 550;

// Pil Paste menutup sendiri setelah file berhasil ditempel
const PASTE_DONE_MS = 1300;

// Aksi instan: tidak perlu bunyi checklist (aksi lain = proses nyata, bunyi saat selesai)
const QUIET_ACTIONS = new Set([
  "copy",
  "cut",
  "copy_path",
  "reveal",
  "terminal",
]);

const errorText = (e: unknown, fallback: string) =>
  typeof e === "string" && e ? e : fallback;

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
  const [paste, setPaste] = useState<PendingPaste | null>(null);
  const [view, setView] = useState<PanelView>("menu");
  const [propsState, setPropsState] = useState<PropsState | null>(null);

  // Penanda urutan drag, supaya hasil async yang basi dibuang
  const seq = useRef(0);
  const propsSeq = useRef(0); // sama, untuk pembacaan properti
  const closeTimer = useRef<number | undefined>(undefined);
  const pasteTimer = useRef<number | undefined>(undefined);
  const pasteBusy = useRef(false); // dialog / penempelan sedang berjalan
  const renameBusy = useRef(false); // penggantian nama sedang berjalan

  // Kotak yang sedang disorot (untuk bunyi choose hanya saat berpindah kotak)
  const hoverRef = useRef<string | null>(null);

  const pasteRef = useRef(paste);
  pasteRef.current = paste;

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  const actions: FileAction[] = useMemo(
    () => buildActions(items, tools),
    [items, tools],
  );

  // Sorot kotak; bunyi choose tiap berpindah ke kotak baru
  const setHover = useCallback((id: string | null) => {
    if (hoverRef.current === id) return;

    hoverRef.current = id;
    setHoverId(id);

    if (id) playSound("choose");
  }, []);

  // Tutup dan buang semua (pil Paste tetap menggantung, tidak ikut dibuang)
  const clear = useCallback(() => {
    seq.current += 1;
    propsSeq.current += 1;
    window.clearTimeout(closeTimer.current);
    hoverRef.current = null;
    setItems([]);
    setHovering(false);
    setHoverId(null);
    setArmedId(null);
    setStatus({});
    setMessage(null);
    setView("menu");
    setPropsState(null);
  }, []);

  // Buka tampilan Rename (fokus ke island supaya bisa mengetik)
  const openRename = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    setArmedId(null);
    setStatus({});
    setMessage(null);
    setView("rename");
    invoke("island_focus").catch(() => {});
  }, []);

  // Buka tampilan Properti dan ambil datanya dari Rust
  const openProps = useCallback(async (list: FileItem[]) => {
    const id = ++propsSeq.current;

    window.clearTimeout(closeTimer.current);
    setArmedId(null);
    setStatus({});
    setMessage(null);
    setView("props");
    setPropsState({ loading: true });

    try {
      const data = await invoke<FileProps>("file_properties", {
        paths: list.map((i) => i.path),
      });

      if (id !== propsSeq.current) return;
      setPropsState({ loading: false, data });
    } catch (e) {
      if (id !== propsSeq.current) return;
      setPropsState({
        loading: false,
        error: errorText(e, "Gagal membaca properti"),
      });
    }
  }, []);

  // Kembali dari Rename / Properti ke menu kotak-kotak
  const backToMenu = useCallback(() => {
    propsSeq.current += 1;
    setView("menu");
    setPropsState(null);
    setMessage(null);
    setStatus({});
  }, []);

  // Jalankan satu aksi di Rust
  const execute = useCallback(
    async (actionId: string, list: FileItem[]) => {
      const action = buildActions(list, toolsRef.current).find(
        (a) => a.id === actionId,
      );
      if (!action || list.length === 0) return;

      // Rename dan Properti punya tampilan sendiri, bukan aksi satu klik
      if (actionId === "rename") {
        openRename();
        return;
      }

      if (actionId === "props") {
        void openProps(list);
        return;
      }

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

        if (actionId === "copy" || actionId === "cut") {
          // Tombol Paste menggantung di island sampai ditekan
          window.clearTimeout(pasteTimer.current);
          setPaste({ items: list, mode: actionId, phase: "ready" });
          closeTimer.current = window.setTimeout(clear, COPY_HOLD_MS);
          return;
        }

        if (!QUIET_ACTIONS.has(actionId)) playSound("checklist");
        closeTimer.current = window.setTimeout(clear, CLOSE_AFTER_DONE_MS);
      } catch (e) {
        setStatus({ [actionId]: "error" });
        setMessage(errorText(e, "Aksi gagal"));
      }
    },
    [clear, openRename, openProps],
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

  // Tombol "Ganti nama" di tampilan Rename
  const renameRun = useCallback(
    async (newName: string) => {
      const list = itemsRef.current;
      if (list.length === 0 || renameBusy.current) return;

      renameBusy.current = true;
      window.clearTimeout(closeTimer.current);
      setMessage(null);
      setStatus({ rename: "running" });

      try {
        const res = await invoke<RenameResult>("file_rename", {
          paths: list.map((i) => i.path),
          newName,
        });

        // Path berubah: baca ulang supaya island menampilkan nama baru
        const fresh = await inspect(res.paths).catch(() => [] as FileItem[]);
        if (fresh.length > 0) setItems(fresh);

        setView("menu");
        setStatus({ rename: "done" });
        setMessage(res.message);
        playSound("checklist");
        closeTimer.current = window.setTimeout(clear, CLOSE_AFTER_DONE_MS);
      } catch (e) {
        // Tetap di tampilan Rename supaya nama bisa diperbaiki
        setStatus({});
        setMessage(errorText(e, "Gagal mengganti nama"));
      } finally {
        renameBusy.current = false;
      }
    },
    [clear],
  );

  // Tombol Paste: pilih folder, lalu tempel file ke sana
  const pasteRun = useCallback(async () => {
    const cur = pasteRef.current;
    if (!cur) return;
    if (cur.phase !== "ready" && cur.phase !== "error") return;
    if (pasteBusy.current) return;

    pasteBusy.current = true;
    window.clearTimeout(pasteTimer.current);

    const paths = cur.items.map((i) => i.path);

    // Hasil async dibuang bila pil sudah diganti (disalin ulang / ditutup)
    const stale = () => pasteRef.current?.items !== cur.items;

    try {
      setPaste({ ...cur, phase: "picking", message: undefined });

      let dest: string | null;

      try {
        dest = await invoke<string | null>("file_pick_folder", {
          start: paths[0],
        });
      } catch (e) {
        if (stale()) return;
        setPaste({
          ...cur,
          phase: "error",
          message: errorText(e, "Gagal membuka dialog"),
        });
        return;
      }

      if (stale()) return;

      // Dialog dibatalkan: pil tetap menggantung
      if (!dest) {
        setPaste({ ...cur, phase: "ready" });
        return;
      }

      setPaste({ ...cur, phase: "running", dest, message: undefined });

      try {
        const res = await invoke<ActionResult>("file_paste", {
          paths,
          dest,
          cut: cur.mode === "cut",
        });

        if (stale()) return;

        playSound("checklist");
        setPaste({ ...cur, phase: "done", dest, message: res.message });
        pasteTimer.current = window.setTimeout(
          () => setPaste(null),
          PASTE_DONE_MS,
        );
      } catch (e) {
        if (stale()) return;
        setPaste({
          ...cur,
          phase: "error",
          dest,
          message: errorText(e, "Gagal menempel"),
        });
      }
    } finally {
      pasteBusy.current = false;
    }
  }, []);

  // Tutup pil Paste tanpa menempel
  const pasteDismiss = useCallback(() => {
    const cur = pasteRef.current;
    if (!cur || cur.phase === "picking" || cur.phase === "running") return;

    window.clearTimeout(pasteTimer.current);
    setPaste(null);
  }, []);

  // Siapkan suara sekali saja
  useEffect(() => {
    void preloadSounds();
  }, []);

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

              propsSeq.current += 1;
              setItems(list);
              setStatus({});
              setMessage(null);
              setArmedId(null);
              setView("menu");
              setPropsState(null);
              setHovering(true);
              setHover(actionAt(p.position));
            } catch (e) {
              console.error("Gagal membaca file yang diseret:", e);
            }
            break;
          }

          case "over":
            setHover(actionAt(p.position));
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

            playSound("drop");

            try {
              let list = itemsRef.current;
              if (!samePaths(list, p.paths)) list = await inspect(p.paths);
              if (id !== seq.current || list.length === 0) return;

              setItems(list);
              setStatus({});
              setMessage(null);
              setHovering(false);
              hoverRef.current = null;
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
  }, [clear, setHover]);

  useEffect(
    () => () => {
      window.clearTimeout(closeTimer.current);
      window.clearTimeout(pasteTimer.current);
    },
    [],
  );

  return {
    items,
    actions,
    hovering,
    hoverId,
    armedId,
    status,
    message,
    paste,
    view,
    propsState,
    active: hovering || items.length > 0,
    run,
    clear,
    back: backToMenu,
    renameRun,
    pasteRun,
    pasteDismiss,
  };
}

export type FileIsland = ReturnType<typeof useFileIsland>;
