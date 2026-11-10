// CalendarUi.tsx
// kalender indonesia: tanggal merah, cuti bersama, hari peringatan, pasaran

import React, { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  DayInfo,
  DayKind,
  hasHolidayData,
  monthEvents,
  nextOffDay,
  pasaran,
} from "./holidays";

const ring =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70";

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const DAYS_FULL = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];
const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agu",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

// warna tiap jenis hari
const KIND_COLOR: Record<DayKind, string> = {
  libur: "#F0607A",
  cuti: "#F5A04B",
  peringatan: "#7FB7FF",
};
const KIND_LABEL: Record<DayKind, string> = {
  libur: "Libur nasional",
  cuti: "Cuti bersama",
  peringatan: "Hari peringatan",
};

// sembunyikan scrollbar
const NO_SCROLLBAR = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

// warna angka tanggal: merah untuk libur / minggu, oranye untuk cuti
function dayColor(infos: DayInfo[], sunday: boolean): string | undefined {
  if (sunday || infos.some((i) => i.kind === "libur")) return KIND_COLOR.libur;
  if (infos.some((i) => i.kind === "cuti")) return KIND_COLOR.cuti;
  return undefined;
}

interface Sel {
  y: number;
  m: number;
  d: number;
}

export const CalendarView: React.FC<{ now: Date; onBack?: () => void }> = ({
  now,
}) => {
  const nowY = now.getFullYear();
  const nowM = now.getMonth();
  const nowD = now.getDate();

  const [cursor, setCursor] = useState({ y: nowY, m: nowM });
  const [sel, setSel] = useState<Sel>({ y: nowY, m: nowM, d: nowD });

  const shift = (delta: number) =>
    setCursor(({ y, m }) => {
      const d = new Date(y, m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  // susunan tanggal (minggu mulai Senin)
  const offset = (new Date(cursor.y, cursor.m, 1).getDay() + 6) % 7;
  const total = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(offset).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // hari khusus bulan ini
  const events = useMemo(
    () => monthEvents(cursor.y, cursor.m),
    [cursor.y, cursor.m],
  );
  const byDay = useMemo(() => {
    const map = new Map<number, DayInfo[]>();
    for (const e of events) map.set(e.day, [...(map.get(e.day) ?? []), e.info]);
    return map;
  }, [events]);

  const isNowMonth = cursor.y === nowY && cursor.m === nowM;
  const isToday = (d: number) => isNowMonth && d === nowD;

  // tanggal yang dipilih (bulan lain: tidak ada)
  const picked = sel.y === cursor.y && sel.m === cursor.m ? sel.d : null;
  const shown = picked ?? (isNowMonth ? nowD : null);
  const shownInfos = shown !== null ? (byDay.get(shown) ?? []) : [];
  const shownWd =
    shown !== null ? new Date(cursor.y, cursor.m, shown).getDay() : 0;

  const liburCount = events.filter((e) => e.info.kind === "libur").length;
  const cutiCount = events.filter((e) => e.info.kind === "cuti").length;

  // libur berikutnya
  const next = nextOffDay(nowY, nowM, nowD);
  const nextWhen = next
    ? next.days === 0
      ? "hari ini"
      : next.days === 1
        ? "besok"
        : `${next.days} hari lagi`
    : "";

  const navBtn = `flex h-[26px] w-[26px] items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white ${ring}`;

  return (
    <div className="flex h-full w-full flex-col gap-2 p-[18px]">
      {/* judul bulan */}
      <div className="flex h-[26px] shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            title="Kembali ke bulan ini"
            onClick={() => {
              setCursor({ y: nowY, m: nowM });
              setSel({ y: nowY, m: nowM, d: nowD });
            }}
            className={`truncate rounded-md text-[13px] font-semibold ${ring}`}
          >
            {MONTHS[cursor.m]} {cursor.y}
          </button>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label="Bulan sebelumnya"
            onClick={() => shift(-1)}
            className={navBtn}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            aria-label="Bulan berikutnya"
            onClick={() => shift(1)}
            className={navBtn}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* kolom kalender */}
        <div className="flex w-[182px] shrink-0 flex-col gap-1.5">
          <div className="grid grid-cols-7 text-center text-[10px]">
            {[...DAYS.slice(1), DAYS[0]].map((d, i) => (
              <div
                key={d}
                className={i === 6 ? "" : "text-white/40"}
                style={i === 6 ? { color: KIND_COLOR.libur } : undefined}
              >
                {d}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 content-start text-center text-[12px] tabular-nums">
            {cells.map((d, i) => {
              if (d === null) return <div key={i} className="h-[26px]" />;

              const infos = byDay.get(d) ?? [];
              const color = dayColor(infos, i % 7 === 6);
              const onlyPeringatan =
                infos.length > 0 && infos.every((x) => x.kind === "peringatan");
              const today = isToday(d);
              const chosen = shown === d;

              return (
                <button
                  key={i}
                  type="button"
                  title={infos.map((x) => x.name).join(", ") || undefined}
                  onClick={() => setSel({ y: cursor.y, m: cursor.m, d })}
                  className={`relative flex h-[26px] items-center justify-center ${ring}`}
                >
                  <span
                    className={`flex h-[20px] w-[20px] items-center justify-center rounded-full transition-colors ${
                      today
                        ? "bg-white font-semibold"
                        : chosen
                          ? "bg-white/20 font-semibold"
                          : "hover:bg-white/10"
                    } ${color ? "" : today ? "text-black" : "text-white/80"} ${
                      color && infos.some((x) => x.kind !== "peringatan")
                        ? "font-semibold"
                        : ""
                    }`}
                    style={color ? { color } : undefined}
                  >
                    {d}
                  </span>
                  {/* titik hari peringatan */}
                  {onlyPeringatan && (
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 h-[3px] w-[3px] rounded-full"
                      style={{ background: KIND_COLOR.peringatan }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* kolom info */}
        <div
          className="flex min-w-0 flex-1 flex-col gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {/* detail tanggal */}
          <div className="shrink-0">
            {shown !== null ? (
              <>
                <div className="text-[10.5px] text-white/60">
                  {DAYS_FULL[shownWd]} {pasaran(cursor.y, cursor.m, shown)}
                </div>
                <div className="text-[13px] font-semibold leading-tight">
                  {shown} {MONTHS[cursor.m]} {cursor.y}
                </div>
                {shownInfos.length > 0 ? (
                  shownInfos.map((x, i) => (
                    <div key={i} className="mt-1 leading-tight">
                      <div
                        className="text-[11.5px] font-medium"
                        style={{ color: KIND_COLOR[x.kind] }}
                      >
                        {x.name}
                      </div>
                      <div className="text-[9.5px] text-white/45">
                        {KIND_LABEL[x.kind]}
                      </div>
                    </div>
                  ))
                ) : (
                  <div
                    className="mt-1 text-[11px]"
                    style={
                      shownWd === 0 ? { color: KIND_COLOR.libur } : undefined
                    }
                  >
                    <span className={shownWd === 0 ? "" : "text-white/45"}>
                      {shownWd === 0
                        ? "Hari Minggu"
                        : shownWd === 6
                          ? "Akhir pekan"
                          : "Hari kerja"}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-[13px] font-semibold leading-tight">
                  {MONTHS[cursor.m]} {cursor.y}
                </div>
                <div className="mt-0.5 text-[11px] text-white/55">
                  {hasHolidayData(cursor.y)
                    ? `${liburCount} libur nasional${
                        cutiCount ? ` · ${cutiCount} cuti bersama` : ""
                      }`
                    : `Data libur ${cursor.y} belum tersedia`}
                </div>
              </>
            )}
          </div>

          {/* daftar tanggal penting bulan ini */}
          <div className="min-h-0 flex-1 border-t border-white/10 pt-1">
            <div className={`h-full overflow-y-auto ${NO_SCROLLBAR}`}>
              {events.length > 0 ? (
                events.map((e, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() =>
                      setSel({ y: cursor.y, m: cursor.m, d: e.day })
                    }
                    className={`flex w-full items-baseline gap-1.5 rounded-md px-1 py-[1px] text-left text-[10.5px] leading-snug transition-colors hover:bg-white/10 ${ring}`}
                  >
                    <span className="w-[16px] shrink-0 text-right tabular-nums text-white/50">
                      {e.day}
                    </span>
                    <span
                      className="truncate"
                      style={{ color: KIND_COLOR[e.info.kind] }}
                    >
                      {e.info.name.replace("Cuti Bersama", "Cuti")}
                    </span>
                  </button>
                ))
              ) : (
                <div className="px-1 text-[10.5px] text-white/40">
                  Tidak ada hari libur
                </div>
              )}
              {/* tahun tanpa data libur */}
              {!hasHolidayData(cursor.y) && (
                <div className="mt-1 px-1 text-[10px] text-white/40">
                  Data libur {cursor.y} belum tersedia
                </div>
              )}
            </div>
          </div>

          {/* libur berikutnya */}
          {next && (
            <div className="shrink-0 border-t border-white/10 pt-1 leading-tight">
              <div className="text-[9.5px] text-white/45">Libur berikutnya</div>
              <div
                className="truncate text-[10.5px]"
                style={{ color: KIND_COLOR[next.info.kind] }}
              >
                {next.info.name}
              </div>
              <div className="truncate text-[10px] text-white/55">
                {next.d} {MONTHS_SHORT[next.m]} · {nextWhen}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
