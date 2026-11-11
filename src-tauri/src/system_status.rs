// File: system_status.rs
// Kegunaan: status native laptop untuk menu island.
// Isi: baterai, kecepatan jaringan, Wi-Fi, Bluetooth, mode pesawat, mode daya.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice};
use windows::Devices::Enumeration::DeviceInformation;
use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
use windows::core::GUID;
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Baterai + kecepatan jaringan (dipanggil tiap detik saat menu terbuka)
// ---------------------------------------------------------------------------

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatteryInfo {
    present: bool,
    percent: u8,
    charging: bool,
    plugged: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetSpeed {
    // byte per detik
    down: f64,
    up: f64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStatus {
    battery: BatteryInfo,
    net: NetSpeed,
}

fn read_battery() -> BatteryInfo {
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) }.is_err() {
        return BatteryInfo::default();
    }

    // BatteryFlag: 128 = tidak ada baterai, 255 = tidak diketahui, 8 = sedang mengisi
    let present = s.BatteryFlag != 255 && s.BatteryFlag & 128 == 0 && s.BatteryLifePercent <= 100;

    BatteryInfo {
        present,
        percent: s.BatteryLifePercent.min(100),
        charging: present && s.BatteryFlag & 8 != 0,
        plugged: s.ACLineStatus == 1,
    }
}

// total byte masuk / keluar dari adaptor Ethernet + Wi-Fi yang aktif
fn read_net_octets() -> (u64, u64) {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    let (mut rx, mut tx) = (0u64, 0u64);

    unsafe {
        if GetIfTable2(&mut table).0 != 0 || table.is_null() {
            return (0, 0);
        }

        let count = (*table).NumEntries as usize;
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), count);

        for row in rows {
            // 6 = Ethernet, 71 = Wi-Fi, status 1 = aktif
            if (row.Type != 6 && row.Type != 71) || row.OperStatus.0 != 1 {
                continue;
            }

            // adaptor virtual dilewati agar lalu lintas tidak terhitung dua kali
            let len = row
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(row.Description.len());
            let desc = String::from_utf16_lossy(&row.Description[..len]).to_lowercase();
            let skip = [
                "virtual", "vmware", "hyper-v", "loopback", "vpn", "tap-", "tunnel", "pseudo",
                "bluetooth",
            ];
            if skip.iter().any(|k| desc.contains(k)) {
                continue;
            }

            rx = rx.saturating_add(row.InOctets);
            tx = tx.saturating_add(row.OutOctets);
        }

        FreeMibTable(table as *const std::ffi::c_void);
    }

    (rx, tx)
}

static LAST_NET: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

fn net_speed() -> NetSpeed {
    let (rx, tx) = read_net_octets();
    let now = Instant::now();
    let mut last = LAST_NET.lock().unwrap_or_else(|e| e.into_inner());

    let speed = match *last {
        Some((t, prx, ptx)) => {
            let dt = now.duration_since(t).as_secs_f64();
            // jeda terlalu lama (menu lama tertutup) -> mulai ulang
            if dt > 5.0 {
                NetSpeed::default()
            } else {
                let dt = dt.max(0.001);
                NetSpeed {
                    down: rx.saturating_sub(prx) as f64 / dt,
                    up: tx.saturating_sub(ptx) as f64 / dt,
                }
            }
        }
        None => NetSpeed::default(),
    };

    *last = Some((now, rx, tx));
    speed
}

#[tauri::command]
pub fn system_status() -> SystemStatus {
    SystemStatus {
        battery: read_battery(),
        net: net_speed(),
    }
}

// hanya baterai (ringan), dipakai pemantau charger
#[tauri::command]
pub fn power_status() -> BatteryInfo {
    read_battery()
}

// ---------------------------------------------------------------------------
// Radio: Wi-Fi, Bluetooth, mode pesawat
// ---------------------------------------------------------------------------

fn radios() -> Result<Vec<Radio>, String> {
    let list = Radio::GetRadiosAsync()
        .map_err(err)?
        .get()
        .map_err(err)?;
    let count = list.Size().map_err(err)?;

    let mut out = Vec::new();
    for i in 0..count {
        if let Ok(r) = list.GetAt(i) {
            out.push(r);
        }
    }
    Ok(out)
}

fn radio_on(r: &Radio) -> bool {
    r.State().map(|s| s == RadioState::On).unwrap_or(false)
}

fn radio_kind(r: &Radio) -> RadioKind {
    r.Kind().unwrap_or(RadioKind::Other)
}

fn set_radio(r: &Radio, on: bool) -> Result<(), String> {
    let state = if on { RadioState::On } else { RadioState::Off };
    let status = r
        .SetStateAsync(state)
        .map_err(err)?
        .get()
        .map_err(err)?;

    if status == RadioAccessStatus::Allowed {
        Ok(())
    } else {
        Err(format!("Windows menolak mengubah radio (kode {})", status.0))
    }
}

fn request_access() {
    // izin mengubah radio; hasilnya diabaikan, kegagalan muncul saat SetState
    let _ = Radio::RequestAccessAsync().and_then(|op| op.get());
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BtDevice {
    id: String,
    name: String,
    connected: bool,
}

// perangkat Bluetooth yang sudah dipasangkan + status sambungan
fn bt_devices() -> Result<Vec<BtDevice>, String> {
    let selector = BluetoothDevice::GetDeviceSelectorFromPairingState(true).map_err(err)?;
    let found = DeviceInformation::FindAllAsyncAqsFilter(&selector)
        .map_err(err)?
        .get()
        .map_err(err)?;
    let count = found.Size().map_err(err)?;

    let mut out = Vec::new();
    for i in 0..count {
        let Ok(info) = found.GetAt(i) else { continue };

        let name = info.Name().map(|n| n.to_string()).unwrap_or_default();
        if name.trim().is_empty() {
            continue;
        }
        let Ok(id) = info.Id() else { continue };

        let connected = BluetoothDevice::FromIdAsync(&id)
            .and_then(|op| op.get())
            .and_then(|d| d.ConnectionStatus())
            .map(|s| s == BluetoothConnectionStatus::Connected)
            .unwrap_or(false);

        out.push(BtDevice {
            id: id.to_string(),
            name,
            connected,
        });
    }

    out.sort_by(|a, b| b.connected.cmp(&a.connected).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RadiosStatus {
    wifi_present: bool,
    wifi_on: bool,
    ssid: Option<String>,
    bluetooth_present: bool,
    bluetooth_on: bool,
    bluetooth_connected: Vec<String>,
    airplane: bool,
}

fn read_radios() -> RadiosStatus {
    let list = radios().unwrap_or_default();

    let mut st = RadiosStatus::default();
    let mut any = false;
    let mut any_on = false;

    for r in &list {
        let kind = radio_kind(r);
        let on = radio_on(r);

        if kind == RadioKind::WiFi {
            st.wifi_present = true;
            st.wifi_on |= on;
        } else if kind == RadioKind::Bluetooth {
            st.bluetooth_present = true;
            st.bluetooth_on |= on;
        } else if kind != RadioKind::MobileBroadband {
            continue;
        }

        any = true;
        any_on |= on;
    }

    // mode pesawat = ada radio, tetapi semuanya mati
    st.airplane = any && !any_on;

    if st.wifi_on {
        st.ssid = wifi_current();
    }
    if st.bluetooth_on {
        st.bluetooth_connected = bt_devices()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d.connected)
            .map(|d| d.name)
            .collect();
    }

    st
}

#[tauri::command]
pub async fn system_radios() -> Result<RadiosStatus, String> {
    tauri::async_runtime::spawn_blocking(read_radios)
        .await
        .map_err(err)
}

// "wifi" atau "bluetooth"
#[tauri::command]
pub async fn system_radio_set(kind: String, on: bool) -> Result<(), String> {
    let target = match kind.as_str() {
        "wifi" => RadioKind::WiFi,
        "bluetooth" => RadioKind::Bluetooth,
        _ => return Err(format!("Jenis radio tidak dikenal: {kind}")),
    };

    tauri::async_runtime::spawn_blocking(move || {
        request_access();

        let mut found = false;
        let mut last_err = None;
        for r in radios()? {
            if radio_kind(&r) == target {
                found = true;
                if let Err(e) = set_radio(&r, on) {
                    last_err = Some(e);
                }
            }
        }

        if !found {
            return Err("Perangkat radio tidak ditemukan".to_string());
        }
        last_err.map_or(Ok(()), Err)
    })
    .await
    .map_err(err)?
}

// radio yang menyala sebelum mode pesawat dinyalakan: (wifi, bluetooth, seluler)
static BEFORE_AIRPLANE: Mutex<(bool, bool, bool)> = Mutex::new((true, true, false));

#[tauri::command]
pub async fn system_airplane_set(on: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        request_access();
        let list = radios()?;
        let mut last_err = None;

        if on {
            // ingat radio yang sedang menyala, lalu matikan semua
            let mut before = (false, false, false);
            for r in &list {
                let kind = radio_kind(r);
                let is_on = radio_on(r);
                if kind == RadioKind::WiFi {
                    before.0 |= is_on;
                } else if kind == RadioKind::Bluetooth {
                    before.1 |= is_on;
                } else if kind == RadioKind::MobileBroadband {
                    before.2 |= is_on;
                } else {
                    continue;
                }
            }
            if before.0 || before.1 || before.2 {
                *BEFORE_AIRPLANE.lock().unwrap_or_else(|e| e.into_inner()) = before;
            }

            for r in &list {
                let kind = radio_kind(r);
                if kind == RadioKind::WiFi
                    || kind == RadioKind::Bluetooth
                    || kind == RadioKind::MobileBroadband
                {
                    if let Err(e) = set_radio(r, false) {
                        last_err = Some(e);
                    }
                }
            }
        } else {
            let (mut w, mut b, m) = *BEFORE_AIRPLANE.lock().unwrap_or_else(|e| e.into_inner());
            if !(w || b || m) {
                w = true;
                b = true;
            }

            for r in &list {
                let kind = radio_kind(r);
                let want = if kind == RadioKind::WiFi {
                    w
                } else if kind == RadioKind::Bluetooth {
                    b
                } else if kind == RadioKind::MobileBroadband {
                    m
                } else {
                    continue;
                };
                if want {
                    if let Err(e) = set_radio(r, true) {
                        last_err = Some(e);
                    }
                }
            }
        }

        last_err.map_or(Ok(()), Err)
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------------------
// Mode daya (Settings > System > Power > Power mode)
// ---------------------------------------------------------------------------
//
// Windows 10 1709+ / Windows 11 menyimpan "power mode" sebagai overlay scheme di
// powrprof.dll. Fungsinya tidak ada di import library SDK, jadi dimuat saat
// dijalankan lewat LoadLibrary + GetProcAddress (tanpa fitur windows-rs tambahan).
// Hasilnya sama dengan slider Power mode di Pengaturan Windows dan tidak butuh admin.

// Hemat daya (Best power efficiency / Better battery)
const OVERLAY_SAVER: GUID = GUID::from_u128(0x961cc777_2547_4f9d_8174_7d86181b8a7a);
// Seimbang (tanpa overlay)
const OVERLAY_BALANCED: GUID = GUID::from_u128(0);
// Performa lebih baik (Windows 10 "Better performance"), dianggap performa tinggi
const OVERLAY_BETTER: GUID = GUID::from_u128(0x3af9b8d9_7c97_431d_ad78_34a8bfea439f);
// Performa terbaik (Best performance)
const OVERLAY_PERFORMANCE: GUID = GUID::from_u128(0xded574b5_45a0_4f42_8737_46345c09c238);

#[link(name = "kernel32")]
unsafe extern "system" {
    fn LoadLibraryW(name: *const u16) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
}

type GetOverlayFn = unsafe extern "system" fn(*mut GUID) -> u32;
type SetOverlayFn = unsafe extern "system" fn(GUID) -> u32;

struct OverlayApi {
    get: GetOverlayFn,
    set: SetOverlayFn,
}

// dimuat sekali; None bila Windows ini tidak punya fungsi overlay
fn overlay_api() -> Option<&'static OverlayApi> {
    static API: OnceLock<Option<OverlayApi>> = OnceLock::new();

    API.get_or_init(|| unsafe {
        let lib_name: Vec<u16> = "powrprof.dll\0".encode_utf16().collect();
        let lib = LoadLibraryW(lib_name.as_ptr());
        if lib.is_null() {
            return None;
        }

        let get = GetProcAddress(lib, c"PowerGetActualOverlayScheme".as_ptr() as *const u8);
        let set = GetProcAddress(lib, c"PowerSetActiveOverlayScheme".as_ptr() as *const u8);
        if get.is_null() || set.is_null() {
            return None;
        }

        Some(OverlayApi {
            get: std::mem::transmute::<*mut c_void, GetOverlayFn>(get),
            set: std::mem::transmute::<*mut c_void, SetOverlayFn>(set),
        })
    })
    .as_ref()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerModeInfo {
    supported: bool,
    // "saver" | "balanced" | "performance"
    mode: String,
}

fn mode_from_guid(g: &GUID) -> &'static str {
    if *g == OVERLAY_SAVER {
        "saver"
    } else if *g == OVERLAY_PERFORMANCE || *g == OVERLAY_BETTER {
        "performance"
    } else {
        // seimbang, atau overlay milik pabrikan yang tidak dikenal
        "balanced"
    }
}

fn read_power_mode() -> Result<&'static str, String> {
    let api = overlay_api().ok_or_else(|| "Mode daya tidak didukung Windows ini".to_string())?;

    let mut g = GUID::from_u128(0);
    let code = unsafe { (api.get)(&mut g) };
    if code != 0 {
        return Err(format!("PowerGetActualOverlayScheme gagal (kode {code})"));
    }

    Ok(mode_from_guid(&g))
}

#[tauri::command]
pub async fn power_mode_get() -> PowerModeInfo {
    tauri::async_runtime::spawn_blocking(|| match read_power_mode() {
        Ok(mode) => PowerModeInfo {
            supported: true,
            mode: mode.to_string(),
        },
        Err(_) => PowerModeInfo {
            supported: false,
            mode: "balanced".to_string(),
        },
    })
    .await
    .unwrap_or_else(|_| PowerModeInfo {
        supported: false,
        mode: "balanced".to_string(),
    })
}

// "saver" | "balanced" | "performance"
#[tauri::command]
pub async fn power_mode_set(mode: String) -> Result<(), String> {
    let target = match mode.as_str() {
        "saver" => OVERLAY_SAVER,
        "balanced" => OVERLAY_BALANCED,
        "performance" => OVERLAY_PERFORMANCE,
        _ => return Err(format!("Mode daya tidak dikenal: {mode}")),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let api =
            overlay_api().ok_or_else(|| "Mode daya tidak didukung Windows ini".to_string())?;

        let code = unsafe { (api.set)(target) };
        if code == 0 {
            Ok(())
        } else {
            Err(format!("PowerSetActiveOverlayScheme gagal (kode {code})"))
        }
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------------------
// Wi-Fi (netsh, keluaran UTF-8)
// ---------------------------------------------------------------------------

fn netsh_text(args: &str) -> String {
    let out = Command::new("cmd")
        .raw_arg(format!("/C chcp 65001 >nul & netsh {args}"))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .output();

    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

// nama Wi-Fi yang sedang tersambung
fn wifi_current() -> Option<String> {
    let text = netsh_text("wlan show interfaces");

    for line in text.lines() {
        // "BSSID" tidak ikut cocok karena diawali huruf B
        if let Some(rest) = line.trim().strip_prefix("SSID") {
            if let Some(value) = rest.trim_start().strip_prefix(':') {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

// baris "SSID 1 : nama" lalu baris sinyal "xx%" di bawahnya
fn parse_networks(text: &str) -> Vec<(String, u8)> {
    let mut out: Vec<(String, u8)> = Vec::new();

    for line in text.lines() {
        let l = line.trim();

        if let Some(rest) = l.strip_prefix("SSID") {
            let rest = rest.trim_start();
            if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                if let Some((_, name)) = rest.split_once(':') {
                    out.push((name.trim().to_string(), 0));
                }
                continue;
            }
        }

        if let Some((_, value)) = l.split_once(':') {
            if let Some(num) = value.trim().strip_suffix('%') {
                if let (Some(last), Ok(n)) = (out.last_mut(), num.trim().parse::<u8>()) {
                    if n > last.1 {
                        last.1 = n;
                    }
                }
            }
        }
    }

    out
}

// nama profil Wi-Fi yang tersimpan di laptop
fn parse_profiles(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let (key, value) = l.split_once(':')?;
            let value = value.trim();
            if key.trim().is_empty() || value.is_empty() || value.starts_with('<') {
                None
            } else {
                Some(value.to_string())
            }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiNetwork {
    ssid: String,
    signal: u8,
    saved: bool,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WifiList {
    connected: Option<String>,
    networks: Vec<WifiNetwork>,
}

#[tauri::command]
pub async fn wifi_list() -> Result<WifiList, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let connected = wifi_current();
        let found = parse_networks(&netsh_text("wlan show networks mode=bssid"));
        let saved = parse_profiles(&netsh_text("wlan show profiles"));

        // gabungkan nama kembar, ambil sinyal terkuat
        let mut merged: Vec<(String, u8)> = Vec::new();
        for (ssid, signal) in found {
            if ssid.is_empty() {
                continue;
            }
            match merged.iter_mut().find(|(s, _)| *s == ssid) {
                Some(entry) => entry.1 = entry.1.max(signal),
                None => merged.push((ssid, signal)),
            }
        }

        let mut networks: Vec<WifiNetwork> = merged
            .into_iter()
            .map(|(ssid, signal)| WifiNetwork {
                saved: saved.iter().any(|p| *p == ssid),
                connected: connected.as_deref() == Some(ssid.as_str()),
                ssid,
                signal,
            })
            .collect();

        networks.sort_by(|a, b| {
            b.connected
                .cmp(&a.connected)
                .then(b.signal.cmp(&a.signal))
                .then(a.ssid.cmp(&b.ssid))
        });

        WifiList {
            connected,
            networks,
        }
    })
    .await
    .map_err(err)
}

// hanya untuk jaringan yang profilnya sudah tersimpan
#[tauri::command]
pub async fn wifi_connect(ssid: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("netsh")
            .args(["wlan", "connect"])
            .arg(format!("name={ssid}"))
            .arg(format!("ssid={ssid}"))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .output()
            .map_err(err)?;

        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn wifi_disconnect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        Command::new("netsh")
            .args(["wlan", "disconnect"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .output()
            .map(|_| ())
            .map_err(err)
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------------------
// Bluetooth + halaman pengaturan Windows
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn bluetooth_list() -> Result<Vec<BtDevice>, String> {
    tauri::async_runtime::spawn_blocking(bt_devices)
        .await
        .map_err(err)?
}

// "wifi" = daftar jaringan Windows, "bluetooth" = pengaturan Bluetooth
#[tauri::command]
pub fn system_open_page(page: String) -> Result<(), String> {
    let uri = match page.as_str() {
        "wifi" => "ms-availablenetworks:",
        "bluetooth" => "ms-settings:bluetooth",
        _ => return Err(format!("Halaman tidak dikenal: {page}")),
    };

    Command::new("cmd")
        .raw_arg(format!("/C start \"\" {uri}"))
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(err)
}