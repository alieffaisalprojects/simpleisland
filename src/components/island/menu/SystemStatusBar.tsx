/**
 * File: SystemStatusBar.tsx
 * Kegunaan: baris status di atas menu island.
 * Kiri: kecepatan jaringan. Tengah: Wi-Fi / Bluetooth aktif + nama.
 * Kanan: baterai + persen (hijau dan beranimasi saat diisi).
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp } from "lucide-react";
import wifiIcon from "../../../assets/styles/menu_icons/wifi.svg";
import bluetoothIcon from "../../../assets/styles/menu_icons/bluetooth.svg";
import type { BatteryInfo, NetSpeed, RadiosStatus } from "./useSystemStatus";

const GREEN = "#4ADE80";
const RED = "#F87171";

// byte per detik -> teks pendek
function fmtSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  const kb = bps / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB/s`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB/s`;
}

const Speed: React.FC<{ net: NetSpeed }> = ({ net }) => (
  <div className="flex w-[64px] shrink-0 flex-col justify-center text-[9.5px] font-medium leading-[11px] tabular-nums text-white/70">
    <span className="flex items-center gap-[2px]">
      <ArrowDown size={9} strokeWidth={3} className="shrink-0 text-sky-300" />
      <span className="truncate">{fmtSpeed(net.down)}</span>
    </span>
    <span className="flex items-center gap-[2px]">
      <ArrowUp size={9} strokeWidth={3} className="shrink-0 text-emerald-300" />
      <span className="truncate">{fmtSpeed(net.up)}</span>
    </span>
  </div>
);

const Chip: React.FC<{ icon: string; label: string; dim?: boolean }> = ({
  icon,
  label,
  dim,
}) => (
  <motion.span
    layout
    initial={{ opacity: 0, scale: 0.8 }}
    animate={{ opacity: dim ? 0.55 : 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.8 }}
    transition={{ type: "spring", stiffness: 520, damping: 30 }}
    className="flex min-w-0 items-center gap-1 rounded-full bg-white/[0.09] px-2 py-[3px] text-[10.5px] font-medium leading-none text-white/90"
  >
    <img
      src={icon}
      alt=""
      draggable={false}
      className="h-[13px] w-[13px] shrink-0 select-none invert"
    />
    {label && <span className="max-w-[78px] truncate">{label}</span>}
  </motion.span>
);

const Battery: React.FC<{ battery: BatteryInfo }> = ({ battery }) => {
  const { percent, charging, plugged } = battery;
  const green = charging || plugged;
  const low = percent <= 20 && !green;
  const color = green ? GREEN : low ? RED : "rgba(255,255,255,0.92)";
  const fillW = Math.max(1.5, (percent / 100) * 18);

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      title={`Baterai ${percent}%${charging ? " (mengisi)" : ""}`}
    >
      <span
        className="text-[11px] font-semibold tabular-nums leading-none"
        style={{ color }}
      >
        {percent}%
      </span>

      <svg width="26" height="13" viewBox="0 0 26 13" aria-hidden="true">
        <defs>
          <clipPath id="island-battery-fill">
            <rect x="2" y="2" width={fillW} height="9" rx="1.6" />
          </clipPath>
        </defs>

        {/* badan + ujung baterai */}
        <rect
          x="0.75"
          y="0.75"
          width="21.5"
          height="11.5"
          rx="3"
          fill="none"
          stroke={color}
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />
        <rect x="23.4" y="4" width="2" height="5" rx="1" fill={color} opacity="0.55" />

        {/* isi */}
        <motion.rect
          x="2"
          y="2"
          width={fillW}
          height="9"
          rx="1.6"
          fill={color}
          animate={charging ? { opacity: [0.65, 1, 0.65] } : { opacity: 1 }}
          transition={
            charging
              ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />

        {/* kilau berjalan saat mengisi */}
        {charging && (
          <g clipPath="url(#island-battery-fill)">
            <motion.rect
              y="2"
              width="7"
              height="9"
              fill="white"
              opacity="0.45"
              initial={{ x: -8 }}
              animate={{ x: 22 }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                ease: "easeInOut",
                repeatDelay: 0.3,
              }}
            />
          </g>
        )}

        {/* petir */}
        {charging && (
          <motion.path
            d="M12.6 2.6 L8.6 7.2 H11.2 L10.4 10.4 L14.4 5.8 H11.8 Z"
            fill="#052e16"
            stroke="#052e16"
            strokeWidth="0.4"
            strokeLinejoin="round"
            animate={{ scale: [1, 1.12, 1] }}
            style={{ transformOrigin: "11.5px 6.5px" }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </svg>
    </div>
  );
};

export const SystemStatusBar: React.FC<{
  battery: BatteryInfo;
  net: NetSpeed;
  radios: RadiosStatus;
}> = ({ battery, net, radios }) => {
  const bt = radios.bluetoothConnected;
  const btLabel =
    bt.length === 0 ? "" : bt.length === 1 ? bt[0] : `${bt[0]} +${bt.length - 1}`;

  return (
    <div className="flex h-[24px] shrink-0 items-center gap-2">
      <Speed net={net} />

      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
        <AnimatePresence initial={false}>
          {radios.wifiOn && (
            <Chip key="wifi" icon={wifiIcon} label={radios.ssid ?? ""} dim={!radios.ssid} />
          )}
          {radios.bluetoothOn && (
            <Chip key="bt" icon={bluetoothIcon} label={btLabel} dim={bt.length === 0} />
          )}
        </AnimatePresence>
      </div>

      {battery.present ? <Battery battery={battery} /> : <div className="w-[64px]" />}
    </div>
  );
};