/**
 * sounds.ts
 * Suara island saat file diseret / dilepas / selesai diproses.
 *
 *   choose.mp3    -> kotak aksi disorot saat file diseret
 *   drop.mp3      -> file dilepas ke island
 *   checklist.mp3 -> proses berat selesai (ceklis muncul)
 *
 * Dibuat dengan Web Audio: file didekode sekali di awal, lalu tiap putar hanya
 * membuat sumber baru dari buffer di memori. Hasilnya tanpa jeda, dan beberapa
 * suara bisa tumpang tindih (menyeret cepat melewati banyak kotak) tanpa terpotong.
 *
 * Lokasi file suara: kalau folder assets kamu bukan src/assets/sounds,
 * cukup ubah tiga baris import di bawah ini.
 */

import chooseUrl from "../../../assets/sounds/choose.wav";
import dropUrl from "../../../assets/sounds/drop.wav";
import checklistUrl from "../../../assets/sounds/checklist.wav";

export type SoundName = "choose" | "drop" | "checklist";

const SOURCES: Record<SoundName, string> = {
  choose: chooseUrl,
  drop: dropUrl,
  checklist: checklistUrl,
};

// Volume tiap suara (0..1)
const VOLUME: Record<SoundName, number> = {
  choose: 0.55,
  drop: 0.85,
  checklist: 0.9,
};

// Jarak minimum antar putaran suara yang sama (ms), mencegah suara menumpuk
const MIN_GAP_MS: Record<SoundName, number> = {
  choose: 50,
  drop: 120,
  checklist: 300,
};

// Suara yang menunggu izin audio lebih lama dari ini dibuang, supaya tidak
// berbunyi terlambat dan tiba-tiba saat izin akhirnya diberikan
const MAX_WAIT_MS = 250;

let ctx: AudioContext | null = null;
let loading: Promise<void> | null = null;

const buffers = new Map<SoundName, AudioBuffer>();
const lastPlayed: Partial<Record<SoundName, number>> = {};

function getContext(): AudioContext | null {
  if (ctx) return ctx;

  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
  } catch (e) {
    console.error("Web Audio tidak tersedia:", e);
    return null;
  }

  return ctx;
}

// Cadangan bila WebView memblokir audio sebelum ada interaksi:
// klik / tekan tombol pertama langsung membuka izinnya
let unlockBound = false;

function bindUnlock() {
  if (unlockBound) return;
  unlockBound = true;

  const unlock = () => {
    void ctx?.resume();

    if (ctx?.state === "running") {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    }
  };

  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

async function loadOne(c: AudioContext, name: SoundName) {
  try {
    const res = await fetch(SOURCES[name]);
    const data = await res.arrayBuffer();
    buffers.set(name, await c.decodeAudioData(data));
  } catch (e) {
    console.error(`Gagal memuat suara "${name}":`, e);
  }
}

// Muat semua suara sekali di awal (aman dipanggil berulang)
export function preloadSounds(): Promise<void> {
  if (loading) return loading;

  const c = getContext();
  if (!c) return Promise.resolve();

  bindUnlock();

  loading = Promise.all(
    (Object.keys(SOURCES) as SoundName[]).map((name) => loadOne(c, name)),
  ).then(() => undefined);

  return loading;
}

function start(c: AudioContext, name: SoundName) {
  const buffer = buffers.get(name);
  if (!buffer) return;

  const source = c.createBufferSource();
  const gain = c.createGain();

  source.buffer = buffer;
  gain.gain.value = VOLUME[name];

  source.connect(gain).connect(c.destination);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };

  source.start();
}

export function playSound(name: SoundName) {
  const now = performance.now();
  const last = lastPlayed[name];

  if (last !== undefined && now - last < MIN_GAP_MS[name]) return;
  lastPlayed[name] = now;

  const c = getContext();
  if (!c) return;

  if (!buffers.has(name)) {
    void preloadSounds(); // belum sempat dimuat: muat dulu, suara kali ini dilewati
    return;
  }

  if (c.state === "running") {
    start(c, name);
    return;
  }

  // Context tertahan (autoplay): coba buka, putar hanya bila masih segar
  c.resume()
    .then(() => {
      if (c.state === "running" && performance.now() - now < MAX_WAIT_MS) {
        start(c, name);
      }
    })
    .catch(() => {});
}
