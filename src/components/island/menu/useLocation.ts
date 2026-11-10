// useLocation.ts
// lokasi untuk jadwal salat (gps, manual, jaringan)

import { useCallback, useEffect, useRef, useState } from "react";

export interface GeoLocation {
  lat: number;
  lng: number;
  city: string;
  source: "gps" | "manual" | "network" | "default";
  // akurasi gps (meter)
  accuracy?: number;
  at: number;
}

export interface Place {
  name: string;
  sub: string;
  lat: number;
  lng: number;
}

export type LocationStatus = "idle" | "locating" | "gps-failed";

const KEY = "island.location";
const DEFAULT_LOCATION: GeoLocation = {
  lat: -6.2088,
  lng: 106.8456,
  city: "Jakarta",
  source: "default",
  at: 0,
};

// posisi gps lebih tua dari ini dibuang
const STALE_FIX_MS = 20000;
// gps dianggap masih segar
const FRESH_GPS_MS = 2 * 60e3;
// lokasi jaringan diperbarui bila lebih tua dari ini
const NETWORK_TTL_MS = 30 * 60e3;
// jeda sebelum island boleh ditutup lagi setelah dialog izin hilang
const RELEASE_DELAY_MS = 600;

function load(): GeoLocation {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as GeoLocation;
      if (typeof v.lat === "number" && typeof v.lng === "number") return v;
    }
  } catch {
    // abaikan
  }
  return DEFAULT_LOCATION;
}

function save(loc: GeoLocation) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loc));
  } catch {
    // abaikan
  }
}

async function getJson(url: string, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// lokasi dari ip
async function fromNetwork(): Promise<GeoLocation> {
  const d = await getJson("https://ipwho.is/");
  if (!d.success) throw new Error("Lokasi jaringan tidak ditemukan");
  return {
    lat: d.latitude,
    lng: d.longitude,
    city: d.city || d.region || "Lokasi saya",
    source: "network",
    at: Date.now(),
  };
}

// nama kota dari koordinat
async function cityName(lat: number, lng: number): Promise<string> {
  try {
    const d = await getJson(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=id`,
    );
    return d.locality || d.city || d.principalSubdivision || "Lokasi saya";
  } catch {
    return "Lokasi saya";
  }
}

// cari kota manual
export async function searchPlaces(query: string): Promise<Place[]> {
  const d = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=id&format=json`,
  );
  const rows: Record<string, unknown>[] = Array.isArray(d.results)
    ? d.results
    : [];
  return rows.map((r) => ({
    name: String(r.name),
    sub: [r.admin2, r.admin1, r.country].filter(Boolean).join(", "),
    lat: Number(r.latitude),
    lng: Number(r.longitude),
  }));
}

// baca gps, ambil yang paling akurat
// onAnswered dipanggil saat dialog izin sudah dijawab (ada posisi atau error)
function readGps(onAnswered: () => void): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation tidak didukung"));
      return;
    }
    const startedAt = Date.now();
    let best: GeolocationPosition | null = null;
    let done = false;
    let watchId = 0;
    let timer = 0;

    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      navigator.geolocation.clearWatch(watchId);
      if (best) resolve(best);
      else reject(err ?? new Error("GPS timeout"));
    };

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        onAnswered();
        // buang posisi lama dari cache sistem
        if (Date.now() - pos.timestamp > STALE_FIX_MS) return;
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        const acc = pos.coords.accuracy;
        const waited = Date.now() - startedAt;
        if (acc <= 50 || (acc <= 150 && waited > 6000)) finish();
      },
      (err) => {
        onAnswered();
        // sensor belum siap, tunggu terus
        if (err.code === err.POSITION_UNAVAILABLE) return;
        finish(err);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
    timer = window.setTimeout(() => finish(), 15000);
  });
}

// pencarian gps yang sedang jalan
// tetap lanjut walau menu ditutup, dipakai bersama kalau menu dibuka lagi
let gpsTask: Promise<GeoLocation> | null = null;

function findGps(onAnswered: () => void): Promise<GeoLocation> {
  if (!gpsTask) {
    gpsTask = (async (): Promise<GeoLocation> => {
      const {
        latitude: lat,
        longitude: lng,
        accuracy,
      } = (await readGps(onAnswered)).coords;
      return {
        lat,
        lng,
        city: await cityName(lat, lng),
        source: "gps",
        accuracy,
        at: Date.now(),
      };
    })().finally(() => {
      gpsTask = null;
    });
  }
  return gpsTask;
}

// status izin lokasi
async function getPermission(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions.query({ name: "geolocation" });
  } catch {
    return null;
  }
}

// onBusy(true) hanya selama dialog izin tampil, supaya island tidak menutup
// begitu dialog dijawab, island bebas ditutup dan gps lanjut di latar belakang
// enabled: pencarian dimulai saat true (sekali per menu dibuka)
export function useLocation(onBusy?: (busy: boolean) => void, enabled = true) {
  const [loc, setLoc] = useState<GeoLocation>(load);
  const [status, setStatus] = useState<LocationStatus>("idle");
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;

  const apply = useCallback((next: GeoLocation) => {
    setLoc(next);
    save(next);
  }, []);

  // tombol lokasi (gps)
  const detectGps = useCallback(async () => {
    setStatus("locating");

    const perm = await getPermission();
    let held = (perm?.state ?? "prompt") === "prompt";

    // lepas penahan island
    const release = () => {
      if (!held) return;
      held = false;
      window.setTimeout(() => busyRef.current?.(false), RELEASE_DELAY_MS);
    };

    // tahan island selama dialog izin tampil
    if (held) {
      busyRef.current?.(true);
      if (perm) {
        perm.onchange = () => {
          if (perm.state !== "prompt") release();
        };
      }
    }

    try {
      apply(await findGps(release));
      setStatus("idle");
    } catch {
      setStatus("gps-failed");
      // jaringan hanya bila belum ada lokasi dari gps / manual
      const c = load();
      if (c.source === "default" || c.source === "network") {
        fromNetwork()
          .then(apply)
          .catch(() => {});
      }
    } finally {
      if (perm) perm.onchange = null;
      release();
    }
  }, [apply]);

  // pilih lokasi manual
  const setManual = useCallback(
    (p: Place) => {
      apply({
        lat: p.lat,
        lng: p.lng,
        city: p.name,
        source: "manual",
        at: Date.now(),
      });
      setStatus("idle");
    },
    [apply],
  );

  // mulai cari lokasi sekali per menu dibuka
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;

    const cached = load();
    if (cached.source === "manual") return;

    void (async () => {
      // izin ditolak, pakai jaringan
      if ((await getPermission())?.state === "denied") {
        if (Date.now() - cached.at > NETWORK_TTL_MS) {
          fromNetwork()
            .then(apply)
            .catch(() => {});
        }
        return;
      }
      // gps masih segar, tidak perlu cari lagi
      if (cached.source === "gps" && Date.now() - cached.at < FRESH_GPS_MS)
        return;
      void detectGps();
    })();
  }, [enabled, apply, detectGps]);

  // keluar dari halaman lokasi, lepas penahan island
  useEffect(() => {
    if (!enabled) busyRef.current?.(false);
  }, [enabled]);

  // menu ditutup, lepas penahan island
  useEffect(() => () => busyRef.current?.(false), []);

  return { loc, status, detectGps, setManual };
}
