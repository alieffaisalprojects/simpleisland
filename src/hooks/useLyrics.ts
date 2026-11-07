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
const cache = new Map<string, LyricsState>();

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

async function getJson(url: string, form?: string): Promise<any> {
  try {
    return JSON.parse(
      await invoke<string>("http_request", { url, form: form ?? null }),
    );
  } catch {
    return null;
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

async function fetchLyrics(
  title: string,
  artistRaw: string,
  duration: number,
): Promise<LyricLine[] | null> {
  const q = encodeURIComponent;
  const name = cleanTitle(title);
  const artist = firstArtist(artistRaw);
  const dur = duration > 0 ? `&duration=${Math.round(duration)}` : "";
  let hit = await getJson(
    `https://lrclib.net/api/get?track_name=${q(name)}&artist_name=${q(artist)}${dur}`,
  );
  if (!hit?.syncedLyrics) {
    const list = await getJson(
      `https://lrclib.net/api/search?q=${q(`${name} ${artist}`)}`,
    );
    if (Array.isArray(list)) {
      const synced = list.filter((x: any) => x.syncedLyrics);
      if (duration > 0)
        synced.sort(
          (a: any, b: any) =>
            Math.abs(a.duration - duration) - Math.abs(b.duration - duration),
        );
      hit = synced[0];
    }
  }
  if (!hit?.syncedLyrics) return null;
  const lines = parseLrc(hit.syncedLyrics);
  return lines.length ? lines : null;
}

async function translateChunk(
  text: string,
): Promise<{ lang: string; text: string }> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${TARGET_LANG}&dt=t`;
  const d = await getJson(url, `q=${encodeURIComponent(text)}`);
  if (!d) throw new Error("translate failed");
  return {
    lang: String(d[2] ?? ""),
    text: (d[0] as any[]).map((s) => s?.[0] ?? "").join(""),
  };
}

async function translateLines(lines: string[]) {
  const src = lines.map((l) => l || "♪");
  const first = await translateChunk(src.join("\n"));
  let out = first.text.split("\n");
  if (out.length !== src.length) {
    // Terjemahkan per baris jika jumlahnya tidak sesuai.
    out = [];
    for (let i = 0; i < src.length; i += 8) {
      const part = await Promise.all(
        src.slice(i, i + 8).map((l) =>
          translateChunk(l)
            .then((r) => r.text.replace(/\n/g, " "))
            .catch(() => ""),
        ),
      );
      out.push(...part);
    }
  }
  return { lang: first.lang, lines: out.map((t) => t.trim()) };
}

export function useLyrics(track: SpotifyTrack): LyricsState {
  const key = track.title ? `${track.title}::${track.artist}` : "";
  const [state, setState] = useState<LyricsState>(EMPTY);

  useEffect(() => {
    if (!key) {
      setState(EMPTY);
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState(hit);
      return;
    }
    let dead = false;
    setState({ ...EMPTY, status: "loading" });
    (async () => {
      const lines = await fetchLyrics(
        track.title,
        track.artist,
        track.durationSecs,
      );
      if (dead) return;
      if (!lines) {
        const none: LyricsState = { ...EMPTY, status: "none" };
        cache.set(key, none);
        setState(none);
        return;
      }
      const base: LyricsState = { ...EMPTY, status: "ready", lines };
      setState(base);
      const tr = await translateLines(lines.map((l) => l.text)).catch(
        () => null,
      );
      if (dead) return;
      const full: LyricsState = tr
        ? {
            ...base,
            translated: tr.lines,
            sourceLang: tr.lang,
            isForeign: Boolean(tr.lang) && tr.lang !== TARGET_LANG,
          }
        : base;
      cache.set(key, full);
      setState(full);
    })();
    return () => {
      dead = true;
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
