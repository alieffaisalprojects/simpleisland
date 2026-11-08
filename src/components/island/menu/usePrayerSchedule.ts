/**
 * File: usePrayerSchedule.ts
 * Kegunaan: Ambil jadwal salat bulanan dari API Aladhan (metode 20 = Kemenag RI)
 * berdasarkan koordinat, lengkap dengan zona waktu lokasi. Hasil disimpan per bulan
 * dan lokasi (localStorage) supaya cepat dan tetap tampil bila internet putus.
 */

import { useEffect, useState } from "react";
import { DayResolver, PrayerTimes, calcDay, deviceTz, zonedTime } from "./prayer";

// fajr, sunrise, dhuhr, asr, maghrib, isha
type Row = [string, string, string, string, string, string];
interface MonthData {
  tz: string;
  days: Record<number, Row>;
}

const STORE = "island.prayer.";
const memory = new Map<string, MonthData>();
const inflight = new Map<string, Promise<boolean>>();

const monthKey = (y: number, m: number, lat: number, lng: number) =>
  `${y}-${m}-${lat.toFixed(2)}_${lng.toFixed(2)}`;

function readStore(k: string): MonthData | null {
  try {
    const raw = localStorage.getItem(STORE + k);
    return raw ? (JSON.parse(raw) as MonthData) : null;
  } catch {
    return null;
  }
}

function writeStore(k: string, data: MonthData) {
  try {
    const old = Object.keys(localStorage).filter((x) => x.startsWith(STORE));
    if (old.length > 24) old.forEach((x) => localStorage.removeItem(x));
    localStorage.setItem(STORE + k, JSON.stringify(data));
  } catch {
    /* abaikan */
  }
}

const hm = (s: unknown): string => {
  const m = /(\d{1,2}):(\d{2})/.exec(String(s ?? ""));
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
};

async function fetchMonth(y: number, m: number, lat: number, lng: number): Promise<MonthData> {
  const url = `https://api.aladhan.com/v1/calendar/${y}/${m}?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&method=20`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.code !== 200 || !Array.isArray(json.data)) throw new Error("Respons tidak valid");

    const days: Record<number, Row> = {};
    let tz = "";
    for (const e of json.data) {
      const t = e.timings ?? {};
      const row = [t.Fajr, t.Sunrise, t.Dhuhr, t.Asr, t.Maghrib, t.Isha].map(hm);
      const day = parseInt(e.date?.gregorian?.day, 10);
      if (row.some((x) => !x) || !day) continue;
      days[day] = row as Row;
      tz = e.meta?.timezone || tz;
    }
    if (!tz || Object.keys(days).length === 0) throw new Error("Data kosong");
    return { tz, days };
  } finally {
    clearTimeout(timer);
  }
}

function ensureMonth(y: number, m: number, lat: number, lng: number): Promise<boolean> {
  const k = monthKey(y, m, lat, lng);
  if (memory.has(k)) return Promise.resolve(true);

  const stored = readStore(k);
  if (stored) {
    memory.set(k, stored);
    return Promise.resolve(true);
  }

  let p = inflight.get(k);
  if (!p) {
    p = fetchMonth(y, m, lat, lng)
      .then((data) => {
        memory.set(k, data);
        writeStore(k, data);
        return true;
      })
      .catch(() => false)
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

export function usePrayerSchedule(lat: number, lng: number, now: Date) {
  const [, bump] = useState(0);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const dayKey = now.toDateString();

  // ambil kemarin, hari ini, dan besok (bisa beda bulan)
  useEffect(() => {
    let alive = true;
    const base = new Date();
    const months = new Map<string, [number, number]>();
    for (const off of [-1, 0, 1]) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off);
      months.set(`${d.getFullYear()}-${d.getMonth()}`, [d.getFullYear(), d.getMonth() + 1]);
    }
    Promise.all([...months.values()].map(([y, m]) => ensureMonth(y, m, lat, lng))).then((r) => {
      if (!alive) return;
      setFailed(r.some((ok) => !ok));
      bump((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [lat, lng, dayKey, retry]);

  // gagal: coba lagi tiap 30 detik
  useEffect(() => {
    if (!failed) return;
    const t = window.setTimeout(() => setRetry((v) => v + 1), 30000);
    return () => window.clearTimeout(t);
  }, [failed, retry]);

  const resolve: DayResolver = (y, m, d): PrayerTimes => {
    const data = memory.get(monthKey(y, m, lat, lng));
    const row = data?.days[d];
    if (!data || !row) return calcDay(y, m, d, lat, lng);
    const at = (s: string) => {
      const [hh, mm] = s.split(":").map(Number);
      return zonedTime(y, m, d, hh, mm, data.tz);
    };
    return {
      fajr: at(row[0]),
      sunrise: at(row[1]),
      dhuhr: at(row[2]),
      asr: at(row[3]),
      maghrib: at(row[4]),
      isha: at(row[5]),
    };
  };

  const current = memory.get(monthKey(now.getFullYear(), now.getMonth() + 1, lat, lng));
  return { resolve, tz: current?.tz ?? deviceTz(), estimate: !current };
}
