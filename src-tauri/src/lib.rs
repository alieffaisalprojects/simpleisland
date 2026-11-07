
mod island_native; // Timer Clock Windows dan HTTP request

use base64::{engine::general_purpose, Engine as _};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

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
const ISLAND_WINDOW_WIDTH: f64 = 520.0;
const ISLAND_WINDOW_TOP: f64 = 0.0;
const ISLAND_COMPACT_HEIGHT: f64 = 60.0;

// ID menu tray.
const MENU_AUTOSTART: &str = "island_autostart";
const MENU_CENTER: &str = "island_center";
const MENU_TOGGLE: &str = "island_toggle";
const MENU_QUIT: &str = "island_quit";
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

// ---------------------------------------------------------------------------
// Tray dan menu
// ---------------------------------------------------------------------------

// Tampilkan island jika Spotify tidak sedang aktif.
fn show_island(app: &AppHandle) {
    #[cfg(windows)]
    if SPOTIFY_ACTIVE.load(Ordering::Relaxed) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_always_on_top(true);
    }
}

// Tampilkan atau sembunyikan island.
fn toggle_island(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            let _ = window.hide();
        } else {
            show_island(app);
        }
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
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

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
        true,
        None::<&str>,
    )?;

    let toggle = MenuItem::with_id(
        app,
        MENU_TOGGLE,
        "Tampilkan / sembunyikan island",
        true,
        None::<&str>,
    )?;

    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Keluar", true, None::<&str>)?;

    Menu::with_items(app, &[&autostart, &center, &toggle, &separator, &quit])
}

// Jalankan aksi menu.
fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_AUTOSTART => {
            let manager = app.autolaunch();

            let result = if manager.is_enabled().unwrap_or(false) {
                manager.disable()
            } else {
                manager.enable()
            };

            if let Err(e) = result {
                eprintln!("Gagal mengubah auto startup: {e}");
            }

            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                if let Ok(menu) = build_menu(app) {
                    let _ = tray.set_menu(Some(menu));
                }
            }
        }

        MENU_CENTER => recenter_island(app),
        MENU_TOGGLE => toggle_island(app),
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
        .tooltip("Dynamic Island")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_island(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

// Aktifkan auto startup pada pemakaian pertama.
fn enable_autostart_first_run(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };

    let marker = dir.join(".autostart-initialized");

    if marker.exists() {
        return;
    }

    if let Err(e) = app.autolaunch().enable() {
        eprintln!("Gagal mengaktifkan auto startup: {e}");
        return;
    }

    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, b"1");
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
                        // Tampilkan kembali island.
                        let _ = window.show();
                        let _ = window.set_always_on_top(true);
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

            if let Ok(session) = get_active_session().await {
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

            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Hit test
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod hit_test {
    use super::HIT_RECTS;
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

        let rects = match HIT_RECTS.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => return Vec::new(),
        };

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

    // Pantau area klik island.
    pub fn start(window: WebviewWindow, hwnd_raw: isize) {
        std::thread::spawn(move || {
            let island = HWND(hwnd_raw as *mut c_void);
            let mut ignoring: Option<bool> = None;

            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));

                // Jangan ubah status saat mouse sedang ditekan.
                if left_button_down() {
                    continue;
                }

                let mut pt = POINT::default();

                if unsafe { GetCursorPos(&mut pt) }.is_err() {
                    continue;
                }

                let inside = point_in_any(&pt, &screen_rects(island));
                let want_ignore = !inside;

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
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{
        BOOL, FALSE, HWND, LPARAM, POINT, RECT, TRUE,
    };
    use windows::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetCursorPos, GetWindowLongPtrW,
        GetWindowRect, IsIconic, IsWindowVisible, SetWindowPos,
        GWL_EXSTYLE, HWND_BOTTOM, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_EX_TOOLWINDOW,
        WS_EX_TOPMOST, WS_EX_TRANSPARENT,
    };

    const CAPTION_HEIGHT: f64 = 36.0;
    const CAPTION_CONTROLS_WIDTH: f64 = 190.0;
    const POLL_MS: u64 = 50;

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

    // Periksa apakah kursor berada di area kontrol title bar aplikasi lain.
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

        pt.y < rect.top + caption_h && pt.x >= rect.right - controls_w
    }

    // Atur posisi island terhadap title bar aplikasi lain.
    pub fn start(hwnd_raw: isize, app: AppHandle) {
        std::thread::spawn(move || {
            let island = HWND(hwnd_raw as *mut c_void);
            let mut frozen: Vec<RECT> = Vec::new();

            loop {
                std::thread::sleep(Duration::from_millis(POLL_MS));

                // Jangan ubah z-order saat Spotify sedang aktif.
                if SPOTIFY_ACTIVE.load(Ordering::Relaxed) {
                    continue;
                }

                unsafe {
                    let is_topmost =
                        ((GetWindowLongPtrW(island, GWL_EXSTYLE) as u32)
                            & WS_EX_TOPMOST.0)
                            != 0;

                    let pill_rects = if is_topmost {
                        let current = screen_rects(island);
                        frozen = current.clone();
                        current
                    } else {
                        frozen.clone()
                    };

                    let want_behind =
                        cursor_over_caption_beneath(island, &pill_rects);

                    if want_behind && is_topmost {
                        let _ = SetWindowPos(
                            island,
                            HWND_BOTTOM,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );

                        let _ = app.emit("island-behind", true);
                    } else if !want_behind && !is_topmost {
                        let _ = SetWindowPos(
                            island,
                            HWND_TOPMOST,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE
                                | SWP_NOSIZE
                                | SWP_NOACTIVATE
                                | SWP_SHOWWINDOW,
                        );

                        let _ = app.emit("island-behind", false);
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
    tauri::Builder::default()
        // Single instance harus didaftarkan pertama.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_island(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        // Tombol close hanya menyembunyikan island.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            media_toggle_play,
            media_next,
            media_previous,
            media_seek,
            island_set_height,
            island_set_hit_rects,
            island_show_menu,
            island_native::http_request,
            island_native::clock_dump,
             island_native::http_request,
            island_native::clock_timer_toggle,
            island_native::clock_timer_cancel
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

            // Aktifkan auto startup pada build release pertama.
            if !cfg!(debug_assertions) {
                enable_autostart_first_run(app.handle());
            }

            // Siapkan system tray.
            setup_tray(app.handle())?;

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
