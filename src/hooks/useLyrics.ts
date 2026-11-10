import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LyricLine, LyricsState, SpotifyTrack } from "../types";

const TARGET_LANG = "id";
const LEAD_SECS = 0.25;
const EMPTY: LyricsState = {
  status: "idle",
  lines: [],
  translated: null,
  isForeign: false,
  sourceLang: "",
};

// ---------------------------------------------------------------------------
// Cache: lirik + terjemahan diambil sekali per lagu, lalu disimpan.
// Disimpan di memori (cepat) dan localStorage (bertahan setelah aplikasi ditutup).
// ---------------------------------------------------------------------------

const STORE_PREFIX = "lyrics:v1:"; // satu kunci per lagu
const INDEX_KEY = "lyrics-index:v1"; // urutan pemakaian (terlama di depan)
const MAX_ENTRIES = 200; // jumlah lagu maksimum yang disimpan
const NONE_TTL_MS = 24 * 60 * 60 * 1000; // "lirik tidak ada" dicek lagi setelah 24 jam
const TR_RETRY_MS = 10 * 60 * 1000; // terjemahan yang gagal dicoba lagi setelah 10 menit
const TRANSLATE_COOLDOWN_MS = 2 * 60 * 1000; // setelah terjemahan gagal, istirahat dulu

interface Entry {
  state: LyricsState;
  trRetryAt: number; // lirik ada tapi belum diterjemahkan: coba lagi setelah waktu ini
  exp: number; // 0 = tidak kedaluwarsa
}

const mem = new Map<string, Entry>();

const makeKey = (track: SpotifyTrack) =>
  track.title
    ? `${track.title.trim()}::${track.artist.trim()}`.toLowerCase()
    : "";

function readIndex(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(idx: string[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  } catch {
    /* abaikan */
  }
}

function readEntry(key: string): Entry | null {
  let entry = mem.get(key) ?? null;

  if (!entry) {
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      if (raw) {
        const parsed = JSON.parse(raw) as Entry;
        const ok =
          parsed &&
          typeof parsed.exp === "number" &&
          typeof parsed.trRetryAt === "number" &&
          parsed.state &&
          typeof parsed.state.status === "string" &&
          Array.isArray(parsed.state.lines);
        if (ok) entry = parsed;
      }
    } catch {
      entry = null;
    }
    if (entry) mem.set(key, entry);
  }

  if (entry && entry.exp > 0 && Date.now() >= entry.exp) {
    removeEntry(key);
    return null;
  }

  return entry;
}

function removeEntry(key: string) {
  mem.delete(key);
  try {
    localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    /* abaikan */
  }
  writeIndex(readIndex().filter((k) => k !== key));
}

function writeEntry(key: string, entry: Entry) {
  mem.set(key, entry);

  const idx = readIndex().filter((k) => k !== key);
  idx.push(key);

  const evict = (n: number) => {
    for (const old of idx.splice(0, n)) {
      mem.delete(old);
      try {
        localStorage.removeItem(STORE_PREFIX + old);
      } catch {
        /* abaikan */
      }
    }
  };

  // Batasi jumlah lagu (entri terlama dibuang)
  if (idx.length > MAX_ENTRIES) evict(idx.length - MAX_ENTRIES);

  const json = JSON.stringify(entry);

  try {
    localStorage.setItem(STORE_PREFIX + key, json);
  } catch {
    // Penyimpanan penuh: buang sebagian entri terlama lalu coba sekali lagi
    evict(Math.max(10, Math.ceil(idx.length / 4)));
    idx.push(key);
    try {
      localStorage.setItem(STORE_PREFIX + key, json);
    } catch {
      /* tetap ada di memori; abaikan */
    }
  }

  writeIndex(Array.from(new Set(idx)));
}

// ---------------------------------------------------------------------------
// Parser LRC
// ---------------------------------------------------------------------------

const STAMP = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)];
    if (!stamps.length) continue;
    const text = raw.replace(STAMP, "").trim();
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
      out.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// Permintaan jaringan
// ---------------------------------------------------------------------------

// status 0 = bukan error HTTP (jaringan putus, timeout, JSON rusak)
type Json = { ok: true; data: any } | { ok: false; status: number };

async function getJson(url: string, form?: string): Promise<Json> {
  try {
    const text = await invoke<string>("http_request", {
      url,
      form: form ?? null,
    });
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    const m = /HTTP (\d+)/.exec(String(e));
    return { ok: false, status: m ? Number(m[1]) : 0 };
  }
}

const cleanTitle = (s: string) =>
  s
    .replace(
      /\s*[([][^)\]]*(remaster|live|version|edit|mono|stereo|feat|ft\.|with)[^)\]]*[)\]]/gi,
      "",
    )
    .replace(/\s+-\s+.*(remaster|version|edit|live|mono|single).*$/i, "")
    .trim();

const firstArtist = (s: string) =>
  s.split(/\s*(?:•|,|&| feat\.? | x )\s*/i)[0].trim();

type LyricsResult =
  | { kind: "ok"; lines: LyricLine[] }
  | { kind: "none" } // lirik memang tidak ada di layanan
  | { kind: "error" }; // gagal sementara (jaringan / dibatasi); jangan disimpan

async function fetchLyrics(
  title: string,
  artistRaw: string,
  duration: number,
): Promise<LyricsResult> {
  const q = encodeURIComponent;
  const name = cleanTitle(title);
  const artist = firstArtist(artistRaw);
  const dur = duration > 0 ? `&duration=${Math.round(duration)}` : "";
  let failed = false;

  let hit: any = null;
  const exact = await getJson(
    `https://lrclib.net/api/get?track_name=${q(name)}&artist_name=${q(artist)}${dur}`,
  );
  if (exact.ok) hit = exact.data;
  else if (exact.status !== 404) failed = true; // 404 = tidak ketemu (normal)

  if (!hit?.syncedLyrics) {
    const found = await getJson(
      `https://lrclib.net/api/search?q=${q(`${name} ${artist}`)}`,
    );
    if (found.ok && Array.isArray(found.data)) {
      const synced = found.data.filter((x: any) => x.syncedLyrics);
      if (duration > 0)
        synced.sort(
          (a: any, b: any) =>
            Math.abs(a.duration - duration) - Math.abs(b.duration - duration),
        );
      hit = synced[0];
    } else if (!found.ok && found.status !== 404) {
      failed = true;
    }
  }

  if (hit?.syncedLyrics) {
    const lines = parseLrc(hit.syncedLyrics);
    if (lines.length) return { kind: "ok", lines };
  }

  return failed ? { kind: "error" } : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Terjemahan (translate.googleapis.com: gratis, tanpa key, tapi bisa dibatasi)
// ---------------------------------------------------------------------------

// Setelah terjemahan gagal (mis. dibatasi), jangan menerjemahkan lagu lain dulu
let translateBlockedUntil = 0;

const CHUNK_LINES = 20; // baris per permintaan bila satu permintaan penuh tidak cocok
const PER_LINE_PARALLEL = 3; // permintaan paralel maksimum untuk cadangan per baris

async function translateChunk(
  text: string,
): Promise<{ lang: string; text: string }> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${TARGET_LANG}&dt=t`;
  const d = await getJson(url, `q=${encodeURIComponent(text)}`);
  if (!d.ok) throw new Error(`translate failed (${d.status})`);
  return {
    lang: String(d.data[2] ?? ""),
    text: (d.data[0] as any[]).map((s) => s?.[0] ?? "").join(""),
  };
}

// Cadangan terakhir: per baris, dengan paralel terbatas (bukan puluhan sekaligus)
async function translatePerLine(src: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < src.length; i += PER_LINE_PARALLEL) {
    const part = await Promise.all(
      src.slice(i, i + PER_LINE_PARALLEL).map((l) =>
        translateChunk(l)
          .then((r) => r.text.replace(/\n/g, " "))
          .catch(() => ""),
      ),
    );
    out.push(...part);
  }
  return out;
}

async function translateLines(lines: string[]) {
  const src = lines.map((l) => l || "♪");

  // 1 permintaan untuk seluruh lirik (kasus normal)
  const first = await translateChunk(src.join("\n"));
  let out = first.text.split("\n");
  let lang = first.lang;

  // Jumlah baris tidak cocok: coba per potongan 20 baris, baru per baris bila perlu
  if (out.length !== src.length) {
    out = [];
    for (let i = 0; i < src.length; i += CHUNK_LINES) {
      const part = src.slice(i, i + CHUNK_LINES);
      const r = await translateChunk(part.join("\n"));
      if (!lang) lang = r.lang;
      const got = r.text.split("\n");
      out.push(
        ...(got.length === part.length ? got : await translatePerLine(part)),
      );
    }
  }

  return { lang, lines: out.map((t) => t.trim()) };
}

// ---------------------------------------------------------------------------
// Pekerjaan pengambilan (satu per lagu, dipakai bersama bila diminta berulang)
// ---------------------------------------------------------------------------

interface Job {
  base: LyricsState | null; // lirik sudah ada, terjemahan menyusul
  subs: Set<(s: LyricsState) => void>;
  done: Promise<LyricsState>;
}

const jobs = new Map<string, Job>();

// Entri sudah ada tapi terjemahannya belum, dan sudah waktunya dicoba lagi
const needsTranslation = (e: Entry) =>
  e.state.status === "ready" &&
  !e.state.translated &&
  Date.now() >= e.trRetryAt &&
  Date.now() >= translateBlockedUntil;

function startJob(
  key: string,
  title: string,
  artist: string,
  duration: number,
): Job {
  const job: Job = {
    base: null,
    subs: new Set(),
    done: Promise.resolve(EMPTY),
  };

  const publish = (s: LyricsState) => {
    job.base = s;
    job.subs.forEach((fn) => fn(s));
  };

  job.done = (async (): Promise<LyricsState> => {
    const existing = readEntry(key);
    let base: LyricsState;

    if (existing) {
      base = existing.state; // lirik sudah tersimpan: hanya terjemahan yang diulang
    } else {
      const res = await fetchLyrics(title, artist, duration);

      // Gagal sementara: tampilkan "tidak ada" tetapi JANGAN disimpan,
      // supaya lagu ini dicoba lagi nanti.
      if (res.kind === "error") return { ...EMPTY, status: "none" };

      if (res.kind === "none") {
        const none: LyricsState = { ...EMPTY, status: "none" };
        writeEntry(key, {
          state: none,
          trRetryAt: 0,
          exp: Date.now() + NONE_TTL_MS,
        });
        return none;
      }

      base = { ...EMPTY, status: "ready", lines: res.lines };
      // Simpan lirik dulu; terjemahan menyusul
      writeEntry(key, { state: base, trRetryAt: 0, exp: 0 });
    }

    publish(base);

    if (Date.now() < translateBlockedUntil) return base;

    try {
      const tr = await translateLines(base.lines.map((l) => l.text));
      const full: LyricsState = {
        ...base,
        translated: tr.lines,
        sourceLang: tr.lang,
        isForeign: Boolean(tr.lang) && tr.lang !== TARGET_LANG,
      };
      writeEntry(key, { state: full, trRetryAt: 0, exp: 0 });
      return full;
    } catch {
      // Dibatasi / gagal: istirahat sebentar, lirik tetap tampil tanpa terjemahan
      translateBlockedUntil = Date.now() + TRANSLATE_COOLDOWN_MS;
      writeEntry(key, {
        state: base,
        trRetryAt: Date.now() + TR_RETRY_MS,
        exp: 0,
      });
      return base;
    }
  })().finally(() => {
    jobs.delete(key);
  });

  jobs.set(key, job);
  return job;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLyrics(track: SpotifyTrack): LyricsState {
  const key = makeKey(track);
  const [state, setState] = useState<LyricsState>(EMPTY);

  useEffect(() => {
    if (!key) {
      setState(EMPTY);
      return;
    }

    // Sudah ada di cache: tampilkan langsung, tanpa permintaan jaringan
    const hit = readEntry(key);
    if (hit && !needsTranslation(hit) && !jobs.has(key)) {
      setState(hit.state);
      return;
    }

    let dead = false;
    const job =
      jobs.get(key) ??
      startJob(key, track.title, track.artist, track.durationSecs);

    setState(hit ? hit.state : { ...EMPTY, status: "loading" });

    const onBase = (s: LyricsState) => {
      if (!dead) setState(s);
    };
    if (job.base) onBase(job.base);
    job.subs.add(onBase);

    // Hasil tetap tersimpan di cache walau lagu sudah berganti (dead = true)
    job.done.then((s) => {
      if (!dead) setState(s);
    });

    return () => {
      dead = true;
      job.subs.delete(onBase);
    };
    // Abaikan pemeriksaan dependensi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

// Mengambil indeks lirik yang sedang aktif.
export function useActiveLine(
  getPosition: () => number,
  lines: LyricLine[],
  enabled: boolean,
) {
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    if (!enabled || !lines.length) {
      setIndex(-1);
      return;
    }
    const tick = () => {
      const p = getPosition() + LEAD_SECS;
      let lo = 0,
        hi = lines.length - 1,
        r = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (lines[m].time <= p) {
          r = m;
          lo = m + 1;
        } else hi = m - 1;
      }
      setIndex((prev) => (prev === r ? prev : r));
    };
    tick();
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [enabled, lines, getPosition]);
  return index;
}
