/**
 * File: useSystemStatus.ts
 * Kegunaan: status native laptop untuk menu island.
 * Isi: baterai, kecepatan jaringan, Wi-Fi, Bluetooth, mode pesawat, mode daya.
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

/** Power mode Windows: hemat daya, seimbang, performa tinggi */
export type PowerMode = "saver" | "balanced" | "performance";

export interface PowerModeStatus {
  /** false bila Windows ini tidak punya pengaturan power mode */
  supported: boolean;
  mode: PowerMode;
}

const EMPTY_POWER: PowerModeStatus = { supported: false, mode: "balanced" };

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
  const [power, setPower] = useState<PowerModeStatus>(EMPTY_POWER);

  const alive = useRef(true);
  const loading = useRef(false);
  const version = useRef(0);
  const powerVersion = useRef(0);

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

  const refreshPower = useCallback(async () => {
    const v = powerVersion.current;
    try {
      const p = await invoke<PowerModeStatus>("power_mode_get");
      if (alive.current && v === powerVersion.current) setPower(p);
    } catch (e) {
      console.error("power_mode_get gagal:", e);
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
    void refreshPower();
    const fast = window.setInterval(tick, 1000);
    const slow = window.setInterval(() => {
      void refreshRadios();
      void refreshPower();
    }, 4000);

    return () => {
      alive.current = false;
      window.clearInterval(fast);
      window.clearInterval(slow);
    };
  }, [refreshRadios, refreshPower]);

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

  // ubah power mode: tampilan langsung berubah, lalu disamakan dengan kondisi asli
  const setPowerMode = useCallback(
    async (mode: PowerMode) => {
      powerVersion.current += 1;
      setPower((prev) => ({ ...prev, mode }));
      try {
        await invoke("power_mode_set", { mode });
      } catch (e) {
        console.error("power_mode_set gagal:", e);
      }
      powerVersion.current += 1;
      void refreshPower();
    },
    [refreshPower],
  );

  return {
    status,
    radios,
    power,
    refreshRadios,
    setWifi,
    setBluetooth,
    setAirplane,
    setPowerMode,
  };
}

export type SystemInfo = ReturnType<typeof useSystemStatus>;
