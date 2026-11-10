/**
 * File: NetworkViews.tsx
 * Kegunaan: halaman Wi-Fi dan Bluetooth di menu island.
 * Tombol di kanan atas = nyala / mati (sekali klik), daftar di bawahnya = pilihan yang tersedia.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import wifiIcon from "../../../assets/styles/menu_icons/wifi.svg";
import bluetoothIcon from "../../../assets/styles/menu_icons/bluetooth.svg";
import type { RadiosStatus } from "./useSystemStatus";

interface WifiNetwork {
  ssid: string;
  signal: number;
  saved: boolean;
  connected: boolean;
}

interface WifiList {
  connected: string | null;
  networks: WifiNetwork[];
}

interface BtDevice {
  id: string;
  name: string;
  connected: boolean;
}

const ring =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70";

// ---- bagian umum ----

const Header: React.FC<{
  title: string;
  icon: string;
  on: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}> = ({ title, icon, on, disabled, onToggle }) => (
  <div className="flex h-[26px] shrink-0 items-center gap-2">
    <img
      src={icon}
      alt=""
      draggable={false}
      className="h-[18px] w-[18px] shrink-0 select-none invert"
    />
    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-white">
      {title}
    </span>

    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${title} ${on ? "mati" : "nyala"}`}
      disabled={disabled}
      onClick={() => onToggle(!on)}
      className={`relative h-[20px] w-[36px] shrink-0 rounded-full transition-colors duration-150 disabled:opacity-40 ${
        on ? "bg-[#34C759]" : "bg-white/20"
      } ${ring}`}
    >
      <span
        className={`absolute left-[2px] top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow transition-transform duration-150 ${
          on ? "translate-x-[16px]" : "translate-x-0"
        }`}
      />
    </button>
  </div>
);

const Empty: React.FC<{ text: string; loading?: boolean }> = ({
  text,
  loading,
}) => (
  <div className="flex h-full items-center justify-center gap-2 text-[12px] text-white/50">
    {loading && <Loader2 size={14} className="animate-spin" />}
    <span>{text}</span>
  </div>
);

const Bars: React.FC<{ signal: number }> = ({ signal }) => (
  <span
    className="flex h-[12px] shrink-0 items-end gap-[2px]"
    aria-hidden="true"
  >
    {[25, 50, 75, 100].map((t, i) => (
      <span
        key={t}
        className={`w-[3px] rounded-[1px] ${signal >= t - 12 ? "bg-white" : "bg-white/25"}`}
        style={{ height: 4 + i * 2.6 }}
      />
    ))}
  </span>
);

const Row: React.FC<{
  name: string;
  note?: string;
  active?: boolean;
  busy?: boolean;
  right?: React.ReactNode;
  onClick?: () => void;
}> = ({ name, note, active, busy, right, onClick }) => (
  <button
    type="button"
    disabled={!onClick || busy}
    onClick={onClick}
    className={`flex h-[34px] w-full shrink-0 items-center gap-2 rounded-[12px] px-3 text-left transition-colors disabled:cursor-default ${
      active ? "bg-sky-400/25" : "bg-white/[0.07]"
    } ${onClick ? "hover:bg-white/[0.14]" : ""} ${ring}`}
  >
    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-white">
      {name}
    </span>
    {note && (
      <span className="shrink-0 text-[10.5px] text-white/60">{note}</span>
    )}
    {busy ? (
      <Loader2 size={13} className="shrink-0 animate-spin text-white" />
    ) : (
      right
    )}
  </button>
);

const listStyle: React.CSSProperties = { scrollbarWidth: "none" };

// ---- Wi-Fi ----

export const WifiView: React.FC<{
  radios: RadiosStatus;
  onToggle: (on: boolean) => void;
  onRefresh: () => void;
  /** tombol kembali sekarang berupa tab di luar island (lihat DynamicIsland) */
  onBack?: () => void;
}> = ({ radios, onToggle, onRefresh }) => {
  const [list, setList] = useState<WifiList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await invoke<WifiList>("wifi_list");
      if (alive.current) setList(r);
    } catch (e) {
      console.error("wifi_list gagal:", e);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!radios.wifiOn) {
      setList(null);
      return;
    }
    void load();
    const timer = window.setInterval(load, 6000);
    return () => window.clearInterval(timer);
  }, [radios.wifiOn, load]);

  const pick = async (n: WifiNetwork) => {
    if (busy) return;
    setError("");
    setBusy(n.ssid);
    try {
      if (n.connected) await invoke("wifi_disconnect");
      else if (n.saved) await invoke("wifi_connect", { ssid: n.ssid });
      // belum tersimpan: butuh kata sandi, buka daftar jaringan Windows
      else await invoke("system_open_page", { page: "wifi" });
    } catch (e) {
      setError(String(e));
    }
    window.setTimeout(() => {
      if (!alive.current) return;
      setBusy(null);
      void load();
      onRefresh();
    }, 1800);
  };

  let body: React.ReactNode;
  if (!radios.wifiPresent)
    body = <Empty text="Adaptor Wi-Fi tidak ditemukan" />;
  else if (!radios.wifiOn) body = <Empty text="Wi-Fi mati" />;
  else if (!list) body = <Empty text="Mencari jaringan…" loading />;
  else if (list.networks.length === 0)
    body = <Empty text="Tidak ada jaringan" />;
  else
    body = (
      <div className="flex flex-col gap-1.5">
        {list.networks.map((n) => (
          <Row
            key={n.ssid}
            name={n.ssid}
            note={
              n.connected ? "Tersambung" : n.saved ? "Tersimpan" : "Perlu sandi"
            }
            active={n.connected}
            busy={busy === n.ssid}
            right={<Bars signal={n.signal} />}
            onClick={() => void pick(n)}
          />
        ))}
      </div>
    );

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        title="Wi-Fi"
        icon={wifiIcon}
        on={radios.wifiOn}
        disabled={!radios.wifiPresent}
        onToggle={onToggle}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" style={listStyle}>
        {body}
      </div>
      {error && (
        <p className="truncate text-[10.5px] text-red-300" title={error}>
          {error}
        </p>
      )}
    </div>
  );
};

// ---- Bluetooth ----

export const BluetoothView: React.FC<{
  radios: RadiosStatus;
  onToggle: (on: boolean) => void;
  /** tombol kembali sekarang berupa tab di luar island (lihat DynamicIsland) */
  onBack?: () => void;
}> = ({ radios, onToggle }) => {
  const [devices, setDevices] = useState<BtDevice[] | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await invoke<BtDevice[]>("bluetooth_list");
      if (alive.current) setDevices(r);
    } catch (e) {
      console.error("bluetooth_list gagal:", e);
      if (alive.current) setDevices([]);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!radios.bluetoothOn) {
      setDevices(null);
      return;
    }
    void load();
    const timer = window.setInterval(load, 6000);
    return () => window.clearInterval(timer);
  }, [radios.bluetoothOn, load]);

  const openSettings = () =>
    void invoke("system_open_page", { page: "bluetooth" }).catch(() => {});

  let body: React.ReactNode;
  if (!radios.bluetoothPresent)
    body = <Empty text="Adaptor Bluetooth tidak ditemukan" />;
  else if (!radios.bluetoothOn) body = <Empty text="Bluetooth mati" />;
  else if (!devices) body = <Empty text="Memuat perangkat…" loading />;
  else
    body = (
      <div className="flex flex-col gap-1.5">
        {devices.map((d) => (
          <Row
            key={d.id}
            name={d.name}
            note={d.connected ? "Tersambung" : "Terpasang"}
            active={d.connected}
            onClick={openSettings}
          />
        ))}
        <Row name="Tambah / sambungkan perangkat…" onClick={openSettings} />
      </div>
    );

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      <Header
        title="Bluetooth"
        icon={bluetoothIcon}
        on={radios.bluetoothOn}
        disabled={!radios.bluetoothPresent}
        onToggle={onToggle}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" style={listStyle}>
        {body}
      </div>
    </div>
  );
};
