import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useDragControls } from "framer-motion";
import type { PanInfo } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import {
  Crosshair,
  Loader2,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Search,
} from "lucide-react";
import {
  MENU_SIZES,
  MenuView,
  getMenuBack,
  swapFade,
} from "../dynamic_island/constants";
import shalatIcon from "../../../assets/styles/icons/sholat.svg";
import kalenderIcon from "../../../assets/styles/icons/kalender.svg";
import stopwatchIcon from "../../../assets/styles/icons/stopwatch.svg";
import catatanIcon from "../../../assets/styles/icons/catatan.svg";
import wifiIcon from "../../../assets/styles/menu_icons/wifi.svg";
import bluetoothIcon from "../../../assets/styles/menu_icons/bluetooth.svg";
import airplaneIcon from "../../../assets/styles/menu_icons/airplane.svg";
import speakerIcon from "../../../assets/styles/icons/speaker.svg";
import chooseSound from "../../../assets/sounds/choose.wav";
import dropSound from "../../../assets/sounds/drop.wav";
import { getPrayerState } from "./prayer";
import { PrayerView } from "./PrayerUi";
import { CalendarView } from "./CalendarUi";
import { GeoLocation, Place, searchPlaces, useLocation } from "./useLocation";
import { usePrayerSchedule } from "./usePrayerSchedule";
import { stopwatch, useStopwatchRunning } from "./stopwatchStore";
import { SystemInfo, useSystemStatus } from "./useSystemStatus";
import { SystemStatusBar } from "./SystemStatusBar";
import { BluetoothView, WifiView } from "./NetworkViews";
import { VolumeHud, VOLUME_HUD_H, VOLUME_HUD_W } from "./VolumeHud";

interface IslandMenuProps {
  view: MenuView;
  onViewChange: (view: MenuView) => void;
  onClose: () => void;
  /** Status dialog izin lokasi. */
  onBusyChange: (busy: boolean) => void;
  /** HUD volume tampil: menu disembunyikan, island menjadi pil horizontal. */
  hud: boolean;
  onHudChange: (on: boolean) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Urutan menu saat digeser.
const SWIPE_ORDER: MenuView[] = [
  "prayer",
  "calendar",
  "stopwatch",
  "notes",
  "wifi",
  "bluetooth",
];
const SWIPE_DIST = 60;
const SWIPE_SPEED = 500;

// Efek suara menu.
const sfxCache: Record<string, HTMLAudioElement> = {};

function playSfx(src: string, volume = 0.6) {
  try {
    const base = (sfxCache[src] ??= new Audio(src));
    const a = base.cloneNode() as HTMLAudioElement;
    a.volume = volume;
    void a.play().catch(() => {});
  } catch {
    /* Abaikan */
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

// Komponen umum.

const ring =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70";

const Header: React.FC<{
  title?: React.ReactNode;
  /** Tombol kembali berada di luar island. */
  onBack?: () => void;
  right?: React.ReactNode;
}> = ({ title, right }) => (
  <div className="flex h-[26px] shrink-0 items-center gap-2">
    <div className="min-w-0 flex-1">{title}</div>
    {right}
  </div>
);

// Tombol menu.

type TileTone = "sky" | "amber" | "green";

// Warna button wifi, bluetooth (menyala)
const TILE_LIT: Record<TileTone, string> = {
  sky: "bg-sky-400/60 hover:bg-sky-400/80",
  amber: "bg-amber-400/30 hover:bg-amber-400/40",
  green: "bg-emerald-400/30 hover:bg-emerald-400/40",
};

// Latar tombol menu saat tidak menyala: hitam transparan ala menu radial.
// Panel island di halaman utama menu dibuat transparan (lihat `menuGlass` di
// DynamicIsland.tsx), jadi setiap tombol berdiri sendiri di atas wallpaper.
// Ubah angka /60 (transparansi) dan /75 (saat hover) untuk menyesuaikan.
const TILE_GLASS =
  "bg-[#050506]/60 ring-1 ring-white/[0.08] hover:bg-[#050506]/75";

interface TileProps {
  name: string;
  icon: string;
  active?: boolean;
  tone?: TileTone;
  dot?: boolean;
  onClick: () => void;
  /** Klik kanan untuk mengubah status. */
  onContext?: () => void;
}

const MenuTile: React.FC<TileProps> = ({
  name,
  icon,
  active,
  tone = "sky",
  dot,
  onClick,
  onContext,
}) => {
  const lit = TILE_LIT[tone];

  return (
    <motion.button
      type="button"
      aria-label={name}
      title={name}
      onClick={() => {
        playSfx(dropSound);
        onClick();
      }}
      onContextMenu={
        onContext
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              playSfx(dropSound);
              onContext();
            }
          : undefined
      }
      onMouseEnter={() => playSfx(chooseSound)}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.93 }}
      transition={{ type: "spring", stiffness: 520, damping: 28 }}
      className={`relative flex min-w-0 flex-1 items-center justify-center rounded-[20px] transition-colors ${
        active ? lit : TILE_GLASS
      } ${ring}`}
    >
      {/* Ikon menu. */}
      <img
        src={icon}
        alt=""
        draggable={false}
        className="h-[36px] w-[36px] select-none invert"
      />
      {dot && (
        <span
          aria-hidden="true"
          className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[#F5D547]"
        />
      )}
    </motion.button>
  );
};

// Halaman utama menu.

const HomeView: React.FC<{
  swRunning: boolean;
  sys: SystemInfo;
  onOpen: (view: MenuView) => void;
  onShowHud: () => void;
}> = ({ swRunning, sys, onOpen, onShowHud }) => {
  const { status, radios, volume } = sys;

  // Daftar aplikasi.
  const apps: { id: MenuView; name: string; icon: string }[] = [
    { id: "prayer", name: "Jadwal Sholat", icon: shalatIcon },
    { id: "calendar", name: "Kalender", icon: kalenderIcon },
    { id: "stopwatch", name: "Stopwatch", icon: stopwatchIcon },
    { id: "notes", name: "Catatan", icon: catatanIcon },
  ];

  return (
    <div className="relative h-full w-full">
      <div className="flex h-full w-full flex-col gap-2 p-[18px]">
        {/* Status bar tetap hitam solid (panel island di sini transparan) */}
        <div className="shrink-0 rounded-[18px] bg-[#050506] px-3 py-1">
          <SystemStatusBar
            battery={status.battery}
            net={status.net}
            radios={radios}
          />
        </div>

        <div className="flex min-h-0 flex-1 gap-2">
          {apps.map(({ id, name, icon }) => (
            <MenuTile
              key={id}
              name={name}
              icon={icon}
              dot={id === "stopwatch" && swRunning}
              onClick={() => onOpen(id)}
            />
          ))}
        </div>

        <div className="flex min-h-0 flex-1 gap-2">
          <MenuTile
            name={`Wi-Fi (klik kanan: ${radios.wifiOn ? "matikan" : "nyalakan"})`}
            icon={wifiIcon}
            active={radios.wifiOn}
            onClick={() => onOpen("wifi")}
            onContext={() => void sys.setWifi(!radios.wifiOn)}
          />
          <MenuTile
            name={`Bluetooth (klik kanan: ${radios.bluetoothOn ? "matikan" : "nyalakan"})`}
            icon={bluetoothIcon}
            active={radios.bluetoothOn}
            onClick={() => onOpen("bluetooth")}
            onContext={() => void sys.setBluetooth(!radios.bluetoothOn)}
          />
          <MenuTile
            name={`Mode pesawat (${radios.airplane ? "nyala" : "mati"})`}
            icon={airplaneIcon}
            active={radios.airplane}
            tone="amber"
            onClick={() => void sys.setAirplane(!radios.airplane)}
          />
          <MenuTile
            name={
              volume.supported
                ? `Volume: ${volume.muted ? "senyap" : `${volume.level}%`}`
                : "Volume (perangkat audio tidak ditemukan)"
            }
            icon={speakerIcon}
            onClick={() => {
              // menu disembunyikan, island berubah jadi pil HUD volume
              if (volume.supported) onShowHud();
            }}
          />
        </div>
      </div>
    </div>
  );
};

// Jadwal salat: tampilan ada di PrayerUi.tsx.

// Pilih lokasi.

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

  // Cari lokasi setelah mengetik.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setEmpty(false);
      setSearching(false);
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

// Stopwatch.

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
            onClick={() => {
              stopwatch.reset();
              // Perbarui tampilan saat stopwatch dijeda.
              setMs(stopwatch.elapsed());
            }}
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

// Catatan.

const NOTES_KEY = "island.notes";

const NotesView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(NOTES_KEY) ?? "";
    } catch {
      return "";
    }
  });

  // Fokuskan keyboard ke window island.
  useEffect(() => {
    invoke("island_focus").catch(() => {});
  }, []);

  const onChange = (value: string) => {
    setText(value);
    try {
      localStorage.setItem(NOTES_KEY, value);
    } catch {
      /* Abaikan */
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

// Pengatur seluruh menu.

export const IslandMenu: React.FC<IslandMenuProps> = ({
  view,
  onViewChange,
  onClose,
  onBusyChange,
  hud,
  onHudChange,
}) => {
  const now = useNow(1000);
  const swRunning = useStopwatchRunning();
  const sys = useSystemStatus();
  const { loc, status, detectGps, setManual } = useLocation(onBusyChange);
  const schedule = usePrayerSchedule(loc.lat, loc.lng, now);
  const prayer = getPrayerState(now, schedule.tz, schedule.resolve);
  const showHud = hud && view === "home";
  const size = showHud
    ? { width: VOLUME_HUD_W, height: VOLUME_HUD_H }
    : MENU_SIZES[view];
  const back = () => onViewChange("home");

  // Kontrol geser antar-menu.
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

    // Geser kiri atau kanan untuk berpindah.
    const next = SWIPE_ORDER[swipeIndex + (dx < 0 ? 1 : -1)];
    if (next) onViewChange(next);
  };

  // Tombol Esc untuk kembali atau menutup menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (view === "home") {
        // Menu tidak bisa ditutup saat stopwatch berjalan.
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
            lat={loc.lat}
            lng={loc.lng}
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
      case "wifi":
        return (
          <WifiView
            radios={sys.radios}
            onToggle={(on) => void sys.setWifi(on)}
            onRefresh={() => void sys.refreshRadios()}
            onBack={back}
          />
        );
      case "bluetooth":
        return (
          <BluetoothView
            radios={sys.radios}
            onToggle={(on) => void sys.setBluetooth(on)}
            onBack={back}
          />
        );
      default:
        return (
          <HomeView
            swRunning={swRunning}
            sys={sys}
            onOpen={onViewChange}
            onShowHud={() => onHudChange(true)}
          />
        );
    }
  };

  // Klik area kosong untuk kembali ke menu utama.
  const onEmptyClick = (e: React.MouseEvent) => {
    if (view === "home") return;
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "button, a, input, textarea, select, label, [role='switch'], [role='button']",
      )
    )
      return;
    // Abaikan klik saat teks sedang dipilih.
    if (window.getSelection()?.toString()) return;
    onViewChange(getMenuBack(view));
  };

  return (
    <div className="relative h-full w-full" onClick={onEmptyClick}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={showHud ? "volume-hud" : view}
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
            // Input tetap bisa digunakan untuk memilih teks.
            if ((e.target as HTMLElement).closest("input, textarea")) return;
            dragControls.start(e);
          }}
          onDragStart={() => window.getSelection()?.removeAllRanges()}
          onDrag={(_, info) => {
            // Tandai jika sudah terjadi geseran.
            if (Math.abs(info.offset.x) > 8) dragged.current = true;
          }}
          onDragEnd={onSwipeEnd}
          onClickCapture={(e) => {
            // Abaikan klik setelah geseran.
            if (dragged.current) {
              e.stopPropagation();
              e.preventDefault();
            }
          }}
        >
          {showHud ? (
            <VolumeHud
              volume={sys.volume}
              onChange={sys.setVolume}
              onClose={() => onHudChange(false)}
            />
          ) : (
            renderView()
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
};

export default IslandMenu;
