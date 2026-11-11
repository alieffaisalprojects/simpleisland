mod island_native; // Timer Clock Windows dan HTTP request
mod file_actions; // Aksi file untuk drag & drop ke island
mod file_convert; // Konversi ICO / PDF / Word + folder Explorer aktif
mod file_crop; // Crop gambar untuk menu radial
mod radial_overlay; // Menu radial di sekitar file yang diseret (jendela transparan layar penuh)
mod settings; // Halaman Pengaturan (Umum + Tampilan)
mod spectrum; // Spektrum audio asli (loopback + FFT) untuk widget Spotify
mod system_status; // Baterai, kecepatan jaringan, Wi-Fi, Bluetooth, mode pesawat

use base64::{engine::general_purpose, Engine as _};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use tauri_plugin_autostart::MacosLauncher;

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
};

#[cfg(windows)]
use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};

// Status Spotify sedang menjadi aplikasi foreground.
#[cfg(windows)]
static SPOTIFY_ACTIVE: AtomicBool = AtomicBool::new(false);

// Selisih epoch Windows ke Unix dalam satuan 100 nanodetik.
#[cfg(windows)]
const WINDOWS_EPOCH_OFFSET_TICKS: i64 = 116_444_736_000_000_000;

// Ukuran dan posisi window island.
const ISLAND_WINDOW_WIDTH: f64 = 600.0;
const ISLAND_WINDOW_TOP: f64 = 0.0;
const ISLAND_COMPACT_HEIGHT: f64 = 60.0;

// ID menu tray.
const MENU_AUTOSTART: &str = "island_autostart";
const MENU_CENTER: &str = "island_center";
const MENU_TOGGLE: &str = "island_toggle";
const MENU_QUIT: &str = "island_quit";
const MENU_SETTINGS: &str = "island_settings";
const TRAY_ID: &str = "island-tray";

// Area klik yang dilaporkan frontend.
static HIT_RECTS: Mutex<Vec<[f64; 4]>> = Mutex::new(Vec::new());

// Simpan area klik dari frontend.
#[tauri::command]
fn island_set_hit_rects(rects: Vec<[f64; 4]>) {
    if let Ok(mut guard) = HIT_RECTS.lock() {
        *guard = rects;
    }
}

// Area klik tambahan di luar pil island (HUD volume terpisah).
static EXTRA_RECT: Mutex<Option<[f64; 4]>> = Mutex::new(None);

#[tauri::command]
fn island_set_extra_rect(rect: Option<[f64; 4]>) {
    if let Ok(mut guard) = EXTRA_RECT.lock() {
        *guard = rect;
    }
}

// Atur posisi dan ukuran window island.
fn place_island(window: &WebviewWindow, logical_height: f64) -> Result<(), String> {
    let monitor = match window.primary_monitor() {
        Ok(Some(m)) => m,
        _ => window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Monitor tidak ditemukan".to_string())?,
    };

    let scale = monitor.scale_factor();
    let mon_pos = monitor.position();
    let mon_size = monitor.size();

    let width = (ISLAND_WINDOW_WIDTH * scale).round() as u32;
    let height = (logical_height * scale).round() as u32;

    let x = mon_pos.x + ((mon_size.width as i64 - width as i64) / 2) as i32;
    let y = mon_pos.y + (ISLAND_WINDOW_TOP * scale).round() as i32;

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    Ok(())
}

// Ubah tinggi island dari frontend.
#[tauri::command]
fn island_set_height(window: WebviewWindow, height: f64) -> Result<(), String> {
    place_island(&window, height.clamp(40.0, 600.0))
}

// Beri fokus ke island (dipakai setelah file dilepas, agar klik di luar menutupnya)
#[tauri::command]
fn island_focus(window: WebviewWindow) {
    let _ = window.set_focus();
}

// ---------------------------------------------------------------------------
// Tray dan menu
// ---------------------------------------------------------------------------

// Tampilkan island jika Spotify tidak sedang aktif.
fn show_island(app: &AppHandle) {
    // Island dimatikan dari Pengaturan: jangan pernah ditampilkan
    if !settings::is_enabled() {
        return;
    }

    #[cfg(windows)]
    if SPOTIFY_ACTIVE.load(Ordering::Relaxed) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
    }
}

// Pusatkan island dengan tinggi yang sedang digunakan.
fn recenter_island(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let scale = window.scale_factor().unwrap_or(1.0);

        let height = window
            .outer_size()
            .map(|s| s.height as f64 / scale)
            .unwrap_or(ISLAND_COMPACT_HEIGHT);

        if let Err(e) = place_island(&window, height) {
            eprintln!("Gagal memusatkan island: {e}");
        }
    }
}

// Buat menu tray dan menu klik kanan.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Ikuti pengaturan (bukan registry): di mode dev registry sengaja tidak disentuh
    let autostart_on = settings::current(app).autostart;
    let island_on = settings::is_enabled();

    let settings_item = MenuItem::with_id(
        app,
        MENU_SETTINGS,
        "Pengaturan…",
        true,
        None::<&str>,
    )?;

    let toggle = CheckMenuItem::with_id(
        app,
        MENU_TOGGLE,
        "Aktifkan Dynamic Island",
        true,
        island_on,
        None::<&str>,
    )?;

    let autostart = CheckMenuItem::with_id(
        app,
        MENU_AUTOSTART,
        "Jalankan saat Windows startup",
        true,
        autostart_on,
        None::<&str>,
    )?;

    let center = MenuItem::with_id(
        app,
        MENU_CENTER,
        "Pusatkan ulang island",
        island_on,
        None::<&str>,
    )?;

    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Keluar", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[&settings_item, &toggle, &autostart, &center, &separator, &quit],
    )
}

// Perbarui tampilan menu tray (centang) setelah pengaturan berubah.
fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

// Jalankan aksi menu.
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_SETTINGS => settings::open_settings(app),

        MENU_AUTOSTART => {
            let now = settings::current(app).autostart;
            settings::set_autostart(app, !now);
        }

        MENU_TOGGLE => settings::set_island_enabled(app, !settings::is_enabled()),
        MENU_CENTER => recenter_island(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

// Tampilkan menu dari frontend.
#[tauri::command]
fn island_show_menu(window: tauri::Window) -> Result<(), String> {
    let menu = build_menu(window.app_handle()).map_err(|e| e.to_string())?;
    menu.popup(window).map_err(|e| e.to_string())
}

// Buat ikon system tray.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Dynamic Islands")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();

                if settings::is_enabled() {
                    show_island(app);
                } else {
                    settings::open_settings(app);
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Deteksi Spotify foreground
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod spotify_visibility {
    use super::SPOTIFY_ACTIVE;
    use std::mem::size_of;
    use std::sync::atomic::Ordering;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    // Periksa nama proses berdasarkan PID.
    fn is_spotify_process(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }

        unsafe {
            let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(handle) => handle,
                Err(_) => return false,
            };

            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            let mut found = false;

if Process32FirstW(snapshot, &mut entry).is_ok() {
    loop {
        if entry.th32ProcessID == pid {
            let length = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());

            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);

            found = name.eq_ignore_ascii_case("Spotify.exe");
            break;
        }

        if Process32NextW(snapshot, &mut entry).is_err() {
            break;
        }
    }
}

            let _ = CloseHandle(snapshot);
            found
        }
    }

    // Periksa aplikasi yang sedang berada di depan.
    fn is_spotify_foreground() -> bool {
        unsafe {
            let hwnd = GetForegroundWindow();

            if hwnd.0.is_null() {
                return false;
            }

            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));

            is_spotify_process(pid)
        }
    }

    // Pantau perubahan aplikasi foreground.
    pub fn start(app: AppHandle) {
        std::thread::spawn(move || {
            let mut previous_state = false;

            loop {
                std::thread::sleep(Duration::from_millis(250));

                let spotify_active = is_spotify_foreground();

                if previous_state == spotify_active {
                    continue;
                }

                previous_state = spotify_active;

                SPOTIFY_ACTIVE.store(spotify_active, Ordering::Relaxed);

                if let Some(window) = app.get_webview_window("main") {
                    if spotify_active {
                        // Sembunyikan island tanpa menghentikan prosesnya.
                        let _ = window.hide();
                    } else {
                        // Tampilkan kembali island (bila diaktifkan di Pengaturan).
                        if super::settings::is_enabled() {
                            let _ = window.show();
                            let _ = window.set_always_on_top(true);
                        }
                    }
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Media SMTC
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
struct MediaInfo {
    title: String,
    artist: String,
    is_playing: bool,
    album_art: String,
    position_secs: f64,
    duration_secs: f64,
}

// ---------------------------------------------------------------------------
// Jenis sumber media: musik (Spotify, dll.) atau video (YouTube, dll.)
// ---------------------------------------------------------------------------

// Dikirim ke frontend lewat event "media-source-update".
// kind = "music" -> tombol next/prev lagu; kind = "video" -> tombol maju/mundur detik.
#[derive(Clone, serde::Serialize)]
struct MediaSourceInfo {
    kind: &'static str,
    app: String,
}

// Aplikasi yang pasti hanya memutar musik (dicocokkan dengan AppUserModelId, huruf kecil).
#[cfg(windows)]
const MUSIC_APPS: &[&str] = &[
    "spotify",
    "applemusic",
    "itunes",
    "tidal",
    "deezer",
    "amazonmusic",
    "foobar",
    "musicbee",
    "winamp",
    "aimp",
    "soundcloud",
    "pandora",
    "qobuz",
    "yandexmusic",
    "resso",
    "youtubemusic",
    "ytmdesktop",
];

// Aplikasi yang pasti memutar video.
#[cfg(windows)]
const VIDEO_APPS: &[&str] = &[
    "netflix",
    "primevideo",
    "disneyplus",
    "hbomax",
    "zunevideo",
    "mpc-hc",
    "mpc-be",
    "potplayer",
    "kmplayer",
    "stremio",
];

// Browser: bisa memutar video (YouTube) maupun musik (YouTube Music, Spotify Web).
#[cfg(windows)]
const BROWSER_APPS: &[&str] = &[
    "chrome",
    "msedge",
    "microsoftedge",
    "firefox",
    "brave",
    "opera",
    "vivaldi",
    "iexplore",
    "thorium",
    "librewolf",
    "waterfox",
];

// Pemutar serbaguna: musik atau video, dibedakan dari ada tidaknya info album.
#[cfg(windows)]
const MIXED_PLAYERS: &[&str] = &["vlc", "zunemusic"];

// Firefox memakai AppUserModelId berupa 16 karakter hex, bukan nama aplikasi.
#[cfg(windows)]
fn looks_like_hash_id(id: &str) -> bool {
    id.len() == 16 && id.chars().all(|c| c.is_ascii_hexdigit())
}

// Petunjuk dari judul window browser: "... - YouTube Music" -> musik, "... - YouTube" -> video.
#[cfg(windows)]
mod source_hint {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, IsWindowVisible,
    };

    // Kata di judul window yang menandakan situs musik.
    const MUSIC_SITES: &[&str] = &[
        "youtube music",
        "spotify",
        "soundcloud",
        "deezer",
        "tidal",
        "apple music",
        "amazon music",
        "pandora",
        "bandcamp",
        "joox",
    ];

    // Kata di judul window yang menandakan situs video.
    const VIDEO_SITES: &[&str] = &[
        "youtube",
        "netflix",
        "twitch",
        "vimeo",
        "disney",
        "prime video",
        "hbo",
        "vidio",
        "wetv",
        "viu",
        "iqiyi",
        "bilibili",
        "dailymotion",
        "tiktok",
        "facebook",
        "hotstar",
        "crunchyroll",
    ];

    struct Search {
        needle: String,
        hits: Vec<String>,
    }

    // Kumpulkan semua window terlihat yang judulnya memuat judul media.
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = unsafe { &mut *(lparam.0 as *mut Search) };

        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return TRUE;
        }

        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };

        if len <= 0 {
            return TRUE;
        }

        let text = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();

        if text.contains(&search.needle) {
            search.hits.push(text);
        }

        TRUE
    }

    // Some(true) = musik, Some(false) = video, None = tidak bisa dipastikan.
    pub fn title_hint(media_title: &str) -> Option<bool> {
        let needle = media_title.trim().to_lowercase();

        if needle.chars().count() < 3 {
            return None;
        }

        let mut search = Search {
            needle,
            hits: Vec::new(),
        };

        let _ = unsafe {
            EnumWindows(Some(enum_cb), LPARAM(&mut search as *mut Search as isize))
        };

        // Situs musik diperiksa lebih dulu karena "YouTube Music" juga memuat kata "YouTube".
        if search
            .hits
            .iter()
            .any(|t| MUSIC_SITES.iter().any(|k| t.contains(k)))
        {
            return Some(true);
        }

        if search
            .hits
            .iter()
            .any(|t| VIDEO_SITES.iter().any(|k| t.contains(k)))
        {
            return Some(false);
        }

        None
    }
}

// Tentukan apakah yang sedang diputar musik atau video.
#[cfg(windows)]
fn classify_source(app: &str, album: &str, title: &str) -> &'static str {
    let id = app.to_lowercase();

    // Tidak ada sesi media: biarkan tampilan musik seperti biasa.
    if id.is_empty() {
        return "music";
    }

    if MUSIC_APPS.iter().any(|k| id.contains(k)) {
        return "music";
    }

    if VIDEO_APPS.iter().any(|k| id.contains(k)) {
        return "video";
    }

    let is_browser = BROWSER_APPS.iter().any(|k| id.contains(k)) || looks_like_hash_id(&id);
    let is_mixed = MIXED_PLAYERS.iter().any(|k| id.contains(k));

    // Browser atau aplikasi tak dikenal: cek judul window (tab yang sedang terbuka).
    if !is_mixed {
        if let Some(is_music) = source_hint::title_hint(title) {
            return if is_music { "music" } else { "video" };
        }
    }

    // Tanpa petunjuk lain: lagu biasanya punya info album, video biasanya tidak.
    if is_browser || is_mixed {
        return if album.trim().is_empty() { "video" } else { "music" };
    }

    // Aplikasi tak dikenal: tetap anggap musik (perilaku lama).
    "music"
}

// Ambil sesi media aktif Windows.
#[cfg(windows)]
async fn get_active_session(
) -> Result<GlobalSystemMediaTransportControlsSession, windows::core::Error> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    manager.GetCurrentSession()
}

// Putar atau jeda media.
#[tauri::command]
async fn media_toggle_play() -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Ok(session) = get_active_session().await {
            let _ = session.TryTogglePlayPauseAsync();
        }
    }

    Ok(())
}

// Putar lagu berikutnya.
#[tauri::command]
async fn media_next() -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Ok(session) = get_active_session().await {
            let _ = session.TrySkipNextAsync();
        }
    }

    Ok(())
}

// Putar lagu sebelumnya.
#[tauri::command]
async fn media_previous() -> Result<(), String> {
    #[cfg(windows)]
    {
        if let Ok(session) = get_active_session().await {
            let _ = session.TrySkipPreviousAsync();
        }
    }

    Ok(())
}

// Ubah posisi lagu.
#[tauri::command]
async fn media_seek(position_secs: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = get_active_session().await.map_err(|e| e.to_string())?;

        let ticks = (position_secs.max(0.0) * 10_000_000.0) as i64;

        let accepted = session
            .TryChangePlaybackPositionAsync(ticks)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?;

        if !accepted {
            return Err("Sesi media menolak perintah seek".to_string());
        }
    }

    #[cfg(not(windows))]
    {
        let _ = position_secs;
    }

    Ok(())
}

// Pantau perubahan media Windows.
#[cfg(windows)]
async fn start_media_listener(app: AppHandle) {
    tokio::spawn(async move {
        loop {
            let mut title = String::new();
            let mut artist = String::new();
            let mut is_playing = false;
            let mut album_art = String::new();
            let mut position_secs = 0.0;
            let mut duration_secs = 0.0;
            let mut source_app = String::new();
            let mut album_title = String::new();

            if let Ok(session) = get_active_session().await {
                // Aplikasi pemutar (Spotify, Chrome, dst.) untuk membedakan musik / video.
                source_app = session
                    .SourceAppUserModelId()
                    .map(|id| id.to_string())
                    .unwrap_or_default();

                if let Ok(playback_info) = session.GetPlaybackInfo() {
                    let status = playback_info.PlaybackStatus().unwrap_or_default().0;
                    is_playing = status == 4;
                }

                if let Ok(timeline) = session.GetTimelineProperties() {
                    let pos_ticks = timeline.Position().unwrap_or_default().Duration;
                    let end_ticks = timeline.EndTime().unwrap_or_default().Duration;

                    position_secs = pos_ticks as f64 / 10_000_000.0;
                    duration_secs = end_ticks as f64 / 10_000_000.0;

                    // Tambahkan waktu sejak snapshot SMTC saat lagu diputar.
                    if is_playing {
                        if let Ok(updated) = timeline.LastUpdatedTime() {
                            let last = updated.UniversalTime;

                            if last > 0 {
                                let now_ticks = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .map(|d| (d.as_nanos() / 100) as i64)
                                    .unwrap_or(0)
                                    + WINDOWS_EPOCH_OFFSET_TICKS;

                                let elapsed =
                                    (now_ticks - last).max(0) as f64 / 10_000_000.0;

                                position_secs += elapsed;
                            }
                        }
                    }

                    if duration_secs > 0.0 {
                        position_secs = position_secs.min(duration_secs);
                    }
                }

                if let Ok(media_props_op) = session.TryGetMediaPropertiesAsync() {
                    if let Ok(media_properties) = media_props_op.get() {
                        title = media_properties.Title().unwrap_or_default().to_string();
                        artist = media_properties.Artist().unwrap_or_default().to_string();
                        album_title = media_properties.AlbumTitle().unwrap_or_default().to_string();

                        if let Ok(thumbnail_ref) = media_properties.Thumbnail() {
                            if let Ok(stream_op) = thumbnail_ref.OpenReadAsync() {
                                if let Ok(stream) = stream_op.get() {
                                    let size = stream.Size().unwrap_or_default() as u32;

                                    if size > 0 {
                                        if let Ok(buffer) = Buffer::Create(size) {
                                            if let Ok(read_op) = stream.ReadAsync(
                                                &buffer,
                                                size,
                                                InputStreamOptions::None,
                                            ) {
                                                if let Ok(buffer_res) = read_op.get() {
                                                    if let Ok(reader) =
                                                        DataReader::FromBuffer(&buffer_res)
                                                    {
                                                        let mut bytes = vec![0u8; size as usize];

                                                        if reader.ReadBytes(&mut bytes).is_ok() {
                                                            album_art = format!(
                                                                "data:image/png;base64,{}",
                                                                general_purpose::STANDARD.encode(&bytes)
                                                            );
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Musik atau video? Dihitung sebelum `title` dipindahkan ke MediaInfo.
            let source_kind = classify_source(&source_app, &album_title, &title);

            let _ = app.emit(
                "spotify-status-update",
                MediaInfo {
                    title: if title.is_empty() {
                        "Tidak ada media".to_string()
                    } else {
                        title
                    },
                    artist: if artist.is_empty() {
                        "Unknown Artist".to_string()
                    } else {
                        artist
                    },
                    is_playing,
                    album_art,
                    position_secs,
                    duration_secs,
                },
            );

            // Event terpisah supaya payload "spotify-status-update" tidak berubah.
            let _ = app.emit(
                "media-source-update",
                MediaSourceInfo {
                    kind: source_kind,
                    app: source_app,
                },
            );

            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Volume sistem (Windows Core Audio)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod volume {
    use std::sync::Mutex;
    use windows::Win32::Foundation::BOOL;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    // Cegah dua perintah volume berjalan bersamaan (tekan cepat / tahan tombol).
    static STEP_LOCK: Mutex<()> = Mutex::new(());

    // Ambil kontrol volume perangkat output default.
    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            // Hasilnya diabaikan: thread ini mungkin sudah memakai COM.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|e| e.to_string())?;

            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| e.to_string())?;

            device
                .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                .map_err(|e| e.to_string())
        }
    }

    // Volume master saat ini (0.0 - 1.0).
    pub fn get() -> Result<f32, String> {
        let ep = endpoint()?;

        unsafe {
            ep.GetMasterVolumeLevelScalar()
                .map_err(|e| e.to_string())
        }
    }

    // Atur volume sistem ke nilai tertentu (0.0 - 1.0).
    pub fn set(value: f32) -> Result<f32, String> {
        let _guard = STEP_LOCK.lock().map_err(|e| e.to_string())?;
        let ep = endpoint()?;
        let target = value.clamp(0.0, 1.0);

        unsafe {
            ep.SetMasterVolumeLevelScalar(target, std::ptr::null())
                .map_err(|e| e.to_string())?;

            // Mengatur volume di atas nol otomatis membatalkan mute.
            if target > 0.0 {
                let _ = ep.SetMute(BOOL(0), std::ptr::null());
            }

            ep.GetMasterVolumeLevelScalar()
                .map_err(|e| e.to_string())
        }
    }

    // Geser volume sebesar `delta`, lalu kembalikan nilai akhirnya.
    pub fn step(delta: f32) -> Result<f32, String> {
        let _guard = STEP_LOCK.lock().map_err(|e| e.to_string())?;
        let ep = endpoint()?;

        unsafe {
            let current = ep
                .GetMasterVolumeLevelScalar()
                .map_err(|e| e.to_string())?;

            let target = (current + delta).clamp(0.0, 1.0);

            ep.SetMasterVolumeLevelScalar(target, std::ptr::null())
                .map_err(|e| e.to_string())?;

            // Naikkan volume = otomatis unmute, seperti tombol volume biasa.
            if target > 0.0 {
                let _ = ep.SetMute(BOOL(0), std::ptr::null());
            }

            ep.GetMasterVolumeLevelScalar()
                .map_err(|e| e.to_string())
        }
    }
}

// Baca volume sistem (0.0 - 1.0).
#[tauri::command]
async fn volume_get() -> Result<f32, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(volume::get)
            .await
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(windows))]
    Err("Hanya tersedia di Windows".to_string())
}

// Atur volume sistem ke nilai tertentu (0.0 - 1.0).
#[tauri::command]
async fn volume_set(value: f32) -> Result<f32, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || volume::set(value))
            .await
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(windows))]
    {
        let _ = value;
        Err("Hanya tersedia di Windows".to_string())
    }
}

// Geser volume sistem, kembalikan volume akhir (0.0 - 1.0).
#[tauri::command]
async fn volume_step(delta: f32) -> Result<f32, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || volume::step(delta))
            .await
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(windows))]
    {
        let _ = delta;
        Err("Hanya tersedia di Windows".to_string())
    }
}

// ---------------------------------------------------------------------------
// Hit test
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod hit_test {
    use super::{EXTRA_RECT, HIT_RECTS};
    use std::ffi::c_void;
    use std::time::Duration;
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, POINT, RECT};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_LBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetWindowRect,
    };

    const HIT_MARGIN: f64 = 2.0;
    const POLL_MS: u64 = 16;

    // Ambil area pil dalam koordinat layar.
    pub fn screen_rects(island: HWND) -> Vec<RECT> {
        let mut win = RECT::default();

        if unsafe { GetWindowRect(island, &mut win) }.is_err() {
            return Vec::new();
        }

        let dpi = unsafe { GetDpiForWindow(island) };
        let scale = if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        };

        let mut rects = match HIT_RECTS.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => return Vec::new(),
        };

        // HUD volume terpisah
        if let Ok(guard) = EXTRA_RECT.lock() {
            if let Some(r) = *guard {
                rects.push(r);
            }
        }

        rects
            .iter()
            .map(|[x, y, w, h]| RECT {
                left: win.left + ((x - HIT_MARGIN) * scale).floor() as i32,
                top: win.top + ((y - HIT_MARGIN) * scale).floor() as i32,
                right: win.left + ((x + w + HIT_MARGIN) * scale).ceil() as i32,
                bottom: win.top + ((y + h + HIT_MARGIN) * scale).ceil() as i32,
            })
            .collect()
    }

    // Periksa apakah kursor berada di dalam area pil.
    pub fn point_in_any(pt: &POINT, rects: &[RECT]) -> bool {
        rects
            .iter()
            .any(|r| pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom)
    }

    // Periksa tombol kiri mouse.
    fn left_button_down() -> bool {
        (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0
    }

    // Zona tangkap drag file: saat file diseret dari luar, area di tengah atas ini
    // ikut menerima event drag walau pil island masih kecil.
    const DROP_ZONE_W: f64 = 320.0;
    const DROP_ZONE_H: f64 = 60.0;

    fn drop_zone(island: HWND) -> Option<RECT> {
        let mut win = RECT::default();

        if unsafe { GetWindowRect(island, &mut win) }.is_err() {
            return None;
        }

        let dpi = unsafe { GetDpiForWindow(island) };
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };

        let win_w = (win.right - win.left) as f64;
        let zone_w = DROP_ZONE_W * scale;
        let left = win.left + ((win_w - zone_w) / 2.0).max(0.0) as i32;

        Some(RECT {
            left,
            top: win.top,
            right: left + zone_w as i32,
            bottom: win.top + (DROP_ZONE_H * scale) as i32,
        })
    }

    // Pantau area klik island.
    pub fn start(window: WebviewWindow, hwnd_raw: isize) {
        std::thread::spawn(move || {
            let island = HWND(hwnd_raw as *mut c_void);
            let mut ignoring: Option<bool> = None;
            let mut was_down = false;
            let mut press_inside = false;

            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));

                let mut pt = POINT::default();

                if unsafe { GetCursorPos(&mut pt) }.is_err() {
                    continue;
                }

                let inside = point_in_any(&pt, &screen_rects(island));
                let down = left_button_down();

                // Catat apakah tekanan mouse dimulai di dalam pil
                if down && !was_down {
                    press_inside = inside;
                }
                was_down = down;

                // Klik yang dimulai di dalam pil (slider, tombol): jangan ubah status sampai dilepas
                if down && press_inside {
                    continue;
                }

                // Tombol ditekan dari luar (mis. menyeret file dari Explorer):
                // zona tangkap ikut aktif supaya island bisa menerima drag
                // Gaya Radial: menunya di kursor, island tidak perlu menangkap drag
                let catch = down
                    && !crate::radial_overlay::mode_on()
                    && drop_zone(island)
                        .map(|zone| point_in_any(&pt, &[zone]))
                        .unwrap_or(false);

                let want_ignore = !(inside || catch);

                if ignoring != Some(want_ignore)
                    && window.set_ignore_cursor_events(want_ignore).is_ok()
                {
                    ignoring = Some(want_ignore);
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// Hindari menutupi title bar aplikasi lain
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod caption_avoid {
    use crate::hit_test::{point_in_any, screen_rects};
    use super::SPOTIFY_ACTIVE;
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{
        BOOL, FALSE, HWND, LPARAM, POINT, RECT, TRUE,
    };
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, UIA_ButtonControlTypeId, UIA_DocumentControlTypeId,
        UIA_TabItemControlTypeId,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetWindowLongPtrW,
        GetWindowRect, IsIconic, IsWindowVisible, SetWindowPos,
        GWL_EXSTYLE, HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    const CAPTION_HEIGHT: f64 = 36.0;
    const CAPTION_CONTROLS_WIDTH: f64 = 190.0;
    const POLL_MS: u64 = 16;

    // Jeda minimum antara dua pemulihan status topmost yang hilang.
    const REASSERT_MS: u64 = 200;

    // Strip tab di bagian atas window aplikasi lain (tab browser, tab Explorer, dst).
    const TAB_BAND_HEIGHT: f64 = 46.0; // tinggi strip tab (DIP) dari tepi atas window
    const TAB_SCAN_EVERY_MS: u64 = 100; // jeda antar pemindaian saat kursor di atas strip
    const TAB_CACHE_TTL_MS: u64 = 1500; // hasil pindai dianggap basi setelah ini
    const TAB_MAX_DEPTH: u32 = 12; // kedalaman maksimum pohon UI yang ditelusuri
    const TAB_MAX_NODES: u32 = 500; // batas jumlah elemen per pemindaian

    // Hasil pindai posisi tab (koordinat layar) untuk satu window.
    struct TabCache {
        hwnd: isize,
        rects: Vec<RECT>,
        stamp: Option<Instant>,
    }

    static TAB_CACHE: Mutex<TabCache> = Mutex::new(TabCache {
        hwnd: 0,
        rects: Vec::new(),
        stamp: None,
    });

    // Window yang sedang perlu dipindai: (hwnd, batas bawah strip tab, waktu diminta).
    static TAB_WANTED: Mutex<Option<(isize, i32, Instant)>> = Mutex::new(None);

    const IGNORED_CLASSES: [&str; 5] = [
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "NotifyIconOverflowWindow",
    ];

    struct Ctx {
        skip: HWND,
        pt: POINT,
        found: Option<(HWND, RECT)>,
    }

    // Periksa posisi kursor terhadap sebuah kotak.
    fn in_rect(pt: &POINT, r: &RECT) -> bool {
        pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom
    }

    // Cari window yang berada di bawah kursor.
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut Ctx);

        if hwnd == ctx.skip
            || !IsWindowVisible(hwnd).as_bool()
            || IsIconic(hwnd).as_bool()
        {
            return TRUE;
        }

        let mut cloaked: u32 = 0;

        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
        {
            return TRUE;
        }

        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;

        if ex_style & (WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0) != 0 {
            return TRUE;
        }

        let mut class = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class);

        if len > 0 {
            let name = String::from_utf16_lossy(&class[..len as usize]);

            if IGNORED_CLASSES.contains(&name.as_str()) {
                return TRUE;
            }
        }

        let mut rect = RECT::default();

        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_err()
            && GetWindowRect(hwnd, &mut rect).is_err()
        {
            return TRUE;
        }

        if in_rect(&ctx.pt, &rect) {
            ctx.found = Some((hwnd, rect));
            return FALSE;
        }

        TRUE
    }

    fn new_uia() -> Option<IUIAutomation> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
        }
    }

    // Pindai strip atas sebuah window lewat UI Automation dan kumpulkan kotak tab
    // (TabItem) serta tombol di strip itu (mis. tombol tab baru).
    // Isi halaman web (Document) tidak ditelusuri supaya pemindaian tetap ringan.
    unsafe fn scan_tabs(uia: &IUIAutomation, hwnd: HWND, band_bottom: i32) -> Vec<RECT> {
        let mut out: Vec<RECT> = Vec::new();

        let Ok(root) = uia.ElementFromHandle(hwnd) else {
            return out;
        };
        let Ok(walker) = uia.ControlViewWalker() else {
            return out;
        };

        let mut stack = vec![(root, 0u32)];
        let mut visited = 0u32;

        while let Some((el, depth)) = stack.pop() {
            let mut child = walker.GetFirstChildElement(&el).ok();

            while let Some(c) = child {
                visited += 1;
                if visited > TAB_MAX_NODES {
                    return out;
                }

                let next = walker.GetNextSiblingElement(&c).ok();
                let rect = c.CurrentBoundingRectangle().unwrap_or_default();
                let ct = c.CurrentControlType().map(|t| t.0).unwrap_or(0);
                let valid = rect.right > rect.left && rect.bottom > rect.top;

                // Abaikan elemen yang seluruhnya berada di bawah strip tab.
                if !valid || rect.top < band_bottom {
                    if valid && ct == UIA_TabItemControlTypeId.0 {
                        out.push(rect);
                    } else if valid
                        && ct == UIA_ButtonControlTypeId.0
                        && rect.bottom <= band_bottom
                    {
                        out.push(rect);
                    } else if ct != UIA_DocumentControlTypeId.0
                        && ct != UIA_TabItemControlTypeId.0
                        && depth + 1 < TAB_MAX_DEPTH
                    {
                        stack.push((c.clone(), depth + 1));
                    }
                }

                child = next;
            }
        }

        out
    }

    // Pemindai berjalan di thread sendiri supaya loop utama tidak tersendat.
    fn start_tab_worker() {
        std::thread::spawn(|| {
            let Some(uia) = new_uia() else {
                return;
            };

            loop {
                std::thread::sleep(Duration::from_millis(TAB_SCAN_EVERY_MS));

                let wanted = TAB_WANTED.lock().ok().and_then(|g| *g);
                let Some((raw, band_bottom, at)) = wanted else {
                    continue;
                };

                // Tidak ada yang meminta lagi (kursor sudah pergi): berhenti memindai.
                if at.elapsed() > Duration::from_millis(TAB_CACHE_TTL_MS) {
                    continue;
                }

                let rects =
                    unsafe { scan_tabs(&uia, HWND(raw as *mut c_void), band_bottom) };

                if let Ok(mut cache) = TAB_CACHE.lock() {
                    *cache = TabCache {
                        hwnd: raw,
                        rects,
                        stamp: Some(Instant::now()),
                    };
                }
            }
        });
    }

    // Minta pemindaian window ini (dipanggil saat kursor di strip tab).
    fn request_tab_scan(hwnd: HWND, band_bottom: i32) {
        if let Ok(mut wanted) = TAB_WANTED.lock() {
            *wanted = Some((hwnd.0 as isize, band_bottom, Instant::now()));
        }
    }

    // Apakah kursor tepat di atas sebuah tab / tombol tab (berdasarkan hasil pindai).
    // Tanpa hasil pindai yang segar, anggap tidak ada tab, jadi island tidak disembunyikan.
    fn tab_under_cursor(hwnd: HWND, pt: &POINT) -> bool {
        let Ok(cache) = TAB_CACHE.lock() else {
            return false;
        };

        if cache.hwnd != hwnd.0 as isize {
            return false;
        }

        match cache.stamp {
            Some(t) if t.elapsed() <= Duration::from_millis(TAB_CACHE_TTL_MS) => {}
            _ => return false,
        }

        cache.rects.iter().any(|r| in_rect(pt, r))
    }

    // Periksa apakah kursor berada di atas tombol title bar atau tab aplikasi lain.
    unsafe fn cursor_over_caption_beneath(
        island: HWND,
        pill_rects: &[RECT],
    ) -> bool {
        let mut pt = POINT::default();

        if GetCursorPos(&mut pt).is_err() {
            return false;
        }

        if !point_in_any(&pt, pill_rects) {
            return false;
        }

        let mut ctx = Ctx {
            skip: island,
            pt,
            found: None,
        };

        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut ctx as *mut Ctx as isize));

        let Some((hwnd, rect)) = ctx.found else {
            return false;
        };

        let dpi = GetDpiForWindow(hwnd);
        let scale = if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        };

        let caption_h = (CAPTION_HEIGHT * scale) as i32;
        let controls_w = (CAPTION_CONTROLS_WIDTH * scale) as i32;

        // Tombol minimize / maximize / close.
        if pt.y < rect.top + caption_h && pt.x >= rect.right - controls_w {
            return true;
        }

        // Tab: hanya bila kursor tepat di atas sebuah tab. Area kosong strip tab
        // tidak membuat island turun.
        let band_bottom = rect.top + (TAB_BAND_HEIGHT * scale) as i32;

        if pt.y >= band_bottom {
            return false;
        }

        request_tab_scan(hwnd, band_bottom);
        tab_under_cursor(hwnd, &pt)
    }

    // Island sedang berstatus topmost atau tidak.
    unsafe fn is_topmost(hwnd: HWND) -> bool {
        ((GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOPMOST.0) != 0
    }

    // Turunkan island ke dasar z-order. Status topmost dilepas dulu supaya
    // island benar-benar turun di bawah window aplikasi lain.
    unsafe fn send_to_back(island: HWND) {
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        let _ = SetWindowPos(island, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        let _ = SetWindowPos(island, HWND_BOTTOM, 0, 0, 0, 0, flags);
    }

    // Naikkan island kembali ke paling depan. NOTOPMOST -> TOPMOST dipakai agar
    // island pasti naik ke atas walau bit topmost-nya masih tersisa dari sebelumnya.
    unsafe fn bring_to_front(island: HWND) {
        let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
        let _ = SetWindowPos(island, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
        let _ = SetWindowPos(island, HWND_TOPMOST, 0, 0, 0, 0, flags);
    }

    // Atur posisi island terhadap title bar aplikasi lain.
    //
    // Status "di belakang" disimpan sendiri di `behind`, TIDAK dibaca dari style
    // window. Dulu island hanya dikembalikan bila WS_EX_TOPMOST terbaca mati; kalau
    // Windows masih menyisakan bit itu setelah HWND_BOTTOM, island tidak pernah
    // naik lagi sampai aplikasi di bawahnya di-minimize.
    pub fn start(hwnd_raw: isize, app: AppHandle) {
        start_tab_worker();

        std::thread::spawn(move || {
            let island = HWND(hwnd_raw as *mut c_void);
            let mut behind = false;
            let mut frozen: Vec<RECT> = Vec::new();
            let mut last_fix = Instant::now();

            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));

                // Jangan ubah z-order saat Spotify sedang aktif.
                if SPOTIFY_ACTIVE.load(Ordering::Relaxed) {
                    continue;
                }

                // Island dimatikan dari Pengaturan: biarkan tersembunyi.
                if !super::settings::is_enabled() {
                    continue;
                }

                unsafe {
                    // Island disembunyikan (tray / Spotify): jangan sentuh z-order,
                    // dan jangan biarkan status "behind" basi tertinggal.
                    if !IsWindowVisible(island).as_bool() {
                        if behind {
                            behind = false;
                            let _ = app.emit("island-behind", false);
                        }
                        continue;
                    }

                    // Di depan: area pil selalu terbaru.
                    // Di belakang: pakai area beku, karena pil mengecil saat mini.
                    let pill_rects = if behind {
                        frozen.clone()
                    } else {
                        let current = screen_rects(island);
                        frozen = current.clone();
                        current
                    };

                    let want_behind =
                        cursor_over_caption_beneath(island, &pill_rects);

                    if want_behind && !behind {
                        send_to_back(island);
                        behind = true;
                        let _ = app.emit("island-behind", true);
                    } else if !want_behind && behind {
                        // Kursor keluar dari tombol title bar (atau tidak jadi klik):
                        // langsung kembali ke depan.
                        bring_to_front(island);
                        behind = false;
                        let _ = app.emit("island-behind", false);
                        last_fix = Instant::now();
                    } else if !behind
                        && !is_topmost(island)
                        && last_fix.elapsed() >= Duration::from_millis(REASSERT_MS)
                    {
                        // Seharusnya di depan tetapi status topmost hilang: pulihkan.
                        bring_to_front(island);
                        last_fix = Instant::now();
                    }
                }
            }
        });
    }
}

// Perintah sapaan bawaan.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ---------------------------------------------------------------------------
// Jalankan aplikasi
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Suara island (choose / drop / checklist) diputar dari WebView saat file diseret
    // dari Explorer. Tanpa klik apa pun di window, WebView2 biasanya memblokir audio
    // (kebijakan autoplay), jadi izinkan. Harus dipanggil sebelum WebView dibuat.
    #[cfg(windows)]
    {
        const AUTOPLAY: &str = "--autoplay-policy=no-user-gesture-required";

        let args = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(old) if !old.contains("--autoplay-policy") => format!("{old} {AUTOPLAY}"),
            Ok(old) => old,
            Err(_) => AUTOPLAY.to_string(),
        };

        // Aman: masih satu thread, belum ada WebView / thread lain yang berjalan
        unsafe { std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args) };
    }

    tauri::Builder::default()
        // Single instance harus didaftarkan pertama.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            settings::on_relaunch(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        // Dialog pilih folder untuk tombol Paste di island
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        // Tombol close hanya menyembunyikan island.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Jendela Pengaturan ditutup betulan; hanya island yang disembunyikan.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            media_toggle_play,
            media_next,
            media_previous,
            media_seek,
            volume_get,
            volume_set,
            volume_step,
            island_set_height,
            island_set_hit_rects,
            island_set_extra_rect,
            radial_overlay::radial_overlay_keep,
            island_show_menu,
            island_native::http_request,
            island_native::clock_dump,
            island_native::clock_timer_toggle,
            island_native::clock_timer_cancel,
            island_focus,
            spectrum::spectrum_set_active,
            file_actions::file_inspect,
            file_actions::file_tools,
            file_actions::file_action,
            file_actions::file_pick_folder,
            file_actions::file_paste,
            file_actions::file_rename,
            file_actions::file_properties,
            file_convert::file_convert,
            file_convert::file_explorer_folder,
            file_crop::file_crop_preview,
            file_crop::file_crop_apply,
            settings::settings_get,
            settings::settings_save,
            settings::settings_recenter,
            settings::settings_quit,
            system_status::system_status,
            system_status::power_status,
            system_status::system_radios,
            system_status::system_volume_get,
            system_status::system_volume_set,
            system_status::system_radio_set,
            system_status::system_airplane_set,
            system_status::wifi_list,
            system_status::wifi_connect,
            system_status::wifi_disconnect,
            system_status::bluetooth_list,
            system_status::system_open_page
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Atur window island.
                let _ = window.set_skip_taskbar(true);
                let _ = window.set_always_on_top(true);

                if let Err(e) = place_island(&window, ISLAND_COMPACT_HEIGHT) {
                    eprintln!("Gagal memposisikan window island: {e}");
                }
            }

            // Muat pengaturan. Island hanya tampil bila diaktifkan di Pengaturan;
            // pada pemasangan baru island mati dan jendela Pengaturan dibuka.
            let first_run = settings::init(app.handle());

            // Siapkan system tray.
            setup_tray(app.handle())?;

            if first_run {
                settings::open_settings(app.handle());
            }

            #[cfg(windows)]
            {
                // Pantau aplikasi Spotify yang sedang aktif.
                spotify_visibility::start(app.handle().clone());

                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(hwnd) = window.hwnd() {
                        let raw = hwnd.0 as isize;

                        // Aktifkan hit test area pil.
                        hit_test::start(window.clone(), raw);

                        // Aktifkan penghindar title bar.
                        caption_avoid::start(raw, app.handle().clone());
                    }
                }
            }

            // Pantau timer Windows Clock.
            island_native::start_clock_watcher(app.handle().clone());

            // Tangkap audio sistem untuk spektrum (aktif hanya saat diminta frontend).
            spectrum::start(app.handle().clone());

            // Pantau drag file dari Explorer / Desktop untuk menu radial.
            radial_overlay::start(app.handle().clone());

            #[cfg(windows)]
            {
                // Jalankan listener media Windows.
                let handle = app.handle().clone();

                tauri::async_runtime::spawn(async move {
                    start_media_listener(handle).await;
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    }