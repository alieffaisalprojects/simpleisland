import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { DynamicIsland } from "./components/island/DynamicIsland";
import { GooeyFilter } from "./components/island/GooeyFilter";
import { useFileDragDrop } from "./hooks/useFileDragDrop";
import { useClockTimer } from "./hooks/useClockTimer";
import { useLyrics } from "./hooks/useLyrics";
import { useChargerSound } from "./hooks/useChargerSound";
import { ActiveWidget, SpotifyTrack } from "./types";

type MediaPayload = {
  title: string;
  artist: string;
  is_playing: boolean;
  album_art?: string;
  position_secs?: number;
  duration_secs?: number;
};

/**
 * Titik acuan posisi lagu di sisi frontend.
 * Posisi saat ini = position + (sekarang - at) bila sedang diputar.
 */
type PositionAnchor = {
  key: string;
  position: number;
  at: number;
  playing: boolean;
  lastReported: number | null;
  duration: number;
};

const emptyTrack: SpotifyTrack = {
  title: "",
  artist: "",
  albumArt: "",
  isPlaying: false,
  positionSecs: 0,
  durationSecs: 0,
  progress: 0,
};

const SEEK_THRESHOLD_SECS = 1.5; // selisih lebih dari ini dianggap seek / resync
const SMOOTHING = 0.3; // koreksi halus untuk drift kecil agar bar tidak melompat
const SEEK_GUARD_MS = 2500; // setelah user menggeser bar, laporan posisi lama dari Rust diabaikan selama ini

export function App() {
  const [activeWidget, setActiveWidget] = useState<ActiveWidget>("idle");
  const [track, setTrack] = useState<SpotifyTrack>(emptyTrack);
  const { droppedFile, clearFile } = useFileDragDrop();
  const clockTimer = useClockTimer(); // timer dari aplikasi Clock Windows
  const lyrics = useLyrics(track);
  useChargerSound(); // suara saat charger dicolok

  const anchorRef = useRef<PositionAnchor>({
    key: "",
    position: 0,
    at: Date.now(),
    playing: false,
    lastReported: null,
    duration: 0,
  });
  // Selama jendela ini aktif, status play/pause dari event Rust yang bertentangan diabaikan
  // (mencegah UI "kedip" balik setelah toggle optimistic).
  const optimisticUntil = useRef(0);
  // Setelah user seek: Rust masih bisa mengirim posisi LAMA (sebelum seek diproses). Itu yang membuat bar balik lagi.
  const seekGuardUntil = useRef(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<MediaPayload>("spotify-status-update", (event) => {
      const payload = event.payload;
      const now = Date.now();
      const title = payload.title || "";
      const validMedia = Boolean(title && title !== "Tidak ada media");
      const key = `${title}::${payload.artist ?? ""}`;

      const anchor = anchorRef.current;
      const trackChanged = key !== anchor.key;

      let playing = Boolean(payload.is_playing);
      if (!trackChanged && now < optimisticUntil.current)
        playing = anchor.playing;
      const playChanged = playing !== anchor.playing;

      const duration = Math.max(
        0,
        payload.duration_secs ?? anchor.duration ?? 0,
      );
      const reported =
        typeof payload.position_secs === "number"
          ? Math.max(0, payload.position_secs)
          : null;
      const expected = anchor.playing
        ? anchor.position + (now - anchor.at) / 1000
        : anchor.position;

      let position: number;
      if (trackChanged) {
        position = reported ?? 0;
      } else if (reported === null) {
        position = expected;
      } else {
        // Posisi dari Rust dianggap "baru" hanya jika nilainya berubah dari laporan sebelumnya.
        // Kalau nilainya sama terus (stale), kita lanjut menghitung sendiri supaya bar tetap berjalan.
        const fresh =
          anchor.lastReported === null ||
          Math.abs(reported - anchor.lastReported) > 0.05;
        const drift = reported - expected;
        const seekGuardActive = now < seekGuardUntil.current;

        if (seekGuardActive && Math.abs(drift) > SEEK_THRESHOLD_SECS) {
          position = expected; // laporan lama sebelum seek -> abaikan
        } else if (
          Math.abs(drift) > SEEK_THRESHOLD_SECS &&
          (fresh || !playing || playChanged)
        ) {
          position = reported; // seek / resync
        } else if (playing && fresh) {
          position = expected + drift * SMOOTHING; // koreksi halus
        } else {
          position = expected;
        }
      }
      if (duration > 0) position = Math.min(position, duration);
      position = Math.max(0, position);

      anchorRef.current = {
        key,
        position,
        at: now,
        playing,
        lastReported: reported ?? anchor.lastReported,
        duration,
      };

      setTrack((previous) => ({
        title: validMedia ? title : "",
        artist: validMedia ? payload.artist || "Unknown Artist" : "",
        albumArt: payload.album_art || (trackChanged ? "" : previous.albumArt),
        isPlaying: playing,
        positionSecs: position,
        durationSecs: duration,
        progress:
          duration > 0 ? (position / duration) * 100 : (previous.progress ?? 0),
        // Widget menginterpolasi posisi dari (positionSecs, syncedAt) tiap frame.
        syncedAt: now,
      }));

      if (validMedia) {
        setActiveWidget((current) =>
          current === "file-drop" || current === "system" || current === "timer"
            ? current
            : "spotify",
        );
      } else {
        setActiveWidget((current) =>
          current === "spotify" ? "idle" : current,
        );
      }
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error) => console.error("Media event listener failed:", error));

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (droppedFile) setActiveWidget("file-drop");
  }, [droppedFile]);

  // Toggle play/pause optimistic: UI (ikon, album mengecil, overlay) langsung berubah tanpa menunggu event Rust.
  const handleTogglePlay = useCallback(() => {
    const now = Date.now();
    const anchor = anchorRef.current;
    const position = anchor.playing
      ? anchor.position + (now - anchor.at) / 1000
      : anchor.position;
    const playing = !anchor.playing;

    anchorRef.current = { ...anchor, position, at: now, playing };
    optimisticUntil.current = now + 900;

    setTrack((previous) => ({
      ...previous,
      isPlaying: playing,
      positionSecs: position,
      syncedAt: now,
    }));
  }, []);

  // Seek optimistic: bar langsung pindah ke posisi baru (maju maupun mundur), lalu event Rust mengonfirmasi.
  const handleSeek = useCallback((positionSecs: number) => {
    const now = Date.now();
    const anchor = anchorRef.current;
    const position = Math.max(
      0,
      anchor.duration > 0
        ? Math.min(positionSecs, anchor.duration)
        : positionSecs,
    );

    // lastReported sengaja TIDAK di-reset: laporan lama yang sama tetap dianggap stale, bukan "baru".
    anchorRef.current = { ...anchor, position, at: now };
    seekGuardUntil.current = now + SEEK_GUARD_MS;

    setTrack((previous) => ({
      ...previous,
      positionSecs: position,
      progress:
        anchor.duration > 0
          ? (position / anchor.duration) * 100
          : (previous.progress ?? 0),
      syncedAt: now,
    }));
  }, []);

  const handleFileAction = useCallback(
    (action: string) => {
      if (action === "open" && droppedFile?.path) {
        void invoke("plugin:opener|open_path", {
          path: droppedFile.path,
        }).catch((error) => {
          console.error("Unable to open dropped file:", error);
        });
      }
      clearFile();
      setActiveWidget("idle");
    },
    [clearFile, droppedFile],
  );

  return (
    <main className="wind-island-root">
      <GooeyFilter />
      <DynamicIsland
        activeWidget={activeWidget}
        track={track}
        onTogglePlay={handleTogglePlay}
        onNextTrack={() => {}}
        onSeek={handleSeek}
        clockTimer={clockTimer}
        lyrics={lyrics}
        droppedFile={droppedFile}
        onFileAction={handleFileAction}
        systemNotification={null}
        onSelectWidget={setActiveWidget}
      />
    </main>
  );
}

export default App;
