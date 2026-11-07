//! island_native.rs
//! 1) Watcher timer aplikasi Clock Windows (UI Automation) -> event `clock-timer-update`.
//! 2) Command `http_request` (GET/POST form) untuk lirik & terjemahan, bebas CORS.
//! 3) Command `clock_dump` untuk debug: daftar teks yang terbaca dari jendela Clock.
//! 4) Command `clock_timer_toggle` / `clock_timer_cancel`: jeda / reset timer di Clock.
//!
//! Payload event: { state, timers: [detik], running: [bool] }
//! `running[i]` = status tombol Jeda/Lanjut pada timer ke-i (true = sedang jalan).
//! `running` tidak dikirim bila status salah satu timer tidak terbaca
//! (frontend lalu memakai deteksi cadangan).
//!
//! Debug otomatis: selama app jalan, watcher menulis laporan ke
//! `%TEMP%\island_clock_debug.txt` (diperbarui tiap ~2 detik).

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

#[cfg(windows)]
use tauri::Emitter;

#[derive(Serialize, Clone)]
struct ClockPayload {
    state: &'static str, // "none" | "minimized" | "visible"
    timers: Vec<u32>,    // detik tersisa, urutan sesuai tampilan di Clock
    #[serde(skip_serializing_if = "Option::is_none")]
    running: Option<Vec<bool>>, // sejajar dengan `timers`
}

/// Baca "H:MM:SS" dari sebuah teks. Karakter selain angka dan ':' (spasi, NBSP,
/// tanda arah teks tak terlihat, kata lain) dianggap pemisah.
fn parse_hms(text: &str) -> Option<u32> {
    for run in text.split(|c: char| !(c.is_ascii_digit() || c == ':')) {
        let parts: Vec<&str> = run.split(':').collect();
        if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || p.len() > 2) {
            continue;
        }
        let (Ok(h), Ok(m), Ok(s)) = (
            parts[0].parse::<u32>(),
            parts[1].parse::<u32>(),
            parts[2].parse::<u32>(),
        ) else {
            continue;
        };
        if m < 60 && s < 60 {
            return Some(h * 3600 + m * 60 + s);
        }
    }
    None
}

/// Satuan waktu (Inggris + Indonesia) -> detik.
fn unit_secs(u: &str) -> Option<u32> {
    match u.to_lowercase().as_str() {
        "h" | "hr" | "hrs" | "hour" | "hours" | "jam" => Some(3600),
        "m" | "min" | "mins" | "minute" | "minutes" | "menit" => Some(60),
        "s" | "sec" | "secs" | "second" | "seconds" | "detik" => Some(1),
        _ => None,
    }
}

/// Baca durasi berbentuk kata, misalnya "4 minutes 58 seconds", "1 jam 2 menit",
/// "4m 58s". Hanya SATU frasa yang berurutan rapat (angka+satuan, angka+satuan, ...)
/// dengan satuan menurun. Frasa terpisah ("Add 1 minute ... 59 seconds") TIDAK dijumlahkan,
/// dan teks tombol tambah waktu ("Add 1 minute" / "Tambah 1 menit") diabaikan.
fn parse_words(text: &str) -> Option<u32> {
    // Pecah menjadi token: deretan angka atau deretan huruf.
    let mut tokens: Vec<(bool, String)> = Vec::new();
    let mut cur = String::new();
    let mut cur_num = false;

    for c in text.chars().chain(std::iter::once(' ')) {
        let kind = if c.is_ascii_digit() {
            Some(true)
        } else if c.is_alphabetic() {
            Some(false)
        } else {
            None
        };

        if !cur.is_empty() && kind != Some(cur_num) {
            tokens.push((cur_num, std::mem::take(&mut cur)));
        }
        if let Some(k) = kind {
            cur_num = k;
            cur.push(c);
        }
    }

    // Tombol / label penambah waktu bukan sisa waktu timer.
    if text.contains('+')
        || tokens.iter().any(|(num, t)| {
            !*num
                && matches!(
                    t.to_lowercase().as_str(),
                    "add" | "plus" | "extra" | "tambah" | "tambahkan"
                )
        })
    {
        return None;
    }

    let is_pair = |i: usize| -> Option<u32> {
        match (tokens.get(i), tokens.get(i + 1)) {
            (Some((true, _)), Some((false, u))) => unit_secs(u),
            _ => None,
        }
    };

    // Cari awal frasa durasi pertama.
    let mut i = 0;
    while i < tokens.len() && is_pair(i).is_none() {
        i += 1;
    }
    if i >= tokens.len() {
        return None;
    }

    let mut total: u32 = 0;
    let mut last_mult = u32::MAX;
    while let Some(mult) = is_pair(i) {
        // Satuan harus menurun (jam > menit > detik); kalau tidak, itu durasi lain.
        if mult >= last_mult {
            break;
        }
        let Ok(n) = tokens[i].1.parse::<u32>() else {
            break;
        };
        last_mult = mult;
        total = total.saturating_add(n.saturating_mul(mult));
        i += 2;
        // Kata sambung antar bagian ("1 hour and 5 minutes", "1 jam dan 5 menit")
        if matches!(tokens.get(i), Some((false, w)) if matches!(w.to_lowercase().as_str(), "and" | "dan")) {
            i += 1;
        }
    }
    Some(total)
}

/// Satu pembacaan per elemen UI (sejajar dengan `names`; None = bukan timer).
/// Kalau Clock menampilkan format "H:MM:SS" (teks utama timer), HANYA itu yang dipakai.
/// Teks berbentuk kata ("1 minute 59 seconds") baru dipakai bila tidak ada teks "H:MM:SS"
/// sama sekali, supaya label lain tidak ikut terbaca sebagai timer (penyebab waktu bertambah).
fn parse_each(names: &[String]) -> Vec<Option<u32>> {
    let has_hms = names.iter().any(|n| parse_hms(n).is_some());
    names
        .iter()
        .map(|n| parse_hms(n).or_else(|| if has_hms { None } else { parse_words(n) }))
        .collect()
}

fn parse_timers(names: &[String]) -> Vec<u32> {
    parse_each(names).into_iter().flatten().collect()
}

#[tauri::command]
pub async fn http_request(url: String, form: Option<String>) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("WindIsland/0.1")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let req = match form {
        Some(body) => client
            .post(&url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body),
        None => client.get(&url),
    };
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clock_dump() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(win::dump)
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    Ok(vec![])
}

/// Jeda / lanjutkan timer di aplikasi Clock.
/// - `remaining` (detik): memilih kartu timer yang tepat bila ada beberapa timer.
/// - `want_running`: status yang diinginkan. Tombol hanya ditekan bila status Clock
///   saat ini berbeda, jadi tidak pernah salah arah akibat event yang terlambat.
#[tauri::command]
pub async fn clock_timer_toggle(
    remaining: Option<u32>,
    want_running: Option<bool>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let result = tauri::async_runtime::spawn_blocking(move || {
            win::press(win::Action::Toggle, remaining, want_running)
        })
        .await
        .map_err(|e| e.to_string())?;
        return result;
    }
    #[cfg(not(windows))]
    {
        let _ = (remaining, want_running);
        Err("Hanya tersedia di Windows".to_string())
    }
}

/// Hentikan (reset) timer di aplikasi Clock.
#[tauri::command]
pub async fn clock_timer_cancel(remaining: Option<u32>) -> Result<String, String> {
    #[cfg(windows)]
    {
        let result = tauri::async_runtime::spawn_blocking(move || {
            win::press(win::Action::Stop, remaining, None)
        })
        .await
        .map_err(|e| e.to_string())?;
        return result;
    }
    #[cfg(not(windows))]
    {
        let _ = remaining;
        Err("Hanya tersedia di Windows".to_string())
    }
}

#[cfg(windows)]
pub fn start_clock_watcher(app: AppHandle) {
    std::thread::spawn(move || win::run(app));
}

#[cfg(not(windows))]
pub fn start_clock_watcher(_app: AppHandle) {}

#[cfg(windows)]
mod win {
    use super::{parse_each, parse_timers, AppHandle, ClockPayload, Emitter};
    use std::{
        mem::size_of,
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern,
        TreeScope_Descendants, UIA_InvokePatternId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, GetClassNameW, GetWindowThreadProcessId, IsIconic,
    };

    // Kata kunci nama tombol di Clock (Inggris + Indonesia)
    const PAUSE: &[&str] = &["pause", "jeda"];
    const RESUME: &[&str] = &["resume", "play", "start", "lanjut", "mulai", "putar"];
    const RESET: &[&str] = &["reset", "atur ulang", "setel ulang"];

    // Jeda polling (ms). Batas bawahnya adalah lama satu scan (lihat scan_ms di file debug).
    const POLL_VISIBLE_MS: u64 = 120;
    const POLL_HIDDEN_MS: u64 = 300;

    pub enum Action {
        Toggle,
        Stop,
    }

    struct Probe {
        pids: Vec<u32>,
        hit: bool,
    }

    // Satu elemen UI Clock
    struct Item {
        name: String,
        lname: String,
        el: IUIAutomationElement,
    }

    // Satu timer di Clock beserta tombol jeda/lanjutnya
    struct TimerInfo {
        secs: u32,
        btn: Option<usize>,      // indeks item tombol jeda/lanjut
        running: Option<bool>,   // true = tombolnya "Pause" (timer sedang jalan)
    }

    unsafe extern "system" fn collect_frames(hwnd: HWND, lp: LPARAM) -> BOOL {
        let frames = &mut *(lp.0 as *mut Vec<HWND>);
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf);
        if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "ApplicationFrameWindow" {
            frames.push(hwnd);
        }
        BOOL(1)
    }

    unsafe extern "system" fn probe_child(hwnd: HWND, lp: LPARAM) -> BOOL {
        let probe = &mut *(lp.0 as *mut Probe);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if probe.pids.contains(&pid) {
            probe.hit = true;
            return BOOL(0);
        }
        BOOL(1)
    }

    /// PID proses Clock (UWP Microsoft.WindowsAlarms -> Time.exe).
    fn clock_pids() -> Vec<u32> {
        let mut pids = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return pids;
            };
            let mut e = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    if String::from_utf16_lossy(&e.szExeFile[..len]).eq_ignore_ascii_case("Time.exe") {
                        pids.push(e.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        pids
    }

    /// Jendela ApplicationFrameWindow yang di dalamnya hidup CoreWindow milik Time.exe.
    fn clock_frame(pids: &[u32]) -> Option<HWND> {
        let mut frames: Vec<HWND> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(collect_frames), LPARAM(&mut frames as *mut _ as isize));
        }
        for f in frames {
            let mut probe = Probe { pids: pids.to_vec(), hit: false };
            unsafe {
                let _ = EnumChildWindows(f, Some(probe_child), LPARAM(&mut probe as *mut _ as isize));
            }
            if probe.hit {
                return Some(f);
            }
        }
        None
    }

    /// Semua elemen bernama di jendela Clock (urutan sesuai pohon UI).
    fn collect(uia: &IUIAutomation, frame: HWND) -> Vec<Item> {
        let mut items = Vec::new();
        unsafe {
            if let (Ok(root), Ok(cond)) = (uia.ElementFromHandle(frame), uia.CreateTrueCondition()) {
                if let Ok(all) = root.FindAll(TreeScope_Descendants, &cond) {
                    for i in 0..all.Length().unwrap_or(0) {
                        if let Ok(el) = all.GetElement(i) {
                            let name = el.CurrentName().map(|n| n.to_string()).unwrap_or_default();
                            if !name.is_empty() {
                                items.push(Item { lname: name.to_lowercase(), name, el });
                            }
                        }
                    }
                }
            }
        }
        items
    }

    /// Status jendela Clock + semua elemennya.
    fn scan(uia: &IUIAutomation) -> (&'static str, Vec<Item>) {
        let pids = clock_pids();
        if pids.is_empty() {
            return ("none", vec![]);
        }
        let Some(frame) = clock_frame(&pids) else {
            return ("none", vec![]);
        };
        if unsafe { IsIconic(frame).as_bool() } {
            return ("minimized", vec![]);
        }
        ("visible", collect(uia, frame))
    }

    fn new_uia() -> Option<IUIAutomation> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
        }
    }

    // ---- Kontrol tombol Clock ----

    // Nama mengandung salah satu kata kunci (kata utuh, agar "display" tidak cocok "play")
    fn has_word(lname: &str, words: &[&str]) -> bool {
        words.iter().any(|w| {
            if w.contains(' ') {
                lname.contains(w)
            } else {
                lname.split(|c: char| !c.is_alphabetic()).any(|t| t == *w)
            }
        })
    }

    /// (indeks item, detik) untuk tiap elemen yang terbaca sebagai timer.
    fn item_timers(items: &[Item]) -> Vec<(usize, u32)> {
        let names: Vec<String> = items.iter().map(|it| it.name.clone()).collect();
        parse_each(&names)
            .into_iter()
            .enumerate()
            .filter_map(|(i, s)| s.map(|s| (i, s)))
            .collect()
    }

    /// Daftar timer (urutan sama dengan `parse_timers`) + status jalan/jeda masing-masing.
    /// Tombol jeda/lanjut yang dipakai = yang pertama muncul setelah teks timer
    /// (kalau tidak ada, yang terakhir sebelumnya). Nama "Pause" -> sedang jalan;
    /// "Start/Resume/Play" -> dijeda.
    fn timer_infos(items: &[Item]) -> Vec<TimerInfo> {
        let timers = item_timers(items);

        let buttons: Vec<(usize, bool)> = items
            .iter()
            .enumerate()
            .filter_map(|(i, it)| {
                if has_word(&it.lname, PAUSE) {
                    Some((i, true))
                } else if has_word(&it.lname, RESUME) {
                    Some((i, false))
                } else {
                    None
                }
            })
            .collect();

        timers
            .iter()
            .map(|&(idx, secs)| {
                let pick = buttons
                    .iter()
                    .find(|&&(b, _)| b > idx)
                    .or_else(|| buttons.iter().rev().find(|&&(b, _)| b < idx));
                TimerInfo {
                    secs,
                    btn: pick.map(|&(b, _)| b),
                    running: pick.map(|&(_, r)| r),
                }
            })
            .collect()
    }

    // Urutan kandidat: yang tepat setelah kartu timer dulu, lalu yang sebelumnya
    fn candidates(items: &[Item], anchor: Option<usize>, words: &[&str]) -> Vec<usize> {
        let hits: Vec<usize> = (0..items.len())
            .filter(|&i| has_word(&items[i].lname, words))
            .collect();

        match anchor {
            Some(a) => {
                let mut v: Vec<usize> = hits.iter().copied().filter(|&i| i > a).collect();
                v.extend(hits.iter().copied().filter(|&i| i < a).rev());
                v
            }
            None => hits,
        }
    }

    // Tekan tombol (hanya elemen yang mendukung Invoke)
    fn invoke(el: &IUIAutomationElement) -> bool {
        unsafe {
            el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                .and_then(|p| p.Invoke())
                .is_ok()
        }
    }

    /// Tekan tombol jeda / reset di Clock. Mengembalikan nama tombol yang ditekan.
    pub fn press(
        action: Action,
        remaining: Option<u32>,
        want_running: Option<bool>,
    ) -> Result<String, String> {
        let uia = new_uia().ok_or("UIA init gagal")?;

        let pids = clock_pids();
        if pids.is_empty() {
            return Err("Clock tidak berjalan".to_string());
        }

        let frame = clock_frame(&pids).ok_or("Jendela Clock tidak ditemukan")?;
        let items = collect(&uia, frame);
        if items.is_empty() {
            return Err("Isi jendela Clock tidak terbaca (mungkin di-minimize)".to_string());
        }

        // Toggle: pilih timer yang tepat, tekan tombolnya hanya bila statusnya berbeda
        // dari yang diinginkan (aman dari event yang terlambat / dobel tekan).
        if let Action::Toggle = action {
            let infos = timer_infos(&items);
            let target = match remaining {
                Some(r) => infos.iter().min_by_key(|t| t.secs.abs_diff(r)),
                None => infos.first(),
            };

            if let Some(t) = target {
                if let (Some(btn), Some(running)) = (t.btn, t.running) {
                    if want_running == Some(running) {
                        return Ok("Status Clock sudah sesuai".to_string());
                    }
                    if invoke(&items[btn].el) {
                        return Ok(items[btn].name.clone());
                    }
                }
            }
        }

        // Kartu timer yang nilainya paling dekat dengan `remaining`
        let anchor = remaining.and_then(|r| {
            item_timers(&items)
                .into_iter()
                .min_by_key(|&(_, s)| s.abs_diff(r))
                .map(|(i, _)| i)
        });

        // Toggle (cadangan): jeda dulu, kalau tidak ada coba lanjutkan.
        // Stop: reset dulu, kalau tidak ada minimal jeda.
        let groups: &[&[&str]] = match action {
            Action::Toggle => &[PAUSE, RESUME],
            Action::Stop => &[RESET, PAUSE],
        };

        for words in groups {
            for i in candidates(&items, anchor, words) {
                if invoke(&items[i].el) {
                    return Ok(items[i].name.clone());
                }
            }
        }

        Err("Tombol tidak ditemukan di Clock".to_string())
    }

    /// Susun laporan debug. Nama elemen dicetak dengan `{:?}` supaya karakter
    /// tak terlihat (misalnya \u{200e}) tampak sebagai escape.
    fn report(state: &str, scan_ms: u128, items: &[Item]) -> Vec<String> {
        let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
        let infos = timer_infos(items);

        let mut out = vec![
            format!("state={state}"),
            format!("clock_pids={:?}", clock_pids()),
            format!("scan_ms={scan_ms}"),
            format!("elemen_bernama={}", names.len()),
            format!("parsed={:?}", parse_timers(&names)),
            format!(
                "running={:?}",
                infos.iter().map(|t| t.running).collect::<Vec<_>>()
            ),
            "--- nama elemen ---".to_string(),
        ];
        out.extend(names.iter().map(|n| format!("{n:?}")));
        out
    }

    /// Tulis laporan ke %TEMP%\island_clock_debug.txt
    fn write_debug_file(lines: &[String]) {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let text = format!("unix_time={secs}\n{}\n", lines.join("\n"));
        let _ = std::fs::write(std::env::temp_dir().join("island_clock_debug.txt"), text);
    }

    pub fn run(app: AppHandle) {
        let Some(uia) = new_uia() else {
            write_debug_file(&["UIA init gagal".to_string()]);
            return;
        };
        let mut last_debug: Option<Instant> = None;

        loop {
            let started = Instant::now();
            let (state, items) = scan(&uia);
            let scan_ms = started.elapsed().as_millis();

            if last_debug.map_or(true, |t| t.elapsed() >= Duration::from_secs(2)) {
                last_debug = Some(Instant::now());
                write_debug_file(&report(state, scan_ms, &items));
            }

            let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
            let timers = parse_timers(&names);
            let infos = timer_infos(&items);

            // Kirim `running` hanya bila status SEMUA timer terbaca
            let running = if infos.iter().all(|t| t.running.is_some()) {
                Some(infos.iter().map(|t| t.running.unwrap_or(false)).collect())
            } else {
                None
            };

            let _ = app.emit(
                "clock-timer-update",
                ClockPayload { state, timers, running },
            );

            thread::sleep(Duration::from_millis(if state == "visible" {
                POLL_VISIBLE_MS
            } else {
                POLL_HIDDEN_MS
            }));
        }
    }

    pub fn dump() -> Vec<String> {
        let Some(uia) = new_uia() else {
            return vec!["UIA init gagal".into()];
        };
        let started = Instant::now();
        let (state, items) = scan(&uia);
        let scan_ms = started.elapsed().as_millis();
        report(state, scan_ms, &items)
    }
}