/**
 * FileActionsPanel.tsx
 * Tampilan menu kotak-kotak di dalam island saat file / folder diseret.
 * Komponen ini hanya menggambar; logikanya ada di useFileIsland.ts dan catalog.ts.
 *
 * Setiap kotak punya atribut data-action-id. Hook memakai atribut itu untuk
 * mengetahui kotak mana yang ada di bawah kursor saat file diseret / dilepas.
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, X } from "lucide-react";
import { describeItems, KIND_ICON } from "./catalog";
import type { FileAction, FileItem } from "./catalog";
import type { TileStatus } from "./useFileIsland";

const COLS = 4;
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
  const rows = Math.max(1, Math.ceil(actionCount / COLS));

  return {
    width: PANEL_W,
    height: PAD + HEADER_H + rows * TILE_H + (rows - 1) * GAP + PAD,
  };
}

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

interface FileActionsPanelProps {
  items: FileItem[];
  actions: FileAction[];
  hovering: boolean; // file masih diseret
  hoverId: string | null;
  armedId: string | null;
  status: Record<string, TileStatus>;
  message: string | null;
  onRun: (id: string) => void;
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
  onRun,
  onClose,
}) => {
  const { title, subtitle, kind } = describeItems(items);
  const KindIcon = KIND_ICON[kind];

  // Keterangan di bawah judul berganti sesuai keadaan
  const hint = message ?? (hovering ? "Lepas di salah satu kotak" : subtitle);

  return (
    <div
      className="flex h-full w-full flex-col text-white"
      style={{ padding: PAD }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex shrink-0 items-start gap-3" style={{ height: HEADER_H }}>
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
              className="mt-[3px] truncate text-[11.5px] leading-tight text-white/50"
            >
              {hint}
            </motion.div>
          </AnimatePresence>
        </div>

        {!hovering && (
          <button
            type="button"
            aria-label="Tutup"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onMouseDown={(e) => e.preventDefault()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Kotak-kotak aksi */}
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
    </div>
  );
};

export default FileActionsPanel;
