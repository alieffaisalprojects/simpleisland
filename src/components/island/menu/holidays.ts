// holidays.ts
// data hari libur nasional, cuti bersama, dan hari peringatan indonesia
// libur + cuti bersama: SKB 3 Menteri (tambah data tahun baru di bawah tiap tahun)

export type DayKind = "libur" | "cuti" | "peringatan";

export interface DayInfo {
  kind: DayKind;
  name: string;
}

// [bulan-tanggal, jenis, nama]
type Row = [string, DayKind, string];

// libur nasional dan cuti bersama per tahun
const BY_YEAR: Record<number, Row[]> = {
  2026: [
    ["01-01", "libur", "Tahun Baru Masehi"],
    ["01-16", "libur", "Isra Mi'raj Nabi Muhammad SAW"],
    ["02-16", "cuti", "Cuti Bersama Imlek"],
    ["02-17", "libur", "Tahun Baru Imlek 2577"],
    ["03-18", "cuti", "Cuti Bersama Nyepi"],
    ["03-19", "libur", "Hari Suci Nyepi (Saka 1948)"],
    ["03-20", "cuti", "Cuti Bersama Idulfitri"],
    ["03-21", "libur", "Idulfitri 1447 H"],
    ["03-22", "libur", "Idulfitri 1447 H"],
    ["03-23", "cuti", "Cuti Bersama Idulfitri"],
    ["03-24", "cuti", "Cuti Bersama Idulfitri"],
    ["04-03", "libur", "Wafat Yesus Kristus"],
    ["04-05", "libur", "Paskah"],
    ["05-01", "libur", "Hari Buruh Internasional"],
    ["05-14", "libur", "Kenaikan Yesus Kristus"],
    ["05-15", "cuti", "Cuti Bersama Kenaikan Yesus Kristus"],
    ["05-27", "libur", "Iduladha 1447 H"],
    ["05-28", "cuti", "Cuti Bersama Iduladha"],
    ["05-31", "libur", "Hari Raya Waisak 2570"],
    ["06-01", "libur", "Hari Lahir Pancasila"],
    ["06-16", "libur", "Tahun Baru Islam 1448 H"],
    ["08-17", "libur", "HUT Kemerdekaan RI"],
    ["08-25", "libur", "Maulid Nabi Muhammad SAW"],
    ["12-24", "cuti", "Cuti Bersama Natal"],
    ["12-25", "libur", "Hari Raya Natal"],
  ],
  2027: [
    ["01-01", "libur", "Tahun Baru Masehi"],
    ["01-05", "libur", "Isra Mi'raj Nabi Muhammad SAW"],
    ["02-05", "cuti", "Cuti Bersama Imlek"],
    ["02-06", "libur", "Tahun Baru Imlek 2578"],
    ["03-08", "libur", "Hari Suci Nyepi (Saka 1949)"],
    ["03-09", "cuti", "Cuti Bersama Idulfitri"],
    ["03-10", "libur", "Idulfitri 1448 H"],
    ["03-11", "libur", "Idulfitri 1448 H"],
    ["03-12", "cuti", "Cuti Bersama Idulfitri"],
    ["03-15", "cuti", "Cuti Bersama Idulfitri"],
    ["03-25", "cuti", "Cuti Bersama Wafat Yesus Kristus"],
    ["03-26", "libur", "Wafat Yesus Kristus"],
    ["03-28", "libur", "Paskah"],
    ["05-01", "libur", "Hari Buruh Internasional"],
    ["05-06", "libur", "Kenaikan Yesus Kristus"],
    ["05-17", "libur", "Iduladha 1448 H"],
    ["05-18", "cuti", "Cuti Bersama Iduladha"],
    ["05-19", "cuti", "Cuti Bersama Waisak"],
    ["05-20", "libur", "Hari Raya Waisak 2571"],
    ["06-01", "libur", "Hari Lahir Pancasila"],
    ["06-06", "libur", "Tahun Baru Islam 1449 H"],
    ["08-15", "libur", "Maulid Nabi Muhammad SAW"],
    ["08-17", "libur", "HUT Kemerdekaan RI"],
    ["12-24", "cuti", "Cuti Bersama Natal"],
    ["12-25", "libur", "Hari Raya Natal"],
    ["12-26", "libur", "Isra Mi'raj Nabi Muhammad SAW"],
  ],
};

// hari peringatan nasional (tanggal tetap tiap tahun, bukan libur)
const PERINGATAN: [string, string][] = [
  ["02-09", "Hari Pers Nasional"],
  ["03-09", "Hari Musik Nasional"],
  ["04-21", "Hari Kartini"],
  ["05-02", "Hari Pendidikan Nasional"],
  ["05-20", "Hari Kebangkitan Nasional"],
  ["07-23", "Hari Anak Nasional"],
  ["08-14", "Hari Pramuka"],
  ["09-09", "Hari Olahraga Nasional"],
  ["10-01", "Hari Kesaktian Pancasila"],
  ["10-02", "Hari Batik Nasional"],
  ["10-05", "Hari TNI"],
  ["10-22", "Hari Santri"],
  ["10-28", "Hari Sumpah Pemuda"],
  ["11-10", "Hari Pahlawan"],
  ["11-12", "Hari Kesehatan Nasional"],
  ["11-25", "Hari Guru Nasional"],
  ["12-19", "Hari Bela Negara"],
  ["12-22", "Hari Ibu"],
];

const ORDER: Record<DayKind, number> = { libur: 0, cuti: 1, peringatan: 2 };
const pad = (n: number) => String(n).padStart(2, "0");

// bulan memakai 0-11 seperti Date
const key = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

// semua hari khusus per tanggal
const TABLE = new Map<string, DayInfo[]>();

function add(k: string, info: DayInfo) {
  const list = TABLE.get(k);
  if (list) list.push(info);
  else TABLE.set(k, [info]);
}

for (const [year, rows] of Object.entries(BY_YEAR)) {
  for (const [md, kind, name] of rows) add(`${year}-${md}`, { kind, name });
}

// peringatan dipasang untuk setiap tahun yang dibuka
function peringatanOf(m: number, d: number): DayInfo[] {
  const md = `${pad(m + 1)}-${pad(d)}`;
  return PERINGATAN.filter(([k]) => k === md).map(([, name]) => ({
    kind: "peringatan" as const,
    name,
  }));
}

// info hari tertentu (libur dulu, lalu cuti, lalu peringatan)
export function getDayInfos(y: number, m: number, d: number): DayInfo[] {
  return [...(TABLE.get(key(y, m, d)) ?? []), ...peringatanOf(m, d)].sort(
    (a, b) => ORDER[a.kind] - ORDER[b.kind],
  );
}

// semua hari khusus dalam satu bulan
export function monthEvents(
  y: number,
  m: number,
): { day: number; info: DayInfo }[] {
  const total = new Date(y, m + 1, 0).getDate();
  const out: { day: number; info: DayInfo }[] = [];
  for (let d = 1; d <= total; d++) {
    for (const info of getDayInfos(y, m, d)) out.push({ day: d, info });
  }
  return out;
}

// apakah data libur tahun ini sudah ada
export const hasHolidayData = (y: number): boolean => y in BY_YEAR;

// libur atau cuti bersama berikutnya (termasuk hari ini)
export function nextOffDay(
  y: number,
  m: number,
  d: number,
): { m: number; d: number; info: DayInfo; days: number } | null {
  const from = Date.UTC(y, m, d);
  let best: { t: number; m: number; d: number; info: DayInfo } | null = null;

  for (const year of [y, y + 1]) {
    for (const [md, kind, name] of BY_YEAR[year] ?? []) {
      const mm = Number(md.slice(0, 2)) - 1;
      const dd = Number(md.slice(3));
      const t = Date.UTC(year, mm, dd);
      if (t < from) continue;
      if (!best || t < best.t) best = { t, m: mm, d: dd, info: { kind, name } };
    }
  }
  if (!best) return null;
  return {
    m: best.m,
    d: best.d,
    info: best.info,
    days: Math.round((best.t - from) / 864e5),
  };
}

// pasaran jawa
const PASARAN = ["Legi", "Pahing", "Pon", "Wage", "Kliwon"];

// 1 Jan 1970 adalah Kamis Wage
export function pasaran(y: number, m: number, d: number): string {
  const days = Math.floor(Date.UTC(y, m, d) / 864e5);
  return PASARAN[(((days + 3) % 5) + 5) % 5];
}
