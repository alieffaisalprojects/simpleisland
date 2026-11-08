//! settings.rs
//! Pengaturan aplikasi (halaman "Pengaturan": Umum + Tampilan).
//!
//! Disimpan sebagai `settings.json` di folder config app
//! (Windows: %APPDATA%\<identifier>\settings.json).
//!
//! Command Tauri:
//!   settings_get()            -> pengaturan saat ini
//!   settings_save(settings)   -> simpan + terapkan (island on/off, autostart), lalu
//!                                kirim event "settings-changed" ke semua window
//!   settings_recenter()       -> pusatkan ulang island
//!   settings_quit()           -> keluar dari aplikasi
//!
//! Alur pemasangan baru:
//!   settings.json belum ada -> island MATI (window island disembunyikan) dan
//!   jendela Pengaturan dibuka, supaya aplikasi tidak langsung jalan setelah diinstal.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;

pub const SETTINGS_LABEL: &str = "settings";

// Dibaca oleh thread pemantau (Spotify, title bar) supaya tidak memunculkan island
// saat dimatikan dari Pengaturan.
static ISLAND_ENABLED: AtomicBool = AtomicBool::new(false);

const STYLES: [&str; 3] = ["pill", "notch", "tab"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Umum
    pub island_enabled: bool,
    pub autostart: bool,
    pub file_drop: bool,
    pub file_sounds: bool,

    // Tampilan: "pill" | "notch" | "tab"
    pub style: String,
    // Lebar "bahu" kiri-kanan pada gaya notch (px)
    pub shoulder: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            island_enabled: false,
            autostart: false,
            file_drop: true,
            file_sounds: true,
            style: "pill".to_string(),
            shoulder: 14,
        }
    }
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if !STYLES.contains(&self.style.as_str()) {
            self.style = "pill".to_string();
        }

        self.shoulder = self.shoulder.clamp(8, 24);
        self
    }
}

pub struct SettingsState(pub Mutex<Settings>);

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

fn config_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

fn read_file(app: &AppHandle) -> Option<Settings> {
    let text = fs::read_to_string(config_path(app)?).ok()?;

    serde_json::from_str::<Settings>(&text)
        .ok()
        .map(Settings::sanitized)
}

fn write_file(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = config_path(app).ok_or("Folder pengaturan tidak ditemukan")?;

    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Akses dari lib.rs
// ---------------------------------------------------------------------------

pub fn is_enabled() -> bool {
    ISLAND_ENABLED.load(Ordering::Relaxed)
}

pub fn current(app: &AppHandle) -> Settings {
    app.try_state::<SettingsState>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.clone()))
        .unwrap_or_default()
}

// Tampilkan / sembunyikan window island sesuai pengaturan
fn apply_window(app: &AppHandle, enabled: bool) {
    if enabled {
        super::show_island(app);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn sync_autostart(app: &AppHandle, want: bool) {
    let manager = app.autolaunch();

    if manager.is_enabled().unwrap_or(false) != want {
        let _ = if want { manager.enable() } else { manager.disable() };
    }
}

// Dipanggil sekali di setup(). Mengembalikan true bila ini pemakaian pertama
// (settings.json belum ada).
pub fn init(app: &AppHandle) -> bool {
    let (settings, first_run) = match read_file(app) {
        Some(s) => (s, false),
        None => {
            let mut s = Settings::default();
            // Jangan mengubah auto startup yang sudah ada, cukup cerminkan keadaannya
            s.autostart = app.autolaunch().is_enabled().unwrap_or(false);
            (s, true)
        }
    };

    ISLAND_ENABLED.store(settings.island_enabled, Ordering::Relaxed);
    app.manage(SettingsState(Mutex::new(settings.clone())));

    if first_run {
        let _ = write_file(app, &settings);
    } else {
        sync_autostart(app, settings.autostart);
    }

    apply_window(app, settings.island_enabled);
    first_run
}

// Simpan dan terapkan. Dipakai oleh command dan menu tray.
fn apply_change(app: &AppHandle, next: Settings) -> Result<Settings, String> {
    let next = next.sanitized();

    let state = app
        .try_state::<SettingsState>()
        .ok_or("Pengaturan belum siap")?;

    let prev = state
        .0
        .lock()
        .map_err(|_| "Pengaturan sedang dipakai")?
        .clone();

    if next.autostart != prev.autostart {
        let manager = app.autolaunch();

        if manager.is_enabled().unwrap_or(false) != next.autostart {
            let result = if next.autostart {
                manager.enable()
            } else {
                manager.disable()
            };

            result.map_err(|e| format!("Gagal mengubah auto startup: {e}"))?;
        }
    }

    write_file(app, &next)?;

    if let Ok(mut guard) = state.0.lock() {
        *guard = next.clone();
    }

    if next.island_enabled != prev.island_enabled {
        ISLAND_ENABLED.store(next.island_enabled, Ordering::Relaxed);
        apply_window(app, next.island_enabled);
    }

    super::refresh_tray_menu(app);
    let _ = app.emit("settings-changed", &next);

    Ok(next)
}

pub fn set_island_enabled(app: &AppHandle, on: bool) {
    let mut s = current(app);
    s.island_enabled = on;

    if let Err(e) = apply_change(app, s) {
        eprintln!("Gagal mengubah status island: {e}");
    }
}

pub fn set_autostart(app: &AppHandle, on: bool) {
    let mut s = current(app);
    s.autostart = on;

    if let Err(e) = apply_change(app, s) {
        eprintln!("Gagal mengubah auto startup: {e}");
    }
}

// Aplikasi dijalankan lagi (mis. klik ganda exe saat sudah berjalan)
pub fn on_relaunch(app: &AppHandle) {
    if is_enabled() {
        super::show_island(app);
    } else {
        open_settings(app);
    }
}

// Buka (atau fokuskan) jendela Pengaturan.
// Dibuat dari task terpisah supaya aman dipanggil dari setup, menu tray, atau command.
pub fn open_settings(app: &AppHandle) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            return;
        }

        // Halaman yang dimuat sama dengan island; main.tsx memilih tampilan
        // berdasarkan label window ("settings").
        let built = WebviewWindowBuilder::new(
            &app,
            SETTINGS_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .title("Pengaturan Simple Island")
        .inner_size(840.0, 580.0)
        .min_inner_size(720.0, 500.0)
        .resizable(true)
        .center()
        .theme(Some(Theme::Dark))
        .build();

        if let Err(e) = built {
            eprintln!("Gagal membuka jendela Pengaturan: {e}");
        }
    });
}

// ---------------------------------------------------------------------------
// Command Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    current(&app)
}

#[tauri::command]
pub async fn settings_save(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    apply_change(&app, settings)
}

#[tauri::command]
pub fn settings_recenter(app: AppHandle) {
    super::recenter_island(&app);
}

#[tauri::command]
pub fn settings_quit(app: AppHandle) {
    app.exit(0);
}