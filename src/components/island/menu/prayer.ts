/**
 * File: prayer.ts
 * Kegunaan: Tipe, warna, dan helper waktu salat (zona waktu lokasi).
 * Sumber utama jadwal: API (lihat usePrayerSchedule.ts).
 * calcDay hanya cadangan sementara saat API belum bisa dijangkau.
 */

export type PrayerKey =
  | "fajr"
  | "sunrise"
  | "dhuhr"
  | "asr"
  | "maghrib"
  | "isha";
export type PrayerTimes = Record<PrayerKey, Date>;

export const FIVE: PrayerKey[] = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

export const PRAYER_LABEL: Record<PrayerKey, string> = {
  fajr: "Subuh",
  sunrise: "Terbit",
  dhuhr: "Dzuhur",
  asr: "Ashar",
  maghrib: "Maghrib",
  isha: "Isya",
};

/** Warna periode yang DIMULAI oleh salat tersebut (Subuh biru fajar ... Isya ungu malam). */
export const PRAYER_COLOR: Record<PrayerKey, string> = {
  fajr: "#FFFFFF",
  sunrise: "#FFFFFF",
  dhuhr: "#FFFFFF",
  asr: "#FFFFFF",
  maghrib: "#FFFFFF",
  isha: "#FFFFFF",
};

// ---- zona waktu ----

export const deviceTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const timeFmt = new Map<string, Intl.DateTimeFormat>();

/** "HH:mm" di zona waktu lokasi. */
export function fmtTime(date: Date, tz: string): string {
  let f = timeFmt.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      f = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    timeFmt.set(tz, f);
  }
  return f.format(date);
}

/** Tanggal kalender di zona waktu lokasi. */
export function civilIn(
  date: Date,
  tz: string,
): { y: number; m: number; d: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
  } catch {
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function tzOffsetMs(t: number, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
  return (
    Date.UTC(
      g("year"),
      g("month") - 1,
      g("day"),
      g("hour"),
      g("minute"),
      g("second"),
    ) - t
  );
}

/** Jam dinding (hh:mm) pada tanggal y-m-d di zona tz -> instan waktu sebenarnya. */
export function zonedTime(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(first, tz));
}

// ---- hitungan cadangan (Kemenag: Subuh 20°, Isya 18°, Ashar Syafii, ihtiyati 2 menit) ----

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const fix = (a: number, b: number) => a - b * Math.floor(a / b);

function julian(y: number, m: number, d: number): number {
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    d +
    B -
    1524.5
  );
}

export function calcDay(
  y: number,
  m: number,
  d: number,
  lat: number,
  lng: number,
): PrayerTimes {
  const D = julian(y, m, d) - lng / 360 - 2451545.0;
  const g = fix(357.529 + 0.98560028 * D, 360);
  const q = fix(280.459 + 0.98564736 * D, 360);
  const L = fix(
    q + 1.915 * Math.sin(rad(g)) + 0.02 * Math.sin(rad(2 * g)),
    360,
  );
  const e = 23.439 - 0.00000036 * D;
  const RA = fix(
    deg(Math.atan2(Math.cos(rad(e)) * Math.sin(rad(L)), Math.cos(rad(L)))) / 15,
    24,
  );
  const decl = deg(Math.asin(Math.sin(rad(e)) * Math.sin(rad(L))));
  const noon = 12 - (q / 15 - RA);

  const ha = (angle: number) =>
    deg(
      Math.acos(
        (-Math.sin(rad(angle)) - Math.sin(rad(decl)) * Math.sin(rad(lat))) /
          (Math.cos(rad(decl)) * Math.cos(rad(lat))),
      ),
    ) / 15;
  const asrAngle = -deg(
    Math.atan(1 / (1 + Math.tan(rad(Math.abs(lat - decl))))),
  );
  const at = (h: number, minutes: number) =>
    new Date(
      Date.UTC(y, m - 1, d) + (h - lng / 15) * 3600000 + minutes * 60000,
    );

  return {
    fajr: at(noon - ha(20), 2),
    sunrise: at(noon - ha(0.833), -2),
    dhuhr: at(noon, 2),
    asr: at(noon + ha(asrAngle), 2),
    maghrib: at(noon + ha(0.833), 2),
    isha: at(noon + ha(18), 2),
  };
}

// ---- status salat ----

export interface PrayerSlot {
  key: PrayerKey;
  time: Date;
}

export interface PrayerState {
  today: PrayerTimes;
  /** Salat berikutnya (Subuh besok bila Isya sudah lewat). */
  next: PrayerSlot;
  /** Salat sebelumnya: menentukan warna dan progress. */
  prev: PrayerSlot;
}

export type DayResolver = (y: number, m: number, d: number) => PrayerTimes;

export function getPrayerState(
  now: Date,
  tz: string,
  resolve: DayResolver,
): PrayerState {
  const c = civilIn(now, tz);
  const day = (offset: number) => {
    const t = new Date(Date.UTC(c.y, c.m - 1, c.d + offset));
    return resolve(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  };

  const today = day(0);
  const slots = FIVE.map((key) => ({ key, time: today[key] }));
  const nowT = now.getTime();
  const next = slots.find((s) => s.time.getTime() > nowT);

  if (next) {
    const before = slots.filter((s) => s.time.getTime() <= nowT);
    const prev = before[before.length - 1] ?? {
      key: "isha" as PrayerKey,
      time: day(-1).isha,
    };
    return { today, next, prev };
  }
  return {
    today,
    next: { key: "fajr", time: day(1).fajr },
    prev: slots[slots.length - 1],
  };
}

// ---- fase langit ----

export type SkyPhase =
  | "night"
  | "dawn"
  | "morning"
  | "noon"
  | "afternoon"
  | "dusk";

/** Fase langit mengikuti waktu salat hari ini (dipakai latar animasi di PrayerSky). */
export function getSkyPhase(now: Date, t: PrayerTimes): SkyPhase {
  const n = now.getTime();
  if (n < t.fajr.getTime()) return "night";
  if (n < t.sunrise.getTime()) return "dawn";
  if (n < t.dhuhr.getTime()) return "morning";
  if (n < t.asr.getTime()) return "noon";
  if (n < t.maghrib.getTime()) return "afternoon";
  if (n < t.isha.getTime()) return "dusk";
  return "night";
}
