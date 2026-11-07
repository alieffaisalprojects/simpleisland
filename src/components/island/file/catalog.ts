/**
 * catalog.ts
 * "Otak" menu file island: mengenali jenis file lalu menyusun kotak aksi yang cocok.
 * Murni logika (tanpa UI dan tanpa Tauri), jadi mudah ditambah / diubah.
 *
 * Menambah aksi baru:
 *  1. tambahkan di buildActions() di bawah (id + label + ikon),
 *  2. tangani id yang sama di `run_action` pada file_actions.rs.
 */

import {
  Archive,
  Copy,
  Download,
  File as FileIcon,
  FileCode,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Link as LinkIcon,
  Minimize2,
  Music,
  RotateCw,
  Scissors,
  Terminal,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type FileKind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "pdf"
  | "doc"
  | "code"
  | "other";

export interface FileItem {
  path: string;
  name: string;
  ext: string; // huruf kecil tanpa titik, "" untuk folder
  isDir: boolean;
  size: number | null; // byte, null untuk folder
  children: number | null; // jumlah isi folder (satu tingkat)
  kind: FileKind;
}

// Alat tambahan yang terpasang di PC (dideteksi oleh Rust)
export interface FileTools {
  rar: boolean;
  sevenZip: boolean;
  ffmpeg: boolean;
}

export interface FileAction {
  id: string;
  label: string; // pendek, muat di kotak kecil
  Icon: LucideIcon;
  tone: "accent" | "neutral" | "danger";
}

const EXT: Record<Exclude<FileKind, "folder" | "other">, string[]> = {
  image: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "ico"],
  video: ["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv", "m4v"],
  audio: ["mp3", "wav", "flac", "m4a", "ogg", "aac", "wma", "opus"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"],
  pdf: ["pdf"],
  doc: ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "md", "odt"],
  code: [
    "js", "ts", "tsx", "jsx", "rs", "py", "html", "css", "json", "java", "c",
    "cpp", "cs", "go", "php", "sh", "bat", "ps1", "toml", "yml", "yaml", "xml", "sql",
  ],
};

export const KIND_ICON: Record<FileKind, LucideIcon> = {
  folder: Folder,
  image: ImageIcon,
  video: Film,
  audio: Music,
  archive: Archive,
  pdf: FileText,
  doc: FileText,
  code: FileCode,
  other: FileIcon,
};

const KIND_LABEL: Record<FileKind, string> = {
  folder: "folder",
  image: "gambar",
  video: "video",
  audio: "audio",
  archive: "arsip",
  pdf: "PDF",
  doc: "dokumen",
  code: "kode",
  other: "file",
};

export function classify(ext: string, isDir: boolean): FileKind {
  if (isDir) return "folder";
  const e = ext.toLowerCase();

  for (const [kind, list] of Object.entries(EXT)) {
    if (list.includes(e)) return kind as FileKind;
  }

  return "other";
}

export function formatSize(bytes: number | null): string {
  if (bytes == null) return "";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }

  const shown = value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[i]}`;
}

// Judul + keterangan untuk header panel
export function describeItems(items: FileItem[]): {
  title: string;
  subtitle: string;
  kind: FileKind;
} {
  if (items.length === 0) return { title: "File", subtitle: "", kind: "other" };

  if (items.length === 1) {
    const it = items[0];

    const subtitle = it.isDir
      ? it.children != null
        ? `Folder · ${it.children} item`
        : "Folder"
      : [it.ext.toUpperCase(), formatSize(it.size)].filter(Boolean).join(" · ");

    return { title: it.name, subtitle, kind: it.kind };
  }

  const kinds = new Set(items.map((i) => i.kind));
  const same = kinds.size === 1;
  const kind: FileKind = same ? items[0].kind : "other";

  return {
    title: `${items.length} item`,
    subtitle: same ? `${items.length} ${KIND_LABEL[kind]}` : "Campuran",
    kind,
  };
}

const act = (
  id: string,
  label: string,
  Icon: LucideIcon,
  tone: FileAction["tone"] = "neutral",
): FileAction => ({ id, label, Icon, tone });

// jpeg dianggap sama dengan jpg
const norm = (ext: string) => (ext === "jpeg" ? "jpg" : ext);

const IMAGE_TARGETS: [string, string][] = [
  ["png", "PNG"],
  ["jpg", "JPG"],
  ["webp", "WebP"],
  ["bmp", "BMP"],
];

// Susun kotak aksi sesuai isi yang diseret (satu atau banyak item)
export function buildActions(items: FileItem[], tools: FileTools): FileAction[] {
  if (items.length === 0) return [];

  const out: FileAction[] = [];
  const single = items.length === 1;
  const kinds = new Set(items.map((i) => i.kind));
  const kind: FileKind | "mixed" = kinds.size === 1 ? items[0].kind : "mixed";

  const addArchives = () => {
    out.push(act("zip", "ZIP", Archive, "accent"));
    if (tools.rar) out.push(act("rar", "RAR", Archive, "accent"));
    if (tools.sevenZip) out.push(act("7z", "7z", Archive, "accent"));
  };

  switch (kind) {
    case "folder":
      addArchives();
      if (single) out.push(act("terminal", "Terminal", Terminal, "accent"));
      break;

    case "image":
      for (const [fmt, label] of IMAGE_TARGETS) {
        if (!items.every((i) => norm(i.ext) === fmt)) {
          out.push(act(`img_${fmt}`, ` ${label}`, ImageIcon, "accent"));
        }
      }
      out.push(act("img_pdf", single ? "PDF" : "Satu PDF", FileText, "accent"));
      out.push(act("img_shrink", "Compress", Minimize2, "accent"));
      out.push(act("zip", "ZIP", Archive, "accent"));
      break;

    case "archive":
      out.push(act("extract_folder", "Ekstrak", Download, "accent"));
      break;

    case "video":
      if (tools.ffmpeg) {
        if (!items.every((i) => i.ext === "mp4")) {
          out.push(act("vid_mp4", "MP4", Film, "accent"));
        }
        out.push(act("vid_mp3", "Convert MP3", Music, "accent"));
      }
      out.push(act("zip", "ZIP", Archive, "accent"));
      break;

    case "audio":
      if (tools.ffmpeg) {
        if (!items.every((i) => i.ext === "mp3")) {
          out.push(act("aud_mp3", "MP3", Music, "accent"));
        }
        if (!items.every((i) => i.ext === "wav")) {
          out.push(act("aud_wav", "WAV", Music, "accent"));
        }
      }
      out.push(act("zip", "ZIP", Archive, "accent"));
      break;

    default:
      // pdf, dokumen, kode, campuran, tak dikenal
      out.push(act("zip", "ZIP", Archive, "accent"));
      break;
  }

  // Aksi umum selalu di baris paling akhir
  out.push(act("copy", "Salin", Copy));
  out.push(act("cut", "Potong", Scissors));
  if (single) out.push(act("reveal", "Lokasi", FolderOpen));
  out.push(act("trash", "Hapus", Trash2, "danger"));

  return out;
}
