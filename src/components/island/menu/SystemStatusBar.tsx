// SystemStatusBar.tsx
// baris status di atas menu island
// kiri: kecepatan unduh (angka + satuan), tengah: hari + tanggal + jam, kanan: wifi + bluetooth + baterai
// tengah tepat di tengah saat diam; saat nama wifi / bluetooth melebar,
// kolom kanan membesar dan jam ikut bergeser ke kiri
// ikon muncul dulu, lalu nama geser keluar, lalu menciut (keluar lagi saat hover)

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import wifiIcon from "../../../assets/styles/menu_icons/wifi.svg";
import bluetoothIcon from "../../../assets/styles/menu_icons/bluetooth.svg";
import type { BatteryInfo, NetSpeed, RadiosStatus } from "./useSystemStatus";

const GREEN = "#4ADE80";
const RED = "#F87171";

// lebar badan ikon baterai
const BODY_W = 23;

// byte per detik -> teks pendek
// dipecah jadi [angka, satuan], mis. ["128", "KB/s"]
function fmtSpeedParts(bps: number): [string, string] {
  if (bps < 1024) return [String(Math.round(bps)), "B/s"];
  const kb = bps / 1024;
  if (kb < 1024)
    return [kb < 10 ? kb.toFixed(1) : String(Math.round(kb)), "KB/s"];
  const mb = kb / 1024;
  return [mb < 10 ? mb.toFixed(1) : String(Math.round(mb)), "MB/s"];
}

const fmtSpeed = (bps: number): string => fmtSpeedParts(bps).join(" ");

// kecepatan unduh di kiri: angka + satuan, putih
const Speed: React.FC<{ net: NetSpeed }> = ({ net }) => {
  const [value, unit] = fmtSpeedParts(net.down);

  return (
    <div
      title={`Unduh ${fmtSpeed(net.down)}`}
      className="flex shrink-0 items-baseline gap-[3px] whitespace-nowrap leading-none tabular-nums"
    >
      <span className="text-[11px] font-semibold text-white">{value}</span>
      <span className="text-[9px] font-medium text-white/55">{unit}</span>
    </div>
  );
};

// hari, tanggal, dan jam

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const DAYS_FULL = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];
const MONTHS_FULL = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const pad2 = (n: number) => String(n).padStart(2, "0");

// waktu sekarang, diperbarui tepat saat menit berganti
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: number;
    const untilNextMinute = () => 60000 - (Date.now() % 60000) + 20;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, untilNextMinute());
    };

    timer = window.setTimeout(tick, untilNextMinute());
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}

// contoh: Kam 30 Nov | 16:20
const Clock: React.FC = () => {
  const now = useMinute();
  const day = DAYS[now.getDay()];
  const date = now.getDate();
  const month = MONTHS[now.getMonth()];
  const full = `${DAYS_FULL[now.getDay()]}, ${date} ${MONTHS_FULL[now.getMonth()]} ${now.getFullYear()}`;

  return (
    <div
      title={full}
      className="flex shrink-0 select-none items-baseline gap-[7px] whitespace-nowrap leading-none"
    >
      <span className="text-[10.5px] font-medium tracking-wide text-white/45">
        {day}
      </span>
      <span className="text-[11px] font-medium tabular-nums text-white/75">
        {date} {month}
      </span>
      <span className="text-[13px] font-semibold tabular-nums tracking-tight text-white">
        {pad2(now.getHours())}
        <span className="relative -top-px px-[0.5px] text-white/50">:</span>
        {pad2(now.getMinutes())}
      </span>
    </div>
  );
};

// jeda ikon muncul sebelum nama keluar
const INTRO_DELAY_MS = 450;
// lama nama tampil sebelum menciut
const INTRO_MS = 2000;

// chip ikon: ikon muncul dulu, lalu nama geser keluar, lalu menciut
// nama keluar lagi saat hover
const Chip: React.FC<{
  icon: string;
  label: string;
  dim?: boolean;
}> = ({ icon, label, dim }) => {
  const [hover, setHover] = useState(false);
  const [intro, setIntro] = useState(false);
  const hasLabel = label !== "";
  const open = hasLabel && (intro || hover);

  // urutan saat chip muncul / nama baru tersedia
  useEffect(() => {
    if (!hasLabel) {
      setIntro(false);
      return;
    }
    const show = window.setTimeout(() => setIntro(true), INTRO_DELAY_MS);
    const hide = window.setTimeout(
      () => setIntro(false),
      INTRO_DELAY_MS + INTRO_MS,
    );
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [hasLabel]);

  return (
    <motion.span
      layout="position"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: dim ? 0.55 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 520, damping: 30 }}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      title={label || undefined}
      className="flex min-w-0 items-center px-0.5 py-[3px] text-[10.5px] font-medium leading-none text-white/90"
    >
      <img
        src={icon}
        alt=""
        draggable={false}
        className="h-[13px] w-[13px] shrink-0 select-none invert"
      />
      {/* nama */}
      {label && (
        <motion.span
          initial={false}
          animate={{ width: open ? "auto" : 0, opacity: open ? 1 : 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="overflow-hidden"
        >
          <span className="block max-w-[78px] truncate whitespace-nowrap pl-1">
            {label}
          </span>
        </motion.span>
      )}
    </motion.span>
  );
};

const Battery: React.FC<{ battery: BatteryInfo }> = ({ battery }) => {
  const { percent, charging, plugged } = battery;
  const green = charging || plugged;
  const low = percent <= 20 && !green;
  const color = green ? GREEN : low ? RED : "rgba(255,255,255,0.92)";
  const fillW = Math.max(5, (percent / 100) * BODY_W);

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

      <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true">
        <defs>
          <clipPath id="island-battery-body">
            <rect width={BODY_W} height="13" rx="4.4" />
          </clipPath>
        </defs>

        {/* ujung baterai */}
        <path
          d="M24.4 4.4 V8.6 A2.1 2.1 0 0 0 24.4 4.4 Z"
          fill={color}
          opacity="0.45"
        />

        <g clipPath="url(#island-battery-body)">
          {/* badan (sisa kosong, transparan) */}
          <rect width={BODY_W} height="13" fill={color} opacity="0.3" />

          {/* isi */}
          <motion.rect
            width={fillW}
            height="13"
            rx="4.4"
            fill={color}
            animate={charging ? { opacity: [0.7, 1, 0.7] } : { opacity: 1 }}
            transition={
              charging
                ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
                : { duration: 0.2 }
            }
          />

          {/* kilau berjalan saat mengisi */}
          {charging && (
            <motion.rect
              y="0"
              width="8"
              height="13"
              fill="white"
              opacity="0.4"
              initial={{ x: -9 }}
              animate={{ x: 24 }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                ease: "easeInOut",
                repeatDelay: 0.3,
              }}
            />
          )}
        </g>

        {/* petir */}
        {charging && (
          <motion.path
            d="M12.9 2.4 L8.5 7.3 H11.4 L10.5 10.6 L14.9 5.7 H12 Z"
            fill="#052e16"
            stroke="#052e16"
            strokeWidth="0.4"
            strokeLinejoin="round"
            animate={{ scale: [1, 1.12, 1] }}
            style={{ transformOrigin: "11.7px 6.5px" }}
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
    bt.length === 0
      ? ""
      : bt.length === 1
        ? bt[0]
        : `${bt[0]} +${bt.length - 1}`;

  // Tiga kolom: kiri dan kanan sama lebar (jam tepat di tengah).
  // Saat isi kolom kanan melebar (nama wifi / bluetooth), kolom itu
  // membesar dan jam ikut bergeser ke kiri.
  return (
    <div className="grid h-[24px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2">
      <div className="flex items-center justify-start">
        <Speed net={net} />
      </div>

      <Clock />

      {/* wifi + bluetooth + baterai */}
      <div className="flex items-center justify-end gap-2">
        <AnimatePresence>
          {radios.wifiOn && (
            <Chip
              key="wifi"
              icon={wifiIcon}
              label={radios.ssid ?? ""}
              dim={!radios.ssid}
            />
          )}
          {radios.bluetoothOn && (
            <Chip
              key="bt"
              icon={bluetoothIcon}
              label={btLabel}
              dim={bt.length === 0}
            />
          )}
        </AnimatePresence>
        {battery.present && <Battery battery={battery} />}
      </div>
    </div>
  );
};
