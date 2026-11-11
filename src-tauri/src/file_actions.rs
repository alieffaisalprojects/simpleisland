//! file_actions.rs
//! Aksi file untuk island saat file / folder diseret ke atasnya.
//!
//! Command Tauri:
//!   file_inspect(paths)         -> info tiap item (folder atau file, ukuran, ekstensi)
//!   file_tools()                -> alat tambahan yang terpasang (WinRAR, 7-Zip, ffmpeg)
//!   file_action(action, paths)  -> menjalankan satu aksi (id sama dengan catalog.ts)
//!   file_pick_folder(start)     -> dialog pilih folder tujuan (tombol Paste di island)
//!   file_paste(paths, dest, cut)-> salin / pindahkan file ke folder yang dipilih
//!   file_rename(paths, newName) -> ganti nama (satu file) / nama dasar + nomor (banyak file)
//!   file_properties(paths)      -> info properti (ukuran, tanggal, atribut, dimensi, halaman PDF)
//!
//! Cara kerja aksi:
//!   - gambar      : crate `image` (PNG, JPG, WebP, BMP) + penulis PDF sederhana
//!   - hapus bg    : algoritma sendiri (modul `bgremove`), cocok untuk latar polos / gradasi
//!   - compress PDF: crate `lopdf` (JPEG di dalam PDF dikecilkan + stream dikompres)
//!   - ZIP / ekstrak : tar.exe bawaan Windows 10/11 (cadangan: PowerShell Compress-Archive)
//!   - RAR / 7z    : hanya bila WinRAR / 7-Zip terpasang
//!   - salin/potong/hapus : PowerShell (clipboard file Explorer, Recycle Bin)
//!   - video/audio : hanya bila ffmpeg ada di PATH

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ---------------------------------------------------------------------------
// Tipe data ke frontend
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    path: String,
    name: String,
    ext: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<u32>,
    exists: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileTools {
    rar: bool,
    seven_zip: bool,
    ffmpeg: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    message: String,
    output: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    message: String,
    paths: Vec<String>, // path baru, urutannya sama dengan input
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileProps {
    count: usize,
    name: String,
    location: String, // kosong bila item berasal dari folder yang berbeda
    is_dir: bool,
    ext: String,
    size: u64,
    files: u64,
    folders: u64,
    approx: bool, // folder terlalu besar, hitungan dihentikan di tengah jalan
    created_ms: Option<i64>,
    modified_ms: Option<i64>,
    accessed_ms: Option<i64>,
    read_only: bool,
    hidden: bool,
    extra: Option<String>, // dimensi gambar / jumlah halaman PDF
}

fn done(message: impl Into<String>, output: Option<&Path>) -> ActionResult {
    ActionResult {
        message: message.into(),
        output: output.map(|p| p.to_string_lossy().to_string()),
    }
}

// ---------------------------------------------------------------------------
// Command Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn file_inspect(paths: Vec<String>) -> Vec<FileMeta> {
    tauri::async_runtime::spawn_blocking(move || {
        paths.iter().map(|p| inspect(p)).collect::<Vec<FileMeta>>()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn file_tools() -> FileTools {
    tauri::async_runtime::spawn_blocking(|| FileTools {
        rar: locate_rar().is_some(),
        seven_zip: locate_7z().is_some(),
        ffmpeg: locate_ffmpeg().is_some(),
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn file_action(action: String, paths: Vec<String>) -> Result<ActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_action(&action, &paths))
        .await
        .map_err(|e| e.to_string())?
}

// Dialog pilih folder tujuan. `None` bila dibatalkan.
// Dibuka sebagai anak window island supaya muncul di atasnya (island selalu di depan).
#[tauri::command]
pub async fn file_pick_folder(
    window: WebviewWindow,
    start: Option<String>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window
            .dialog()
            .file()
            .set_title("Pilih folder tujuan")
            .set_parent(&window);

        // Mulai dari folder asal file
        if let Some(s) = start {
            let dir = parent_dir(Path::new(&s));

            if dir.is_dir() {
                dialog = dialog.set_directory(dir);
            }
        }

        match dialog.blocking_pick_folder() {
            Some(chosen) => chosen
                .into_path()
                .map(|p| Some(p.to_string_lossy().to_string()))
                .map_err(|e| e.to_string()),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// Tempel: salin (atau pindahkan bila `cut`) semua item ke folder `dest`
#[tauri::command]
pub async fn file_paste(
    paths: Vec<String>,
    dest: String,
    cut: bool,
) -> Result<ActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || paste_into(&paths, &dest, cut))
        .await
        .map_err(|e| e.to_string())?
}

// Ganti nama. Satu item: `new_name` = nama lengkap baru.
// Banyak item: `new_name` = nama dasar, hasilnya "nama (1).ext", "nama (2).ext", ...
#[tauri::command]
pub async fn file_rename(paths: Vec<String>, new_name: String) -> Result<RenameResult, String> {
    tauri::async_runtime::spawn_blocking(move || rename_items(&paths, &new_name))
        .await
        .map_err(|e| e.to_string())?
}

// Properti satu atau banyak item
#[tauri::command]
pub async fn file_properties(paths: Vec<String>) -> Result<FileProps, String> {
    tauri::async_runtime::spawn_blocking(move || properties(&paths))
        .await
        .map_err(|e| e.to_string())?
}

fn inspect(p: &str) -> FileMeta {
    let path = Path::new(p);
    let meta = fs::metadata(path).ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string());

    let ext = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };

    let children = if is_dir {
        fs::read_dir(path).ok().map(|d| d.count() as u32)
    } else {
        None
    };

    FileMeta {
        path: p.to_string(),
        name,
        ext,
        is_dir,
        size: if is_dir { None } else { meta.as_ref().map(|m| m.len()) },
        children,
        exists: meta.is_some(),
    }
}

// ---------------------------------------------------------------------------
// Pembagi aksi
// ---------------------------------------------------------------------------

fn run_action(action: &str, paths: &[String]) -> Result<ActionResult, String> {
    if paths.is_empty() {
        return Err("Tidak ada file".to_string());
    }

    for p in paths {
        if !Path::new(p).exists() {
            return Err(format!("Tidak ditemukan: {p}"));
        }
    }

    match action {
        "copy" => {
            clipboard_files(paths, false)?;
            Ok(done("Disalin, tinggal tempel", None))
        }

        "cut" => {
            clipboard_files(paths, true)?;
            Ok(done("Dipotong, tempel untuk memindah", None))
        }

        "copy_path" => {
            copy_paths_as_text(paths)?;
            Ok(done("Path disalin", None))
        }

        "reveal" => {
            reveal(&paths[0])?;
            Ok(done("Dibuka di Explorer", None))
        }

        "trash" => {
            trash(paths)?;
            Ok(done("Dihapus ke Recycle Bin", None))
        }

        "terminal" => {
            open_terminal(&paths[0])?;
            Ok(done("Terminal dibuka", None))
        }

        "zip" | "rar" | "7z" => {
            let out = make_archive(action, paths)?;
            Ok(done(format!("Dibuat: {}", file_label(&out)), Some(out.as_path())))
        }

        "extract_folder" | "extract_here" => {
            let mut last: Option<PathBuf> = None;

            for p in paths {
                last = Some(extract(p, action == "extract_here")?);
            }

            Ok(done("Selesai diekstrak", last.as_deref()))
        }

        "pdf_shrink" => pdf_shrink(paths),

        a if a.starts_with("img_") => image_action(&a[4..], paths),

        "vid_mp4" | "vid_mp3" | "aud_mp3" | "aud_wav" => media_action(action, paths),

        _ => Err(format!("Aksi tidak dikenal: {action}")),
    }
}

// ---------------------------------------------------------------------------
// Pembantu umum
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

// Jalankan perintah, kembalikan baris error terakhir bila gagal
fn run(cmd: &mut Command) -> Result<(), String> {
    hide_window(cmd);

    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;

    if out.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let last_line = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string());

    Err(last_line.unwrap_or_else(|| format!("Perintah gagal ({})", out.status)))
}

fn encode_script(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();

    general_purpose::STANDARD.encode(bytes)
}

// Jalankan skrip PowerShell. Daftar path dan variabel lain dikirim lewat
// environment, jadi nama file aneh tidak merusak perintah.
fn powershell(script: &str, paths: &[String], extra: &[(&str, &str)]) -> Result<(), String> {
    let encoded = encode_script(script);

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
    ])
    .arg(encoded)
    .env("ISLAND_PATHS", paths.join("\n"));

    for (k, v) in extra {
        cmd.env(k, v);
    }

    run(&mut cmd)
}

fn parent_dir(p: &Path) -> PathBuf {
    p.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn file_label(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

// Nama tanpa ekstensi untuk file, nama utuh untuk folder (mis. "v1.2")
fn display_stem(p: &Path) -> String {
    let name = if p.is_dir() { p.file_name() } else { p.file_stem() };

    name.map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Berkas".to_string())
}

// Nama baru yang belum dipakai: "foto.png", "foto (1).png", "foto (2).png" ...
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let name_for = |n: u32| -> String {
        let base = if n == 0 {
            stem.to_string()
        } else {
            format!("{stem} ({n})")
        };

        if ext.is_empty() {
            base
        } else {
            format!("{base}.{ext}")
        }
    };

    let mut n = 0;

    loop {
        let candidate = dir.join(name_for(n));

        if !candidate.exists() {
            return candidate;
        }

        n += 1;
    }
}

// Ukuran file yang enak dibaca: "12 MB", "4.5 MB"
fn format_size(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut i = 0;

    while value >= 1024.0 && i < units.len() - 1 {
        value /= 1024.0;
        i += 1;
    }

    if i == 0 || value >= 10.0 {
        format!("{:.0} {}", value, units[i])
    } else {
        format!("{:.1} {}", value, units[i])
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;

    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

fn in_program_files(rel: &str) -> Option<PathBuf> {
    ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|base| PathBuf::from(base).join(rel))
        .find(|p| p.is_file())
}

fn locate_rar() -> Option<PathBuf> {
    in_program_files("WinRAR\\Rar.exe").or_else(|| find_in_path("Rar.exe"))
}

fn locate_unrar() -> Option<PathBuf> {
    in_program_files("WinRAR\\UnRAR.exe").or_else(locate_rar)
}

fn locate_7z() -> Option<PathBuf> {
    in_program_files("7-Zip\\7z.exe").or_else(|| find_in_path("7z.exe"))
}

fn locate_ffmpeg() -> Option<PathBuf> {
    find_in_path("ffmpeg.exe")
}

// ---------------------------------------------------------------------------
// Clipboard, Recycle Bin, Explorer, Terminal
// ---------------------------------------------------------------------------

// Salin / potong file ke clipboard seperti Ctrl+C / Ctrl+X di Explorer
const SCRIPT_CLIPBOARD: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = $env:ISLAND_PATHS -split [char]10 | Where-Object { $_ }
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { [void]$list.Add($p) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
$effect = if ($env:ISLAND_MODE -eq 'cut') { 2 } else { 1 }
$stream = New-Object System.IO.MemoryStream(,[byte[]]@($effect,0,0,0))
$data.SetData('Preferred DropEffect', $stream)
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
"#;

// Hapus ke Recycle Bin (bukan hapus permanen)
const SCRIPT_TRASH: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($p in ($env:ISLAND_PATHS -split [char]10 | Where-Object { $_ })) {
  if (Test-Path -LiteralPath $p -PathType Container) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  } else {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
  }
}
"#;

const SCRIPT_COPY_TEXT: &str = r#"
$ErrorActionPreference = 'Stop'
Set-Clipboard -Value (($env:ISLAND_PATHS -split [char]10) -join [Environment]::NewLine)
"#;

// Cadangan ZIP bila file berasal dari folder yang berbeda-beda
const SCRIPT_COMPRESS: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$list = $env:ISLAND_PATHS -split [char]10 | Where-Object { $_ }
Compress-Archive -LiteralPath $list -DestinationPath $env:ISLAND_OUT
"#;

fn clipboard_files(paths: &[String], cut: bool) -> Result<(), String> {
    powershell(
        SCRIPT_CLIPBOARD,
        paths,
        &[("ISLAND_MODE", if cut { "cut" } else { "copy" })],
    )
}

fn copy_paths_as_text(paths: &[String]) -> Result<(), String> {
    powershell(SCRIPT_COPY_TEXT, paths, &[])
}

fn trash(paths: &[String]) -> Result<(), String> {
    powershell(SCRIPT_TRASH, paths, &[])
}

#[cfg(windows)]
fn reveal(path: &str) -> Result<(), String> {
    // raw_arg: Explorer butuh format /select,"path" persis seperti ini
    Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn reveal(_path: &str) -> Result<(), String> {
    Err("Hanya tersedia di Windows".to_string())
}

fn open_terminal(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    let dir = if p.is_dir() { p.to_path_buf() } else { parent_dir(p) };

    // Windows Terminal dulu
    if Command::new("wt.exe").arg("-d").arg(&dir).spawn().is_ok() {
        return Ok(());
    }

    // Cadangan: jendela cmd biasa di folder tersebut
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/c", "start", "cmd.exe"]).current_dir(&dir);
    hide_window(&mut cmd);

    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Ganti nama (Rename)
// ---------------------------------------------------------------------------

const WIN_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

// Aturan nama file Windows
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Nama tidak boleh kosong".to_string());
    }

    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 32)
    {
        return Err("Nama tidak boleh memuat < > : \" / \\ | ? *".to_string());
    }

    if name.ends_with('.') {
        return Err("Nama tidak boleh diakhiri titik".to_string());
    }

    let stem = name.split('.').next().unwrap_or("").to_uppercase();

    if WIN_RESERVED.contains(&stem.as_str()) {
        return Err(format!("\"{stem}\" nama khusus Windows, pakai nama lain"));
    }

    Ok(())
}

fn rename_items(paths: &[String], new_name: &str) -> Result<RenameResult, String> {
    if paths.is_empty() {
        return Err("Tidak ada file".to_string());
    }

    let name = new_name.trim();
    validate_name(name)?;

    // Ganti huruf besar/kecil saja ("foto.png" -> "Foto.png") dianggap file yang sama
    let same_entry = |a: &Path, b: &Path| {
        a.parent() == b.parent() && file_label(a).to_lowercase() == file_label(b).to_lowercase()
    };

    // Susun semua pasangan (lama, baru) dulu, supaya gagal sebelum ada yang berubah
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (i, p) in paths.iter().enumerate() {
        let src = Path::new(p);

        if !src.exists() {
            return Err(format!("Tidak ditemukan: {}", file_label(src)));
        }

        let target_name = if paths.len() == 1 {
            name.to_string()
        } else {
            let n = i + 1;

            match src.extension() {
                Some(e) if !src.is_dir() => format!("{name} ({n}).{}", e.to_string_lossy()),
                _ => format!("{name} ({n})"),
            }
        };

        let dst = parent_dir(src).join(target_name);

        if dst.as_path() != src && dst.exists() && !same_entry(src, &dst) {
            return Err(format!("Sudah ada: {}", file_label(&dst)));
        }

        plan.push((src.to_path_buf(), dst));
    }

    // Jalankan; bila ada yang gagal, kembalikan yang sudah terlanjur diganti
    let mut applied: Vec<(PathBuf, PathBuf)> = Vec::new();

    for (src, dst) in &plan {
        if src == dst {
            continue;
        }

        if let Err(e) = fs::rename(src, dst) {
            for (s, d) in applied.iter().rev() {
                let _ = fs::rename(d, s);
            }

            return Err(format!("{}: {e}", file_label(src)));
        }

        applied.push((src.clone(), dst.clone()));
    }

    let new_paths: Vec<String> = plan
        .iter()
        .map(|(_, d)| d.to_string_lossy().to_string())
        .collect();

    let message = if plan.len() == 1 {
        if plan[0].0 == plan[0].1 {
            "Nama tidak berubah".to_string()
        } else {
            format!("Diganti jadi {}", file_label(&plan[0].1))
        }
    } else {
        format!("{} item diganti nama", plan.len())
    };

    Ok(RenameResult {
        message,
        paths: new_paths,
    })
}

// ---------------------------------------------------------------------------
// Properti
// ---------------------------------------------------------------------------

// Folder dengan isi lebih dari ini dihitung sampai batas saja (ditandai `approx`)
const WALK_LIMIT: u64 = 300_000;

fn ms_of(t: std::io::Result<SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

// (hanya-baca, tersembunyi)
#[cfg(windows)]
fn attr_flags(meta: &fs::Metadata) -> (bool, bool) {
    use std::os::windows::fs::MetadataExt;

    let a = meta.file_attributes();
    (a & 0x1 != 0, a & 0x2 != 0)
}

#[cfg(not(windows))]
fn attr_flags(meta: &fs::Metadata) -> (bool, bool) {
    (meta.permissions().readonly(), false)
}

// Hitung isi folder. Tautan simbolik dilewati supaya tidak berputar tanpa ujung.
// Mengembalikan true bila berhenti karena batas WALK_LIMIT.
fn walk_dir(root: &Path, files: &mut u64, folders: &mut u64, size: &mut u64) -> bool {
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };

        for entry in entries.flatten() {
            if *files + *folders >= WALK_LIMIT {
                return true;
            }

            let Ok(kind) = entry.file_type() else {
                continue;
            };

            if kind.is_symlink() {
                continue;
            }

            if kind.is_dir() {
                *folders += 1;
                stack.push(entry.path());
            } else {
                *files += 1;

                if let Ok(m) = entry.metadata() {
                    *size += m.len();
                }
            }
        }
    }

    false
}

// Keterangan tambahan: dimensi gambar atau jumlah halaman PDF
fn file_extra(path: &Path, ext: &str, size: u64) -> Option<String> {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff" | "ico" => {
            image::image_dimensions(path)
                .ok()
                .map(|(w, h)| format!("{w} × {h} px"))
        }

        "pdf" if size <= 60 * 1024 * 1024 => lopdf::Document::load(path)
            .ok()
            .map(|d| format!("{} halaman", d.get_pages().len())),

        _ => None,
    }
}

fn properties(paths: &[String]) -> Result<FileProps, String> {
    if paths.is_empty() {
        return Err("Tidak ada file".to_string());
    }

    let single = paths.len() == 1;
    let mut p = FileProps {
        count: paths.len(),
        ..Default::default()
    };

    let mut parents: Vec<PathBuf> = Vec::new();
    let (mut files, mut folders, mut size) = (0u64, 0u64, 0u64);

    for s in paths {
        let path = Path::new(s);

        let meta = fs::metadata(path)
            .map_err(|_| format!("Tidak ditemukan: {}", file_label(path)))?;

        let parent = parent_dir(path);

        if !parents.contains(&parent) {
            parents.push(parent);
        }

        if meta.is_dir() {
            if !single {
                folders += 1;
            }

            if walk_dir(path, &mut files, &mut folders, &mut size) {
                p.approx = true;
            }
        } else {
            if !single {
                files += 1;
            }

            size += meta.len();
        }

        if single {
            let label = file_label(path);

            p.name = if label.is_empty() { s.clone() } else { label };
            p.is_dir = meta.is_dir();

            p.ext = if meta.is_dir() {
                String::new()
            } else {
                path.extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };

            p.created_ms = ms_of(meta.created());
            p.modified_ms = ms_of(meta.modified());
            p.accessed_ms = ms_of(meta.accessed());

            let (read_only, hidden) = attr_flags(&meta);
            p.read_only = read_only;
            p.hidden = hidden;

            if !meta.is_dir() {
                p.extra = file_extra(path, &p.ext, meta.len());
            }
        }
    }

    p.files = files;
    p.folders = folders;
    p.size = size;

    p.location = if parents.len() == 1 {
        parents[0].to_string_lossy().to_string()
    } else {
        String::new()
    };

    Ok(p)
}

// ---------------------------------------------------------------------------
// Tempel (Paste) ke folder pilihan
// ---------------------------------------------------------------------------

// Nama tujuan di `dir`. Bila sudah dipakai, pola Explorer:
// "foto - Copy.png", "foto - Copy (2).png" ...
fn paste_target(dir: &Path, src: &Path) -> PathBuf {
    let name = src.file_name().unwrap_or_default();
    let direct = dir.join(name);

    if !direct.exists() {
        return direct;
    }

    let (stem, ext) = if src.is_dir() {
        (name.to_string_lossy().to_string(), String::new())
    } else {
        (
            src.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            src.extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
    };

    let mut n = 1u32;

    loop {
        let label = if n == 1 {
            format!("{stem} - Copy")
        } else {
            format!("{stem} - Copy ({n})")
        };

        let full = if ext.is_empty() {
            label
        } else {
            format!("{label}.{ext}")
        };

        let candidate = dir.join(full);

        if !candidate.exists() {
            return candidate;
        }

        n += 1;
    }
}

// Salin file atau seluruh isi folder. Tautan simbolik / junction di dalam folder
// dilewati supaya tidak berputar tanpa ujung (mis. "Application Data" di profil user).
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;

        for entry in fs::read_dir(src)? {
            let entry = entry?;

            if entry.file_type()?.is_symlink() {
                continue;
            }

            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }

        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ())
    }
}

fn remove_any(p: &Path) -> std::io::Result<()> {
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
}

fn paste_into(paths: &[String], dest: &str, cut: bool) -> Result<ActionResult, String> {
    if paths.is_empty() {
        return Err("Tidak ada file".to_string());
    }

    let dest_dir = Path::new(dest);

    if !dest_dir.is_dir() {
        return Err("Folder tujuan tidak ditemukan".to_string());
    }

    let dest_real = fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
    let mut last: Option<PathBuf> = None;
    let mut count = 0usize;

    for p in paths {
        let src = Path::new(p);

        if !src.exists() {
            return Err(format!("Tidak ditemukan: {}", file_label(src)));
        }

        let src_real = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());

        // Folder tidak boleh ditempel ke dalam dirinya sendiri
        if src_real.is_dir() && dest_real.starts_with(&src_real) {
            return Err(format!(
                "Folder \"{}\" tidak bisa ditempel ke dalam dirinya sendiri",
                file_label(src)
            ));
        }

        // Dipindah ke folder yang sama: tidak ada yang perlu dilakukan
        if cut && src_real.parent() == Some(dest_real.as_path()) {
            count += 1;
            last = Some(src.to_path_buf());
            continue;
        }

        let target = paste_target(dest_dir, src);

        if cut {
            // Pindah di drive yang sama itu instan; antar drive jatuh ke salin + hapus
            if fs::rename(src, &target).is_err() {
                let moved = copy_recursive(src, &target).and_then(|_| remove_any(src));

                if let Err(e) = moved {
                    let _ = remove_any(&target); // buang hasil setengah jadi
                    return Err(format!("{}: {e}", file_label(src)));
                }
            }
        } else if let Err(e) = copy_recursive(src, &target) {
            let _ = remove_any(&target);
            return Err(format!("{}: {e}", file_label(src)));
        }

        count += 1;
        last = Some(target);
    }

    let folder = match file_label(dest_dir) {
        name if name.is_empty() => dest.to_string(), // akar drive, mis. "D:\"
        name => name,
    };

    let message = if count == 1 {
        format!("Ditempel ke {folder}")
    } else {
        format!("{count} item ditempel ke {folder}")
    };

    Ok(done(message, last.as_deref()))
}

// ---------------------------------------------------------------------------
// Arsip: buat dan ekstrak
// ---------------------------------------------------------------------------

fn make_archive(kind: &str, paths: &[String]) -> Result<PathBuf, String> {
    let first = Path::new(&paths[0]);
    let dir = parent_dir(first);

    let base = if paths.len() == 1 {
        display_stem(first)
    } else {
        "Arsip".to_string()
    };

    let out = unique_path(&dir, &base, kind);

    // Nama relatif terhadap folder induk, supaya isi arsip rapi
    let same_parent = paths
        .iter()
        .all(|p| Path::new(p).parent() == first.parent());

    let mut names: Vec<OsString> = Vec::new();

    for p in paths {
        let name = Path::new(p).file_name().ok_or("Nama file tidak valid")?;
        names.push(name.to_os_string());
    }

    match kind {
        "zip" => {
            if same_parent {
                let mut c = Command::new("tar.exe");
                c.arg("-a").arg("-c").arg("-f").arg(&out).arg("-C").arg(&dir);
                c.args(&names);
                run(&mut c)?;
            } else {
                let out_str = out.to_string_lossy().to_string();
                powershell(SCRIPT_COMPRESS, paths, &[("ISLAND_OUT", out_str.as_str())])?;
            }
        }

        "rar" => {
            let tool = locate_rar().ok_or("WinRAR tidak ditemukan")?;
            let mut c = Command::new(tool);
            c.current_dir(&dir).arg("a").arg("-r").arg(&out);
            c.args(&names);
            run(&mut c)?;
        }

        "7z" => {
            let tool = locate_7z().ok_or("7-Zip tidak ditemukan")?;
            let mut c = Command::new(tool);
            c.current_dir(&dir).arg("a").arg(&out);
            c.args(&names);
            run(&mut c)?;
        }

        _ => return Err(format!("Format arsip tidak dikenal: {kind}")),
    }

    Ok(out)
}

fn extract(path: &str, here: bool) -> Result<PathBuf, String> {
    let src = Path::new(path);
    let parent = parent_dir(src);

    let dest = if here {
        parent.clone()
    } else {
        let stem = display_stem(src);
        let stem = stem
            .strip_suffix(".tar")
            .map(str::to_string)
            .unwrap_or(stem);

        unique_path(&parent, &stem, "")
    };

    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if let Some(tool) = locate_7z() {
        let mut out_arg = OsString::from("-o");
        out_arg.push(&dest);

        let mut c = Command::new(tool);
        c.arg("x").arg("-y").arg(out_arg).arg(src);
        run(&mut c)?;
    } else if ext == "rar" {
        let tool = locate_unrar().ok_or("Untuk RAR butuh WinRAR atau 7-Zip")?;

        let mut dest_arg = dest.clone().into_os_string();
        dest_arg.push("\\");

        let mut c = Command::new(tool);
        c.arg("x").arg("-y").arg(src).arg(dest_arg);
        run(&mut c)?;
    } else {
        let mut c = Command::new("tar.exe");
        c.arg("-x").arg("-f").arg(src).arg("-C").arg(&dest);
        run(&mut c)?;
    }

    Ok(dest)
}

// ---------------------------------------------------------------------------
// Gambar
// ---------------------------------------------------------------------------

use image::{imageops::FilterType, DynamicImage};

// Ratakan transparansi ke latar putih (JPEG dan PDF tidak punya alpha)
fn flatten_white(img: &DynamicImage) -> image::RgbImage {
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);

    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;

        out.put_pixel(x, y, image::Rgb([mix(p[0]), mix(p[1]), mix(p[2])]));
    }

    out
}

fn jpeg_bytes(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let rgb = DynamicImage::ImageRgb8(flatten_white(img));
    let mut out: Vec<u8> = Vec::new();

    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    rgb.write_with_encoder(encoder).map_err(|e| e.to_string())?;

    Ok(out)
}

fn save_image(img: &DynamicImage, out: &Path, ext: &str) -> Result<(), String> {
    match ext {
        "jpg" | "jpeg" => fs::write(out, jpeg_bytes(img, 92)?).map_err(|e| e.to_string()),
        "webp" | "bmp" => DynamicImage::ImageRgba8(img.to_rgba8())
            .save(out)
            .map_err(|e| e.to_string()),
        _ => img.save(out).map_err(|e| e.to_string()),
    }
}

// Ekstensi keluaran untuk Perkecil / Putar: samakan dengan sumber bila bisa ditulis
fn keep_ext(src: &Path) -> String {
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "jpg" | "jpeg" => "jpg".to_string(),
        "png" | "webp" | "bmp" => ext,
        _ => "png".to_string(),
    }
}

// Gambar di atas ini (jumlah piksel) ditolak oleh Hapus BG supaya memori tidak jebol
const RMBG_MAX_PIXELS: usize = 36_000_000;

fn image_action(op: &str, paths: &[String]) -> Result<ActionResult, String> {
    if op == "pdf" {
        return images_to_pdf(paths);
    }

    let mut last: Option<PathBuf> = None;

    for p in paths {
        let src = Path::new(p);

        if src.is_dir() {
            return Err("Folder tidak bisa diproses sebagai gambar".to_string());
        }

        let img = image::open(src).map_err(|e| format!("{}: {e}", file_label(src)))?;
        let dir = parent_dir(src);
        let stem = display_stem(src);

        let out = match op {
            "png" | "jpg" | "webp" | "bmp" => {
                let out = unique_path(&dir, &stem, op);
                save_image(&img, &out, op)?;
                out
            }

            "shrink" => {
                let small = img.resize(
                    (img.width() / 2).max(1),
                    (img.height() / 2).max(1),
                    FilterType::Lanczos3,
                );
                let ext = keep_ext(src);
                let out = unique_path(&dir, &format!("{stem} (Dikompres)"), &ext);
                save_image(&small, &out, &ext)?;
                out
            }

            "rotate" => {
                let turned = img.rotate90();
                let ext = keep_ext(src);
                let out = unique_path(&dir, &format!("{stem} (putar)"), &ext);
                save_image(&turned, &out, &ext)?;
                out
            }

            // Hapus background -> PNG transparan
            "rmbg" => {
                let rgba = img.to_rgba8();
                let (w, h) = (rgba.width() as usize, rgba.height() as usize);

                if w * h > RMBG_MAX_PIXELS {
                    return Err(format!("{}: gambar terlalu besar", file_label(src)));
                }

                let mut buf = rgba.into_raw();

                if !bgremove::remove(&mut buf, w, h) {
                    return Err(format!(
                        "{}: latar belakang tidak terdeteksi (butuh latar polos / gradasi)",
                        file_label(src)
                    ));
                }

                let cut = image::RgbaImage::from_raw(w as u32, h as u32, buf)
                    .ok_or("Gagal menyusun gambar")?;

                let out = unique_path(&dir, &format!("{stem} (tanpa bg)"), "png");
                cut.save(&out).map_err(|e| e.to_string())?;
                out
            }

            _ => return Err(format!("Aksi gambar tidak dikenal: {op}")),
        };

        last = Some(out);
    }

    let message = match (paths.len(), last.as_ref()) {
        (1, Some(out)) => format!("Tersimpan: {}", file_label(out)),
        (n, _) => format!("{n} gambar selesai"),
    };

    Ok(done(message, last.as_deref()))
}

// ---------------------------------------------------------------------------
// Hapus background (tanpa AI, murni algoritma)
//
// Cara kerja:
//   1. Warna latar diambil dari median piksel di tepi gambar (ruang warna Lab).
//   2. Area latar ditumbuhkan dari tepi (flood fill) dengan toleransi otomatis.
//      Gradasi mulus ikut dikenali, jadi latar yang tidak rata tetap bersih.
//   3. Bintik kecil dibuang.
//   4. Di sekitar tepi objek (3 px) dihitung transparansi halus (anti-alias)
//      dan warna tepi dibersihkan dari sisa warna latar, jadi tidak ada "halo" putih.
//
// Cocok untuk: latar polos / gradasi (foto produk, pas foto, logo, tanda tangan).
// Tidak cocok untuk latar ramai (pemandangan, ruangan) karena itu butuh model AI.
// ---------------------------------------------------------------------------

mod bgremove {
    use std::collections::VecDeque;

    const NONE: usize = usize::MAX;
    const BAND: u8 = 3; // lebar zona tepi (piksel)

    fn srgb_lut() -> [f32; 256] {
        let mut lut = [0f32; 256];

        for (i, v) in lut.iter_mut().enumerate() {
            let c = i as f32 / 255.0;
            *v = if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            };
        }

        lut
    }

    // sRGB 8-bit -> Lab (D65)
    fn lab_of(r: u8, g: u8, b: u8, lut: &[f32; 256]) -> [f32; 3] {
        let (r, g, b) = (lut[r as usize], lut[g as usize], lut[b as usize]);

        let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
        let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;

        let f = |t: f32| {
            if t > 0.008856 {
                t.cbrt()
            } else {
                7.787 * t + 16.0 / 116.0
            }
        };

        let (fx, fy, fz) = (f(x), f(y), f(z));

        [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
    }

    fn dist(a: &[f32; 3], b: &[f32; 3]) -> f32 {
        let (dl, da, db) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        (dl * dl + da * da + db * db).sqrt()
    }

    fn sort_f32(v: &mut [f32]) {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }

    fn median(samples: &[[f32; 3]], channel: usize) -> f32 {
        let mut v: Vec<f32> = samples.iter().map(|p| p[channel]).collect();
        sort_f32(&mut v);
        v[v.len() / 2]
    }

    // Empat tetangga (kiri, kanan, atas, bawah); NONE bila di luar gambar
    fn neighbors(i: usize, w: usize, h: usize) -> [usize; 4] {
        let (x, y) = (i % w, i / w);

        [
            if x > 0 { i - 1 } else { NONE },
            if x + 1 < w { i + 1 } else { NONE },
            if y > 0 { i - w } else { NONE },
            if y + 1 < h { i + w } else { NONE },
        ]
    }

    // `px` = RGBA 8-bit. Mengubah kanal alpha (dan warna tepi) di tempat.
    // Mengembalikan false bila latar tidak terdeteksi.
    pub fn remove(px: &mut [u8], w: usize, h: usize) -> bool {
        let n = w * h;

        if w < 8 || h < 8 || px.len() < n * 4 {
            return false;
        }

        let lut = srgb_lut();

        let lab: Vec<[f32; 3]> = (0..n)
            .map(|i| lab_of(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], &lut))
            .collect();

        // --- 1. Piksel tepi gambar ---
        let t = (w.min(h) / 100).clamp(1, 6);
        let mut ring: Vec<usize> = Vec::new();

        for y in 0..h {
            if y < t || y >= h - t {
                ring.extend(y * w..(y + 1) * w);
            } else {
                ring.extend(y * w..y * w + t);
                ring.extend(y * w + w - t..(y + 1) * w);
            }
        }

        // --- 2. Warna latar (median) dan toleransi otomatis ---
        let step = (ring.len() / 20_000).max(1);
        let sample: Vec<[f32; 3]> = ring.iter().step_by(step).map(|&i| lab[i]).collect();
        let med = [median(&sample, 0), median(&sample, 1), median(&sample, 2)];

        let mut devs: Vec<f32> = sample.iter().map(|p| dist(p, &med)).collect();
        sort_f32(&mut devs);
        let sigma = devs[devs.len() * 6 / 10];
        let tol = (sigma * 2.5 + 6.0).clamp(10.0, 28.0);

        let d0: Vec<f32> = lab.iter().map(|p| dist(p, &med)).collect();

        // --- 3. Tumbuhkan area latar dari tepi ---
        let grow = tol * 0.30; // selisih tetangga yang masih dianggap gradasi mulus
        let far = tol * 2.4; // batas jarak dari warna latar tengah
        let mut bg = vec![false; n];
        let mut queue: VecDeque<usize> = VecDeque::new();

        for &i in &ring {
            if !bg[i] && d0[i] < tol * 1.6 {
                bg[i] = true;
                queue.push_back(i);
            }
        }

        while let Some(i) = queue.pop_front() {
            for &j in &neighbors(i, w, h) {
                if j == NONE || bg[j] {
                    continue;
                }

                if d0[j] < tol || (d0[j] < far && dist(&lab[j], &lab[i]) < grow) {
                    bg[j] = true;
                    queue.push_back(j);
                }
            }
        }

        let bg_count = bg.iter().filter(|&&b| b).count();

        // Hampir tidak ada latar, atau hampir semuanya latar: tidak ada yang bisa dipotong
        if bg_count < n / 200 || bg_count > n - n / 200 {
            return false;
        }

        // --- 4. Buang bintik kecil (komponen objek yang terlalu kecil) ---
        let min_speck = (n / 5000).max(12);
        let mut seen = vec![false; n];
        let mut stack: Vec<usize> = Vec::new();
        let mut comp: Vec<usize> = Vec::new();

        for s in 0..n {
            if bg[s] || seen[s] {
                continue;
            }

            comp.clear();
            stack.clear();
            seen[s] = true;
            stack.push(s);

            while let Some(i) = stack.pop() {
                comp.push(i);

                for &j in &neighbors(i, w, h) {
                    if j != NONE && !bg[j] && !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }

            if comp.len() < min_speck {
                for &k in &comp {
                    bg[k] = true;
                }
            }
        }

        // --- 5. Zona tepi: jarak ke batas objek / latar (maks BAND) ---
        let mut near = vec![255u8; n];
        let mut q2: VecDeque<usize> = VecDeque::new();

        for i in 0..n {
            let on_border = neighbors(i, w, h)
                .iter()
                .any(|&j| j != NONE && bg[j] != bg[i]);

            if on_border {
                near[i] = 0;
                q2.push_back(i);
            }
        }

        while let Some(i) = q2.pop_front() {
            let d = near[i];

            if d >= BAND {
                continue;
            }

            for &j in &neighbors(i, w, h) {
                if j != NONE && near[j] == 255 {
                    near[j] = d + 1;
                    q2.push_back(j);
                }
            }
        }

        let edge: Vec<usize> = (0..n).filter(|&i| near[i] <= BAND).collect();

        // Rata-rata warna latar di seluruh tepi (cadangan bila di sekitar piksel tidak ada latar)
        let mut gsum = [0f32; 3];
        let mut gcnt = 0f32;

        for &i in &ring {
            if bg[i] {
                for c in 0..3 {
                    gsum[c] += px[i * 4 + c] as f32;
                }

                gcnt += 1.0;
            }
        }

        let gbg = if gcnt > 0.0 {
            [gsum[0] / gcnt, gsum[1] / gcnt, gsum[2] / gcnt]
        } else {
            [255.0, 255.0, 255.0]
        };

        // --- 6. Transparansi halus di zona tepi ---
        let mut alpha: Vec<u8> = bg.iter().map(|&b| if b { 0 } else { 255 }).collect();
        let mut locs: Vec<[f32; 3]> = Vec::with_capacity(edge.len());

        let lo = tol * 0.7;
        let span = tol * 1.3;
        let r = BAND as usize + 2;

        for &i in &edge {
            let (x, y) = (i % w, i / w);
            let (x0, x1) = (x.saturating_sub(r), (x + r).min(w - 1));
            let (y0, y1) = (y.saturating_sub(r), (y + r).min(h - 1));

            let mut deep = [0f32; 3]; // latar yang agak jauh dari batas
            let mut deep_n = 0f32;
            let mut any = [0f32; 3]; // semua latar di sekitar
            let mut any_n = 0f32;

            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    let j = yy * w + xx;

                    if !bg[j] {
                        continue;
                    }

                    let p = j * 4;
                    let c = [px[p] as f32, px[p + 1] as f32, px[p + 2] as f32];

                    for k in 0..3 {
                        any[k] += c[k];
                    }

                    any_n += 1.0;

                    if near[j] >= 2 {
                        for k in 0..3 {
                            deep[k] += c[k];
                        }

                        deep_n += 1.0;
                    }
                }
            }

            let loc = if deep_n > 0.0 {
                [deep[0] / deep_n, deep[1] / deep_n, deep[2] / deep_n]
            } else if any_n > 0.0 {
                [any[0] / any_n, any[1] / any_n, any[2] / any_n]
            } else {
                gbg
            };

            let loc_lab = lab_of(loc[0] as u8, loc[1] as u8, loc[2] as u8, &lut);
            let a = ((dist(&lab[i], &loc_lab) - lo) / span).clamp(0.0, 1.0);
            let a = a * a * (3.0 - 2.0 * a); // smoothstep, tepi lebih halus

            alpha[i] = (a * 255.0).round() as u8;
            locs.push(loc);
        }

        // Haluskan sedikit tepi (kotak 3x3, hanya di zona tepi)
        let snap = alpha.clone();

        for &i in &edge {
            let (x, y) = (i % w, i / w);
            let (x0, x1) = (x.saturating_sub(1), (x + 1).min(w - 1));
            let (y0, y1) = (y.saturating_sub(1), (y + 1).min(h - 1));

            let mut sum = 0u32;
            let mut cnt = 0u32;

            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    sum += snap[yy * w + xx] as u32;
                    cnt += 1;
                }
            }

            alpha[i] = (sum / cnt) as u8;
        }

        // --- 7. Bersihkan warna tepi dari sisa warna latar ---
        for (k, &i) in edge.iter().enumerate() {
            let a = alpha[i] as f32 / 255.0;

            if a > 0.0 && a < 0.999 {
                for c in 0..3 {
                    let v = (px[i * 4 + c] as f32 - (1.0 - a) * locs[k][c]) / a;
                    px[i * 4 + c] = v.clamp(0.0, 255.0) as u8;
                }
            }
        }

        // Gabungkan dengan alpha asli (gambar PNG yang memang sudah transparan)
        for i in 0..n {
            let a = alpha[i] as u32;
            let o = px[i * 4 + 3] as u32;
            px[i * 4 + 3] = (a * o / 255) as u8;
        }

        true
    }
}

// ---------------------------------------------------------------------------
// PDF: compress
//
//   - JPEG di dalam PDF didecode, diperkecil (maks 1600 px) dan dienkode ulang (kualitas 60)
//   - stream yang belum terkompresi dikompres
//   - objek yang tidak terpakai dibuang
// File asli tidak diubah; hasilnya disimpan sebagai "nama (kecil).pdf".
// ---------------------------------------------------------------------------

const PDF_MAX_SIDE: u32 = 1600;
const PDF_JPEG_QUALITY: u8 = 60;

fn pdf_name_is(obj: Option<&lopdf::Object>, want: &[u8]) -> bool {
    matches!(obj, Some(lopdf::Object::Name(n)) if n.as_slice() == want)
}

// Filter gambar hanya DCTDecode (JPEG)?
fn pdf_is_dct(dict: &lopdf::Dictionary) -> bool {
    match dict.get(b"Filter").ok() {
        Some(lopdf::Object::Name(n)) => n.as_slice() == b"DCTDecode",
        Some(lopdf::Object::Array(a)) => {
            a.len() == 1 && matches!(&a[0], lopdf::Object::Name(n) if n.as_slice() == b"DCTDecode")
        }
        _ => false,
    }
}

// Jumlah komponen warna JPEG (1 = abu-abu, 3 = RGB, 4 = CMYK), dibaca dari header SOF
fn jpeg_components(data: &[u8]) -> Option<u8> {
    let mut i = 2usize; // lewati SOI (FF D8)

    while i + 9 < data.len() {
        if data[i] != 0xFF {
            i += 1;
            continue;
        }

        let marker = data[i + 1];

        if marker == 0xFF {
            i += 1;
            continue;
        }

        // SOF0..SOF15, kecuali DHT (C4), JPG (C8), DAC (CC)
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            return Some(data[i + 9]);
        }

        // Marker tanpa panjang
        if marker == 0x00 || marker == 0x01 || marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }

        let len = ((data[i + 2] as usize) << 8) | data[i + 3] as usize;
        i += 2 + len;
    }

    None
}

// Decode -> perkecil -> enkode ulang. Mengembalikan (byte JPEG, lebar, tinggi).
fn recompress_jpeg(data: &[u8], comps: u8) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(data, image::ImageFormat::Jpeg).ok()?;

    let img = if img.width().max(img.height()) > PDF_MAX_SIDE {
        img.resize(PDF_MAX_SIDE, PDF_MAX_SIDE, FilterType::Triangle)
    } else {
        img
    };

    let mut out: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, PDF_JPEG_QUALITY);

    let written = if comps == 1 {
        DynamicImage::ImageLuma8(img.to_luma8()).write_with_encoder(encoder)
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(encoder)
    };

    written.ok()?;

    Some((out, img.width(), img.height()))
}

fn shrink_pdf_images(doc: &mut lopdf::Document) {
    for (_, obj) in doc.objects.iter_mut() {
        let lopdf::Object::Stream(stream) = obj else {
            continue;
        };

        if !pdf_name_is(stream.dict.get(b"Subtype").ok(), b"Image") {
            continue;
        }

        if !pdf_is_dct(&stream.dict) {
            continue;
        }

        // Lewati stensil / gambar bermasker warna (hasilnya bisa rusak)
        let is_mask = matches!(
            stream.dict.get(b"ImageMask").ok(),
            Some(lopdf::Object::Boolean(true))
        );

        if is_mask || stream.dict.has(b"Mask") {
            continue;
        }

        // Hanya abu-abu (1) dan RGB (3); CMYK dilewati
        let comps = match jpeg_components(&stream.content) {
            Some(c @ (1 | 3)) => c,
            _ => continue,
        };

        if let Some((data, nw, nh)) = recompress_jpeg(&stream.content, comps) {
            if data.len() < stream.content.len() {
                stream.set_content(data);
                stream.dict.set("Width", lopdf::Object::Integer(nw as i64));
                stream.dict.set("Height", lopdf::Object::Integer(nh as i64));
                stream.dict.set("BitsPerComponent", lopdf::Object::Integer(8));
                let _ = stream.dict.remove(b"DecodeParms");
            }
        }
    }
}

fn pdf_shrink(paths: &[String]) -> Result<ActionResult, String> {
    let mut last: Option<PathBuf> = None;
    let (mut before, mut after) = (0u64, 0u64);

    for p in paths {
        let src = Path::new(p);

        if src.is_dir() {
            return Err("Folder tidak bisa di-compress sebagai PDF".to_string());
        }

        let mut doc =
            lopdf::Document::load(src).map_err(|e| format!("{}: {e}", file_label(src)))?;

        if doc.trailer.has(b"Encrypt") {
            return Err(format!("{}: PDF terkunci / berpassword", file_label(src)));
        }

        shrink_pdf_images(&mut doc);
        doc.prune_objects();
        doc.delete_zero_length_streams();
        doc.compress();

        let out = unique_path(
            &parent_dir(src),
            &format!("{} (kecil)", display_stem(src)),
            "pdf",
        );

        doc.save(&out).map_err(|e| e.to_string())?;

        let old_size = fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        let new_size = fs::metadata(&out).map(|m| m.len()).unwrap_or(0);

        // Tidak lebih kecil: buang hasilnya, file asli sudah optimal
        if new_size == 0 || new_size >= old_size {
            let _ = fs::remove_file(&out);
            continue;
        }

        before += old_size;
        after += new_size;
        last = Some(out);
    }

    match last {
        Some(out) => {
            let saved = (before - after) * 100 / before;

            Ok(done(
                format!(
                    "Hemat {saved}% · {} → {}",
                    format_size(before),
                    format_size(after)
                ),
                Some(out.as_path()),
            ))
        }

        None => Ok(done("PDF sudah sekecil mungkin", None)),
    }
}

// --- PDF dari gambar (penulis PDF minimal, satu gambar per halaman) ---

struct PdfPage {
    jpeg: Vec<u8>,
    w: u32,
    h: u32,
}

fn build_pdf(pages: &[PdfPage]) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = Vec::new(); // posisi objek ke-(i+1)

    buf.extend_from_slice(b"%PDF-1.4\n");

    let kids = (0..pages.len())
        .map(|i| format!("{} 0 R", 3 + 3 * i))
        .collect::<Vec<_>>()
        .join(" ");

    offsets.push(buf.len());
    buf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    offsets.push(buf.len());
    buf.extend_from_slice(
        format!(
            "2 0 obj\n<< /Type /Pages /Kids [{kids}] /Count {} >>\nendobj\n",
            pages.len()
        )
        .as_bytes(),
    );

    for (i, page) in pages.iter().enumerate() {
        let (page_id, image_id, content_id) = (3 + 3 * i, 4 + 3 * i, 5 + 3 * i);

        // Ukuran halaman = ukuran gambar pada 96 dpi, dalam satuan point
        let pw = page.w as f64 * 0.75;
        let ph = page.h as f64 * 0.75;

        offsets.push(buf.len());
        buf.extend_from_slice(
            format!(
                "{page_id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {pw:.2} {ph:.2}] /Resources << /XObject << /Im0 {image_id} 0 R >> >> /Contents {content_id} 0 R >>\nendobj\n"
            )
            .as_bytes(),
        );

        offsets.push(buf.len());
        buf.extend_from_slice(
            format!(
                "{image_id} 0 obj\n<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                page.w,
                page.h,
                page.jpeg.len()
            )
            .as_bytes(),
        );
        buf.extend_from_slice(&page.jpeg);
        buf.extend_from_slice(b"\nendstream\nendobj\n");

        let content = format!("q {pw:.2} 0 0 {ph:.2} 0 0 cm /Im0 Do Q");

        offsets.push(buf.len());
        buf.extend_from_slice(
            format!(
                "{content_id} 0 obj\n<< /Length {} >>\nstream\n{content}\nendstream\nendobj\n",
                content.len()
            )
            .as_bytes(),
        );
    }

    let xref_pos = buf.len();
    let total = offsets.len() + 1;

    let mut xref = format!("xref\n0 {total}\n0000000000 65535 f \n");

    for off in &offsets {
        xref.push_str(&format!("{off:010} 00000 n \n"));
    }

    xref.push_str(&format!(
        "trailer\n<< /Size {total} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ));

    buf.extend_from_slice(xref.as_bytes());
    buf
}

fn images_to_pdf(paths: &[String]) -> Result<ActionResult, String> {
    let mut pages: Vec<PdfPage> = Vec::new();

    for p in paths {
        let src = Path::new(p);

        if src.is_dir() {
            return Err("Folder tidak bisa dijadikan PDF".to_string());
        }

        let img = image::open(src).map_err(|e| format!("{}: {e}", file_label(src)))?;

        pages.push(PdfPage {
            w: img.width(),
            h: img.height(),
            jpeg: jpeg_bytes(&img, 90)?,
        });
    }

    let first = Path::new(&paths[0]);
    let dir = parent_dir(first);

    let base = if paths.len() == 1 {
        display_stem(first)
    } else {
        "Gambar".to_string()
    };

    let out = unique_path(&dir, &base, "pdf");
    fs::write(&out, build_pdf(&pages)).map_err(|e| e.to_string())?;

    Ok(done(
        format!("Tersimpan: {}", file_label(&out)),
        Some(out.as_path()),
    ))
}

// ---------------------------------------------------------------------------
// Video / audio (butuh ffmpeg)
// ---------------------------------------------------------------------------

fn media_args(action: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match action {
        "vid_mp4" => Some((
            "mp4",
            vec!["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac"],
        )),
        "vid_mp3" | "aud_mp3" => Some(("mp3", vec!["-vn", "-q:a", "2"])),
        "aud_wav" => Some(("wav", vec![])),
        _ => None,
    }
}

fn media_action(action: &str, paths: &[String]) -> Result<ActionResult, String> {
    let ffmpeg = locate_ffmpeg().ok_or("ffmpeg tidak ditemukan di PATH")?;
    let (ext, args) = media_args(action).ok_or("Aksi media tidak dikenal")?;

    let mut last: Option<PathBuf> = None;

    for p in paths {
        let src = Path::new(p);

        if src.is_dir() {
            return Err("Folder tidak bisa dikonversi".to_string());
        }

        let out = unique_path(&parent_dir(src), &display_stem(src), ext);

        let mut c = Command::new(&ffmpeg);
        c.arg("-nostdin").arg("-y").arg("-i").arg(src).args(&args).arg(&out);
        run(&mut c)?;

        last = Some(out);
    }

    let message = match (paths.len(), last.as_ref()) {
        (1, Some(out)) => format!("Tersimpan: {}", file_label(out)),
        (n, _) => format!("{n} file selesai"),
    };

    Ok(done(message, last.as_deref()))
}