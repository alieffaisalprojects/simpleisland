export type ActiveWidget =
  | "idle"
  | "spotify"
  | "timer"
  | "file-drop"
  | "system";

export interface SpotifyTrack {
  title: string;
  artist: string;
  albumArt: string;
  isPlaying: boolean;
  /** Posisi lagu saat ini dalam detik. */
  positionSecs: number;
  /** Durasi penuh lagu dalam detik. */
  durationSecs: number;
  /** Cadangan untuk versi lama. */
  progress?: number;
  /** Waktu pembaruan posisi terakhir. */
  syncedAt?: number;
}

export interface DroppedFile {
  name: string;
  extension: string;
  size: string;
  path: string;
  type: "pdf" | "image" | "folder" | "code" | "unknown";
}

/** Timer dari aplikasi Clock Windows. */
export interface ClockTimer {
  active: boolean;
  running: boolean;
  remaining: number;
  total: number;
  /** Jeda atau lanjutkan timer. */
  toggle?: () => void;
  /** Hentikan timer. */
  stop?: () => void;
}

export interface LyricLine {
  time: number;
  text: string;
}

export interface LyricsState {
  status: "idle" | "loading" | "ready" | "none";
  lines: LyricLine[];
  /** Terjemahan setiap baris lirik. */
  translated: string[] | null;
  /** Menandakan lirik menggunakan bahasa selain Indonesia. */
  isForeign: boolean;
  sourceLang: string;
}
