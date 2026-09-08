import type { ReactNode } from "react";
import type { DayDef, PeriodDef } from "../../lib/classTimetables/types";

function formatTimeRange(startTime: string | null, endTime: string | null): string {
  if (!startTime || !endTime) return "";
  return `${startTime.slice(0, 5)}–${endTime.slice(0, 5)}`;
}

/**
 * Gün (satır) × periyot (sütun) haftalık program tablosu. Gün sütunu yatay
 * kaydırmada, periyot başlıkları dikey kaydırmada sticky kalır. period.order
 * yalnız sıralama içindir — başlıkta HER ZAMAN gerçek period.name gösterilir
 * (bkz. XML'deki "5-OO"/"5-IO" gibi teknik sıradan farklı gerçek zil adları).
 * Sınıf ve Öğretmen Ders Programı ekranları arasında paylaşılır.
 */
export default function WeeklyTimetableGrid({
  days,
  periods,
  renderCell,
}: {
  days: DayDef[];
  periods: PeriodDef[];
  renderCell: (dayId: string, periodId: string) => ReactNode;
}) {
  const sortedDays = [...days].sort((a, b) => a.order - b.order);
  const sortedPeriods = [...periods].sort((a, b) => a.order - b.order);

  return (
    <div className="tt-table-scroll">
      <table className="tt-table">
        <thead>
          <tr>
            <th className="tt-corner" scope="col">
              Gün / Saat
            </th>
            {sortedPeriods.map((period) => (
              <th key={period.id} className="tt-period-header" scope="col">
                <div className="tt-period-name">{period.name}</div>
                <div className="tt-period-time">{formatTimeRange(period.startTime, period.endTime)}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedDays.map((day) => (
            <tr key={day.id}>
              <th className="tt-day-header" scope="row">
                {day.name}
              </th>
              {sortedPeriods.map((period) => (
                <td key={period.id} className="tt-cell">
                  {renderCell(day.id, period.id)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
