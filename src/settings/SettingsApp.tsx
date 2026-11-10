// halaman pengaturan simple island

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Info, RotateCcw, ZoomIn } from "lucide-react";
import { IslandShoulders } from "../components/island/IslandShoulders";
import { ISLAND_TOP } from "../components/island/dynamic_island/constants";
import {
  DEFAULT_APPEARANCE,
  HEIGHT_MAX,
  HEIGHT_MIN,
  SHOULDER_MAX,
  SHOULDER_MIN,
  SIZE_KEYS,
  STYLE_OPTIONS,
  TOP_MAX,
  TOP_MIN,
  WIDTH_MAX,
  WIDTH_MIN,
  sizeOf,
  useSettings,
} from "./settings";
import type { AppSettings, IslandStyle, SizeMode } from "./settings";

// gambar panduan instalasi
import defenderStep1 from "../assets/styles/warnings/windows-defender1.webp";
import defenderStep2 from "../assets/styles/warnings/windows-defender2.webp";

// ikon sidebar (svg hitam, dijadikan putih lewat filter di tampilan)
import iconUmum from "../assets/styles/settings/umum.svg";
import iconTampilan from "../assets/styles/settings/tampilan.svg";
import iconInstal from "../assets/styles/settings/instal.svg";

// ikon baris halaman Umum (svg hitam, dijadikan putih lewat filter)
import iconAktifkan from "../assets/styles/generals/aktifkan.svg";
import iconOtomatis from "../assets/styles/generals/otomatis.svg";
import iconMenu from "../assets/styles/generals/menu.svg";
import iconSuara from "../assets/styles/generals/suara.svg";
import iconNonaktifkan from "../assets/styles/generals/nonaktifkan.svg";

type Tab = "general" | "appearance" | "install";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "general", label: "Umum", icon: iconUmum },
  { id: "appearance", label: "Tampilan", icon: iconTampilan },
  { id: "install", label: "Instalasi", icon: iconInstal },
];

// komponen kecil

const Toggle: React.FC<{
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}> = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 ${
      checked ? "bg-[#34C759]" : "bg-[#636366]"
    } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
  >
    <motion.span
      className="absolute top-[3px] h-[20px] w-[20px] rounded-full bg-white shadow"
      initial={false}
      animate={{ left: checked ? 21 : 3 }}
      transition={{ type: "spring", stiffness: 520, damping: 32 }}
    />
  </button>
);

const Card: React.FC<{ title?: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="mb-5">
    {title && (
      <h2 className="mb-2 px-1 text-[11.5px] font-bold uppercase tracking-[0.08em] text-white">
        {title}
      </h2>
    )}
    <div className="divide-y divide-white/[0.07] overflow-hidden rounded-[18px] bg-white/[0.04] ring-1 ring-white/[0.07]">
      {children}
    </div>
  </section>
);

const Row: React.FC<{
  icon: string;
  title: string;
  desc?: string;
  children: React.ReactNode;
}> = ({ icon, title, desc, children }) => (
  <div className="flex items-center gap-3.5 px-4 py-3.5">
    <div className="flex h-8 w-8 shrink-0 items-center justify-center">
      <img
        src={icon}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-[23px] w-[23px] brightness-0 invert"
      />
    </div>

    <div className="min-w-0 flex-1">
      <div className="text-[13px] font-semibold tracking-[-0.01em] text-white">
        {title}
      </div>
      {desc && (
        <div className="mt-[2px] text-[11.5px] leading-[1.45] text-white/55">
          {desc}
        </div>
      )}
    </div>

    {children}
  </div>
);

const ActionButton: React.FC<{
  onClick: () => void;
  tone?: "neutral" | "danger";
  children: React.ReactNode;
}> = ({ onClick, tone = "neutral", children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`h-[32px] shrink-0 rounded-[10px] px-3.5 text-[12.5px] font-medium transition active:scale-95 ${
      tone === "danger"
        ? "bg-[#ce2828] text-white hover:bg-[#9b0c0c]"
        : "bg-white/10 text-white/90 hover:bg-white/[0.17]"
    }`}
  >
    {children}
  </button>
);

// slider, nilai disimpan saat dilepas

const SliderRow: React.FC<{
  title: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  display: (value: number) => string;
  onCommit: (value: number) => void;
  dense?: boolean; // versi rapat untuk panel sempit
}> = ({ title, desc, value, min, max, display, onCommit, dense }) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const commitDraft = () => {
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className={dense ? "py-2.5" : "px-4 py-3.5"}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div
            className={`font-medium ${dense ? "text-[13px]" : "text-[13.5px]"}`}
          >
            {title}
          </div>
          {desc && (
            <div className="mt-[2px] text-[12px] text-white/50">{desc}</div>
          )}
        </div>
        <span className="shrink-0 rounded-[8px] bg-white/10 px-2 py-[3px] text-[12px] tabular-nums text-white/80">
          {display(draft)}
        </span>
      </div>

      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={title}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commitDraft}
        onKeyUp={commitDraft}
        onBlur={commitDraft}
        className="w-full accent-sky-400"
      />
    </div>
  );
};

// tampilan selisih ukuran: 0 = bawaan
const fmtOffset = (v: number) =>
  v === 0 ? "Bawaan" : `${v > 0 ? "+" : ""}${v} px`;

// pratinjau bentuk island

// ukuran dasar pratinjau
const PREVIEW_BASE: Record<SizeMode, { w: number; h: number }> = {
  compact: { w: 108, h: 32 },
  mini: { w: 84, h: 26 },
};

const ShapePreview: React.FC<{
  style: IslandStyle;
  shoulder: number;
  dw?: number;
  dh?: number;
  dtop?: number;
  mode?: SizeMode;
}> = ({ style, shoulder, dw = 0, dh = 0, dtop = 0, mode = "compact" }) => {
  const flush = style !== "pill";
  const w = Math.max(40, Math.round(PREVIEW_BASE[mode].w + dw * 0.5));
  const h = Math.max(16, Math.round(PREVIEW_BASE[mode].h + dh * 0.5));
  const top = flush ? 0 : Math.max(0, Math.round(10 + dtop * 0.4));
  const r = Math.min(16, h / 2);

  return (
    <div
      className="relative h-[78px] w-full overflow-hidden rounded-[12px]"
      style={{
        background:
          "linear-gradient(135deg, #4f7cff 0%, #9b6bff 55%, #ff8fb1 100%)",
      }}
    >
      <div
        className="absolute left-1/2 bg-[#050506]"
        style={{
          top,
          width: w,
          height: h,
          transform: "translateX(-50%)",
          borderTopLeftRadius: flush ? 0 : r,
          borderTopRightRadius: flush ? 0 : r,
          borderBottomLeftRadius: r,
          borderBottomRightRadius: r,
        }}
      >
        {style === "notch" && (
          <IslandShoulders size={Math.round(shoulder * 0.8)} />
        )}

        <div className="flex h-full items-center justify-between px-3.5">
          <span className="h-[9px] w-[9px] rounded-full bg-white/30" />
          <span className="h-[9px] w-[9px] rounded-full bg-emerald-400/80" />
        </div>
      </div>
    </div>
  );
};

// panel ukuran satu kondisi (compact / mini)

const SizeGroup: React.FC<{
  title: string;
  desc: string;
  mode: SizeMode;
  style: IslandStyle;
  shoulder: number;
  top: number;
  width: number;
  height: number;
  onWidth: (value: number) => void;
  onHeight: (value: number) => void;
  onReset: () => void;
}> = ({
  title,
  desc,
  mode,
  style,
  shoulder,
  top,
  width,
  height,
  onWidth,
  onHeight,
  onReset,
}) => (
  <div className="flex min-w-0 flex-col gap-3 p-4">
    <div>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.01em]">
          {title}
        </h3>

        <button
          type="button"
          disabled={width === 0 && height === 0}
          onClick={onReset}
          className="flex h-[24px] items-center gap-1.5 rounded-[8px] px-2 text-[11.5px] font-medium text-white/60 transition hover:bg-white/10 hover:text-white/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>

      <p className="mt-[3px] min-h-[34px] text-[11.5px] leading-[1.45] text-white/50">
        {desc}
      </p>
    </div>

    <ShapePreview
      style={style}
      shoulder={shoulder}
      dw={width}
      dh={height}
      dtop={top}
      mode={mode}
    />

    <div className="divide-y divide-white/[0.07]">
      <SliderRow
        dense
        title="Lebar"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        display={fmtOffset}
        onCommit={onWidth}
      />

      <SliderRow
        dense
        title="Tinggi"
        value={height}
        min={HEIGHT_MIN}
        max={HEIGHT_MAX}
        display={fmtOffset}
        onCommit={onHeight}
      />
    </div>
  </div>
);

// halaman umum

interface PageProps {
  settings: AppSettings;
  commit: (patch: Partial<AppSettings>) => void;
}

const GeneralPage: React.FC<PageProps> = ({ settings, commit }) => {
  const [confirmQuit, setConfirmQuit] = useState(false);

  // konfirmasi keluar otomatis hilang
  useEffect(() => {
    if (!confirmQuit) return;
    const timer = window.setTimeout(() => setConfirmQuit(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmQuit]);

  return (
    <>
      {!settings.islandEnabled && (
        <div className="mb-5 flex items-center gap-4 rounded-[18px] bg-sky-400/10 p-4 ring-1 ring-sky-300/25">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-sky-400/20 text-sky-200">
            <img
              src={iconAktifkan}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="h-[22px] w-[22px] brightness-0 invert"
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">
              Aktifkan Simple Island
            </div>
          </div>

          <button
            type="button"
            onClick={() => commit({ islandEnabled: true })}
            className="h-[34px] shrink-0 rounded-[11px] bg-sky-400 px-4 text-[13px] font-semibold text-[#050506] transition hover:bg-sky-300 active:scale-95"
          >
            Aktifkan sekarang
          </button>
        </div>
      )}

      <Card title="Simple Island">
        <Row icon={iconAktifkan} title="Aktifkan Simple Island">
          <Toggle
            label="Aktifkan Simple Island"
            checked={settings.islandEnabled}
            onChange={(v) => commit({ islandEnabled: v })}
          />
        </Row>

        <Row
          icon={iconOtomatis}
          title="Jalankan Otomatis Saat Komputer Dinyalakan"
        >
          <Toggle
            label="Jalankan saat Windows startup"
            checked={settings.autostart}
            onChange={(v) => commit({ autostart: v })}
          />
        </Row>
      </Card>

      <Card title="Fitur">
        <Row
          icon={iconMenu}
          title="Menu Serbaguna"
          desc="Menu aksi (konversi, ZIP, salin, dll.) saat file diseret ke island."
        >
          <Toggle
            label="Seret dan lepas file"
            checked={settings.fileDrop}
            onChange={(v) => commit({ fileDrop: v })}
          />
        </Row>

        <Row
          icon={iconSuara}
          title="Suara"
          desc="Efek suara saat memilih, melepas, dan menyelesaikan aksi file."
        >
          <Toggle
            label="Suara efek file"
            checked={settings.fileSounds}
            onChange={(v) => commit({ fileSounds: v })}
          />
        </Row>
      </Card>

      <Card title="Lainnya">
        <Row
          icon={iconNonaktifkan}
          title="Nonaktifkan SImple Island"
          desc="Menutup island dan ikon dari system tray."
        >
          <ActionButton
            tone="danger"
            onClick={() => {
              if (!confirmQuit) {
                setConfirmQuit(true);
                return;
              }

              void invoke("settings_quit");
            }}
          >
            {confirmQuit ? "Yakin Menonaktifkan?" : "Nonaktifkan"}
          </ActionButton>
        </Row>
      </Card>
    </>
  );
};

// halaman tampilan

const AppearancePage: React.FC<PageProps> = ({ settings, commit }) => {
  // simpan nilai slider saat dilepas
  const [draft, setDraft] = useState(settings.shoulder);

  useEffect(() => setDraft(settings.shoulder), [settings.shoulder]);

  const commitDraft = () => {
    if (draft !== settings.shoulder) commit({ shoulder: draft });
  };

  const isDefault = (
    Object.keys(DEFAULT_APPEARANCE) as (keyof typeof DEFAULT_APPEARANCE)[]
  ).every((k) => settings[k] === DEFAULT_APPEARANCE[k]);

  // ukuran gaya yang sedang dipilih (compact dan mini terpisah)
  const keys = SIZE_KEYS[settings.style];
  const compact = sizeOf(settings, settings.style, "compact");
  const mini = sizeOf(settings, settings.style, "mini");
  const setSize = (patch: Record<string, number>) =>
    commit(patch as Partial<AppSettings>);
  const styleLabel =
    STYLE_OPTIONS.find((o) => o.id === settings.style)?.label ?? "";
  const topMin = Math.max(TOP_MIN, -ISLAND_TOP);

  return (
    <>
      <Card title="Gaya island">
        <div className="grid grid-cols-3 gap-3 p-3">
          {STYLE_OPTIONS.map((opt) => {
            const selected = settings.style === opt.id;
            const sz = sizeOf(settings, opt.id, "compact");

            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={selected}
                onClick={() => commit({ style: opt.id })}
                className={`flex flex-col gap-3 rounded-[16px] p-2.5 text-left transition focus:outline-none ${
                  selected
                    ? "bg-sky-400/12 ring-2 ring-sky-300/70 shadow-[0_5px_18px_rgba(56,189,248,0.12)]"
                    : "bg-white/[0.045] ring-1 ring-white/10 hover:bg-white/[0.085]"
                }`}
              >
                <ShapePreview
                  style={opt.id}
                  shoulder={draft}
                  dw={sz.w}
                  dh={sz.h}
                  dtop={opt.id === "pill" ? settings.pillTop : 0}
                />

                <div className="flex items-center gap-2 px-1">
                  <span className="text-[13px] font-semibold tracking-[-0.015em]">
                    {opt.label}
                  </span>
                </div>

                <p className="px-1 pb-1 text-[11.5px] leading-[1.45] text-white/55">
                  {opt.desc}
                </p>
              </button>
            );
          })}
        </div>
      </Card>

      <AnimatePresence initial={false}>
        {settings.style === "notch" && (
          <motion.div
            key="shoulder"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <Card title="SESUAIKAN SUDUT TEPIAN">
              <div className="px-4 py-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="text-[13.5px] font-medium">
                      Sudut Tepian
                    </div>
                    <div className="mt-[2px] text-[12px] text-white/50">
                      Lengkung kiri-kanan di tepi atas layar.
                    </div>
                  </div>
                  <span className="rounded-[8px] bg-white/10 px-2 py-[3px] text-[12px] tabular-nums text-white/80">
                    {draft} px
                  </span>
                </div>

                <input
                  type="range"
                  min={SHOULDER_MIN}
                  max={SHOULDER_MAX}
                  step={1}
                  value={draft}
                  aria-label="Lebar bahu"
                  onChange={(e) => setDraft(Number(e.target.value))}
                  onPointerUp={commitDraft}
                  onKeyUp={commitDraft}
                  onBlur={commitDraft}
                  className="w-full accent-sky-400"
                />
              </div>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Card title={`Ukuran ${styleLabel}`}>
        <div className="grid grid-cols-2 divide-x divide-white/[0.07]">
          <SizeGroup
            title="Compact"
            desc="Saat ada musik, timer, atau aktivitas lain."
            mode="compact"
            style={settings.style}
            shoulder={draft}
            top={settings.style === "pill" ? settings.pillTop : 0}
            width={compact.w}
            height={compact.h}
            onWidth={(v) => setSize({ [keys.compact.w]: v })}
            onHeight={(v) => setSize({ [keys.compact.h]: v })}
            onReset={() =>
              setSize({ [keys.compact.w]: 0, [keys.compact.h]: 0 })
            }
          />

          <SizeGroup
            title="Mini"
            desc="Saat idle atau tidak ada aktivitas."
            mode="mini"
            style={settings.style}
            shoulder={draft}
            top={settings.style === "pill" ? settings.pillTop : 0}
            width={mini.w}
            height={mini.h}
            onWidth={(v) => setSize({ [keys.mini.w]: v })}
            onHeight={(v) => setSize({ [keys.mini.h]: v })}
            onReset={() => setSize({ [keys.mini.w]: 0, [keys.mini.h]: 0 })}
          />
        </div>

        {settings.style === "pill" && (
          <SliderRow
            title="Jarak dari atas layar"
            desc="Jarak pil dari tepi atas monitor."
            value={settings.pillTop}
            min={topMin}
            max={TOP_MAX}
            display={(v) => `${Math.max(0, ISLAND_TOP + v)} px`}
            onCommit={(v) => commit({ pillTop: v })}
          />
        )}

        <div className="flex items-center gap-2.5 px-4 py-3 text-[11.5px] text-white/45">
          <Info size={14} className="shrink-0" />
          Ukuran saat diperluas (expanded) tidak ikut berubah.
        </div>
      </Card>

      <div className="flex items-center justify-between gap-4 px-1">
        <button
          type="button"
          disabled={isDefault}
          onClick={() => commit({ ...DEFAULT_APPEARANCE })}
          className="flex h-[32px] shrink-0 items-center gap-2 rounded-[10px] bg-white/10 px-3.5 text-[12.5px] font-medium text-white/90 transition hover:bg-white/[0.17] active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw size={14} />
          Kembalikan semua ke tampilan bawaan
        </button>
      </div>
    </>
  );
};

// halaman instalasi

interface GuideImage {
  src: string;
  alt: string;
}

interface GuideStep {
  title: string;
  body: React.ReactNode;
  image?: GuideImage;
}

// nama tombol Windows dibuat tebal supaya mudah dicari di layar
const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <strong className="font-semibold text-white">{children}</strong>
);

const INSTALL_STEPS: GuideStep[] = [
  {
    title: "Jalankan installer dan klik More info",
    body: (
      <>
        Buka file installer Simple Island. Jika muncul layar biru{" "}
        <Key>Windows protected your PC</Key>, jangan ditutup. Klik tulisan{" "}
        <Key>More info</Key> (Info lebih lanjut) di bagian teks.
      </>
    ),
    image: {
      src: defenderStep1,
      alt: "Peringatan Windows protected your PC dengan tautan More info",
    },
  },
  {
    title: "Klik Run anyway",
    body: (
      <>
        Setelah <Key>More info</Key> diklik, tombol <Key>Run anyway</Key> (Tetap
        jalankan) muncul di bagian bawah jendela. Klik tombol itu untuk
        melanjutkan instalasi.
      </>
    ),
    image: {
      src: defenderStep2,
      alt: "Tombol Run anyway pada peringatan Windows protected your PC",
    },
  },
  {
    title: "Klik Dismiss jika Windows Security muncul",
    body: (
      <>
        Windows Defender kadang menampilkan notifikasi di pojok kanan bawah saat
        installer diperiksa. Klik <Key>Dismiss</Key> (Tutup) pada notifikasi itu
        supaya instalasi tidak terhenti, lalu lanjutkan ke langkah berikutnya.
      </>
    ),
  },
  {
    title: "Selesaikan instalasi",
    body: (
      <>
        Ikuti wizard sampai selesai, lalu buka Simple Island dari menu Start.
        Peringatan ini hanya muncul sekali saat pertama kali installer
        dijalankan.
      </>
    ),
  },
];

const HELP_ITEMS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Tombol Run anyway tidak muncul",
    body: (
      <>
        Klik kanan file installer, pilih <Key>Properties</Key>, centang{" "}
        <Key>Unblock</Key> di bagian bawah tab General, klik <Key>Apply</Key>,
        lalu jalankan installer lagi.
      </>
    ),
  },
  {
    title: "File hilang atau dikarantina oleh Defender",
    body: (
      <>
        Buka <Key>Windows Security</Key>, pilih{" "}
        <Key>Virus &amp; threat protection</Key>, lalu{" "}
        <Key>Protection history</Key>. Pilih file Simple Island dan izinkan di
        perangkat ini, kemudian jalankan installer lagi.
      </>
    ),
  },
  {
    title: "Browser memblokir unduhan",
    body: (
      <>
        Di Edge atau Chrome, buka daftar unduhan lalu pilih <Key>Keep</Key> atau{" "}
        <Key>Keep anyway</Key> (Simpan) pada file installer.
      </>
    ),
  },
];

// gambar panduan; klik untuk memperbesar
const GuideShot: React.FC<{
  image: GuideImage;
  onOpen: (image: GuideImage) => void;
}> = ({ image, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(image)}
    aria-label={`Perbesar gambar: ${image.alt}`}
    className="group relative mt-4 block w-full overflow-hidden rounded-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
  >
    <img
      src={image.src}
      alt={image.alt}
      loading="lazy"
      draggable={false}
      className="block h-auto w-full transition duration-200 group-hover:brightness-105"
    />

    <span className="absolute bottom-2.5 right-2.5 flex h-[26px] items-center gap-1.5 rounded-[8px] bg-black/60 px-2 text-[11px] font-medium text-white/80 opacity-0 backdrop-blur transition group-hover:opacity-100 group-focus-visible:opacity-100">
      <ZoomIn size={13} />
      Perbesar
    </span>
  </button>
);

// tampilan gambar layar penuh
const Lightbox: React.FC<{ image: GuideImage | null; onClose: () => void }> = ({
  image,
  onClose,
}) => {
  useEffect(() => {
    if (!image) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image, onClose]);

  return (
    <AnimatePresence>
      {image && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={image.alt}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-8 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
        >
          <motion.img
            src={image.src}
            alt={image.alt}
            draggable={false}
            className="max-h-full max-w-full rounded-[14px] shadow-2xl ring-1 ring-white/15"
            initial={{ scale: 0.96 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

// bagian tanpa latar dan garis, hanya judul dan isi
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="mb-10">
    <h2 className="mb-5 px-1 text-[11.5px] font-bold uppercase tracking-[0.08em] text-white">
      {title}
    </h2>
    {children}
  </section>
);

const InstallPage: React.FC = () => {
  const [zoomed, setZoomed] = useState<GuideImage | null>(null);

  return (
    <>
      <div className="mb-10 border border-slate-200 bg-slate-100 p-4">
        <div className="text-[14px] font-semibold text-slate-900 font-bold">
          Pemberitahuan Windows SmartScreen
        </div>
        <p className="mt-[3px] text-[14px] leading-[1.5] text-slate-600">
          Peringatan ini muncul karena berkas installer belum dipublikasikan
          dengan sertifikat berbayar. Saya menjamin keamanan aplikasi ini. Silakan
          ikuti panduan berikut untuk melanjutkan proses instalasi.
        </p>
      </div>

      <Section title="Melewati peringatan SmartScreen">
        <ol className="flex flex-col gap-9 px-1">
          {INSTALL_STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-[13px] font-bold tabular-nums text-black">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-semibold tracking-[-0.01em]">
                  {step.title}
                </h3>

                <p className="mt-1 text-[12.5px] leading-[1.6] text-white/60">
                  {step.body}
                </p>

                {step.image && (
                  <GuideShot image={step.image} onOpen={setZoomed} />
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Jika masih terhambat">
        <div className="flex flex-col gap-6 px-1">
          {HELP_ITEMS.map((item) => (
            <div key={item.title} className="pl-11">
              <div className="text-[13px] font-semibold tracking-[-0.01em]">
                {item.title}
              </div>

              <p className="mt-1 text-[12px] leading-[1.6] text-white/55">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <div className="flex items-center gap-2.5 px-1 pb-2 text-[11.5px] text-white/45">
        <Info size={14} className="shrink-0" />
        Unduh installer hanya dari sumber resmi Simple Island.
      </div>

      <Lightbox image={zoomed} onClose={() => setZoomed(null)} />
    </>
  );
};

// halaman utama

export const SettingsApp: React.FC = () => {
  const { settings, ready, update } = useSettings();
  const [tab, setTab] = useState<Tab>("general");
  const [error, setError] = useState<string | null>(null);

  // atur latar jendela
  useEffect(() => {
    document.title = "Pengaturan · Simple Island";
    document.documentElement.style.background = "#101114";
    document.body.style.background = "#101114";
  }, []);

  // pesan error otomatis hilang
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 5000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const commit = (patch: Partial<AppSettings>) => {
    void update(patch).then((err) => {
      if (err) setError(err);
    });
  };

  return (
    <div className="flex h-screen w-screen select-none overflow-hidden bg-[#101114] text-white">
      {/* sidebar */}
      <aside className="flex w-[200px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0b0c0e] p-3">
        <nav className="flex flex-col gap-1 pt-2">
          {TABS.map(({ id, label, icon }) => {
            const active = tab === id;

            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`relative flex h-[38px] items-center gap-3 rounded-[11px] px-3 text-[13.5px] font-medium transition-colors focus:outline-none ${
                  active ? "text-white" : "text-white/55 hover:text-white/85"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="settings-tab"
                    className="absolute inset-0 rounded-[11px] bg-white/10"
                    transition={{ type: "spring", stiffness: 500, damping: 36 }}
                  />
                )}
                <img
                  src={icon}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className={`relative h-[17px] w-[17px] brightness-0 invert transition-opacity ${
                    active ? "opacity-100" : "opacity-55"
                  }`}
                />
                <span className="relative">{label}</span>
              </button>
            );
          })}
        </nav>

        {/* kredit pembuat dan versi */}
        <div className="mt-auto px-2 pb-2">
          <div className="mb-3 h-px w-full bg-white/[0.07]" />

          <div className="text-[12px] font-semibold leading-none  text-white/35">
            Developed by
          </div>

          <div className="mt-[7px] text-[15px] font-bold leading-[1.15] tracking-[-0.02em] text-white">
            Faisal Adriansyah
          </div>

          <div className="mt-[9px] inline-flex rounded-[7px]  py-[3px] text-[10.5px] font-bold tabular-nums tracking-[0.06em] text-white/70">
            V2026.01
          </div>
        </div>
      </aside>

      {/* konten */}
      <main className="relative z-[1] min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <h1 className="mb-5 text-[28px] font-semibold tracking-[-0.04em]">
          {TABS.find((t) => t.id === tab)?.label}
        </h1>

        {ready && (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16 }}
            >
              {tab === "general" && (
                <GeneralPage settings={settings} commit={commit} />
              )}
              {tab === "appearance" && (
                <AppearancePage settings={settings} commit={commit} />
              )}
              {tab === "install" && <InstallPage />}
            </motion.div>
          </AnimatePresence>
        )}

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              className="fixed bottom-5 left-[232px] right-8 flex items-center gap-3 rounded-[14px] bg-red-500/20 px-4 py-3 text-[12.5px] text-red-100 ring-1 ring-red-400/30 backdrop-blur"
            >
              <AlertCircle size={16} className="shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default SettingsApp;
