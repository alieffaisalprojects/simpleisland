/**
 * File: IslandMenu.tsx
 * Kegunaan: Menu island yang terbuka saat klik kanan.
 * Isi: Salat (lokasi real-time), Kalender, Stopwatch, Catatan.
 * Tombol kembali di setiap halaman mengarah ke layar utama menu.
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import type { PanInfo } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Loader2,
  Lock,
  MapPin,
  Pause,
  Play,
  RotateCcw,
  Search,
} from "lucide-react";
import { MENU_SIZES, MenuView, swapFade } from "../dynamic_island/constants";
import shalatIcon from "../../../assets/styles/icons/sajadah.svg";
import kalenderIcon from "../../../assets/styles/icons/kalender.svg";
import stopwatchIcon from "../../../assets/styles/icons/stopwatch.svg";
import catatanIcon from "../../../assets/styles/icons/catatan.svg";
import chooseSound from "../../../assets/sounds/choose.wav";
import dropSound from "../../../assets/sounds/drop.wav";
import {
  FIVE,
  PRAYER_COLOR,
  PRAYER_LABEL,
  PrayerState,
  civilIn,
  fmtTime,
  getPrayerState,
} from "./prayer";
import { GeoLocation, Place, searchPlaces, useLocation } from "./useLocation";
import { usePrayerSchedule } from "./usePrayerSchedule";
import { stopwatch, useStopwatchRunning } from "./stopwatchStore";

interface IslandMenuProps {
  view: MenuView;
  onViewChange: (view: MenuView) => void;
  onClose: () => void;
  /** true saat menu sedang menunggu dialog izin lokasi. */
  onBusyChange: (busy: boolean) => void;
}

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = [
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

const pad = (n: number) => String(n).padStart(2, "0");
const shortDateIn = (d: Date, tz: string) => {
  const c = civilIn(d, tz);
  const weekday = new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
  return `${DAYS[weekday]}, ${c.d} ${MONTHS[c.m - 1].slice(0, 3)}`;
};

function countdown(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `dalam ${h} j ${m} mnt` : `dalam ${m} mnt`;
}

//urutan menu saat digeser kiri / kanan
const SWIPE_ORDER: MenuView[] = ["prayer", "calendar", "stopwatch", "notes"];
const SWIPE_DIST = 60;
const SWIPE_SPEED = 500;

//suara menu: hover = choose, klik = drop
const sfxCache: Record<string, HTMLAudioElement> = {};

function playSfx(src: string, volume = 0.6) {
  try {
    const base = (sfxCache[src] ??= new Audio(src));
    const a = base.cloneNode() as HTMLAudioElement;
    a.volume = volume;
    void a.play().catch(() => {});
  } catch {
    /* abaikan */
  }
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// ---- bagian umum ----

const ring =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70";

const Header: React.FC<{
  title?: React.ReactNode;
  onBack: () => void;
  right?: React.ReactNode;
}> = ({ title, onBack, right }) => (
  <div className="flex h-[26px] shrink-0 items-center gap-2">
    <button
      type="button"
      aria-label="Kembali"
      onClick={onBack}
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:scale-95 ${ring}`}
    >
      <ChevronLeft size={15} />
    </button>
    <div className="min-w-0 flex-1">{title}</div>
    {right}
  </div>
);

// ---- layar utama ----

const HomeView: React.FC<{
  swRunning: boolean;
  onOpen: (view: MenuView) => void;
}> = ({ swRunning, onOpen }) => {
  // nama hanya untuk pembaca layar dan tooltip, tidak ditampilkan
  const items: { id: MenuView; name: string; icon: string }[] = [
    { id: "prayer", name: "Jadwal Sholat", icon: shalatIcon },
    { id: "calendar", name: "Kalender", icon: kalenderIcon },
    { id: "stopwatch", name: "Stopwatch", icon: stopwatchIcon },
    { id: "notes", name: "Catatan", icon: catatanIcon },
  ];

  return (
    <div className="flex h-full w-full gap-2 p-[18px]">
      {items.map(({ id, name, icon }) => (
        <motion.button
          key={id}
          type="button"
          aria-label={name}
          title={name}
          onClick={() => {
            playSfx(dropSound);
            onOpen(id);
          }}
          onMouseEnter={() => playSfx(chooseSound)}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.93 }}
          transition={{ type: "spring", stiffness: 520, damping: 28 }}
          className={`relative flex min-w-0 flex-1 items-center justify-center rounded-[20px] bg-white/[0.07] transition-colors hover:bg-white/[0.13] ${ring}`}
        >
          {/* SVG  */}
          <img
            src={icon}
            alt=""
            draggable={false}
            className="h-[44px] w-[44px] select-none invert"
          />
          {id === "stopwatch" && swRunning && (
            <span
              aria-hidden="true"
              className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[#F5D547]"
            />
          )}
        </motion.button>
      ))}
    </div>
  );
};

// ---- jadwal salat ----

const ARC_W = 224;
const ARC_BASE = 58;
const ARC_H = 44;
const colX = (i: number) => (ARC_W / FIVE.length) * (i + 0.5);

// lengkung simetris dari Subuh (kiri) ke Isya (kanan), puncak di tengah
const curveY = (x: number): number => {
  const c0 = colX(0);
  const c4 = colX(FIVE.length - 1);
  const u = Math.min(1, Math.max(0, (x - c0) / (c4 - c0)));
  return ARC_BASE - ARC_H * Math.sin(Math.PI * u);
};

const segPath = (xa: number, xb: number): string => {
  const n = Math.max(2, Math.ceil((xb - xa) / 2));
  return (
    "M" +
    Array.from({ length: n + 1 }, (_, i) => {
      const x = xa + ((xb - xa) * i) / n;
      return `${x.toFixed(1)} ${curveY(x).toFixed(1)}`;
    }).join(" L")
  );
};

const PrayerView: React.FC<{
  now: Date;
  prayer: PrayerState;
  tz: string;
  city: string;
  locating: boolean;
  estimate: boolean;
  stale: boolean;
  onLocation: () => void;
  onBack: () => void;
}> = ({
  now,
  prayer,
  tz,
  city,
  locating,
  estimate,
  stale,
  onLocation,
  onBack,
}) => {
  const { today, next, prev } = prayer;
  const nowT = now.getTime();
  const color = PRAYER_COLOR[prev.key];

  const progress = Math.min(
    1,
    Math.max(
      0,
      (nowT - prev.time.getTime()) /
        (next.time.getTime() - prev.time.getTime()),
    ),
  );

  // waktu -> posisi x: lima salat berjarak sama, di antaranya diinterpolasi
  const anchors = FIVE.map((key, i) => ({
    t: today[key].getTime(),
    x: colX(i),
  }));
  const xAt = (t: number): number => {
    if (t <= anchors[0].t) return anchors[0].x;
    const last = anchors[anchors.length - 1];
    if (t >= last.t) return last.x;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      if (t < b.t) return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
    }
    return last.x;
  };
  const xNow = xAt(nowT);
  const yNow = curveY(xNow);
  // siang = terbit sampai Maghrib; selain itu gelap, pakai bulan
  const isDay =
    nowT >= today.sunrise.getTime() && nowT < today.maghrib.getTime();

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        onBack={onBack}
        title={
          <button
            type="button"
            onClick={onLocation}
            title="Ubah lokasi"
            className={`flex max-w-[190px] items-center gap-1 rounded-full py-1 pr-2 text-[11px] text-white/70 transition-colors hover:text-white ${ring}`}
          >
            {locating ? (
              <Loader2 size={12} className="shrink-0 animate-spin" />
            ) : (
              <MapPin size={12} className="shrink-0" />
            )}
            <span className="truncate">
              {city}
              {estimate ? " · memuat" : stale ? " · lokasi lama" : ""}
            </span>
          </button>
        }
        right={
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-[11px] text-white/55">
              {shortDateIn(now, tz)}
            </span>
            <span className="text-[13px] font-semibold tabular-nums">
              {fmtTime(now, tz)}
            </span>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 items-center gap-[18px]">
        {/* salat berikutnya */}
        <div className="w-[124px] shrink-0">
          <div className="text-[10.5px] text-white/50">Berikutnya</div>
          <div className="mt-0.5 text-[24px] font-semibold leading-none">
            {PRAYER_LABEL[next.key]}
          </div>
          <div className="mt-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
            <span
              className="text-[13px] font-semibold tabular-nums"
              style={{ color: PRAYER_COLOR[next.key] }}
            >
              {fmtTime(next.time, tz)}
            </span>
            <span className="text-[10.5px] text-white/50">
              {countdown(next.time.getTime() - nowT)}
            </span>
          </div>
          <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full"
              style={{ width: `${progress * 100}%`, background: color }}
            />
          </div>
        </div>

        {/* lengkung Subuh -> Isya */}
        <div className="shrink-0" style={{ width: ARC_W }}>
          <svg
            width={ARC_W}
            height={ARC_BASE + 6}
            viewBox={`0 0 ${ARC_W} ${ARC_BASE + 6}`}
            aria-hidden="true"
          >
            <line
              x1={4}
              x2={ARC_W - 4}
              y1={ARC_BASE}
              y2={ARC_BASE}
              stroke="white"
              strokeOpacity={0.12}
            />
            <path
              d={segPath(colX(0), colX(FIVE.length - 1))}
              fill="none"
              stroke="white"
              strokeOpacity={0.2}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
            {/* bagian yang sudah dilalui, warna sesuai periode salat */}
            {FIVE.slice(0, -1).map((key, i) => {
              const xa = colX(i);
              const xb = Math.min(colX(i + 1), xNow);
              if (xb <= xa) return null;
              return (
                <path
                  key={key}
                  d={segPath(xa, xb)}
                  fill="none"
                  stroke={PRAYER_COLOR[key]}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              );
            })}
            {/* titik tiap waktu salat */}
            {FIVE.map((key, i) => {
              const passed = today[key].getTime() <= nowT;
              const isNext = key === next.key;
              return (
                <circle
                  key={key}
                  cx={colX(i)}
                  cy={curveY(colX(i))}
                  r={isNext ? 3.6 : 2.8}
                  fill={
                    isNext ? "#050506" : passed ? PRAYER_COLOR[key] : "white"
                  }
                  fillOpacity={isNext || passed ? 1 : 0.3}
                  stroke={isNext ? PRAYER_COLOR[key] : "none"}
                  strokeWidth={1.7}
                />
              );
            })}
            {/* langit gelap: bintang kecil */}
            {!isDay &&
              [
                [30, 14],
                [86, 8],
                [150, 12],
                [196, 22],
              ].map(([sx, sy]) => (
                <circle
                  key={sx}
                  cx={sx}
                  cy={sy}
                  r={0.9}
                  fill="white"
                  opacity={0.35}
                />
              ))}
            {/* siang: matahari, gelap: bulan sabit */}
            {isDay ? (
              <>
                <circle
                  cx={xNow}
                  cy={yNow}
                  r={10}
                  fill={color}
                  opacity={0.16}
                />
                {Array.from({ length: 8 }, (_, i) => {
                  const a = (i * Math.PI) / 4;
                  return (
                    <line
                      key={i}
                      x1={xNow + Math.cos(a) * 7.2}
                      y1={yNow + Math.sin(a) * 7.2}
                      x2={xNow + Math.cos(a) * 9.4}
                      y2={yNow + Math.sin(a) * 9.4}
                      stroke={color}
                      strokeWidth={1.4}
                      strokeLinecap="round"
                    />
                  );
                })}
                <circle cx={xNow} cy={yNow} r={4.6} fill={color} />
              </>
            ) : (
              <>
                <defs>
                  <mask id="island-moon-mask">
                    <rect
                      x={xNow - 12}
                      y={yNow - 12}
                      width={24}
                      height={24}
                      fill="white"
                    />
                    <circle
                      cx={xNow + 2.6}
                      cy={yNow - 1.8}
                      r={4.3}
                      fill="black"
                    />
                  </mask>
                </defs>
                <circle
                  cx={xNow}
                  cy={yNow}
                  r={10}
                  fill="#C9C3FF"
                  opacity={0.16}
                />
                <circle
                  cx={xNow}
                  cy={yNow}
                  r={5.4}
                  fill="#E8E5FF"
                  mask="url(#island-moon-mask)"
                />
              </>
            )}
          </svg>

          <div className="grid grid-cols-5 text-center">
            {FIVE.map((key) => {
              const isNext = key === next.key;
              const passed = today[key].getTime() <= nowT;
              return (
                <div key={key} className="min-w-0">
                  <div
                    className={`text-[9.5px] ${isNext ? "text-white" : "text-white/50"}`}
                  >
                    {PRAYER_LABEL[key]}
                  </div>
                  <div
                    className="text-[11px] font-semibold tabular-nums"
                    style={{
                      color:
                        isNext || passed
                          ? PRAYER_COLOR[key]
                          : "rgba(255,255,255,0.55)",
                      opacity: isNext ? 1 : passed ? 0.75 : 1,
                    }}
                  >
                    {fmtTime(today[key], tz)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---- pilih lokasi ----

const sourceLabel = (l: GeoLocation): string =>
  l.source === "gps"
    ? `GPS${l.accuracy ? ` ±${Math.round(l.accuracy)} m` : ""}`
    : l.source === "manual"
      ? "dipilih manual"
      : "perkiraan dari jaringan";

const ago = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "baru saja";
  return m < 60 ? `${m} mnt lalu` : `${Math.round(m / 60)} j lalu`;
};

const LocateView: React.FC<{
  loc: GeoLocation;
  locating: boolean;
  gpsFailed: boolean;
  onGps: () => void;
  onPick: (place: Place) => void;
  onBack: () => void;
}> = ({ loc, locating, gpsFailed, onGps, onPick, onBack }) => {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    invoke("island_focus").catch(() => {});
  }, []);

  // cari setelah berhenti mengetik
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setEmpty(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await searchPlaces(term);
        if (cancelled) return;
        setResults(found.slice(0, 3));
        setEmpty(found.length === 0);
      } catch {
        if (!cancelled) {
          setResults([]);
          setEmpty(true);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        onBack={onBack}
        title={<span className="text-[13px] font-semibold">Lokasi</span>}
      />

      <div className="flex gap-2">
        <label className="relative flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40"
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari kota atau kecamatan"
            spellCheck={false}
            className="h-[34px] w-full rounded-full bg-white/[0.07] pl-8 pr-3 text-[12px] text-white outline-none placeholder:text-white/35 focus:bg-white/[0.12]"
          />
        </label>
        <button
          type="button"
          onClick={onGps}
          disabled={locating}
          className={`flex h-[34px] shrink-0 items-center gap-1.5 rounded-full bg-white px-3 text-[11.5px] font-semibold text-black transition-transform active:scale-95 disabled:opacity-60 ${ring}`}
        >
          {locating ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Crosshair size={13} />
          )}
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {results.length > 0 ? (
          <div className="flex flex-col gap-1">
            {results.map((p, i) => (
              <button
                key={`${p.lat}-${p.lng}-${i}`}
                type="button"
                onClick={() => onPick(p)}
                className={`flex h-[28px] w-full items-baseline gap-2 rounded-xl px-2.5 text-left transition-colors hover:bg-white/10 ${ring}`}
              >
                <span className="shrink-0 text-[12px] font-semibold">
                  {p.name}
                </span>
                <span className="truncate text-[10.5px] text-white/45">
                  {p.sub}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="px-1 text-[11px] leading-relaxed text-white/55">
            {searching ? (
              "Mencari…"
            ) : empty ? (
              "Tidak ditemukan. Coba nama kota atau kecamatan lain."
            ) : (
              <>
                <div>
                  <span className="text-white">{loc.city}</span> ·{" "}
                  {sourceLabel(loc)}
                  {loc.source !== "manual" && loc.at > 0
                    ? ` · ${ago(loc.at)}`
                    : ""}
                </div>
                <div className="tabular-nums text-white/40">
                  {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
                </div>
                {gpsFailed ? (
                  <div className="mt-0.5 text-[#F0607A]">
                    GPS gagal diperbarui, lokasi di atas bisa jadi lokasi lama.
                    Aktifkan Layanan Lokasi Windows atau cari kota di atas.
                  </div>
                ) : (
                  loc.source === "gps" &&
                  (loc.accuracy ?? 0) > 1000 && (
                    <div className="mt-0.5 text-[#F5D547]">
                      Akurasi rendah. Cari kota atau kecamatan di atas untuk
                      hasil pasti.
                    </div>
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ---- kalender ----

const CalendarView: React.FC<{ now: Date; onBack: () => void }> = ({
  now,
  onBack,
}) => {
  const [cursor, setCursor] = useState({
    y: now.getFullYear(),
    m: now.getMonth(),
  });

  const shift = (delta: number) =>
    setCursor(({ y, m }) => {
      const d = new Date(y, m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  // pekan dimulai Senin
  const offset = (new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7;
  const total = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const isToday = (d: number) =>
    d === now.getDate() &&
    cursor.m === now.getMonth() &&
    cursor.y === now.getFullYear();

  const navBtn = `flex h-[26px] w-[26px] items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white ${ring}`;

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        onBack={onBack}
        title={
          <button
            type="button"
            title="Kembali ke bulan ini"
            onClick={() =>
              setCursor({ y: now.getFullYear(), m: now.getMonth() })
            }
            className={`truncate rounded-md text-[13px] font-semibold ${ring}`}
          >
            {MONTHS[cursor.m]} {cursor.y}
          </button>
        }
        right={
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label="Bulan sebelumnya"
              onClick={() => shift(-1)}
              className={navBtn}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="Bulan berikutnya"
              onClick={() => shift(1)}
              className={navBtn}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-7 text-center text-[10px] text-white/40">
        {[...DAYS.slice(1), DAYS[0]].map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 content-start text-center text-[12px] tabular-nums">
        {cells.map((d, i) => (
          <div key={i} className="flex h-7 items-center justify-center">
            {d !== null && (
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full ${
                  isToday(d)
                    ? "bg-white font-semibold text-black"
                    : "text-white/80"
                }`}
              >
                {d}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

// ---- stopwatch ----

const StopwatchView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const running = useStopwatchRunning();
  const [ms, setMs] = useState(() => stopwatch.elapsed());

  useEffect(() => {
    setMs(stopwatch.elapsed());
    if (!running) return;
    const timer = window.setInterval(() => setMs(stopwatch.elapsed()), 40);
    return () => window.clearInterval(timer);
  }, [running]);

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  const centis = Math.floor(ms / 10) % 100;

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        onBack={onBack}
        title={
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            Stopwatch
            {running && (
              <span
                title="Island terkunci selama stopwatch berjalan"
                className="flex items-center gap-1 text-[10.5px] font-normal text-white/50"
              >
                <Lock size={10} />
                terkunci
              </span>
            )}
          </span>
        }
      />
      <div className="flex flex-1 items-center justify-between">
        <div className="text-[34px] font-semibold leading-none tabular-nums">
          {pad(minutes)}:{pad(seconds)}
          <span className="text-[20px] text-white/50">.{pad(centis)}</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            aria-label="Atur ulang"
            onClick={() => stopwatch.reset()}
            disabled={ms === 0 && !running}
            className={`flex h-[38px] w-[38px] items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20 active:scale-95 disabled:opacity-40 ${ring}`}
          >
            <RotateCcw size={15} />
          </button>
          <button
            type="button"
            aria-label={running ? "Jeda" : "Mulai"}
            onClick={() => stopwatch.toggle()}
            className={`flex h-[38px] w-[38px] items-center justify-center rounded-full bg-white text-black transition-transform active:scale-95 ${ring}`}
          >
            {running ? (
              <Pause size={15} fill="currentColor" />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---- catatan ----

const NOTES_KEY = "island.notes";

const NotesView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(NOTES_KEY) ?? "";
    } catch {
      return "";
    }
  });

  // minta fokus keyboard untuk window island
  useEffect(() => {
    invoke("island_focus").catch(() => {});
  }, []);

  const onChange = (value: string) => {
    setText(value);
    try {
      localStorage.setItem(NOTES_KEY, value);
    } catch {
      /* abaikan */
    }
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        onBack={onBack}
        title={<span className="text-[13px] font-semibold">Catatan</span>}
      />
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Tulis catatan. Tersimpan otomatis."
        spellCheck={false}
        className="min-h-0 flex-1 resize-none rounded-[14px] bg-white/[0.07] p-2.5 text-[12.5px] leading-snug text-white outline-none placeholder:text-white/35 focus:bg-white/[0.1]"
      />
    </div>
  );
};

// ---- menu ----

export const IslandMenu: React.FC<IslandMenuProps> = ({
  view,
  onViewChange,
  onClose,
  onBusyChange,
}) => {
  const now = useNow(1000);
  const swRunning = useStopwatchRunning();
  const { loc, status, detectGps, setManual } = useLocation(onBusyChange);
  const schedule = usePrayerSchedule(loc.lat, loc.lng, now);
  const prayer = getPrayerState(now, schedule.tz, schedule.resolve);
  const size = MENU_SIZES[view];
  const back = () => onViewChange("home");

  //geser kiri / kanan (drag mouse) untuk pindah menu
  const dragControls = useDragControls();
  const dragged = useRef(false);
  const swipeIndex = SWIPE_ORDER.indexOf(view);
  const swipeable = swipeIndex !== -1;

  const onSwipeEnd = (_: unknown, info: PanInfo) => {
    window.setTimeout(() => {
      dragged.current = false;
    }, 0);

    const dx = info.offset.x;
    const vx = info.velocity.x;
    const far = Math.abs(dx) > SWIPE_DIST;
    const fast = Math.abs(dx) > 25 && Math.abs(vx) > SWIPE_SPEED;
    if (!far && !fast) return;

    // geser ke kiri = menu berikutnya
    const next = SWIPE_ORDER[swipeIndex + (dx < 0 ? 1 : -1)];
    if (next) onViewChange(next);
  };

  // Esc: kembali, lalu tutup
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "home") {
        // terkunci selama stopwatch berjalan
        if (!stopwatch.isRunning()) onClose();
      } else {
        onViewChange(view === "locate" ? "prayer" : "home");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onClose, onViewChange]);

  const renderView = (): React.ReactNode => {
    switch (view) {
      case "prayer":
        return (
          <PrayerView
            now={now}
            prayer={prayer}
            tz={schedule.tz}
            city={loc.city}
            locating={status === "locating"}
            estimate={schedule.estimate}
            stale={
              status === "gps-failed" &&
              loc.source === "gps" &&
              Date.now() - loc.at > 15 * 60e3
            }
            onLocation={() => onViewChange("locate")}
            onBack={back}
          />
        );
      case "locate":
        return (
          <LocateView
            loc={loc}
            locating={status === "locating"}
            gpsFailed={status === "gps-failed"}
            onGps={detectGps}
            onPick={(place) => {
              setManual(place);
              onViewChange("prayer");
            }}
            onBack={() => onViewChange("prayer")}
          />
        );
      case "calendar":
        return <CalendarView now={now} onBack={back} />;
      case "stopwatch":
        return <StopwatchView onBack={back} />;
      case "notes":
        return <NotesView onBack={back} />;
      default:
        return <HomeView swRunning={swRunning} onOpen={onViewChange} />;
    }
  };

  return (
    <div className="relative h-full w-full">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          {...swapFade}
          className="absolute inset-x-0 top-0 mx-auto touch-pan-y"
          style={{ width: size.width, height: size.height }}
          drag={swipeable ? "x" : false}
          dragListener={false}
          dragControls={dragControls}
          dragConstraints={{ left: 0, right: 0 }}
          dragElastic={0.2}
          dragMomentum={false}
          dragSnapToOrigin
          onPointerDown={(e) => {
            if (!swipeable || e.button !== 0) return;
            // kolom ketik: drag dipakai untuk memilih teks
            if ((e.target as HTMLElement).closest("input, textarea")) return;
            dragControls.start(e);
          }}
          onDragStart={() => {
            dragged.current = true;
            window.getSelection()?.removeAllRanges();
          }}
          onDragEnd={onSwipeEnd}
          onClickCapture={(e) => {
            // setelah geser, jangan ikut menekan tombol
            if (dragged.current) {
              e.stopPropagation();
              e.preventDefault();
            }
          }}
        >
          {renderView()}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

export default IslandMenu;
