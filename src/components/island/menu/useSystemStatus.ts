/**
 * File: useSystemStatus.ts
 * Kegunaan: status native laptop untuk menu island.
 * Isi: baterai, kecepatan jaringan, Wi-Fi, Bluetooth, mode pesawat, volume.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface BatteryInfo {
  present: boolean;
  percent: number;
  charging: boolean;
  plugged: boolean;
}

/** byte per detik */
export interface NetSpeed {
  down: number;
  up: number;
}

export interface SystemStatus {
  battery: BatteryInfo;
  net: NetSpeed;
}

export interface RadiosStatus {
  wifiPresent: boolean;
  wifiOn: boolean;
  ssid: string | null;
  bluetoothPresent: boolean;
  bluetoothOn: boolean;
  bluetoothConnected: string[];
  airplane: boolean;
}

export interface VolumeStatus {
  /** false bila tidak ada perangkat audio keluaran */
  supported: boolean;
  /** 0..100 */
  level: number;
  muted: boolean;
}

const EMPTY_VOLUME: VolumeStatus = { supported: false, level: 0, muted: false };

const EMPTY_STATUS: SystemStatus = {
  battery: { present: false, percent: 0, charging: false, plugged: false },
  net: { down: 0, up: 0 },
};

const EMPTY_RADIOS: RadiosStatus = {
  wifiPresent: false,
  wifiOn: false,
  ssid: null,
  bluetoothPresent: false,
  bluetoothOn: false,
  bluetoothConnected: [],
  airplane: false,
};

// ssid yang sesaat kosong (saat scan) ditahan selama ini
const SSID_HOLD_MS = 12000;

// cache terakhir: menu dibuka lagi langsung tampil lengkap,
// ikon wifi / bluetooth muncul bareng baterai (tidak menunggu pembacaan native)
let cachedStatus: SystemStatus | null = null;
let cachedRadios: RadiosStatus | null = null;

// isi cache lebih awal supaya pembukaan menu pertama juga langsung lengkap
export function warmSystemStatus() {
  invoke<SystemStatus>("system_status")
    .then((s) => {
      if (!cachedStatus) cachedStatus = s;
    })
    .catch(() => {});
  invoke<RadiosStatus>("system_radios")
    .then((r) => {
      if (!cachedRadios) cachedRadios = r;
    })
    .catch(() => {});
}

warmSystemStatus();

// isi sama persis -> tidak perlu update state (hindari render ulang)
const sameRadios = (a: RadiosStatus, b: RadiosStatus): boolean =>
  a.wifiPresent === b.wifiPresent &&
  a.wifiOn === b.wifiOn &&
  a.ssid === b.ssid &&
  a.bluetoothPresent === b.bluetoothPresent &&
  a.bluetoothOn === b.bluetoothOn &&
  a.airplane === b.airplane &&
  a.bluetoothConnected.join("\n") === b.bluetoothConnected.join("\n");

export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus>(
    () => cachedStatus ?? EMPTY_STATUS,
  );
  const [radios, setRadios] = useState<RadiosStatus>(
    () => cachedRadios ?? EMPTY_RADIOS,
  );
  const [volume, setVolumeState] = useState<VolumeStatus>(EMPTY_VOLUME);

  const alive = useRef(true);
  const loading = useRef(false);
  const version = useRef(0);
  const volBusy = useRef(false);
  const volPending = useRef<number | null>(null);
  const volTouched = useRef(0);
  // ssid terakhir yang terbaca (supaya tidak berkedip kosong saat scan)
  const lastSsid = useRef<{ ssid: string; at: number } | null>(
    cachedRadios?.ssid ? { ssid: cachedRadios.ssid, at: Date.now() } : null,
  );

  // simpan nilai terbaru ke cache (nilai kosong bawaan tidak disimpan)
  useEffect(() => {
    if (status !== EMPTY_STATUS) cachedStatus = status;
  }, [status]);

  useEffect(() => {
    if (radios !== EMPTY_RADIOS) cachedRadios = radios;
  }, [radios]);

  const refreshRadios = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const v = version.current;
    try {
      let r = await invoke<RadiosStatus>("system_radios");

      // ssid sesaat null saat scan: pakai nilai terakhir selama beberapa detik
      if (
        r.wifiOn &&
        !r.ssid &&
        lastSsid.current &&
        Date.now() - lastSsid.current.at < SSID_HOLD_MS
      ) {
        r = { ...r, ssid: lastSsid.current.ssid };
      } else if (r.ssid) {
        lastSsid.current = { ssid: r.ssid, at: Date.now() };
      } else if (!r.wifiOn) {
        lastSsid.current = null;
      }

      // objek baru hanya bila isinya benar-benar berubah
      if (alive.current && v === version.current)
        setRadios((prev) => (sameRadios(prev, r) ? prev : r));
    } catch (e) {
      console.error("system_radios gagal:", e);
    } finally {
      loading.current = false;
    }
  }, []);

  // baca volume asli (ikut berubah bila volume diubah manual di laptop)
  const refreshVolume = useCallback(async () => {
    if (volBusy.current || Date.now() - volTouched.current < 700) return;
    try {
      const v = await invoke<VolumeStatus>("system_volume_get");
      if (
        alive.current &&
        !volBusy.current &&
        Date.now() - volTouched.current >= 700
      ) {
        setVolumeState(v);
      }
    } catch (e) {
      console.error("system_volume_get gagal:", e);
    }
  }, []);

  useEffect(() => {
    alive.current = true;

    const tick = async () => {
      try {
        const s = await invoke<SystemStatus>("system_status");
        if (alive.current) setStatus(s);
      } catch (e) {
        console.error("system_status gagal:", e);
      }
    };

    void tick();
    void refreshRadios();
    void refreshVolume();
    const fast = window.setInterval(tick, 1000);
    const slow = window.setInterval(() => {
      void refreshRadios();
    }, 4000);
    const vol = window.setInterval(() => void refreshVolume(), 600);

    return () => {
      alive.current = false;
      window.clearInterval(fast);
      window.clearInterval(slow);
      window.clearInterval(vol);
    };
  }, [refreshRadios, refreshVolume]);

  // ubah radio: tampilan langsung berubah, lalu disamakan dengan kondisi asli
  const change = useCallback(
    async (
      cmd: string,
      args: Record<string, unknown>,
      optimistic: Partial<RadiosStatus>,
    ) => {
      version.current += 1;
      // ssid ditahan hanya untuk kondisi normal; saat radio diubah, mulai bersih
      lastSsid.current = null;
      setRadios((prev) => ({ ...prev, ...optimistic }));
      try {
        await invoke(cmd, args);
      } catch (e) {
        console.error(`${cmd} gagal:`, e);
      }
      version.current += 1;
      void refreshRadios();
      window.setTimeout(() => void refreshRadios(), 1500);
    },
    [refreshRadios],
  );

  const setWifi = useCallback(
    (on: boolean) =>
      change(
        "system_radio_set",
        { kind: "wifi", on },
        on ? { wifiOn: true } : { wifiOn: false, ssid: null },
      ),
    [change],
  );

  const setBluetooth = useCallback(
    (on: boolean) =>
      change(
        "system_radio_set",
        { kind: "bluetooth", on },
        on
          ? { bluetoothOn: true }
          : { bluetoothOn: false, bluetoothConnected: [] },
      ),
    [change],
  );

  const setAirplane = useCallback(
    (on: boolean) =>
      change(
        "system_airplane_set",
        { on },
        on
          ? {
              airplane: true,
              wifiOn: false,
              ssid: null,
              bluetoothOn: false,
              bluetoothConnected: [],
            }
          : { airplane: false },
      ),
    [change],
  );

  // ubah volume: tampilan langsung berubah, perintah dikirim berurutan (nilai terbaru menang)
  const setVolume = useCallback((level: number) => {
    const next = Math.max(0, Math.min(100, Math.round(level)));
    volTouched.current = Date.now();
    setVolumeState((prev) => ({
      ...prev,
      level: next,
      muted: next > 0 ? false : prev.muted,
    }));
    volPending.current = next;
    if (volBusy.current) return;
    volBusy.current = true;
    void (async () => {
      while (volPending.current !== null) {
        const l = volPending.current;
        volPending.current = null;
        try {
          await invoke("system_volume_set", { level: l });
        } catch (e) {
          console.error("system_volume_set gagal:", e);
        }
      }
      volBusy.current = false;
      volTouched.current = Date.now();
    })();
  }, []);

  return {
    status,
    radios,
    volume,
    refreshRadios,
    setWifi,
    setBluetooth,
    setAirplane,
    setVolume,
  };
}

export type SystemInfo = ReturnType<typeof useSystemStatus>;
