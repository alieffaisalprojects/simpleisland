//! file_crop.rs
//! Crop gambar untuk menu radial (FileCropPanel.tsx).
//!
//!   file_crop_preview  -> gambar diperkecil (data URL) + ukuran asli, untuk tampilan crop
//!   file_crop_apply    -> potong gambar asli, simpan sebagai <nama>_crop.<ext> di folder yang sama
//!
//! Butuh crate `image` dan `base64` di Cargo.toml (base64 sudah dipakai lib.rs).

use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageFormat};
use serde::Serialize;
use std::io::Cursor;
use std::path::{Path, PathBuf};

// Sisi terpanjang gambar pratinjau (px)
const PREVIEW_MAX: u32 = 1100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropPreview {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
pub struct CropResult {
    message: String,
    output: Option<String>,
}

fn encode(img: &DynamicImage, fmt: ImageFormat) -> Result<Vec<u8>, String> {
    let mut buf = Cursor::new(Vec::new());

    img.write_to(&mut buf, fmt)
        .map_err(|e| format!("Gagal membuat pratinjau: {e}"))?;

    Ok(buf.into_inner())
}

fn preview_blocking(path: &str) -> Result<CropPreview, String> {
    let img = image::open(path).map_err(|e| format!("Gagal membuka gambar: {e}"))?;
    let (width, height) = (img.width(), img.height());

    let small = if width.max(height) > PREVIEW_MAX {
        img.thumbnail(PREVIEW_MAX, PREVIEW_MAX)
    } else {
        img
    };

    // ada transparansi -> PNG, selain itu JPEG (lebih ringan)
    let (bytes, mime) = if small.color().has_alpha() {
        (encode(&small, ImageFormat::Png)?, "image/png")
    } else {
        let rgb = DynamicImage::ImageRgb8(small.to_rgb8());
        (encode(&rgb, ImageFormat::Jpeg)?, "image/jpeg")
    };

    Ok(CropPreview {
        data_url: format!("data:{mime};base64,{}", general_purpose::STANDARD.encode(bytes)),
        width,
        height,
    })
}

// <nama>_crop.<ext>, lalu _crop_2, _crop_3, ... bila sudah ada
fn unique_path(src: &Path) -> PathBuf {
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("gambar");
    let ext = src.extension().and_then(|s| s.to_str()).unwrap_or("png");

    let mut out = dir.join(format!("{stem}_crop.{ext}"));
    let mut n = 2;

    while out.exists() && n < 1000 {
        out = dir.join(format!("{stem}_crop_{n}.{ext}"));
        n += 1;
    }

    out
}

fn apply_blocking(path: &str, x: u32, y: u32, w: u32, h: u32) -> Result<CropResult, String> {
    let img = image::open(path).map_err(|e| format!("Gagal membuka gambar: {e}"))?;
    let (iw, ih) = (img.width(), img.height());

    if x >= iw || y >= ih {
        return Err("Area crop di luar gambar".into());
    }

    let w = w.min(iw - x).max(1);
    let h = h.min(ih - y).max(1);
    let mut out = img.crop_imm(x, y, w, h);

    let src = Path::new(path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // JPEG / BMP tidak mendukung transparansi
    if matches!(ext.as_str(), "jpg" | "jpeg" | "bmp") && out.color().has_alpha() {
        out = DynamicImage::ImageRgb8(out.to_rgb8());
    }

    let dest = unique_path(src);

    out.save(&dest)
        .map_err(|e| format!("Gagal menyimpan hasil crop: {e}"))?;

    let name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("hasil crop");

    Ok(CropResult {
        message: format!("Disimpan: {name} ({w}×{h})"),
        output: Some(dest.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn file_crop_preview(path: String) -> Result<CropPreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn file_crop_apply(
    path: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<CropResult, String> {
    tauri::async_runtime::spawn_blocking(move || apply_blocking(&path, x, y, width, height))
        .await
        .map_err(|e| e.to_string())?
}