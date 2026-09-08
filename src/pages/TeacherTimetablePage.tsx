import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Users, Printer, AlertCircle, RotateCcw, Info, FileQuestion } from "lucide-react";
import { navigate, ROUTES } from "../lib/router";
import { fetchTeachers, fetchTeacherTimetable } from "../lib/teacherTimetables/fetchTeacherTimetables";
import EmptyState from "../components/timetable/EmptyState";
import WeeklyTimetableGrid from "../components/timetable/WeeklyTimetableGrid";
import LessonCellContent, { type CellLesson } from "../components/timetable/LessonCellContent";
import TimetableFooter from "../components/timetable/TimetableFooter";
import DutyAvailabilityMatrix from "../components/teacherDuty/DutyAvailabilityMatrix";
import { formatImportedAt } from "../lib/currentImport/formatImportedAt";
import type { TeacherSummary, TeacherTimetableResponse, CurrentImportTeachersResponse } from "../lib/teacherTimetables/types";
import "../components/timetable/WeeklyTimetableGrid.css";
import "./TeacherTimetablePage.css";

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

type TeachersOutcome = { status: "loaded"; data: CurrentImportTeachersResponse } | { status: "error" };
type TimetableOutcome =
  | { forId: string; status: "loaded"; data: TeacherTimetableResponse }
  | { forId: string; status: "error" };

export default function TeacherTimetablePage() {
  const [teachersOutcome, setTeachersOutcome] = useState<TeachersOutcome | null>(null);
  const [teachersRetryNonce, setTeachersRetryNonce] = useState(0);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("");
  const [timetableOutcome, setTimetableOutcome] = useState<TimetableOutcome | null>(null);
  const [timetableRetryNonce, setTimetableRetryNonce] = useState(0);
  const [staleSelectionNotice, setStaleSelectionNotice] = useState(false);
  const [dutyDirty, setDutyDirty] = useState(false);
  const [pendingTeacherId, setPendingTeacherId] = useState<string | null>(null);

  const teachersLoading = teachersOutcome === null;

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    fetchTeachers(controller.signal)
      .then((data) => {
        if (ignore) return;
        setTeachersOutcome({ status: "loaded", data });
      })
      .catch((err) => {
        if (ignore || isAbortError(err)) return;
        setTeachersOutcome({ status: "error" });
      });
    return () => {
      ignore = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachersRetryNonce]);

  const timetableLoading = !!selectedTeacherId && (timetableOutcome === null || timetableOutcome.forId !== selectedTeacherId);

  useEffect(() => {
    if (!selectedTeacherId) {
      setTimetableOutcome(null);
      return;
    }
    const controller = new AbortController();
    let ignore = false;
    const forId = selectedTeacherId;

    fetchTeacherTimetable(forId, controller.signal)
      .then((data) => {
        if (ignore) return;
        if (data.hasImport && !data.teacherFound) {
          // Seçilen öğretmen artık güncel importta yok (ör. arada yeni bir
          // XML yüklendi). Seçimi temizle, öğretmen listesini yenile, bilgilendir.
          setSelectedTeacherId("");
          setTeachersRetryNonce((n) => n + 1);
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
  }, [selectedTeacherId, timetableRetryNonce]);

  function handleSelectTeacher(teacherId: string) {
    if (teacherId === selectedTeacherId) return;
    if (dutyDirty) {
      setPendingTeacherId(teacherId);
      return;
    }
    setStaleSelectionNotice(false);
    setSelectedTeacherId(teacherId);
  }

  function confirmTeacherSwitch() {
    if (pendingTeacherId === null) return;
    setStaleSelectionNotice(false);
    setSelectedTeacherId(pendingTeacherId);
    setPendingTeacherId(null);
    setDutyDirty(false);
  }

  function cancelTeacherSwitch() {
    setPendingTeacherId(null);
  }

  function handleRetryTeachers() {
    setTeachersOutcome(null);
    setTeachersRetryNonce((n) => n + 1);
  }

  function handleRetryTimetable() {
    setTimetableOutcome(null);
    setTimetableRetryNonce((n) => n + 1);
  }

  const loadedTimetable =
    timetableOutcome?.status === "loaded" && timetableOutcome.data.hasImport && timetableOutcome.data.teacherFound
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
    <div className="tp-page">
      <div className="tp-page-header">
        <h1 className="page-title">Öğretmen ders programı</h1>
        <p className="page-desc">Bir öğretmen seçerek haftalık ders programını görüntüleyin.</p>
      </div>

      {staleSelectionNotice && (
        <div className="alert alert-info" role="status">
          <Info size={18} strokeWidth={2} aria-hidden="true" />
          <span>Seçtiğiniz öğretmen artık güncel içe aktarmada bulunmuyor. Öğretmen listesi yenilendi, lütfen tekrar seçin.</span>
        </div>
      )}

      <div className="tp-control-card" aria-busy={teachersLoading}>
        <div className="tp-control-left">
          <label htmlFor="tp-teacher-select" className="tp-control-label">
            Öğretmen Seçin
          </label>
          {teachersLoading ? (
            <div className="tp-skeleton tp-skeleton-select" />
          ) : teachersOutcome?.status === "error" ? (
            <div className="tp-inline-error">
              <span>Öğretmen listesi alınamadı.</span>
              <button type="button" className="btn btn-secondary" onClick={handleRetryTeachers}>
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
                Tekrar Dene
              </button>
            </div>
          ) : (
            <select
              id="tp-teacher-select"
              className="tp-select"
              value={selectedTeacherId}
              onChange={(e) => handleSelectTeacher(e.target.value)}
              disabled={!teachersOutcome.data.hasImport || teachersOutcome.data.teachers.length === 0}
            >
              <option value="">Öğretmen seçiniz</option>
              {teachersOutcome.data.teachers.map((t: TeacherSummary) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="tp-control-right">
          <div className="tp-stat-pill">
            <span>{loadedTimetable ? `${loadedTimetable.summary.dayCount} Gün` : "—"}</span>
          </div>
          <div className="tp-stat-pill">
            <span>{loadedTimetable ? `${loadedTimetable.summary.periodCount} Ders Saati` : "—"}</span>
          </div>
          <div className="tp-stat-pill">
            <span>{loadedTimetable ? `${loadedTimetable.summary.weeklyLessonCount} Haftalık Ders` : "—"}</span>
          </div>
          <div className="tp-stat-pill">
            <Users size={14} strokeWidth={2} aria-hidden="true" />
            <span>{loadedTimetable ? `${loadedTimetable.summary.classCount} Sınıf` : "—"}</span>
          </div>
          <button type="button" className="btn btn-secondary tp-print-btn" onClick={handlePrint} disabled={!canPrint}>
            <Printer size={16} strokeWidth={2} aria-hidden="true" />
            Yazdır
          </button>
        </div>
      </div>

      <div className="tp-body">
        {teachersOutcome?.status === "loaded" && !teachersOutcome.data.hasImport && (
          <EmptyState
            icon={<FileQuestion size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="Henüz bir XML dosyası yüklenmedi."
            desc="Önce Veri ve XML ekranından ders programını yükleyin."
            actionLabel="Veri ve XML ekranına git"
            onAction={() => navigate(ROUTES.dataXml)}
          />
        )}

        {teachersOutcome?.status === "loaded" && teachersOutcome.data.hasImport && teachersOutcome.data.teachers.length === 0 && (
          <EmptyState
            icon={<FileQuestion size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="Yüklenen XML dosyasında öğretmen bulunamadı."
          />
        )}

        {teachersOutcome?.status === "loaded" &&
          teachersOutcome.data.hasImport &&
          teachersOutcome.data.teachers.length > 0 &&
          !selectedTeacherId && (
            <EmptyState
              icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
              title="Ders programını görüntülemek için bir öğretmen seçin."
            />
          )}

        {timetableLoading && (
          <div className="tp-table-skeleton" aria-busy="true" aria-live="polite">
            <span className="visually-hidden">Ders programı yükleniyor…</span>
            <div className="tp-skeleton tp-skeleton-table" />
          </div>
        )}

        {timetableOutcome?.status === "error" && timetableOutcome.forId === selectedTeacherId && (
          <div className="tp-error-card" role="alert">
            <AlertCircle size={20} strokeWidth={2} aria-hidden="true" />
            <div>
              <p className="tp-error-title">Öğretmen ders programı alınamadı.</p>
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
            title="Bu öğretmen için ders programı bulunamadı."
          />
        )}

        {loadedTimetable && loadedTimetable.lessons.length > 0 && <TeacherTimetableCard snapshot={loadedTimetable} />}

        {selectedTeacherId && <DutyAvailabilityMatrix key={selectedTeacherId} teacherId={selectedTeacherId} onDirtyChange={setDutyDirty} />}
      </div>

      {pendingTeacherId !== null && (
        <SwitchTeacherConfirmDialog onCancel={cancelTeacherSwitch} onConfirm={confirmTeacherSwitch} />
      )}
    </div>
  );
}

function SwitchTeacherConfirmDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button");
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="tp-confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="tp-confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tp-switch-title"
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <h2 id="tp-switch-title">Kaydedilmemiş değişiklikler var</h2>
        <p>Nöbet uygunluk matrisinde kaydedilmemiş değişiklikler var. Öğretmen değiştirilirse bu değişiklikler kaybolacak.</p>
        <div className="tp-confirm-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Vazgeç
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            Yine de Devam Et
          </button>
        </div>
      </div>
    </div>
  );
}

function TeacherTimetableCard({
  snapshot,
}: {
  snapshot: Extract<TeacherTimetableResponse, { teacherFound: true }>;
}) {
  const { teacher, days, periods, lessons, importedAt } = snapshot;

  const lessonsByCell = useMemo(() => {
    const map = new Map<string, CellLesson[]>();
    for (const lesson of lessons) {
      const key = `${lesson.dayId}:${lesson.periodId}`;
      const list = map.get(key) ?? [];
      list.push({
        cardId: lesson.cardId,
        subjectName: lesson.subjectName,
        entityNames: lesson.classNames,
        classroomNames: lesson.classroomNames,
        mappingStatus: lesson.mappingStatus,
        conflict: lesson.conflict,
      });
      map.set(key, list);
    }
    return map;
  }, [lessons]);

  const hasAmbiguous = lessons.some((l) => l.mappingStatus === "ambiguous");
  const hasConflict = lessons.some((l) => l.conflict);

  return (
    <div className="tp-timetable-card">
      <WeeklyTimetableGrid
        days={days}
        periods={periods}
        renderCell={(dayId, periodId) => <LessonCellContent lessons={lessonsByCell.get(`${dayId}:${periodId}`) ?? []} />}
      />

      <TimetableFooter importedAt={importedAt} hasAmbiguous={hasAmbiguous} hasConflict={hasConflict} />

      <div className="tp-print-header print-only">
        <h2>Öğretmen Ders Programı</h2>
        <p>{teacher.name}</p>
        <p>
          Kaplan Okulları · Üçevler Kampüsü · 2026–2027 · Son güncelleme: {formatImportedAt(importedAt)}
        </p>
      </div>
    </div>
  );
}
