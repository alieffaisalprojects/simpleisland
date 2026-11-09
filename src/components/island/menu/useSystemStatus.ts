/**
 * File: useSystemStatus.ts
 * Kegunaan: status native laptop untuk menu island.
 * Isi: baterai, kecepatan jaringan, Wi-Fi, Bluetooth, mode pesawat.
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

export function useSystemStatus() {
  const [status, setStatus] = useState<SystemStatus>(EMPTY_STATUS);
  const [radios, setRadios] = useState<RadiosStatus>(EMPTY_RADIOS);

  const alive = useRef(true);
  const loading = useRef(false);
  const version = useRef(0);

  const refreshRadios = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    const v = version.current;
    try {
      const r = await invoke<RadiosStatus>("system_radios");
      if (alive.current && v === version.current) setRadios(r);
    } catch (e) {
      console.error("system_radios gagal:", e);
    } finally {
      loading.current = false;
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
    const fast = window.setInterval(tick, 1000);
    const slow = window.setInterval(refreshRadios, 4000);

    return () => {
      alive.current = false;
      window.clearInterval(fast);
      window.clearInterval(slow);
    };
  }, [refreshRadios]);

  // ubah radio: tampilan langsung berubah, lalu disamakan dengan kondisi asli
  const change = useCallback(
    async (
      cmd: string,
      args: Record<string, unknown>,
      optimistic: Partial<RadiosStatus>,
    ) => {
      version.current += 1;
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

  return {
    status,
    radios,
    refreshRadios,
    setWifi,
    setBluetooth,
    setAirplane,
  };
}

export type SystemInfo = ReturnType<typeof useSystemStatus>;
