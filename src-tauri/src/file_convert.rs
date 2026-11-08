//! file_convert.rs
//! Konversi tambahan untuk island + deteksi folder Explorer yang sedang dibuka.
//!
//! Perintah Tauri:
//!   - file_convert(action, paths)  : img_ico, pdf_png, pdf_jpg, pdf_docx, doc_pdf
//!   - file_explorer_folder()       : folder di jendela Explorer paling atas (untuk "Paste")
//!
//! Catatan:
//!   - Hanya Windows.
//!   - PDF -> PNG/JPG memakai Windows.Data.Pdf bawaan Windows (tanpa DLL tambahan).
//!   - PDF <-> Word memakai Microsoft Word (COM via PowerShell); bila Word tidak ada,
//!     dicoba LibreOffice (soffice).
//!   - Hasil disimpan di folder yang sama dengan file asal, dengan nama yang tidak menimpa.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::{engine::general_purpose, Engine as _};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat};
use serde::Serialize;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct ActionResult {
    pub message: String,
    pub output: Option<String>,
}

fn s(e: impl ToString) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

// "nama.ext", kalau sudah ada: "nama (2).ext", "nama (3).ext", ...
// ext kosong = untuk nama folder.
fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let make = |n: u32| -> PathBuf {
        let base = if n == 1 {
            stem.to_string()
        } else {
            format!("{stem} ({n})")
        };

        if ext.is_empty() {
            dir.join(base)
        } else {
            dir.join(format!("{base}.{ext}"))
        }
    };

    (1u32..)
        .map(make)
        .find(|p| !p.exists())
        .expect("nama unik selalu ditemukan")
}

fn parts(src: &Path) -> (PathBuf, String, String) {
    let dir = src.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = src
        .file_stem()
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let ext = src
        .extension()
        .map(|x| x.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    (dir, stem, ext)
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|x| x.to_string_lossy().into_owned())
        .unwrap_or_default()
}

// Skrip dikirim sebagai -EncodedCommand (UTF-16LE base64), sama seperti file_actions.rs,
// supaya baris baru / tanda kutip di skrip tidak rusak oleh aturan argumen Windows.
fn encode_script(script: &str) -> String {
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();

    general_purpose::STANDARD.encode(bytes)
}

// Gagal -> Err berisi teks error LENGKAP (tanpa sisa CLIXML PowerShell)
fn powershell(script: &str, envs: &[(&str, String)]) -> Result<String, String> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
    ])
    .arg(encode_script(script));

    for (k, v) in envs {
        cmd.env(k, v);
    }

    let out = cmd
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("PowerShell gagal dijalankan: {e}"))?;

    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }

    let clean = |bytes: &[u8]| -> String {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("#<") && !l.starts_with("<Objs"))
            .collect::<Vec<_>>()
            .join(" ")
    };

    let mut detail = clean(&out.stderr);
    if detail.is_empty() {
        detail = clean(&out.stdout);
    }
    if detail.is_empty() {
        detail = format!("PowerShell berhenti dengan kode {:?}", out.status.code());
    }

    Err(detail)
}

// Pesan pendek untuk island (muat ~2 baris); yang lengkap ada di log
fn brief(msg: &str) -> String {
    let flat = msg.split_whitespace().collect::<Vec<_>>().join(" ");

    if flat.chars().count() <= 110 {
        flat
    } else {
        let cut: String = flat.chars().take(108).collect();
        format!("{cut}…")
    }
}

// Tulis error lengkap ke %TEMP%\island_convert.log (ditimpa tiap gagal)
fn log_error(context: &str, detail: &str) {
    let path = std::env::temp_dir().join("island_convert.log");
    let _ = fs::write(path, format!("{context}\r\n\r\n{detail}\r\n"));
}

// ---------------------------------------------------------------------------
// BMP / gambar lain -> ICO
// ---------------------------------------------------------------------------

fn image_to_ico(src: &Path) -> Result<PathBuf, String> {
    let img = image::open(src).map_err(|e| format!("Gagal membuka gambar: {e}"))?;

    // Format ICO maksimal 256 x 256
    let img = if img.width() > 256 || img.height() > 256 {
        img.resize(256, 256, FilterType::Lanczos3)
    } else {
        img
    };

    let (dir, stem, _) = parts(src);
    let out = unique(&dir, &stem, "ico");

    DynamicImage::ImageRgba8(img.to_rgba8())
        .save_with_format(&out, ImageFormat::Ico)
        .map_err(|e| format!("Gagal menyimpan ICO: {e}"))?;

    Ok(out)
}

// ---------------------------------------------------------------------------
// PDF -> PNG / JPG (Windows.Data.Pdf)
// ---------------------------------------------------------------------------

fn pdf_to_images(src: &Path, jpg: bool) -> Result<PathBuf, String> {
    use windows::core::HSTRING;
    use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
    use windows::Storage::StorageFile;
    use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
    use windows::UI::Color;

    let ext = if jpg { "jpg" } else { "png" };
    let path = src.to_string_lossy().into_owned();

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(s)?
        .get()
        .map_err(s)?;

    let doc = PdfDocument::LoadFromFileAsync(&file)
        .map_err(s)?
        .get()
        .map_err(|_| "PDF tidak bisa dibuka (terkunci password atau rusak)".to_string())?;

    let count = doc.PageCount().map_err(s)?;
    if count == 0 {
        return Err("PDF kosong".into());
    }

    let (dir, stem, _) = parts(src);

    // 1 halaman -> satu file; banyak halaman -> folder berisi satu file per halaman
    let (out_dir, single_out) = if count == 1 {
        (dir.clone(), Some(unique(&dir, &stem, ext)))
    } else {
        let folder = unique(&dir, &stem, "");
        fs::create_dir_all(&folder).map_err(|e| format!("Gagal membuat folder: {e}"))?;
        (folder, None)
    };

    for i in 0..count {
        let page = doc.GetPage(i).map_err(s)?;
        let size = page.Size().map_err(s)?;

        // Ukuran halaman dalam 96 dpi; dikali 2 supaya hasil tajam (~192 dpi)
        let width = ((size.Width * 2.0) as u32).clamp(200, 6000);

        let opts = PdfPageRenderOptions::new().map_err(s)?;
        opts.SetDestinationWidth(width).map_err(s)?;
        opts.SetBackgroundColor(Color {
            A: 255,
            R: 255,
            G: 255,
            B: 255,
        })
        .map_err(s)?;

        let stream = InMemoryRandomAccessStream::new().map_err(s)?;
        page.RenderWithOptionsToStreamAsync(&stream, &opts)
            .map_err(s)?
            .get()
            .map_err(s)?;

        let len = stream.Size().map_err(s)? as u32;
        stream.Seek(0).map_err(s)?;

        let reader = DataReader::CreateDataReader(&stream).map_err(s)?;
        reader.LoadAsync(len).map_err(s)?.get().map_err(s)?;

        let mut png = vec![0u8; len as usize];
        reader.ReadBytes(&mut png).map_err(s)?;

        let target = match &single_out {
            Some(p) => p.clone(),
            None => out_dir.join(format!("{stem}_{:03}.{ext}", i + 1)),
        };

        if jpg {
            let rgb = image::load_from_memory(&png)
                .map_err(|e| format!("Gagal membaca hasil render: {e}"))?
                .to_rgb8();

            let mut f = fs::File::create(&target).map_err(s)?;
            DynamicImage::ImageRgb8(rgb)
                .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                    &mut f, 92,
                ))
                .map_err(|e| format!("Gagal menyimpan JPG: {e}"))?;
        } else {
            fs::write(&target, &png).map_err(s)?;
        }
    }

    Ok(single_out.unwrap_or(out_dir))
}

// ---------------------------------------------------------------------------
// Word <-> PDF (Microsoft Word, cadangan: LibreOffice)
// ---------------------------------------------------------------------------

const WORD_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = 'menjalankan Word'
$w = $null
$own = $false
$code = 0
try {
    # Pakai Word yang sudah terbuka bila ada (dan jangan ditutup); kalau tidak, buka sendiri
    try {
        $w = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    } catch {
        $w = New-Object -ComObject Word.Application
        $own = $true
        $w.Visible = $false
        $w.DisplayAlerts = 0
    }

    $stage = 'membuka file'
    $d = $w.Documents.Open($env:CV_IN, $false, $true, $false)

    $stage = 'menyimpan hasil'
    $d.SaveAs2($env:CV_OUT, [int]$env:CV_FMT)
    $d.Close(0)
} catch {
    [Console]::Error.WriteLine('[' + $stage + '] ' + $_.Exception.Message)
    $code = 1
} finally {
    if ($own -and $w -ne $null) { try { $w.Quit() } catch {} }
}
exit $code
"#;

fn via_word(src: &Path, out: &Path, format: u32) -> Result<(), String> {
    powershell(
        WORD_SCRIPT,
        &[
            ("CV_IN", src.to_string_lossy().into_owned()),
            ("CV_OUT", out.to_string_lossy().into_owned()),
            ("CV_FMT", format.to_string()),
        ],
    )
    .map(|_| ())
}

fn find_soffice() -> Option<PathBuf> {
    let mut roots: Vec<String> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(v) = std::env::var(key) {
            roots.push(v);
        }
    }

    roots
        .into_iter()
        .map(|r| {
            PathBuf::from(r)
                .join("LibreOffice")
                .join("program")
                .join("soffice.exe")
        })
        .find(|p| p.exists())
}

fn via_libreoffice(src: &Path, out: &Path, to_pdf: bool) -> Result<(), String> {
    let soffice = find_soffice().ok_or_else(|| {
        "Butuh Microsoft Word atau LibreOffice terpasang untuk konversi ini".to_string()
    })?;

    let tmp = std::env::temp_dir().join(format!("island_cv_{}", std::process::id()));
    fs::create_dir_all(&tmp).map_err(s)?;

    let mut cmd = Command::new(soffice);
    cmd.arg("--headless");

    if to_pdf {
        cmd.args(["--convert-to", "pdf"]);
    } else {
        cmd.args(["--infilter=writer_pdf_import", "--convert-to", "docx"]);
    }

    let status = cmd
        .arg("--outdir")
        .arg(&tmp)
        .arg(src)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("LibreOffice gagal dijalankan: {e}"))?;

    let produced = tmp.join(format!(
        "{}.{}",
        src.file_stem().unwrap_or_default().to_string_lossy(),
        if to_pdf { "pdf" } else { "docx" }
    ));

    let result = if status.status.success() && produced.exists() {
        fs::copy(&produced, out).map(|_| ()).map_err(s)
    } else {
        Err("LibreOffice gagal mengonversi file".to_string())
    };

    let _ = fs::remove_dir_all(&tmp);
    result
}

fn office_convert(src: &Path, to_pdf: bool) -> Result<PathBuf, String> {
    let (dir, stem, _) = parts(src);
    let out = unique(&dir, &stem, if to_pdf { "pdf" } else { "docx" });

    // wdFormatPDF = 17, wdFormatDocumentDefault (docx) = 16
    let word = via_word(src, &out, if to_pdf { 17 } else { 16 }).and_then(|_| {
        if out.exists() {
            Ok(())
        } else {
            Err("Word selesai tetapi file hasil tidak ditemukan".to_string())
        }
    });

    match word {
        Ok(()) => Ok(out),
        Err(e) => {
            log_error(
                &format!(
                    "Konversi lewat Microsoft Word gagal\r\nFile: {}\r\nKe: {}",
                    src.display(),
                    if to_pdf { "PDF" } else { "DOCX" }
                ),
                &e,
            );

            if find_soffice().is_some() {
                via_libreoffice(src, &out, to_pdf)?;
                Ok(out)
            } else {
                Err(format!("Word: {}", brief(&e)))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Perintah: file_convert
// ---------------------------------------------------------------------------

fn convert_one(action: &str, src: &Path) -> Result<PathBuf, String> {
    let ext = parts(src).2;

    match action {
        "img_ico" => image_to_ico(src),

        "pdf_png" | "pdf_jpg" => {
            if ext != "pdf" {
                return Err("Bukan file PDF".into());
            }
            pdf_to_images(src, action == "pdf_jpg")
        }

        "pdf_docx" => {
            if ext != "pdf" {
                return Err("Bukan file PDF".into());
            }
            office_convert(src, false)
        }

        "doc_pdf" => {
            if !matches!(ext.as_str(), "doc" | "docx" | "rtf" | "odt") {
                return Err("Bukan file Word".into());
            }
            office_convert(src, true)
        }

        other => Err(format!("Aksi tidak dikenal: {other}")),
    }
}

fn convert(action: &str, paths: &[String]) -> Result<ActionResult, String> {
    if paths.is_empty() {
        return Err("Tidak ada file".into());
    }

    let mut ok: Vec<PathBuf> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for p in paths {
        let src = Path::new(p);

        match convert_one(action, src) {
            Ok(out) => ok.push(out),
            Err(e) => errors.push(format!("{}: {e}", file_name(src))),
        }
    }

    if ok.is_empty() {
        return Err(errors.join("; "));
    }

    let message = match (ok.len(), errors.len()) {
        (1, 0) => format!("Disimpan: {}", file_name(&ok[0])),
        (n, 0) => format!("{n} file berhasil diubah"),
        (n, m) => format!("{n} berhasil, {m} gagal ({})", errors[0]),
    };

    Ok(ActionResult {
        message,
        output: Some(ok[0].to_string_lossy().into_owned()),
    })
}

// Dijalankan di thread terpisah supaya island tidak macet selama konversi
#[tauri::command]
pub async fn file_convert(action: String, paths: Vec<String>) -> Result<ActionResult, String> {
    let res = tauri::async_runtime::spawn_blocking(move || convert(&action, &paths))
        .await
        .map_err(|e| e.to_string())?;

    res
}

// ---------------------------------------------------------------------------
// Perintah: file_explorer_folder  (tujuan tombol "Paste")
// ---------------------------------------------------------------------------

// Jendela Explorer (CabinetWClass) paling atas yang terlihat dan tidak diminimalkan.
// EnumWindows berjalan dari z-order paling atas, jadi yang pertama ketemu = paling depan.
fn top_explorer_hwnd() -> Option<i64> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, IsIconic, IsWindowVisible,
    };

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let slot = &mut *(lparam.0 as *mut Option<i64>);

            if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
                let mut buf = [0u16; 64];
                let n = GetClassNameW(hwnd, &mut buf);

                if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "CabinetWClass" {
                    *slot = Some(hwnd.0 as isize as i64);
                    return BOOL(0); // berhenti
                }
            }
        }

        BOOL(1)
    }

    let mut found: Option<i64> = None;

    unsafe {
        // EnumWindows mengembalikan error saat callback berhenti lebih awal: itu normal
        let _ = EnumWindows(Some(callback), LPARAM(&mut found as *mut Option<i64> as isize));
    }

    found
}

const EXPLORER_PATH_SCRIPT: &str = r#"
$h = [int64]$env:CV_HWND
$app = New-Object -ComObject Shell.Application
foreach ($w in $app.Windows()) {
    try {
        if ([int64]$w.HWND -eq $h) {
            $p = $w.Document.Folder.Self.Path
            if ($p) { Write-Output $p; break }
        }
    } catch {}
}
"#;

fn explorer_folder() -> Result<Option<String>, String> {
    let Some(hwnd) = top_explorer_hwnd() else {
        return Ok(None);
    };

    let out = powershell(EXPLORER_PATH_SCRIPT, &[("CV_HWND", hwnd.to_string())])?;
    let path = out.lines().next().unwrap_or("").trim().to_string();

    // Folder virtual ("This PC", "Home") bukan folder sungguhan: abaikan
    if path.is_empty() || !Path::new(&path).is_dir() {
        return Ok(None);
    }

    Ok(Some(path))
}

#[tauri::command]
pub async fn file_explorer_folder() -> Result<Option<String>, String> {
    let res = tauri::async_runtime::spawn_blocking(explorer_folder)
        .await
        .map_err(|e| e.to_string())?;

    res
}