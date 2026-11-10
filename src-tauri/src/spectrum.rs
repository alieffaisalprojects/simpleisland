//! spectrum.rs
//! Spektrum audio asli untuk widget Spotify.
//!
//! - Menangkap suara yang sedang diputar di perangkat output default (WASAPI loopback).
//! - Menghitung 5 pita frekuensi (FFT) dan mengirimnya ke frontend lewat event
//!   `audio-spectrum` (array 5 angka 0.0 - 1.0, sekitar 30 kali per detik).
//! - Hanya menangkap saat frontend meminta (`spectrum_set_active(true)`), jadi tidak
//!   memakai CPU ketika widget tidak membutuhkannya.
//!
//! Catatan: loopback menangkap SEMUA suara sistem, bukan hanya Spotify.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

// Frontend sedang membutuhkan data spektrum.
static ACTIVE: AtomicBool = AtomicBool::new(false);

// Nyalakan / matikan pengambilan spektrum.
#[tauri::command]
pub fn spectrum_set_active(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
}

// Jalankan thread penangkap audio (hanya Windows).
pub fn start(app: AppHandle) {
    #[cfg(windows)]
    std::thread::spawn(move || win::run(app));

    #[cfg(not(windows))]
    let _ = app;
}

// ---------------------------------------------------------------------------
// Analisis frekuensi (tanpa ketergantungan platform)
// ---------------------------------------------------------------------------

mod dsp {
    use std::f32::consts::PI;

    pub const FFT_N: usize = 1024;
    pub const BANDS: usize = 5;

    // Batas pita (Hz): bass, low-mid, mid, high-mid, treble.
    const EDGES_HZ: [f32; BANDS + 1] = [40.0, 150.0, 500.0, 1500.0, 4500.0, 12000.0];

    // Musik punya energi lebih kecil di frekuensi tinggi; naikkan sedikit agar seimbang.
    const TILT_DB: [f32; BANDS] = [0.0, 3.0, 6.0, 9.0, 12.0];

    // Rentang yang ditampilkan di bawah puncak terbaru (dB).
    const RANGE_DB: f32 = 34.0;

    // Acuan puncak tidak turun di bawah ini (supaya derau tidak ikut membesar).
    const REF_FLOOR_DB: f32 = -48.0;

    // Di bawah ini dianggap hening.
    const SILENCE_DB: f32 = -75.0;

    // Turunnya acuan puncak per pembacaan (~30 kali/detik -> sekitar 4,5 dB/detik).
    const REF_DECAY_DB: f32 = 0.15;

    pub struct Analyzer {
        sample_rate: f32,
        ring: Vec<f32>,
        pos: usize,
        window: Vec<f32>,
        re: Vec<f32>,
        im: Vec<f32>,
        rev: Vec<usize>,
        cos_t: Vec<f32>,
        sin_t: Vec<f32>,
        ref_db: f32,
    }

    impl Analyzer {
        pub fn new(sample_rate: f32) -> Self {
            let bits = FFT_N.trailing_zeros();
            let rev = (0..FFT_N)
                .map(|i| i.reverse_bits() >> (usize::BITS - bits))
                .collect();

            Self {
                sample_rate: sample_rate.max(8000.0),
                ring: vec![0.0; FFT_N],
                pos: 0,
                window: (0..FFT_N)
                    .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / FFT_N as f32).cos())
                    .collect(),
                re: vec![0.0; FFT_N],
                im: vec![0.0; FFT_N],
                rev,
                cos_t: (0..FFT_N / 2)
                    .map(|k| (2.0 * PI * k as f32 / FFT_N as f32).cos())
                    .collect(),
                sin_t: (0..FFT_N / 2)
                    .map(|k| -(2.0 * PI * k as f32 / FFT_N as f32).sin())
                    .collect(),
                ref_db: REF_FLOOR_DB,
            }
        }

        // Masukkan satu sampel mono.
        pub fn push(&mut self, sample: f32) {
            self.ring[self.pos] = if sample.is_finite() { sample } else { 0.0 };
            self.pos = (self.pos + 1) % FFT_N;
        }

        // FFT radix-2 di tempat pada self.re / self.im.
        fn fft(&mut self) {
            for i in 0..FFT_N {
                let j = self.rev[i];
                if j > i {
                    self.re.swap(i, j);
                    self.im.swap(i, j);
                }
            }

            let mut len = 2;
            while len <= FFT_N {
                let half = len / 2;
                let step = FFT_N / len;

                for start in (0..FFT_N).step_by(len) {
                    for k in 0..half {
                        let (wr, wi) = (self.cos_t[k * step], self.sin_t[k * step]);
                        let (a, b) = (start + k, start + k + half);
                        let tr = self.re[b] * wr - self.im[b] * wi;
                        let ti = self.re[b] * wi + self.im[b] * wr;
                        self.re[b] = self.re[a] - tr;
                        self.im[b] = self.im[a] - ti;
                        self.re[a] += tr;
                        self.im[a] += ti;
                    }
                }

                len *= 2;
            }
        }

        // Hitung tinggi 5 pita (0.0 - 1.0) dari sampel terbaru.
        pub fn levels(&mut self) -> [f32; BANDS] {
            for i in 0..FFT_N {
                self.re[i] = self.ring[(self.pos + i) % FFT_N] * self.window[i];
                self.im[i] = 0.0;
            }
            self.fft();

            let bin_hz = self.sample_rate / FFT_N as f32;
            let mut db = [f32::NEG_INFINITY; BANDS];

            for b in 0..BANDS {
                let lo = ((EDGES_HZ[b] / bin_hz).ceil() as usize).max(1);
                let hi = ((EDGES_HZ[b + 1] / bin_hz).floor() as usize)
                    .min(FFT_N / 2 - 1)
                    .max(lo);

                // Amplitudo puncak pita (jendela Hann: penguatan koheren 0,5).
                let mut peak = 0.0f32;
                for k in lo..=hi {
                    let mag = (self.re[k] * self.re[k] + self.im[k] * self.im[k]).sqrt();
                    peak = peak.max(4.0 * mag / FFT_N as f32);
                }

                db[b] = 20.0 * peak.max(1e-9).log10() + TILT_DB[b];
            }

            let frame_max = db.iter().cloned().fold(f32::NEG_INFINITY, f32::max);

            // Hening: semua nol, acuan puncak dibiarkan.
            if frame_max < SILENCE_DB {
                return [0.0; BANDS];
            }

            // Acuan puncak naik seketika, turun pelan. Dengan begitu tinggi bar
            // mengikuti dinamika lagu, bukan seberapa keras volume diputar.
            self.ref_db = frame_max
                .max(self.ref_db - REF_DECAY_DB)
                .max(REF_FLOOR_DB);

            let floor = self.ref_db - RANGE_DB;
            let mut out = [0.0f32; BANDS];
            for b in 0..BANDS {
                let v = ((db[b] - floor) / RANGE_DB).clamp(0.0, 1.0);
                out[b] = v.powf(1.4);
            }
            out
        }
    }
}

// ---------------------------------------------------------------------------
// Penangkap audio Windows (WASAPI loopback)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod win {
    use super::dsp::{Analyzer, BANDS};
    use super::ACTIVE;
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const BUFFERFLAGS_SILENT: u32 = 0x2;

    // Interval pengiriman ke frontend (~30 kali per detik).
    const EMIT_EVERY_MS: u64 = 33;

    // Tanpa paket audio selama ini = tidak ada suara (loopback tidak mengirim apa-apa saat hening).
    const NO_DATA_MS: u64 = 150;

    struct Capture {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        channels: usize,
        float: bool,
        sample_rate: f32,
    }

    // Buka loopback pada perangkat output default.
    unsafe fn open() -> Result<Capture, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| e.to_string())?;

        let client: IAudioClient = device
            .Activate::<IAudioClient>(CLSCTX_ALL, None)
            .map_err(|e| e.to_string())?;

        let fmt = client.GetMixFormat().map_err(|e| e.to_string())?;

        // Struct WAVEFORMATEX bersifat packed: baca field dengan read_unaligned.
        let tag = std::ptr::addr_of!((*fmt).wFormatTag).read_unaligned();
        let channels = std::ptr::addr_of!((*fmt).nChannels).read_unaligned() as usize;
        let rate = std::ptr::addr_of!((*fmt).nSamplesPerSec).read_unaligned();
        let bits = std::ptr::addr_of!((*fmt).wBitsPerSample).read_unaligned();

        let float = tag == WAVE_FORMAT_IEEE_FLOAT || (tag == WAVE_FORMAT_EXTENSIBLE && bits == 32);

        let init = client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            2_000_000, // buffer 200 ms (satuan 100 ns)
            0,
            fmt,
            None,
        );

        CoTaskMemFree(Some(fmt as *const c_void));
        init.map_err(|e| e.to_string())?;

        if channels == 0 || !(float || bits == 16) {
            return Err("Format audio tidak didukung".to_string());
        }

        let capture: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
        client.Start().map_err(|e| e.to_string())?;

        Ok(Capture {
            client,
            capture,
            channels,
            float,
            sample_rate: rate as f32,
        })
    }

    // Ambil semua paket yang tersedia dan masukkan ke analyzer (sampel mono).
    // Mengembalikan (ada paket, perangkat bermasalah).
    unsafe fn drain(cap: &Capture, analyzer: &mut Analyzer) -> (bool, bool) {
        let mut got = false;

        loop {
            let size = match cap.capture.GetNextPacketSize() {
                Ok(n) => n,
                Err(_) => return (got, true),
            };

            if size == 0 {
                return (got, false);
            }

            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;

            if cap
                .capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .is_err()
            {
                return (got, true);
            }

            let ch = cap.channels;

            for f in 0..frames as usize {
                let mut sum = 0.0f32;

                if flags & BUFFERFLAGS_SILENT == 0 && !data.is_null() {
                    for c in 0..ch {
                        let idx = f * ch + c;
                        sum += if cap.float {
                            std::ptr::read_unaligned((data as *const f32).add(idx))
                        } else {
                            std::ptr::read_unaligned((data as *const i16).add(idx)) as f32
                                / 32768.0
                        };
                    }
                }

                analyzer.push(sum / ch as f32);
            }

            let _ = cap.capture.ReleaseBuffer(frames);
            got = true;
        }
    }

    pub fn run(app: AppHandle) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }

        loop {
            // Tidak diminta frontend: jangan menangkap apa pun.
            if !ACTIVE.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }

            let cap = match unsafe { open() } {
                Ok(c) => c,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(1000));
                    continue;
                }
            };

            let mut analyzer = Analyzer::new(cap.sample_rate);
            let mut last_emit = Instant::now();
            let mut last_data = Instant::now();
            let mut broken = false;

            while ACTIVE.load(Ordering::Relaxed) && !broken {
                std::thread::sleep(Duration::from_millis(8));

                let (got, bad) = unsafe { drain(&cap, &mut analyzer) };
                broken = bad;

                if got {
                    last_data = Instant::now();
                }

                if last_emit.elapsed() >= Duration::from_millis(EMIT_EVERY_MS) {
                    last_emit = Instant::now();

                    let levels: [f32; BANDS] =
                        if last_data.elapsed() > Duration::from_millis(NO_DATA_MS) {
                            [0.0; BANDS]
                        } else {
                            analyzer.levels()
                        };

                    let _ = app.emit("audio-spectrum", levels);
                }
            }

            unsafe {
                let _ = cap.client.Stop();
            }

            // Perangkat berubah / dicabut: tunggu sebentar lalu buka lagi.
            if broken {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}