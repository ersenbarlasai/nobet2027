import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CalendarDays,
  Printer,
  AlertCircle,
  RotateCcw,
  Info,
  AlertTriangle,
  FileQuestion,
} from "lucide-react";
import { navigate, ROUTES } from "../lib/router";
import { fetchClasses, fetchClassTimetable } from "../lib/classTimetables/fetchClassTimetables";
import { subjectColor } from "../lib/classTimetables/subjectColor";
import type {
  ClassSummary,
  ClassTimetableResponse,
  CurrentImportClassesResponse,
  LessonCell,
} from "../lib/classTimetables/types";
import "./ClassTimetablePage.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function formatImportedAt(iso: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Istanbul",
  }).format(date);
  const capitalized = datePart.replace(/\p{L}+/u, (word) => word.charAt(0).toLocaleUpperCase("tr-TR") + word.slice(1));
  return `${capitalized}, ${timePart}`;
}

function formatTimeRange(startTime: string | null, endTime: string | null): string {
  if (!startTime || !endTime) return "";
  return `${startTime.slice(0, 5)}–${endTime.slice(0, 5)}`;
}

type ClassesOutcome = { status: "loaded"; data: CurrentImportClassesResponse } | { status: "error" };
type TimetableOutcome = { forId: string; status: "loaded"; data: ClassTimetableResponse } | { forId: string; status: "error" };

export default function ClassTimetablePage() {
  const [classesOutcome, setClassesOutcome] = useState<ClassesOutcome | null>(null);
  const [classesRetryNonce, setClassesRetryNonce] = useState(0);
  const [selectedClassId, setSelectedClassId] = useState<string>("");
  const [timetableOutcome, setTimetableOutcome] = useState<TimetableOutcome | null>(null);
  const [timetableRetryNonce, setTimetableRetryNonce] = useState(0);
  const [staleSelectionNotice, setStaleSelectionNotice] = useState(false);

  const classesLoading = classesOutcome === null;

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    fetchClasses(controller.signal)
      .then((data) => {
        if (ignore) return;
        setClassesOutcome({ status: "loaded", data });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setClassesOutcome({ status: "error" });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classesRetryNonce]);

  const timetableLoading = !!selectedClassId && (timetableOutcome === null || timetableOutcome.forId !== selectedClassId);

  useEffect(() => {
    if (!selectedClassId) {
      setTimetableOutcome(null);
      return;
    }
    const controller = new AbortController();
    let ignore = false;
    const forId = selectedClassId;

    fetchClassTimetable(forId, controller.signal)
      .then((data) => {
        if (ignore) return;
        if (data.hasImport && !data.classFound) {
          // Seçilen sınıf artık güncel importta yok (ör. arada yeni bir XML
          // yüklendi). Seçimi temizle, sınıf listesini yenile, bilgilendir.
          setSelectedClassId("");
          setClassesRetryNonce((n) => n + 1);
          setStaleSelectionNotice(true);
          return;
        }
        setTimetableOutcome({ forId, status: "loaded", data });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setTimetableOutcome({ forId, status: "error" });
      });

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [selectedClassId, timetableRetryNonce]);

  function handleSelectClass(classId: string) {
    setStaleSelectionNotice(false);
    setSelectedClassId(classId);
  }

  function handleRetryClasses() {
    setClassesOutcome(null);
    setClassesRetryNonce((n) => n + 1);
  }

  function handleRetryTimetable() {
    setTimetableOutcome(null);
    setTimetableRetryNonce((n) => n + 1);
  }

  const loadedTimetable =
    timetableOutcome?.status === "loaded" && timetableOutcome.data.hasImport && timetableOutcome.data.classFound
      ? timetableOutcome.data
      : null;

  const canPrint =
    loadedTimetable !== null &&
    loadedTimetable.summary.weeklyLessonCount > 0 &&
    loadedTimetable.summary.occupiedCellCount > 0;

  function handlePrint() {
    if (!canPrint) return;
    window.print();
  }

  return (
    <div className="ct-page">
      <div className="ct-page-header">
        <h1 className="page-title">Sınıf ders programı</h1>
        <p className="page-desc">Bir sınıf seçerek haftalık ders programını görüntüleyin.</p>
      </div>

      {staleSelectionNotice && (
        <div className="alert alert-info" role="status">
          <Info size={18} strokeWidth={2} aria-hidden="true" />
          <span>Seçtiğiniz sınıf artık güncel içe aktarmada bulunmuyor. Sınıf listesi yenilendi, lütfen tekrar seçin.</span>
        </div>
      )}

      <div className="ct-control-card" aria-busy={classesLoading}>
        <div className="ct-control-left">
          <label htmlFor="ct-class-select" className="ct-control-label">
            Sınıf Seçin
          </label>
          {classesLoading ? (
            <div className="ct-skeleton ct-skeleton-select" />
          ) : classesOutcome?.status === "error" ? (
            <div className="ct-inline-error">
              <span>Sınıf listesi alınamadı.</span>
              <button type="button" className="btn btn-secondary" onClick={handleRetryClasses}>
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                Tekrar Dene
              </button>
            </div>
          ) : (
            <select
              id="ct-class-select"
              className="ct-select"
              value={selectedClassId}
              onChange={(e) => handleSelectClass(e.target.value)}
              disabled={!classesOutcome.data.hasImport || classesOutcome.data.classes.length === 0}
            >
              <option value="">Sınıf seçiniz</option>
              {classesOutcome.data.classes.map((c: ClassSummary) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="ct-control-right">
          {loadedTimetable && (
            <div className="ct-teacher-badge">
              <span className="ct-teacher-badge-label">Sınıf Öğretmeni</span>
              <span className="ct-teacher-badge-value">
                {loadedTimetable.class.classTeacher ? loadedTimetable.class.classTeacher.name : "Tanımlanmamış"}
              </span>
            </div>
          )}
          <div className="ct-stat-pill">
            <CalendarDays size={14} strokeWidth={2} aria-hidden="true" />
            <span>{loadedTimetable ? `${loadedTimetable.summary.dayCount} Gün` : "—"}</span>
          </div>
          <div className="ct-stat-pill">
            <span>{loadedTimetable ? `${loadedTimetable.summary.periodCount} Ders Saati` : "—"}</span>
          </div>
          <div className="ct-stat-pill">
            <span>{loadedTimetable ? `${loadedTimetable.summary.weeklyLessonCount} Haftalık Ders` : "—"}</span>
          </div>
          <button type="button" className="btn btn-secondary ct-print-btn" onClick={handlePrint} disabled={!canPrint}>
            <Printer size={16} strokeWidth={2} aria-hidden="true" />
            Yazdır
          </button>
        </div>
      </div>

      <div className="ct-body">
        {classesOutcome?.status === "loaded" && !classesOutcome.data.hasImport && (
          <EmptyState
            icon={<FileQuestion size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="Henüz bir XML dosyası yüklenmedi."
            desc="Önce Veri ve XML ekranından ders programını yükleyin."
            actionLabel="Veri ve XML ekranına git"
            onAction={() => navigate(ROUTES.dataXml)}
          />
        )}

        {classesOutcome?.status === "loaded" && classesOutcome.data.hasImport && classesOutcome.data.classes.length === 0 && (
          <EmptyState
            icon={<FileQuestion size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="Yüklenen XML dosyasında sınıf bulunamadı."
          />
        )}

        {classesOutcome?.status === "loaded" &&
          classesOutcome.data.hasImport &&
          classesOutcome.data.classes.length > 0 &&
          !selectedClassId && (
            <EmptyState
              icon={<CalendarDays size={32} strokeWidth={1.5} aria-hidden="true" />}
              title="Ders programını görüntülemek için bir sınıf seçin."
            />
          )}

        {timetableLoading && (
          <div className="ct-table-skeleton" aria-busy="true" aria-live="polite">
            <span className="visually-hidden">Ders programı yükleniyor…</span>
            <div className="ct-skeleton ct-skeleton-table" />
          </div>
        )}

        {timetableOutcome?.status === "error" && timetableOutcome.forId === selectedClassId && (
          <div className="ct-error-card" role="alert">
            <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
            <div>
              <p className="ct-error-title">Sınıf ders programı alınamadı.</p>
              <button type="button" className="btn btn-secondary" onClick={handleRetryTimetable}>
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                Tekrar Dene
              </button>
            </div>
          </div>
        )}

        {loadedTimetable && loadedTimetable.lessons.length === 0 && (
          <EmptyState
            icon={<FileQuestion size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="Bu sınıf için ders programı bulunamadı."
          />
        )}

        {loadedTimetable && loadedTimetable.lessons.length > 0 && <TimetableGrid snapshot={loadedTimetable} />}
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  desc,
  actionLabel,
  onAction,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="ct-empty-state">
      {icon}
      <p className="ct-empty-title">{title}</p>
      {desc && <p className="ct-empty-desc">{desc}</p>}
      {actionLabel && onAction && (
        <button type="button" className="btn btn-primary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function TimetableGrid({
  snapshot,
}: {
  snapshot: Extract<ClassTimetableResponse, { classFound: true }>;
}) {
  const { class: klass, days, periods, lessons, importedAt } = snapshot;

  const sortedDays = useMemo(() => [...days].sort((a, b) => a.order - b.order), [days]);
  // period.order YALNIZ sıralama içindir — kullanıcıya gösterilen ders
  // numarası/kodu her zaman gerçek period.name'den gelir (bkz. XML <period
  // name>: "5-OO"/"5-IO" gibi teknik sıradan (order) farklı gerçek zil adları
  // olabilir; bunları tek bir sütuna birleştirme veya order'dan üretme).
  const sortedPeriods = useMemo(() => [...periods].sort((a, b) => a.order - b.order), [periods]);

  const lessonsByCell = useMemo(() => {
    const map = new Map<string, LessonCell[]>();
    for (const lesson of lessons) {
      const key = `${lesson.dayId}:${lesson.periodId}`;
      const list = map.get(key) ?? [];
      list.push(lesson);
      map.set(key, list);
    }
    return map;
  }, [lessons]);

  const hasAmbiguous = lessons.some((l) => l.mappingStatus === "ambiguous");

  return (
    <div className="ct-timetable-card">
      <div className="ct-table-scroll">
        <table className="ct-table">
          <thead>
            <tr>
              <th className="ct-corner" scope="col">
                Gün / Saat
              </th>
              {sortedPeriods.map((period) => (
                <th key={period.id} className="ct-period-header" scope="col">
                  <div className="ct-period-name">{period.name}</div>
                  <div className="ct-period-time">{formatTimeRange(period.startTime, period.endTime)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedDays.map((day) => (
              <tr key={day.id}>
                <th className="ct-day-header" scope="row">
                  {day.name}
                </th>
                {sortedPeriods.map((period) => {
                  const cellLessons = lessonsByCell.get(`${day.id}:${period.id}`) ?? [];
                  return (
                    <td key={period.id} className="ct-cell">
                      <TimetableCell lessons={cellLessons} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ct-footer">
        <p className="ct-footer-updated">
          Son güncelleme: <time dateTime={importedAt}>{formatImportedAt(importedAt)}</time>
        </p>
        <div className="ct-legend">
          <span className="ct-legend-item">
            <span className="ct-legend-swatch ct-legend-swatch--filled" /> Dolu ders
          </span>
          <span className="ct-legend-item">
            <span className="ct-legend-swatch ct-legend-swatch--empty" /> Boş periyot
          </span>
          {hasAmbiguous && (
            <span className="ct-legend-item">
              <AlertTriangle size={14} strokeWidth={2} className="ct-legend-icon-warning" aria-hidden="true" />
              Belirsiz eşleşme
            </span>
          )}
        </div>
      </div>

      <div className="ct-print-header print-only">
        <h2>{klass.name}</h2>
        <p>
          Sınıf Öğretmeni: {klass.classTeacher ? klass.classTeacher.name : "Tanımlanmamış"} · 2026–2027 · Son güncelleme:{" "}
          {formatImportedAt(importedAt)}
        </p>
      </div>
    </div>
  );
}

function TimetableCell({ lessons }: { lessons: LessonCell[] }) {
  if (lessons.length === 0) {
    return <span className="ct-cell-empty">—</span>;
  }

  const hasConflict = lessons.some((l) => l.conflict);

  return (
    <div className={hasConflict ? "ct-lesson-stack ct-lesson-stack--conflict" : "ct-lesson-stack"}>
      {hasConflict && (
        <div className="ct-conflict-banner" title="Bu hücrede birden çok kaynak XML kaydı çakışıyor.">
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>Veri çakışması</span>
        </div>
      )}
      {lessons.map((lesson) => (
        <LessonBadge key={lesson.cardId} lesson={lesson} />
      ))}
    </div>
  );
}

function LessonBadge({ lesson }: { lesson: LessonCell }) {
  const color = subjectColor(lesson.subjectName);
  const isUnassigned = lesson.teacherAssignmentStatus === "unassigned";
  const teacherText = isUnassigned ? "Öğretmen atanmamış" : lesson.teacherNames.join(", ");
  const classroomText = lesson.classroomNames.join(", ");
  const isAmbiguous = lesson.mappingStatus === "ambiguous";
  const fullText = [lesson.subjectName ?? "Ders", teacherText, classroomText].filter(Boolean).join(" · ");

  return (
    <div
      className="ct-lesson-badge"
      style={{ background: color.bg, color: color.fg, borderColor: color.border }}
      title={isAmbiguous ? `${fullText} — Bu dersin öğretmen–sınıf eşleşmesi kaynak XML'den kesin olarak belirlenemiyor.` : fullText}
    >
      <div className="ct-lesson-subject">
        <span className="ct-lesson-subject-text">{lesson.subjectName ?? "Ders"}</span>
        {isAmbiguous && (
          <AlertTriangle
            size={13}
            strokeWidth={2}
            className="ct-lesson-ambiguous-icon"
            aria-label="Bu dersin öğretmen–sınıf eşleşmesi kaynak XML'den kesin olarak belirlenemiyor."
          />
        )}
      </div>
      <div className={isUnassigned ? "ct-lesson-teacher ct-lesson-teacher--unassigned" : "ct-lesson-teacher"}>
        {teacherText}
      </div>
      {classroomText && <div className="ct-lesson-classroom">{classroomText}</div>}
    </div>
  );
}
