/**
 * File: useLocation.ts
 * Kegunaan: Lokasi untuk jadwal salat.
 *   - Lokasi baru dicari setelah halaman jadwal salat / lokasi dibuka (parameter `enabled`),
 *     bukan saat menu pertama dibuka, supaya menu tidak tertahan oleh pencarian GPS.
 *   - GPS presisi tinggi: menunggu fix terbaik (hingga 12 detik), berhenti dini bila akurasi <= 100 m.
 *   - Pilih kota manual (pencarian) untuk hasil paling pasti.
 *   - Perkiraan dari IP hanya cadangan, karena sering menunjuk kantor ISP, bukan posisi Anda.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface GeoLocation {
  lat: number;
  lng: number;
  city: string;
  source: "gps" | "manual" | "network" | "default";
  /** Akurasi GPS dalam meter. */
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

// bacaan GPS lebih tua dari ini dianggap cache lama dari sistem dan dibuang
const STALE_FIX_MS = 20000;
// GPS dianggap masih segar selama ini; lewat itu diperbarui saat menu dibuka
const FRESH_GPS_MS = 2 * 60e3;
// lokasi jaringan diperbarui bila lebih tua dari ini
const NETWORK_TTL_MS = 30 * 60e3;

function load(): GeoLocation {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as GeoLocation;
      if (typeof v.lat === "number" && typeof v.lng === "number") return v;
    }
  } catch {
    /* abaikan */
  }
  return DEFAULT_LOCATION;
}

function save(loc: GeoLocation) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loc));
  } catch {
    /* abaikan */
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

/** Cari kota/kecamatan untuk dipilih manual. */
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

/** Pantau GPS dan ambil bacaan segar paling akurat. */
function readGps(): Promise<GeolocationPosition> {
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
        // buang posisi lama dari cache sistem (lokasi yang pernah dikunjungi)
        if (Date.now() - pos.timestamp > STALE_FIX_MS) return;
        if (!best || pos.coords.accuracy < best.coords.accuracy) best = pos;
        const acc = pos.coords.accuracy;
        const waited = Date.now() - startedAt;
        if (acc <= 50 || (acc <= 150 && waited > 6000)) finish();
      },
      (err) => {
        // sensor belum siap: tunggu sampai batas waktu
        if (err.code === err.POSITION_UNAVAILABLE) return;
        finish(err);
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
    timer = window.setTimeout(() => finish(), 15000);
  });
}

async function permissionState(): Promise<PermissionState> {
  try {
    const r = await navigator.permissions.query({ name: "geolocation" });
    return r.state;
  } catch {
    return "prompt";
  }
}

/**
 * onBusy(true) hanya selama dialog izin lokasi bisa muncul, supaya island tidak menutup
 * saat window kehilangan fokus. Bila izin sudah ada, GPS berjalan tanpa menahan island.
 *
 * enabled: pencarian lokasi baru dimulai saat nilainya true (sekali per menu dibuka).
 */
export function useLocation(onBusy?: (busy: boolean) => void, enabled = true) {
  const [loc, setLoc] = useState<GeoLocation>(load);
  const [status, setStatus] = useState<LocationStatus>("idle");
  const busyRef = useRef(onBusy);
  busyRef.current = onBusy;

  const apply = useCallback((next: GeoLocation) => {
    setLoc(next);
    save(next);
  }, []);

  const detectGps = useCallback(async () => {
    setStatus("locating");
    // island ditahan terbuka hanya bila dialog izin mungkin muncul
    const hold = (await permissionState()) === "prompt";
    if (hold) busyRef.current?.(true);
    try {
      const {
        latitude: lat,
        longitude: lng,
        accuracy,
      } = (await readGps()).coords;
      apply({
        lat,
        lng,
        city: await cityName(lat, lng),
        source: "gps",
        accuracy,
        at: Date.now(),
      });
      setStatus("idle");
    } catch {
      setStatus("gps-failed");
      // jaringan hanya bila belum pernah ada lokasi yang dipilih / dari GPS
      const c = load();
      if (c.source === "default" || c.source === "network") {
        fromNetwork()
          .then(apply)
          .catch(() => {});
      }
    } finally {
      if (hold) window.setTimeout(() => busyRef.current?.(false), 600);
    }
  }, [apply]);

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

  // setelah halaman jadwal salat dibuka: perbarui lokasi dari GPS kecuali dipilih manual
  const startedRef = useRef(false);

  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;

    const cached = load();
    if (cached.source === "manual") return;

    void (async () => {
      if ((await permissionState()) === "denied") {
        if (Date.now() - cached.at > NETWORK_TTL_MS) {
          fromNetwork()
            .then(apply)
            .catch(() => {});
        }
        return;
      }
      if (cached.source === "gps" && Date.now() - cached.at < FRESH_GPS_MS)
        return;
      void detectGps();
    })();
  }, [enabled, apply, detectGps]);

  // keluar dari halaman lokasi: lepas penahan island
  useEffect(() => {
    if (!enabled) busyRef.current?.(false);
  }, [enabled]);

  // menu ditutup: pastikan penahan island terlepas
  useEffect(() => () => busyRef.current?.(false), []);

  return { loc, status, detectGps, setManual };
}
