/**
 * FilePastePill.tsx
 * Isi pil island untuk file yang sudah disalin / dipotong: menggantung di island
 * sampai tombol Paste ditekan (lalu pilih folder tujuan) atau ditutup dengan X.
 *
 * Seperti Windows saat menyeret file, ada tulisan "+ Copy" (atau "Move" untuk Potong),
 * dan saat menempel jadi "+ Copy to <folder>".
 *
 * Komponen ini hanya menggambar; logikanya ada di useFileIsland.ts.
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ClipboardPaste, Loader2, X } from "lucide-react";
import { describeItems, KIND_ICON } from "./catalog";
import type { PendingPaste } from "./useFileIsland";

// Lebar pil saat compact (dipakai DynamicIsland)
export const PASTE_PILL_WIDTH = 296;

// Nama folder terakhir dari path, mis. "C:\\Users\\Aku\\Documents" -> "Documents"
function folderName(path?: string): string {
  if (!path) return "";

  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

interface FilePastePillProps {
  paste: PendingPaste;
  onPaste: () => void;
  onDismiss: () => void;
}

export const FilePastePill: React.FC<FilePastePillProps> = ({
  paste,
  onPaste,
  onDismiss,
}) => {
  const { items, mode, phase, dest, message } = paste;
  const { title, subtitle, kind } = describeItems(items);
  const KindIcon = KIND_ICON[kind];

  const label = mode === "cut" ? "Move" : "+ Copy";
  const target = folderName(dest);
  const busy = phase === "picking" || phase === "running";
  const canAct = phase === "ready" || phase === "error";

  // Baris kedua: tulisan Copy + keterangan sesuai keadaan
  let detail: string;
  if (phase === "picking") detail = "Pilih folder…";
  else if (phase === "running") detail = target ? `to ${target}` : "";
  else if (phase === "done") detail = message ?? "Selesai";
  else if (phase === "error") detail = message ?? "Gagal menempel";
  else detail = subtitle;

  return (
    <div
      className="flex h-full w-full items-center gap-2 px-[6px] text-white"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] bg-white/10">
        <KindIcon size={14} className="text-white/85" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] font-semibold leading-none tracking-[-0.01em]">
          {title}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${phase}-${detail}`}
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={{ duration: 0.14 }}
            className="mt-[4px] flex items-center gap-[5px] leading-none"
          >
            {phase === "done" ? (
              <Check size={11} strokeWidth={3} className="shrink-0 text-emerald-300" />
            ) : (
              <span className="shrink-0 rounded-[5px] bg-sky-400/20 px-[5px] py-[2px] text-[9px] font-semibold text-sky-200">
                {label}
              </span>
            )}

            <span
              className={`truncate text-[10px] ${
                phase === "error" ? "text-red-300" : "text-white/50"
              }`}
            >
              {detail}
            </span>
          </motion.div>
        </AnimatePresence>
      </div>

      {busy && <Loader2 size={17} className="mr-1 shrink-0 animate-spin text-white/80" />}

      {canAct && (
        <>
          <motion.button
            type="button"
            aria-label="Paste"
            onClick={(e) => {
              e.stopPropagation();
              onPaste();
            }}
            onMouseDown={(e) => e.preventDefault()}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 520, damping: 28 }}
            className="flex h-[26px] shrink-0 items-center gap-[5px] rounded-full bg-sky-400 pl-[9px] pr-[11px] text-[11px] font-semibold text-[#050506] transition-colors hover:bg-sky-300 focus:outline-none"
          >
            <ClipboardPaste size={13} strokeWidth={2.4} />
            Paste
          </motion.button>

          <button
            type="button"
            aria-label="Tutup"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-white/50 transition hover:bg-white/10 hover:text-white active:scale-90"
          >
            <X size={13} />
          </button>
        </>
      )}

      {phase === "done" && (
        <Check size={17} strokeWidth={2.6} className="mr-1 shrink-0 text-emerald-300" />
      )}
    </div>
  );
};

export default FilePastePill;
