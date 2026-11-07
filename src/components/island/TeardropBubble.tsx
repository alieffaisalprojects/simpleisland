import React from "react";
import { motion } from "framer-motion";

interface TeardropBubbleProps {
  icon: React.ReactNode;
  label?: string;
  onClick?: () => void;
}

export const TeardropBubble: React.FC<TeardropBubbleProps> = ({ icon, label, onClick }) => (
  <motion.button
    type="button"
    initial={{ scale: 0.72, opacity: 0, x: -5 }}
    animate={{ scale: 1, opacity: 1, x: 0 }}
    exit={{ scale: 0.72, opacity: 0, x: -5 }}
    whileTap={{ scale: 0.94 }}
    transition={{ type: "spring", stiffness: 520, damping: 34, mass: 0.7 }}
    onClick={(event) => { event.stopPropagation(); onClick?.(); }}
    onMouseDown={(event) => event.preventDefault()}
    className="flex h-[34px] max-w-[150px] items-center justify-center gap-1.5 rounded-full border border-white/[0.09] bg-[#080809] px-3 text-white shadow-[0_8px_24px_rgba(0,0,0,.32)]"
  >
    <span className="shrink-0">{icon}</span>
    {label && <span className="max-w-[92px] truncate text-[10px] font-semibold tabular-nums">{label}</span>}
  </motion.button>
);
