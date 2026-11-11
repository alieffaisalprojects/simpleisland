//! radial_overlay.rs
//! Menu radial yang muncul tepat di kursor saat file diseret dari Explorer / Desktop.
//!
//! Alur (semua keputusan hit-test dibuat native di sini, bukan di WebView):
//!   1. Thread pemantau mendeteksi awal drag file di Explorer / Desktop, lalu jendela
//!      "radial" dibesarkan menutupi monitor dan menjadi target drop (WebView menerima
//!      daftar file dan menggambar lingkarannya).
//!   2. Selama drag, kursor di DALAM lingkaran  -> jendela menangkap drag (pilih irisan).
//!      Kursor di LUAR lingkaran -> jendela tembus klik, drag lanjut ke Explorer / folder
//!      / aplikasi lain seperti biasa (file pindah normal).
//!   3. Lingkaran muncul DI DEPAN kursor, searah seretan, supaya file yang diseret tidak
//!      tertutup. Kalau di depan kursor tidak muat (mis. kursor mentok di tepi monitor),
//!      lingkaran muncul tepat di kursor.
//!   4. Lingkaran tetap aktif dan ikut kursor dengan "tali": kalau kursor menjauh dari
//!      tepi lingkaran, pusat lingkaran ditarik mengikuti. Kursor kembali ke dalam
//!      lingkaran -> bisa lepas di irisan.
//!   5. Tombol dilepas di luar lingkaran -> menu ditutup. Dilepas di dalam -> aksi jalan
//!      atau menu tetap terbuka (klik irisan).
//!
//! Event ke frontend (jendela "radial"):
//!   radial-start   [x, y]  pusat lingkaran (px CSS relatif jendela), drag dimulai
//!   radial-anchor  [x, y]  pusat lingkaran berpindah mengikuti kursor
//!   radial-release bool    tombol dilepas; true = kursor di dalam lingkaran
//!
//! Jendela selalu tampil sejak dibuat (kecil, transparan, tembus klik) supaya WebView2-nya
//! hidup dan drop target-nya terpasang; hanya dibesarkan / dikecilkan.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindowBuilder,
};

pub const RADIAL_LABEL: &str = "radial";

// Ukuran jendela saat diparkir (px). Transparan dan tembus klik.
const PARK_SIZE: u32 = 32;

// Ukuran lingkaran (px CSS), harus sama dengan FileRadialMenu.tsx: R_OUT + HALO
const RADIUS_CSS: f64 = 160.0;
// Jarak tali: pusat baru ditarik bila kursor lebih jauh dari RADIUS + GAP
const GAP_CSS: f64 = 90.0;
// Jarak minimal lingkaran dari tepi layar: RADIUS + 8
const HALF_CSS: f64 = 168.0;
// Jarak kosong antara kursor (file) dan tepi lingkaran saat menu baru muncul
const CLEAR_CSS: f64 = 56.0;

// Frontend menahan jendela tetap besar selama menu radial aktif
static KEEP: AtomicBool = AtomicBool::new(false);

// Jendela sedang / sudah dibuat
static CREATING: AtomicBool = AtomicBool::new(false);

// Gaya menu saat ini Radial (dibaca island untuk mematikan zona tangkapnya)
static MODE_ON: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn radial_overlay_keep(on: bool) {
    KEEP.store(on, Ordering::Relaxed);
}

#[allow(dead_code)]
pub fn mode_on() -> bool {
    MODE_ON.load(Ordering::Relaxed)
}

fn radial_enabled(app: &AppHandle) -> bool {
    let s = crate::settings::current(app);
    s.island_enabled && s.file_drop && s.file_menu_style == "radial"
}

// Monitor tempat overlay tampil (koordinat fisik)
#[derive(Clone, Copy, Default)]
#[allow(dead_code)]
struct Geo {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    scale: f64,
}

#[allow(dead_code)]
fn clampf(v: f64, min: f64, max: f64) -> f64 {
    v.min(max.max(min)).max(min)
}

// Jaga pusat lingkaran tetap di dalam monitor
#[allow(dead_code)]
fn clamp_center(g: &Geo, x: f64, y: f64) -> (f64, f64) {
    let half = HALF_CSS * g.scale;

    (
        clampf(x, g.x as f64 + half, (g.x + g.w) as f64 - half),
        clampf(y, g.y as f64 + half, (g.y + g.h) as f64 - half),
    )
}

// Pusat awal: di depan kursor searah seretan (file tidak tertutup).
// Tidak muat di monitor (kursor mentok di tepi) -> tepat di kursor.
#[allow(dead_code)]
fn start_center(g: &Geo, px: f64, py: f64, dx: f64, dy: f64) -> (f64, f64) {
    let len = (dx * dx + dy * dy).sqrt();

    if len > 0.0 {
        let off = (RADIUS_CSS + CLEAR_CSS) * g.scale;
        let half = HALF_CSS * g.scale;
        let tx = px + dx / len * off;
        let ty = py + dy / len * off;

        let fits = tx >= g.x as f64 + half
            && tx <= (g.x + g.w) as f64 - half
            && ty >= g.y as f64 + half
            && ty <= (g.y + g.h) as f64 - half;

        if fits {
            return (tx, ty);
        }
    }

    clamp_center(g, px, py)
}

// Kirim posisi pusat (px CSS relatif jendela) ke frontend
#[allow(dead_code)]
fn emit_pos(app: &AppHandle, event: &str, g: &Geo, cx: f64, cy: f64) {
    let pos = [(cx - g.x as f64) / g.scale, (cy - g.y as f64) / g.scale];
    let _ = app.emit_to(RADIAL_LABEL, event, pos);
}

// Jendela tidak boleh merebut fokus dari Explorer dan tidak muncul di Alt+Tab
#[cfg(windows)]
fn no_activate(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    if let Ok(hwnd) = window.hwnd() {
        let raw = hwnd.0 as isize;
        let h = HWND(raw as *mut c_void);

        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let add = (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize;
            SetWindowLongPtrW(h, GWL_EXSTYLE, ex | add);
        }
    }
}

// Buat jendela: langsung tampil tapi kecil, transparan, dan tembus klik (diparkir).
fn create(app: &AppHandle) {
    if CREATING.swap(true, Ordering::SeqCst) {
        return;
    }

    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        if app.get_webview_window(RADIAL_LABEL).is_some() {
            return;
        }

        let built = WebviewWindowBuilder::new(
            &app,
            RADIAL_LABEL,
            WebviewUrl::App("index.html".into()),
        )
        .title("Simple Island Radial")
        .inner_size(PARK_SIZE as f64, PARK_SIZE as f64)
        .position(0.0, 0.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(true)
        .build();

        match built {
            Ok(window) => {
                let _ = window.set_ignore_cursor_events(true);

                #[cfg(windows)]
                no_activate(&window);

                eprintln!("[radial] jendela dibuat (diparkir {PARK_SIZE}x{PARK_SIZE})");
            }
            Err(e) => {
                eprintln!("[radial] gagal membuat jendela: {e}");
                CREATING.store(false, Ordering::SeqCst);
            }
        }
    });
}

// Besarkan jendela menutupi monitor tempat kursor berada. Jendela MASIH tembus klik;
// pemanggil mengaktifkan hit-test lewat `set_hit` setelah event start terkirim.
#[allow(dead_code)]
fn show_overlay(app: &AppHandle, x: i32, y: i32) -> Option<Geo> {
    let Some(win) = app.get_webview_window(RADIAL_LABEL) else {
        eprintln!("[radial] drag terdeteksi tapi jendela belum siap");
        return None;
    };

    let monitors = win.available_monitors().unwrap_or_default();

    let found = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();

            x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
        })
        .cloned()
        .or_else(|| win.primary_monitor().ok().flatten());

    let m = found?;

    let geo = Geo {
        x: m.position().x,
        y: m.position().y,
        w: m.size().width as i32,
        h: m.size().height as i32,
        scale: m.scale_factor(),
    };

    let _ = win.set_ignore_cursor_events(true);
    let _ = win.set_position(PhysicalPosition::new(geo.x, geo.y));
    let _ = win.set_size(PhysicalSize::new(geo.w as u32, geo.h as u32));
    let _ = win.set_always_on_top(true);
    let _ = win.show();

    Some(geo)
}

// true = jendela menangkap mouse / drag; false = tembus klik
#[allow(dead_code)]
fn set_hit(app: &AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window(RADIAL_LABEL) {
        let _ = win.set_ignore_cursor_events(!on);
    }
}

// Kecilkan jendela dan kembalikan tembus klik (tidak disembunyikan)
fn park_overlay(app: &AppHandle) {
    KEEP.store(false, Ordering::Relaxed);

    if let Some(win) = app.get_webview_window(RADIAL_LABEL) {
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.set_size(PhysicalSize::new(PARK_SIZE, PARK_SIZE));
        let _ = win.set_position(PhysicalPosition::new(0, 0));
    }
}

#[cfg(windows)]
pub fn start(app: AppHandle) {
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetCursorPos, WindowFromPoint, GA_ROOT,
    };

    const POLL_MS: u64 = 8;
    const EMIT_MS: u128 = 14;
    const MODE_CHECK_MS: u128 = 150;
    // Jarak geser (px fisik) sebelum menu muncul; cukup jauh supaya arah seretan akurat
    const ARM_DIST: i32 = 14;
    // Jendela menangkap drag sampai frontend siap (file terbaca) atau waktu ini habis
    const READY_MS: u128 = 600;
    // Beri waktu event drop sampai ke frontend sebelum jendela diparkir
    const GRACE_MS: u128 = 450;

    fn class_of(hwnd: HWND) -> String {
        if hwnd.is_invalid() {
            return String::new();
        }

        let mut buf = [0u16; 64];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };

        if len <= 0 {
            return String::new();
        }

        String::from_utf16_lossy(&buf[..len as usize])
    }

    // Titik berada di daftar file Explorer atau Desktop (bukan title bar, tombol, dll.)
    fn is_file_source(pt: POINT) -> bool {
        let leaf = unsafe { WindowFromPoint(pt) };

        if leaf.is_invalid() {
            return false;
        }

        let root = unsafe { GetAncestor(leaf, GA_ROOT) };
        let leaf_class = class_of(leaf);
        let root_class = class_of(if root.is_invalid() { leaf } else { root });

        matches!(leaf_class.as_str(), "DirectUIHWND" | "SysListView32")
            && matches!(
                root_class.as_str(),
                "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
            )
    }

    std::thread::spawn(move || {
        let mut mode_on = false;
        let mut last_mode = Instant::now() - Duration::from_secs(1);
        let mut was_down = false;
        let mut press = POINT::default();
        let mut from_files = false;
        let mut visible = false;
        let mut released_at = Instant::now();

        // sesi drag: dari overlay tampil sampai tombol pertama kali dilepas
        let mut session = false;
        let mut geo = Geo::default();
        let (mut cx, mut cy) = (0.0f64, 0.0f64);
        let mut hit = false;
        let mut last_inside = true;
        // kursor sudah pernah masuk lingkaran (sebelumnya tali lebih longgar)
        let mut engaged = false;
        let mut started = Instant::now();
        let mut last_sent = (f64::NAN, f64::NAN);
        let mut last_emit = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(POLL_MS));

            if last_mode.elapsed().as_millis() >= MODE_CHECK_MS {
                last_mode = Instant::now();
                mode_on = radial_enabled(&app);
                MODE_ON.store(mode_on, Ordering::Relaxed);

                if mode_on && app.get_webview_window(RADIAL_LABEL).is_none() {
                    create(&app);
                }
            }

            // Gaya menu bukan Radial: pastikan jendela tidak tertinggal besar
            if !mode_on {
                if visible {
                    park_overlay(&app);
                    visible = false;
                }

                session = false;
                was_down = false;
                from_files = false;
                continue;
            }

            let mut pt = POINT::default();

            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                continue;
            }

            let down = (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0;

            // Tombol baru ditekan: apakah dimulai di daftar file?
            if down && !was_down {
                press = pt;
                from_files = !visible && is_file_source(pt);
            }

            // Tombol dilepas
            if !down && was_down {
                released_at = Instant::now();
                from_files = false;

                if session {
                    session = false;

                    // kirim posisi terakhir lalu kabari frontend
                    if (cx, cy) != last_sent {
                        emit_pos(&app, "radial-anchor", &geo, cx, cy);
                        last_sent = (cx, cy);
                    }

                    let _ = app.emit_to(RADIAL_LABEL, "radial-release", last_inside);

                    // dilepas di dalam lingkaran: jendela tetap menangkap mouse (klik irisan)
                    if last_inside && !hit {
                        set_hit(&app, true);
                        hit = true;
                    }
                }
            }

            // Kursor bergeser sedikit dengan tombol masih ditekan: drag file dimulai
            if down && from_files && !visible {
                let dx = pt.x - press.x;
                let dy = pt.y - press.y;

                if dx * dx + dy * dy >= ARM_DIST * ARM_DIST {
                    if let Some(g) = show_overlay(&app, pt.x, pt.y) {
                        geo = g;
                        let (ax, ay) = start_center(&geo, pt.x as f64, pt.y as f64, dx as f64, dy as f64);
                        cx = ax;
                        cy = ay;

                        let ox = pt.x as f64 - cx;
                        let oy = pt.y as f64 - cy;
                        let inside = (ox * ox + oy * oy).sqrt() <= RADIUS_CSS * geo.scale;

                        // beri tahu frontend dulu, baru jendela menangkap drag
                        // (menangkap dulu walau kursor di luar lingkaran, supaya
                        // frontend menerima daftar file dan menggambar menunya)
                        emit_pos(&app, "radial-start", &geo, cx, cy);
                        last_sent = (cx, cy);
                        last_emit = Instant::now();
                        set_hit(&app, true);

                        hit = true;
                        last_inside = inside;
                        engaged = inside;
                        started = Instant::now();
                        visible = true;
                        session = true;
                        eprintln!("[radial] overlay aktif di ({}, {})", pt.x, pt.y);
                    }

                    from_files = false;
                }
            }

            // Selama drag: di dalam lingkaran menangkap drag, di luar tembus klik,
            // dan pusat lingkaran ditarik mengikuti kursor (tali)
            if visible && session && down {
                let r = RADIUS_CSS * geo.scale;
                // sebelum kursor masuk lingkaran, tali dilonggarkan sebesar jarak kosong awal
                let slack = if engaged { GAP_CSS } else { GAP_CSS + CLEAR_CSS };
                let gap = slack * geo.scale;
                let dx = pt.x as f64 - cx;
                let dy = pt.y as f64 - cy;
                let d = (dx * dx + dy * dy).sqrt();
                let inside = d <= r;

                if inside {
                    engaged = true;
                }

                if d > r + gap {
                    let k = (r + gap) / d;
                    let (nx, ny) = clamp_center(&geo, pt.x as f64 - dx * k, pt.y as f64 - dy * k);
                    cx = nx;
                    cy = ny;
                }

                // di luar lingkaran: tembus klik, tapi baru setelah frontend siap
                let ready = KEEP.load(Ordering::Relaxed) || started.elapsed().as_millis() >= READY_MS;
                let want_hit = inside || !ready;

                if want_hit != hit {
                    set_hit(&app, want_hit);
                    hit = want_hit;
                }

                last_inside = inside;

                if (cx, cy) != last_sent && last_emit.elapsed().as_millis() >= EMIT_MS {
                    emit_pos(&app, "radial-anchor", &geo, cx, cy);
                    last_sent = (cx, cy);
                    last_emit = Instant::now();
                }
            }

            // Menu sudah selesai dan tombol sudah dilepas: parkir jendela
            if visible
                && !down
                && !session
                && !KEEP.load(Ordering::Relaxed)
                && released_at.elapsed().as_millis() >= GRACE_MS
            {
                park_overlay(&app);
                visible = false;
                hit = false;
            }

            was_down = down;
        }
    });
}

#[cfg(not(windows))]
pub fn start(_app: AppHandle) {}