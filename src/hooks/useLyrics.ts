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
// Disimpan di memori (cepat) dan localStorage (bertahan setelah aplikasi ditutup,
// jadi lagu yang pernah diputar tetap punya lirik walau offline).
//
// Aturan penggantian:
//  - maksimal MAX_ENTRIES lagu
//  - selama belum penuh, tidak ada yang dibuang (berapa lama pun tidak diputar)
//  - saat penuh dan ada lagu baru, lagu yang paling lama tidak diputar
//    (lirik + terjemahannya) digantikan lagu baru (LRU)
//  - lagu tanpa lirik tidak ikut disimpan / dihitung (hanya diingat di memori
//    selama aplikasi jalan, dicek lagi setelah NONE_TTL_MS)
//  - lagu BARU (belum pernah tersimpan) baru masuk cache setelah diputar
//    minimal MIN_PLAY_MS; kalau di-skip sebelum itu, tidak disimpan.
//    Lagu yang sudah tersimpan tidak pernah dihapus karena di-skip.
// ---------------------------------------------------------------------------

const STORE_PREFIX = "lyrics:v1:"; // satu kunci per lagu
const INDEX_KEY = "lyrics-index:v2"; // daftar [kunci, waktu terakhir diputar]
const LEGACY_INDEX_KEY = "lyrics-index:v1"; // format lama (hanya urutan), dimigrasi
const MAX_ENTRIES = 200; // jumlah lagu maksimum yang disimpan
const TOUCH_MIN_MS = 60 * 1000; // jangan tulis ulang indeks kalau baru saja diperbarui
const NONE_TTL_MS = 24 * 60 * 60 * 1000; // "lirik tidak ada" dicek lagi setelah 24 jam
const TR_RETRY_MS = 10 * 60 * 1000; // terjemahan yang gagal dicoba lagi setelah 10 menit
const TRANSLATE_COOLDOWN_MS = 2 * 60 * 1000; // setelah terjemahan gagal, istirahat dulu
const MIN_PLAY_MS = 10 * 1000; // lagu baru baru boleh disimpan setelah diputar segini lama

interface Entry {
  state: LyricsState;
  trRetryAt: number; // lirik ada tapi belum diterjemahkan: coba lagi setelah waktu ini
  exp: number; // 0 = tidak kedaluwarsa
}

const mem = new Map<string, Entry>();

// Lagu baru yang sudah diputar >= MIN_PLAY_MS (sesi ini) -> boleh disimpan
const confirmed = new Set<string>();
// Lirik lagu baru yang sedang diputar, belum lolos 10 detik: belum masuk cache
const pending = new Map<string, Entry>();
// Lagu yang sedang aktif; hasil fetch lagu lain yang belum tersimpan dibuang
let activeKey = "";

const isOffline = () =>
  typeof navigator !== "undefined" && navigator.onLine === false;

const makeKey = (track: SpotifyTrack) =>
  track.title
    ? `${track.title.trim()}::${track.artist.trim()}`.toLowerCase()
    : "";

// Indeks: kunci lagu -> waktu terakhir diputar (ms). Dimuat sekali, lalu dijaga di memori.
let index: Map<string, number> | null = null;

function saveIndex() {
  if (!index) return;
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(Array.from(index)));
  } catch {
    /* abaikan */
  }
}

function dropKey(key: string) {
  mem.delete(key);
  pending.delete(key);
  index?.delete(key);
  try {
    localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    /* abaikan */
  }
}

// Hanya bekerja saat cache melebihi batas: buang yang paling lama tidak diputar.
// `keep` = lagu yang sedang ditulis, tidak boleh ikut dibuang.
function prune(keep = "") {
  const idx = getIndex();

  if (idx.size > MAX_ENTRIES) {
    const oldest = Array.from(idx)
      .filter(([k]) => k !== keep)
      .sort((a, b) => a[1] - b[1]);
    for (const [k] of oldest.slice(0, idx.size - MAX_ENTRIES)) dropKey(k);
  }
}

function getIndex(): Map<string, number> {
  if (index) return index;

  const map = new Map<string, number>();
  index = map;

  try {
    const v = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
    if (Array.isArray(v)) {
      for (const p of v) {
        if (
          Array.isArray(p) &&
          typeof p[0] === "string" &&
          typeof p[1] === "number"
        ) {
          map.set(p[0], p[1]);
        }
      }
    }
  } catch {
    /* indeks rusak: dibangun ulang dari isi penyimpanan di bawah */
  }

  // Samakan indeks dengan isi penyimpanan:
  // - lagu yang ada datanya tapi belum terindeks (migrasi dari v1) dianggap baru diputar
  // - indeks tanpa data dibuang
  try {
    const now = Date.now();
    const found = new Set<string>();
    const legacyNone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(STORE_PREFIX)) continue;
      // Sisa versi lama: entri "lirik tidak ada" tidak lagi disimpan, jadi dibuang
      if (localStorage.getItem(k)?.includes('"status":"none"')) {
        legacyNone.push(k);
        continue;
      }
      found.add(k.slice(STORE_PREFIX.length));
    }
    for (const k of legacyNone) localStorage.removeItem(k);
    for (const k of found) if (!map.has(k)) map.set(k, now);
    for (const k of Array.from(map.keys())) if (!found.has(k)) map.delete(k);
    localStorage.removeItem(LEGACY_INDEX_KEY);
  } catch {
    /* abaikan */
  }

  prune();
  saveIndex();
  return map;
}

function removeEntry(key: string) {
  dropKey(key);
  saveIndex();
}

// Tandai lagu baru saja diputar (memperpanjang umurnya di cache)
function touch(key: string) {
  const idx = getIndex();
  const prev = idx.get(key);
  if (prev === undefined) return;
  const now = Date.now();
  if (now - prev < TOUCH_MIN_MS) return;
  idx.set(key, now);
  saveIndex();
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

  // Lagu baru yang belum lolos 10 detik
  if (!entry) entry = pending.get(key) ?? null;

  if (entry && entry.exp > 0 && Date.now() >= entry.exp) {
    removeEntry(key);
    return null;
  }

  return entry;
}

function writeEntry(key: string, entry: Entry) {
  // Lagu tanpa lirik hanya diingat di memori (tidak disimpan, tidak dihitung)
  if (entry.state.status === "none") {
    mem.set(key, entry);
    return;
  }

  // Lagu baru yang belum lolos 10 detik: tahan di pending, jangan masuk cache.
  // Kalau lagunya sudah bukan yang aktif (di-skip), buang saja.
  if (!confirmed.has(key) && !getIndex().has(key)) {
    if (key === activeKey) pending.set(key, entry);
    return;
  }

  pending.delete(key);
  mem.set(key, entry);

  const idx = getIndex();
  idx.set(key, Date.now());
  prune(key);

  const json = JSON.stringify(entry);

  try {
    localStorage.setItem(STORE_PREFIX + key, json);
  } catch {
    // Penyimpanan penuh: buang seperempat entri terlama lalu coba sekali lagi
    const oldest = Array.from(idx)
      .filter(([k]) => k !== key)
      .sort((a, b) => a[1] - b[1]);
    const n = Math.max(10, Math.ceil(oldest.length / 4));
    for (const [k] of oldest.slice(0, n)) dropKey(k);
    try {
      localStorage.setItem(STORE_PREFIX + key, json);
    } catch {
      /* tetap ada di memori; abaikan */
    }
  }

  saveIndex();
}

// Lagu sudah diputar cukup lama: sekarang boleh disimpan permanen
function commitKey(key: string) {
  confirmed.add(key);
  const e = pending.get(key);
  if (e) writeEntry(key, e);
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
// (saat offline tidak perlu mencoba: lirik tersimpan langsung ditampilkan)
const needsTranslation = (e: Entry) =>
  e.state.status === "ready" &&
  !e.state.translated &&
  !isOffline() &&
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
      // Offline dan belum ada di cache: langsung gagal sementara, tanpa menunggu timeout
      const res: LyricsResult = isOffline()
        ? { kind: "error" }
        : await fetchLyrics(title, artist, duration);

      // Gagal sementara: tampilkan "tidak ada" tetapi JANGAN disimpan,
      // supaya lagu ini dicoba lagi nanti (otomatis saat kembali online).
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
      // (lagu baru ditahan di pending sampai lolos MIN_PLAY_MS)
      writeEntry(key, { state: base, trRetryAt: 0, exp: 0 });
    }

    publish(base);

    if (isOffline() || Date.now() < translateBlockedUntil) return base;

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
      // Putus di tengah jalan: bukan salah layanan, cukup coba lagi nanti
      if (isOffline()) return base;
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
  const [onlineTick, setOnlineTick] = useState(0);

  // Saat koneksi kembali, lagu yang gagal diambil / belum diterjemahkan dicoba lagi
  useEffect(() => {
    const onOnline = () => setOnlineTick((n) => n + 1);
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  // Lagu baru baru disimpan ke cache kalau diputar minimal MIN_PLAY_MS.
  // Kalau di-skip sebelum itu, hasilnya dibuang (lagu yang sudah tersimpan tidak terpengaruh).
  // Harus dideklarasikan sebelum effect utama supaya `activeKey` sudah benar saat job mulai.
  useEffect(() => {
    activeKey = key;
    if (!key) return;
    const t = window.setTimeout(() => commitKey(key), MIN_PLAY_MS);
    return () => {
      window.clearTimeout(t);
      if (!confirmed.has(key)) pending.delete(key);
    };
  }, [key]);

  useEffect(() => {
    if (!key) {
      setState(EMPTY);
      return;
    }

    const hit = readEntry(key);
    // Lagu ini sedang diputar: perpanjang umurnya di cache
    if (hit) touch(key);

    // Sudah ada di cache: tampilkan langsung, tanpa permintaan jaringan
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
  }, [key, onlineTick]);

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
