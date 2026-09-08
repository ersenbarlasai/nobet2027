import { AlertTriangle } from "lucide-react";
import LessonEntityBadge from "./LessonEntityBadge";
import type { MappingStatus } from "../../lib/classTimetables/types";

export interface CellLesson {
  cardId: string;
  subjectName: string | null;
  entityNames: string[];
  classroomNames: string[];
  mappingStatus: MappingStatus;
  conflict: boolean;
}

/**
 * Bir program hücresinin içeriği: boşsa "—", doluysa bir veya birden çok
 * (çakışma durumunda) gruplanmış ders kartı + gerekirse kırmızı çakışma
 * bandı. Hem Sınıf hem Öğretmen Ders Programı ekranlarında aynı görsel
 * davranışı sağlamak için paylaşılır.
 */
export default function LessonCellContent({ lessons }: { lessons: CellLesson[] }) {
  if (lessons.length === 0) {
    return <span className="tt-cell-empty">—</span>;
  }

  const hasConflict = lessons.some((l) => l.conflict);

  return (
    <div className={hasConflict ? "tt-lesson-stack tt-lesson-stack--conflict" : "tt-lesson-stack"}>
      {hasConflict && (
        <div
          className="tt-conflict-banner"
          title="Bu öğretmene aynı gün ve ders saatinde birden fazla ders atanmış."
        >
          <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
          <span>Ders çakışması</span>
        </div>
      )}
      {lessons.map((lesson) => (
        <LessonEntityBadge
          key={lesson.cardId}
          subjectName={lesson.subjectName}
          entityNames={lesson.entityNames}
          classroomNames={lesson.classroomNames}
          mappingStatus={lesson.mappingStatus}
        />
      ))}
    </div>
  );
}
