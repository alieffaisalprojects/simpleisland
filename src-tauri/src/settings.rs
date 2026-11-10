//! settings.rs
//! Pengaturan aplikasi (halaman "Pengaturan": Umum + Tampilan).
//!
//! Disimpan sebagai `settings.json` di folder config app
//! (Windows: %APPDATA%\<identifier>\settings.json).
//!
//! Command Tauri:
//!   settings_get()            -> pengaturan saat ini
//!   settings_save(patch)      -> gabungkan perubahan + terapkan (island on/off, autostart), lalu
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

// Ukuran jendela Pengaturan (lebar, tinggi). Boleh di-maximize, tetapi hasilnya
// dibatasi MAX supaya tidak melebar sampai memenuhi layar.
const SETTINGS_WINDOW_SIZE: (f64, f64) = (840.0, 580.0);
const SETTINGS_WINDOW_MIN: (f64, f64) = (720.0, 500.0);
const SETTINGS_WINDOW_MAX: (f64, f64) = (1000.0, 700.0);

// Dibaca oleh thread pemantau (Spotify, title bar) supaya tidak memunculkan island
// saat dimatikan dari Pengaturan.
static ISLAND_ENABLED: AtomicBool = AtomicBool::new(false);

const STYLES: [&str; 3] = ["pill", "notch", "tab"];

// Batas offset ukuran island (px dari ukuran bawaan)
const WIDTH_RANGE: (i32, i32) = (-30, 60);
const HEIGHT_RANGE: (i32, i32) = (-8, 20);
const TOP_RANGE: (i32, i32) = (-20, 60);

fn clamp_width(v: i32) -> i32 {
    v.clamp(WIDTH_RANGE.0, WIDTH_RANGE.1)
}

fn clamp_height(v: i32) -> i32 {
    v.clamp(HEIGHT_RANGE.0, HEIGHT_RANGE.1)
}

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

    // Ukuran island saat compact (ada aktivitas) dan mini (idle), per gaya.
    // Selisih px dari ukuran bawaan (0 = bawaan). Ukuran expanded tidak diatur.
    pub pill_compact_width: i32,
    pub pill_compact_height: i32,
    pub pill_mini_width: i32,
    pub pill_mini_height: i32,
    pub notch_compact_width: i32,
    pub notch_compact_height: i32,
    pub notch_mini_width: i32,
    pub notch_mini_height: i32,
    pub tab_compact_width: i32,
    pub tab_compact_height: i32,
    pub tab_mini_width: i32,
    pub tab_mini_height: i32,

    // Jarak pil dari tepi atas layar (selisih dari jarak bawaan)
    pub pill_top: i32,
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
            pill_compact_width: 0,
            pill_compact_height: 0,
            pill_mini_width: 0,
            pill_mini_height: 0,
            notch_compact_width: 0,
            notch_compact_height: 0,
            notch_mini_width: 0,
            notch_mini_height: 0,
            tab_compact_width: 0,
            tab_compact_height: 0,
            tab_mini_width: 0,
            tab_mini_height: 0,
            pill_top: 0,
        }
    }
}

impl Settings {
    fn sanitized(mut self) -> Self {
        if !STYLES.contains(&self.style.as_str()) {
            self.style = "pill".to_string();
        }

        self.shoulder = self.shoulder.clamp(8, 24);

        self.pill_compact_width = clamp_width(self.pill_compact_width);
        self.pill_compact_height = clamp_height(self.pill_compact_height);
        self.pill_mini_width = clamp_width(self.pill_mini_width);
        self.pill_mini_height = clamp_height(self.pill_mini_height);
        self.notch_compact_width = clamp_width(self.notch_compact_width);
        self.notch_compact_height = clamp_height(self.notch_compact_height);
        self.notch_mini_width = clamp_width(self.notch_mini_width);
        self.notch_mini_height = clamp_height(self.notch_mini_height);
        self.tab_compact_width = clamp_width(self.tab_compact_width);
        self.tab_compact_height = clamp_height(self.tab_compact_height);
        self.tab_mini_width = clamp_width(self.tab_mini_width);
        self.tab_mini_height = clamp_height(self.tab_mini_height);

        self.pill_top = self.pill_top.clamp(TOP_RANGE.0, TOP_RANGE.1);
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

// Versi lama menyimpan satu ukuran per gaya (pillWidth, notchHeight, ...) yang berlaku
// untuk compact dan mini sekaligus. Salin nilainya ke kedua kondisi supaya tampilan
// pengguna lama tidak berubah setelah update.
fn migrate_sizes(value: &mut serde_json::Value) {
    const OLD_KEYS: [(&str, [&str; 2]); 6] = [
        ("pillWidth", ["pillCompactWidth", "pillMiniWidth"]),
        ("pillHeight", ["pillCompactHeight", "pillMiniHeight"]),
        ("notchWidth", ["notchCompactWidth", "notchMiniWidth"]),
        ("notchHeight", ["notchCompactHeight", "notchMiniHeight"]),
        ("tabWidth", ["tabCompactWidth", "tabMiniWidth"]),
        ("tabHeight", ["tabCompactHeight", "tabMiniHeight"]),
    ];

    let Some(map) = value.as_object_mut() else {
        return;
    };

    for (old, news) in OLD_KEYS {
        if let Some(v) = map.remove(old) {
            for new in news {
                map.entry(new.to_string()).or_insert_with(|| v.clone());
            }
        }
    }
}

fn read_file(app: &AppHandle) -> Option<Settings> {
    let text = fs::read_to_string(config_path(app)?).ok()?;

    let mut value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    migrate_sizes(&mut value);

    serde_json::from_value::<Settings>(value)
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

// Daftarkan entri auto startup yang menunjuk ke exe yang SEDANG berjalan.
//
// `is_enabled()` hanya mengecek apakah entri ada, bukan ke exe mana entri itu
// menunjuk. Karena itu `enable()` selalu dipanggil ulang (menimpa path lama), bukan
// dilewati ketika sudah "aktif".
//
// Saat mode dev (`pnpm tauri dev`) entri TIDAK ditulis: exe debug membuka console dan
// memuat localhost:1420, padahal server dev tidak jalan setelah boot Windows.
fn register_autostart(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        eprintln!(
            "Mode dev: entri auto startup tidak ditulis (akan menunjuk ke exe debug). \
             Jalankan hasil `pnpm tauri build` sekali untuk mendaftarkannya."
        );
        return Ok(());
    }

    app.autolaunch().enable().map_err(|e| e.to_string())
}

fn unregister_autostart(app: &AppHandle) -> Result<(), String> {
    let manager = app.autolaunch();

    if manager.is_enabled().unwrap_or(false) {
        manager.disable().map_err(|e| e.to_string())?;
    }

    Ok(())
}

// Samakan entri auto startup di registry dengan pengaturan. Dipanggil setiap aplikasi
// start, sehingga entri lama yang menunjuk ke path salah (mis. target\debug\...exe,
// atau exe yang sudah dipindah/di-update) otomatis diperbaiki.
fn sync_autostart(app: &AppHandle, want: bool) {
    let result = if want {
        register_autostart(app)
    } else {
        unregister_autostart(app)
    };

    if let Err(e) = result {
        eprintln!("Gagal menyinkronkan auto startup: {e}");
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
    }

    // Selalu disinkronkan (juga saat pemakaian pertama) supaya path entri diperbarui
    sync_autostart(app, settings.autostart);

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
        let result = if next.autostart {
            register_autostart(app)
        } else {
            unregister_autostart(app)
        };

        result.map_err(|e| format!("Gagal mengubah auto startup: {e}"))?;
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

// Gabungkan perubahan parsial ke pengaturan saat ini, lalu terapkan.
// Hanya kunci yang dikirim yang berubah, jadi data basi dari jendela
// Pengaturan tidak menimpa perubahan dari tray (dan sebaliknya).
fn apply_patch(app: &AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    let prev = current(app);

    let mut value = serde_json::to_value(&prev).map_err(|e| e.to_string())?;

    if let (Some(base), Some(extra)) = (value.as_object_mut(), patch.as_object()) {
        for (k, v) in extra {
            base.insert(k.clone(), v.clone());
        }
    }

    let next = serde_json::from_value::<Settings>(value).map_err(|e| e.to_string())?;
    apply_change(app, next)
}

// Tray dan jendela Pengaturan sama-sama lewat main thread, jadi urut dan tidak saling balapan
fn queue_patch(app: &AppHandle, patch: serde_json::Value) {
    let handle = app.clone();

    let queued = app.run_on_main_thread(move || {
        if let Err(e) = apply_patch(&handle, patch) {
            eprintln!("Gagal menerapkan pengaturan: {e}");
        }
    });

    if let Err(e) = queued {
        eprintln!("Gagal menjadwalkan pengaturan: {e}");
    }
}

pub fn set_island_enabled(app: &AppHandle, on: bool) {
    queue_patch(app, serde_json::json!({ "islandEnabled": on }));
}

pub fn set_autostart(app: &AppHandle, on: bool) {
    queue_patch(app, serde_json::json!({ "autostart": on }));
}

// Aplikasi dijalankan lagi (klik shortcut saat sudah berjalan): selalu buka Pengaturan
pub fn on_relaunch(app: &AppHandle) {
    // island tetap tampil bila aktif
    if is_enabled() {
        super::show_island(app);
    }

    open_settings(app);
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
        //
        // Boleh ditarik dan di-maximize, tetapi ukurannya dibatasi antara MIN dan MAX.
        let built = WebviewWindowBuilder::new(
            &app,
            SETTINGS_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .title("Pengaturan Simple Island")
        .inner_size(SETTINGS_WINDOW_SIZE.0, SETTINGS_WINDOW_SIZE.1)
        .min_inner_size(SETTINGS_WINDOW_MIN.0, SETTINGS_WINDOW_MIN.1)
        .max_inner_size(SETTINGS_WINDOW_MAX.0, SETTINGS_WINDOW_MAX.1)
        .resizable(true)
        .maximizable(true)
        .center()
        .theme(Some(Theme::Dark))
        .build();

        match built {
            Ok(window) => {
                // Windows tidak selalu menghormati batas maksimum saat tombol maximize
                // ditekan. Jadi begitu jendela masuk status maximize, batalkan maximize
                // lalu pasang ukuran maksimum yang diizinkan dan taruh di tengah layar.
                let target = window.clone();

                window.on_window_event(move |event| {
                    if !matches!(event, tauri::WindowEvent::Resized(_)) {
                        return;
                    }

                    let win = target.clone();

                    // dijalankan di task terpisah supaya tidak memblokir event loop
                    tauri::async_runtime::spawn(async move {
                        if win.is_maximized().unwrap_or(false) {
                            let _ = win.unmaximize();
                            let _ = win.set_size(tauri::LogicalSize::new(
                                SETTINGS_WINDOW_MAX.0,
                                SETTINGS_WINDOW_MAX.1,
                            ));
                            let _ = win.center();
                        }
                    });
                });
            }
            Err(e) => eprintln!("Gagal membuka jendela Pengaturan: {e}"),
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
pub async fn settings_save(
    app: AppHandle,
    settings: serde_json::Value,
) -> Result<Settings, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();

    app.run_on_main_thread(move || {
        let result = apply_patch(&handle, settings);

        // kembalikan fokus ke jendela Pengaturan (island baru tampil bisa merebut fokus)
        if let Some(window) = handle.get_webview_window(SETTINGS_LABEL) {
            let _ = window.set_focus();
        }

        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;

    rx.await
        .map_err(|_| "Gagal menerapkan pengaturan".to_string())?
}

#[tauri::command]
pub fn settings_recenter(app: AppHandle) {
    super::recenter_island(&app);
}

#[tauri::command]
pub fn settings_quit(app: AppHandle) {
    app.exit(0);
}