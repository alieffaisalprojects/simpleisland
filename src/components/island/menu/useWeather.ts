/**
 * File: useWeather.ts
 * Kegunaan: Mengambil suhu (°C) dan kondisi hujan saat ini dari Open-Meteo
 * (gratis, tanpa API key) berdasarkan koordinat lokasi.
 * Data di-cache 10 menit supaya membuka menu berulang kali tidak memanggil API terus.
 */

import { useEffect, useState } from "react";

/** 0 = tidak hujan, 1 = gerimis/ringan, 2 = sedang, 3 = lebat/badai. */
export type RainLevel = 0 | 1 | 2 | 3;

export interface Weather {
  /** Suhu udara saat ini (°C). null bila belum ada data. */
  temp: number | null;
  rain: RainLevel;
  thunder: boolean;
  /** Tutupan awan 0..1. */
  cloud: number;
  /** Kode cuaca WMO dari Open-Meteo. */
  code: number | null;
}

const EMPTY: Weather = {
  temp: null,
  rain: 0,
  thunder: false,
  cloud: 0.15,
  code: null,
};

const TTL = 10 * 60e3;

// Kode WMO -> tingkat hujan.
const RAIN_BY_CODE: Record<number, RainLevel> = {
  51: 1,
  53: 1,
  55: 2,
  56: 1,
  57: 2,
  61: 1,
  63: 2,
  65: 3,
  66: 2,
  67: 3,
  80: 1,
  81: 2,
  82: 3,
  95: 3,
  96: 3,
  99: 3,
};

const cache = new Map<string, { at: number; data: Weather }>();

async function fetchWeather(
  lat: string,
  lng: string,
  signal: AbortSignal,
): Promise<Weather> {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lng}` +
    "&current=temperature_2m,weather_code,precipitation,cloud_cover" +
    "&timezone=auto";

  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const c = json?.current;
  if (!c || typeof c.temperature_2m !== "number") {
    throw new Error("Respons cuaca tidak valid");
  }

  const code = Number(c.weather_code);
  const precip = Number(c.precipitation) || 0;
  let rain: RainLevel = RAIN_BY_CODE[code] ?? 0;
  if (rain > 0) {
    if (precip >= 4) rain = 3;
    else if (precip >= 1.5 && rain < 2) rain = 2;
  }

  const cover = Math.min(1, Math.max(0, (Number(c.cloud_cover) || 0) / 100));
  return {
    temp: c.temperature_2m,
    rain,
    thunder: code >= 95,
    cloud: rain > 0 ? Math.max(cover, 0.7) : Math.max(cover, 0.1),
    code: Number.isFinite(code) ? code : null,
  };
}

export function useWeather(lat: number, lng: number): Weather {
  // Pembulatan 2 desimal (~1 km) agar GPS yang bergeser sedikit tidak memicu request baru.
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const [data, setData] = useState<Weather>(
    () => cache.get(key)?.data ?? EMPTY,
  );

  useEffect(() => {
    let alive = true;
    let ctrl: AbortController | null = null;
    const [la, lo] = key.split(",");

    const cached = cache.get(key);
    if (cached) setData(cached.data);

    const load = async () => {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL) return;

      ctrl?.abort();
      const mine = new AbortController();
      ctrl = mine;
      const timeout = window.setTimeout(() => mine.abort(), 8000);
      try {
        const w = await fetchWeather(la, lo, mine.signal);
        cache.set(key, { at: Date.now(), data: w });
        if (alive) setData(w);
      } catch {
        /* Pertahankan data terakhir bila gagal. */
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 60e3);
    return () => {
      alive = false;
      ctrl?.abort();
      window.clearInterval(timer);
    };
  }, [key]);

  return data;
}
