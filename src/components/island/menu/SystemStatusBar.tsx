// SystemStatusBar.tsx
// baris status di atas menu island
// kiri: jam, tengah: hari + tanggal, kanan: bluetooth + wifi + baterai (wifi menempel di kiri baterai)
// hari + tanggal tepat di tengah saat diam; saat nama wifi / bluetooth melebar,
// kolom kanan membesar dan hari + tanggal ikut bergeser ke kiri
// ikon langsung tampil, lalu nama geser keluar ke kiri ikon, lalu menciut (keluar lagi saat hover)

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import wifiIcon from "../../../assets/styles/menu_icons/wifi.svg";
import bluetoothIcon from "../../../assets/styles/menu_icons/bluetooth.svg";
import type { BatteryInfo, NetSpeed, RadiosStatus } from "./useSystemStatus";

const GREEN = "#4ADE80";
const RED = "#F87171";

// lebar badan ikon baterai
const BODY_W = 23;

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

const fullDate = (now: Date) =>
  `${DAYS_FULL[now.getDay()]}, ${now.getDate()} ${MONTHS_FULL[now.getMonth()]} ${now.getFullYear()}`;

// tengah, contoh: Kam 30 Nov
const DateText: React.FC = () => {
  const now = useMinute();

  return (
    <div
      title={fullDate(now)}
      className="flex shrink-0 select-none items-baseline gap-[6px] whitespace-nowrap leading-none"
    >
      <span className="text-[10.5px] font-medium tracking-wide text-white/45">
        {DAYS[now.getDay()]}
      </span>
      <span className="text-[11px] font-medium tabular-nums text-white/75">
        {now.getDate()} {MONTHS[now.getMonth()]}
      </span>
    </div>
  );
};

// kiri, contoh: 16:20
const TimeText: React.FC = () => {
  const now = useMinute();

  return (
    <div
      title={fullDate(now)}
      className="shrink-0 select-none whitespace-nowrap text-[13px] font-semibold leading-none tabular-nums tracking-tight text-white"
    >
      {pad2(now.getHours())}
      <span className="relative -top-px px-[0.5px] text-white/50">:</span>
      {pad2(now.getMinutes())}
    </div>
  );
};

// jeda sebelum nama keluar (ikon sudah tampil)
const INTRO_DELAY_MS = 450;
// lama nama tampil sebelum menciut
const INTRO_MS = 2000;

// animasi nama ala iOS: pegas tanpa memantul, memudar + blur tipis
const LABEL_SPRING = {
  type: "spring",
  stiffness: 300,
  damping: 34,
  mass: 1,
} as const;
// menciut (nama masuk lagi ke ikon): lebih pelan dari saat keluar
const LABEL_SPRING_OUT = {
  type: "spring",
  stiffness: 150,
  damping: 24.5,
  mass: 1,
} as const;
const LABEL_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// chip ikon: ikon langsung tampil, nama geser keluar lalu menciut
// nama keluar lagi saat hover
//
// - nama ada di KIRI ikon, jadi ikon tidak bergeser saat nama keluar / menciut
//   (ikon tetap di bawah kursor, hover tidak berkedip)
// - dibungkus React.memo dan tanpa layout="position": status sistem di-poll
//   tiap detik, tanpa memo semua chip ikut render ulang dan framer
//   menganimasikan selisih posisinya terus-menerus (ikon bergeser kiri-kanan)
const Chip = React.memo(function Chip({
  icon,
  label,
  dim,
}: {
  icon: string;
  label: string;
  dim?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [intro, setIntro] = useState(false);
  const hasLabel = label !== "";
  const open = hasLabel && (intro || hover);

  // urutan saat nama tersedia: jeda, tampil, lalu menciut
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
      initial={false} // ikon langsung tampil, tanpa animasi masuk
      animate={{ opacity: dim ? 0.55 : 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 520, damping: 30 }}
      onHoverStart={() => setHover(true)}
      onHoverEnd={() => setHover(false)}
      title={label || undefined}
      className="flex min-w-0 items-center px-0.5 py-[3px] text-[10.5px] font-medium leading-none text-white/90"
    >
      {/* nama (di kiri ikon) */}
      {label && (
        <motion.span
          initial={false}
          animate={{
            width: open ? "auto" : 0,
            opacity: open ? 1 : 0,
            filter: open ? "blur(0px)" : "blur(4px)",
          }}
          transition={{
            width: open ? LABEL_SPRING : LABEL_SPRING_OUT,
            // keluar: teks muncul setelah ruangnya mulai terbuka
            // menciut: teks memudar pelan sambil ruangnya menutup
            opacity: open
              ? { duration: 0.34, delay: 0.05, ease: LABEL_EASE }
              : { duration: 0.45, ease: "easeInOut" },
            filter: open
              ? { duration: 0.34, delay: 0.05, ease: LABEL_EASE }
              : { duration: 0.45, ease: "easeInOut" },
          }}
          className="overflow-hidden"
        >
          <motion.span
            initial={false}
            animate={{ x: open ? 0 : 8 }}
            transition={open ? LABEL_SPRING : LABEL_SPRING_OUT}
            className="block max-w-[78px] truncate whitespace-nowrap pr-1"
          >
            {label}
          </motion.span>
        </motion.span>
      )}
      <img
        src={icon}
        alt=""
        draggable={false}
        className="h-[13px] w-[13px] shrink-0 select-none invert"
      />
    </motion.span>
  );
});

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

        {/* petir ala iPhone: putih dengan kontur gelap, terlihat di atas isi
            maupun bagian kosong. Muncul saat mengisi atau terhubung ke charger
            (mis. baterai sudah penuh tapi charger masih tertancap) */}
        {green && (
          <motion.path
            d="M13.4 1.6 L7.6 7.2 H11 L10 11.4 L15.8 5.6 H12.3 Z"
            fill="#ffffff"
            stroke="#0b0b0c"
            strokeWidth="1.2"
            strokeLinejoin="round"
            paintOrder="stroke"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            style={{ transformOrigin: "11.7px 6.5px" }}
          />
        )}
      </svg>
    </div>
  );
};

export const SystemStatusBar: React.FC<{
  battery: BatteryInfo;
  /** tidak dipakai lagi (kecepatan unduh dihapus); dibiarkan agar pemanggil lama tidak error */
  net?: NetSpeed;
  radios: RadiosStatus;
}> = ({ battery, radios }) => {
  const bt = radios.bluetoothConnected;
  const btLabel =
    bt.length === 0
      ? ""
      : bt.length === 1
        ? bt[0]
        : `${bt[0]} +${bt.length - 1}`;

  // Tiga kolom: kiri dan kanan sama lebar (hari + tanggal tepat di tengah).
  // Saat isi kolom kanan melebar (nama wifi / bluetooth), kolom itu
  // membesar dan hari + tanggal ikut bergeser ke kiri.
  return (
    <div className="grid h-[24px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2">
      {/* jam (ujung kiri) */}
      <div className="flex items-center justify-start">
        <TimeText />
      </div>

      {/* hari + tanggal (tengah) */}
      <DateText />

      {/* bluetooth + wifi + baterai (wifi menempel di kiri baterai) */}
      <div className="flex items-center justify-end gap-2">
        <AnimatePresence>
          {radios.bluetoothOn && (
            <Chip
              key="bt"
              icon={bluetoothIcon}
              label={btLabel}
              dim={bt.length === 0}
            />
          )}
          {radios.wifiOn && (
            <Chip
              key="wifi"
              icon={wifiIcon}
              label={radios.ssid ?? ""}
              dim={!radios.ssid}
            />
          )}
        </AnimatePresence>
        {battery.present && <Battery battery={battery} />}
      </div>
    </div>
  );
};
