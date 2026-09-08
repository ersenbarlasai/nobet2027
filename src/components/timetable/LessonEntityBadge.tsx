import { AlertTriangle } from "lucide-react";
import { subjectColor } from "../../lib/classTimetables/subjectColor";
import type { MappingStatus } from "../../lib/classTimetables/types";

const AMBIGUOUS_EXPLANATION = "Bu dersin öğretmen–sınıf eşleşmesi kaynak XML'den kesin olarak belirlenemiyor.";

/**
 * Bir ders hücresindeki tek bir gruplanmış ders kartı: ders adı + ikincil
 * varlık listesi (Sınıf Ders Programı'nda öğretmen adları, Öğretmen Ders
 * Programı'nda sınıf adları) + varsa derslik. Deterministik subject rengini
 * kullanır (bkz. subjectColor — iki ekranda da aynı ders aynı rengi alır).
 */
export default function LessonEntityBadge({
  subjectName,
  entityNames,
  classroomNames,
  mappingStatus,
}: {
  subjectName: string | null;
  entityNames: string[];
  classroomNames: string[];
  mappingStatus: MappingStatus;
}) {
  const color = subjectColor(subjectName);
  const entityText = entityNames.join(", ");
  const classroomText = classroomNames.join(", ");
  const isAmbiguous = mappingStatus === "ambiguous";
  const fullText = [subjectName ?? "Ders", entityText, classroomText].filter(Boolean).join(" · ");

  return (
    <div
      className="tt-lesson-badge"
      style={{ background: color.bg, color: color.fg, borderColor: color.border }}
      title={isAmbiguous ? `${fullText} — ${AMBIGUOUS_EXPLANATION}` : fullText}
    >
      <div className="tt-lesson-subject">
        <span className="tt-lesson-subject-text">{subjectName ?? "Ders"}</span>
        {isAmbiguous && (
          <AlertTriangle size={13} strokeWidth={2} className="tt-lesson-ambiguous-icon" aria-label={AMBIGUOUS_EXPLANATION} />
        )}
      </div>
      {entityText && <div className="tt-lesson-entities">{entityText}</div>}
      {classroomText && <div className="tt-lesson-classroom">{classroomText}</div>}
    </div>
  );
}
