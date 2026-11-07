//! file_actions.rs
//! Aksi file untuk island saat file / folder diseret ke atasnya.
//!
//! Command Tauri:
//!   file_inspect(paths)         -> info tiap item (folder atau file, ukuran, ekstensi)
//!   file_tools()                -> alat tambahan yang terpasang (WinRAR, 7-Zip, ffmpeg)
//!   file_action(action, paths)  -> menjalankan satu aksi (id sama dengan catalog.ts)
//!
//! Cara kerja aksi:
//!   - gambar      : crate `image` (PNG, JPG, WebP, BMP) + penulis PDF sederhana
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
};

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
            Ok(done("Dipindah ke Recycle Bin", None))
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
                let out = unique_path(&dir, &format!("{stem} (kecil)"), &ext);
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
