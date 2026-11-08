/**
 * FileActionsPanel.tsx
 * Tampilan menu kotak-kotak di dalam island saat file / folder diseret.
 * Komponen ini hanya menggambar; logikanya ada di useFileIsland.ts dan catalog.ts.
 *
 * Setiap kotak punya atribut data-action-id. Hook memakai atribut itu untuk
 * mengetahui kotak mana yang ada di bawah kursor saat file diseret / dilepas.
 *
 * Panel punya tiga tampilan (prop `view`):
 *   "menu"   -> kotak-kotak aksi
 *   "rename" -> kolom ganti nama
 *   "props"  -> daftar properti
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check, Loader2, X } from "lucide-react";
import { describeItems, formatSize, KIND_ICON } from "./catalog";
import type { FileAction, FileItem } from "./catalog";
import type {
  FileProps,
  PanelView,
  PropsState,
  TileStatus,
} from "./useFileIsland";

const COLS = 4;
const MIN_ROWS = 2; // supaya tampilan Rename / Properti selalu cukup tinggi
const TILE_H = 62;
const GAP = 8;
const HEADER_H = 54;
const PAD = 18;
const PANEL_W = 360;

// Ukuran island saat panel terbuka (dipakai DynamicIsland)
export function getFilePanelSize(actionCount: number): {
  width: number;
  height: number;
} {
  const rows = Math.max(MIN_ROWS, Math.ceil(actionCount / COLS));

  return {
    width: PANEL_W,
    height: PAD + HEADER_H + rows * TILE_H + (rows - 1) * GAP + PAD,
  };
}

// Tulisan saat kotak ini disorot ketika file diseret
const HOVER_HINT: Record<string, string> = {
  copy: "+ Copy",
  cut: "Move",
  rename: "Ganti nama",
  props: "Lihat properti",
  img_rmbg: "Hapus latar",
  pdf_shrink: "Perkecil PDF",
};

const TONE: Record<FileAction["tone"], string> = {
  neutral: "bg-white/[0.09] text-white/90",
  accent: "bg-sky-400/[0.17] text-sky-100",
  danger: "bg-red-500/[0.17] text-red-200",
};

const TONE_ACTIVE: Record<FileAction["tone"], string> = {
  neutral: "bg-white/[0.24] text-white ring-2 ring-white/70",
  accent: "bg-sky-400/[0.38] text-white ring-2 ring-sky-200/80",
  danger: "bg-red-500/[0.38] text-white ring-2 ring-red-300/80",
};

const Tile: React.FC<{
  action: FileAction;
  index: number;
  status?: TileStatus;
  active: boolean; // kursor / drag sedang di atas kotak ini
  armed: boolean; // aksi berbahaya menunggu klik
  onRun: (id: string) => void;
}> = ({ action, index, status, active, armed, onRun }) => {
  const { Icon } = action;
  const lit = active || armed;

  return (
    // Pembungkus: animasi muncul berurutan
    <motion.div
      initial={{ opacity: 0, scale: 0.55, y: 12, filter: "blur(6px)" }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        filter: "blur(0px)",
        transition: {
          type: "spring",
          stiffness: 380,
          damping: 24,
          delay: 0.05 + index * 0.024,
        },
      }}
    >
      {/* Kotak: membesar saat disorot, mengecil saat ditekan */}
      <motion.button
        type="button"
        data-action-id={action.id}
        aria-label={action.label}
        onClick={(e) => {
          e.stopPropagation();
          onRun(action.id);
        }}
        onMouseDown={(e) => e.preventDefault()}
        animate={{ scale: lit ? 1.09 : 1 }}
        whileTap={{ scale: 0.92 }}
        transition={{ type: "spring", stiffness: 520, damping: 28 }}
        className={`flex w-full flex-col items-center justify-center gap-[5px] rounded-[18px] text-[10.5px] font-medium leading-none transition-colors duration-150 focus:outline-none ${
          lit ? TONE_ACTIVE[action.tone] : TONE[action.tone]
        }`}
        style={{ height: TILE_H }}
      >
        <span className="flex h-[22px] items-center justify-center">
          {status === "running" ? (
            <Loader2 size={19} className="animate-spin" />
          ) : status === "done" ? (
            <Check size={20} strokeWidth={2.6} className="text-emerald-300" />
          ) : status === "error" ? (
            <X size={20} strokeWidth={2.6} className="text-red-300" />
          ) : (
            <Icon size={19} strokeWidth={2} />
          )}
        </span>

        <span className="max-w-full truncate px-1">
          {armed ? "Yakin?" : action.label}
        </span>
      </motion.button>
    </motion.div>
  );
};

// ---------------------------------------------------------------------------
// Tampilan Rename
// ---------------------------------------------------------------------------

// Nama tanpa ekstensi (folder: nama utuh)
const stemOf = (it: FileItem) =>
  it.isDir || !it.ext
    ? it.name
    : it.name.slice(0, it.name.length - it.ext.length - 1);

const RenameView: React.FC<{
  items: FileItem[];
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}> = ({ items, busy, onSubmit, onCancel }) => {
  const single = items.length === 1;
  const first = items[0];

  // Satu item: nama lengkap. Banyak item: nama dasar (nomor ditambah otomatis).
  const [value, setValue] = useState(single ? first.name : stemOf(first));
  const inputRef = useRef<HTMLInputElement>(null);

  // Fokus ke kolom, blok nama tanpa ekstensi (seperti Rename di Explorer)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;

      el.focus();
      const keepExt = single && !first.isDir && first.ext;
      el.setSelectionRange(
        0,
        keepExt ? first.name.length - first.ext.length - 1 : el.value.length,
      );
    }, 80);

    return () => window.clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    const v = value.trim();
    if (!v || busy) return;
    onSubmit(v);
  };

  const sampleExt = !first.isDir && first.ext ? `.${first.ext}` : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between">
      <div>
        <input
          ref={inputRef}
          value={value}
          disabled={busy}
          spellCheck={false}
          placeholder={single ? "Nama baru" : "Nama dasar"}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();

            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="h-[42px] w-full rounded-[14px] bg-white/10 px-3 text-[13px] text-white outline-none ring-1 ring-white/15 transition placeholder:text-white/35 focus:ring-sky-300/70 disabled:opacity-60"
        />

        {!single && (
          <div className="mt-[6px] truncate px-1 text-[11px] text-white/45">
            Hasil: {value.trim() || "nama"} (1){sampleExt}, (2)…
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-[38px] items-center justify-center rounded-[13px] bg-white/[0.09] text-[12px] font-medium text-white/85 transition hover:bg-white/[0.16] active:scale-95"
        >
          Batal
        </button>

        <button
          type="button"
          onClick={submit}
          onMouseDown={(e) => e.preventDefault()}
          disabled={busy || !value.trim()}
          className="flex h-[38px] items-center justify-center gap-2 rounded-[13px] bg-sky-400/[0.3] text-[12px] font-semibold text-white transition hover:bg-sky-400/[0.45] active:scale-95 disabled:opacity-50"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Ganti nama
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tampilan Properti
// ---------------------------------------------------------------------------

const fmtDate = (ms: number | null) =>
  ms == null
    ? "-"
    : new Date(ms).toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

function propRows(d: FileProps): [string, string][] {
  // Banyak item: ringkasan saja
  if (d.count > 1) {
    return [
      ["Item", `${d.count} item`],
      ["Isi", `${d.files} file, ${d.folders} folder${d.approx ? "+" : ""}`],
      ["Ukuran", formatSize(d.size)],
    ];
  }

  const attrs = [d.readOnly && "Hanya-baca", d.hidden && "Tersembunyi"]
    .filter(Boolean)
    .join(", ");

  const kind = d.isDir
    ? "Folder"
    : d.ext
      ? `File ${d.ext.toUpperCase()}`
      : "File";

  const size = d.isDir
    ? `${formatSize(d.size)} · ${d.files} file, ${d.folders} folder${d.approx ? "+" : ""}`
    : d.extra
      ? `${formatSize(d.size)} · ${d.extra}`
      : formatSize(d.size);

  return [
    ["Jenis", attrs ? `${kind} · ${attrs}` : kind],
    ["Ukuran", size],
    ["Dibuat", fmtDate(d.createdMs)],
    ["Diubah", fmtDate(d.modifiedMs)],
    ["Diakses", fmtDate(d.accessedMs)],
  ];
}

const PropsView: React.FC<{ state: PropsState | null }> = ({ state }) => {
  if (!state || state.loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-white/60">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  if (state.error || !state.data) {
    return (
      <div className="flex flex-1 items-center justify-center px-2 text-center text-[12px] text-red-200">
        {state.error ?? "Gagal membaca properti"}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
      {propRows(state.data).map(([label, value]) => (
        <div
          key={label}
          className="flex shrink-0 items-baseline gap-3 text-[11.5px] leading-tight"
          style={{ height: 21 }}
        >
          <span className="w-[50px] shrink-0 text-white/45">{label}</span>
          <span className="min-w-0 flex-1 truncate text-white/90" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface FileActionsPanelProps {
  items: FileItem[];
  actions: FileAction[];
  hovering: boolean; // file masih diseret
  hoverId: string | null;
  armedId: string | null;
  status: Record<string, TileStatus>;
  message: string | null;
  view: PanelView;
  propsState: PropsState | null;
  onRun: (id: string) => void;
  onRename: (name: string) => void;
  onBack: () => void;
  onClose: () => void;
}

export const FileActionsPanel: React.FC<FileActionsPanelProps> = ({
  items,
  actions,
  hovering,
  hoverId,
  armedId,
  status,
  message,
  view,
  propsState,
  onRun,
  onRename,
  onBack,
  onClose,
}) => {
  const { title, subtitle, kind } = describeItems(items);
  const KindIcon = KIND_ICON[kind];

  // Keterangan di bawah judul berganti sesuai keadaan
  // (saat Salin / Potong disorot: "+ Copy" / "Move", seperti saat menyeret file di Windows)
  let hint: string;

  if (message) hint = message;
  else if (view === "rename")
    hint =
      items.length === 1 ? "Ketik nama baru" : "Nama dasar + nomor otomatis";
  else if (view === "props") hint = "Properti";
  else if (hovering)
    hint = (hoverId && HOVER_HINT[hoverId]) || "Lepas di salah satu kotak";
  else hint = subtitle;

  return (
    <div
      className="flex h-full w-full flex-col text-white"
      style={{ padding: PAD }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div
        className="flex shrink-0 items-start gap-3"
        style={{ height: HEADER_H }}
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-white/10 ring-1 ring-white/10">
          <KindIcon size={20} className="text-white/85" />
        </div>

        <div className="min-w-0 flex-1 pt-[2px]">
          <div className="truncate text-[14px] font-semibold leading-tight tracking-[-0.02em]">
            {title}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={hint}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16 }}
              title={hint}
              className="mt-[3px] text-[11.5px] leading-tight text-white/50"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {hint}
            </motion.div>
          </AnimatePresence>
        </div>

        {!hovering && (
          <div className="flex shrink-0 items-center">
            {view !== "menu" && (
              <button
                type="button"
                aria-label="Kembali"
                onClick={(e) => {
                  e.stopPropagation();
                  onBack();
                }}
                onMouseDown={(e) => e.preventDefault()}
                className="flex h-7 w-7 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white active:scale-90"
              >
                <ArrowLeft size={16} />
              </button>
            )}

            <button
              type="button"
              aria-label="Tutup"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              onMouseDown={(e) => e.preventDefault()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white active:scale-90"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Isi: kotak aksi / Rename / Properti */}
      {view === "rename" ? (
        <RenameView
          items={items}
          busy={status.rename === "running"}
          onSubmit={onRename}
          onCancel={onBack}
        />
      ) : view === "props" ? (
        <PropsView state={propsState} />
      ) : (
        <div
          className="grid"
          style={{
            gap: GAP,
            gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
          }}
        >
          {actions.map((action, i) => (
            <Tile
              key={action.id}
              action={action}
              index={i}
              status={status[action.id]}
              active={hoverId === action.id}
              armed={armedId === action.id}
              onRun={onRun}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default FileActionsPanel;
