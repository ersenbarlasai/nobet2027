import { describe, expect, it } from "vitest";
import {
  compareTeacherNames,
  computeTeacherTimetableSummary,
  groupTeacherAssignmentRows,
  type RawTeacherAssignmentRow,
} from "../services/teacherTimetables";

describe("compareTeacherNames", () => {
  it("3) Türkçe/numeric-aware/case-insensitive sıralama", () => {
    const names = ["yıldız rukiye", "Arslan Asuman", "İstek Nazım", "10. Öğretmen", "2. Öğretmen"];
    const sorted = [...names].sort(compareTeacherNames);
    // case-insensitive: "Arslan" ve "yıldız" harf büyüklüğünden bağımsız sıralanır;
    // numeric-aware: "2. Öğretmen" "10. Öğretmen"'den önce gelir.
    expect(sorted.indexOf("2. Öğretmen")).toBeLessThan(sorted.indexOf("10. Öğretmen"));
    expect(sorted.indexOf("Arslan Asuman")).toBeLessThan(sorted.indexOf("İstek Nazım"));
  });
});

function row(overrides: Partial<RawTeacherAssignmentRow> = {}): RawTeacherAssignmentRow {
  return {
    cardId: "card-1",
    sourceCardKey: "card-1",
    dayId: "day-1",
    periodId: "period-1",
    subjectName: "MAINCOURSE",
    className: "5/A",
    classroom: null,
    mappingStatus: "exact",
    ...overrides,
  };
}

describe("groupTeacherAssignmentRows", () => {
  it("9) aynı card için tek satır -> tek hücre", () => {
    const cells = groupTeacherAssignmentRows([row()]);
    expect(cells).toHaveLength(1);
    expect(cells[0].classNames).toEqual(["5/A"]);
  });

  it("10) çoklu sınıf aynı card -> tek hücrede benzersiz sınıf listesi", () => {
    const cells = groupTeacherAssignmentRows([
      row({ className: "5/A", mappingStatus: "expanded" }),
      row({ className: "5/B", mappingStatus: "expanded" }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0].classNames).toEqual(["5/A", "5/B"]);
  });

  it("11) aynı sınıf tekrar edilmez", () => {
    const cells = groupTeacherAssignmentRows([
      row({ className: "5/A" }),
      row({ className: "5/A" }),
    ]);
    expect(cells[0].classNames).toEqual(["5/A"]);
  });

  it("benzersiz derslik adları listesi üretir", () => {
    const cells = groupTeacherAssignmentRows([
      row({ classroom: "5A-D1,5A-D2" }),
      row({ className: "5/B", classroom: "5A-D1" }),
    ]);
    expect(cells[0].classroomNames.sort()).toEqual(["5A-D1", "5A-D2"]);
  });

  it("12) ambiguous mapping tek hücrede korunur, ders gizlenmez", () => {
    const cells = groupTeacherAssignmentRows([
      row({ className: "5/A", mappingStatus: "ambiguous" }),
      row({ className: "5/B", mappingStatus: "ambiguous" }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0].mappingStatus).toBe("ambiguous");
    expect(cells[0].subjectName).toBe("MAINCOURSE");
  });

  it("mapping status önceliği: ambiguous > expanded > exact", () => {
    const cells = groupTeacherAssignmentRows([row({ mappingStatus: "exact" }), row({ mappingStatus: "ambiguous" })]);
    expect(cells[0].mappingStatus).toBe("ambiguous");
  });

  it("13) aynı gün+saatte farklı card -> conflict=true her iki hücrede de", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1", sourceCardKey: "card-1" }),
      row({ cardId: "card-2", sourceCardKey: "card-2", subjectName: "SKILLS", className: "6/B" }),
    ]);
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.conflict)).toBe(true);
  });

  it("farklı gün/saatteki cardlar conflict oluşturmaz", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1", periodId: "period-1" }),
      row({ cardId: "card-2", periodId: "period-2", className: "6/B" }),
    ]);
    expect(cells.every((c) => !c.conflict)).toBe(true);
  });
});

describe("computeTeacherTimetableSummary", () => {
  it("14) weeklyLessonCount ham assignment satırı değil benzersiz card/hücre sayısını kullanır", () => {
    const cells = groupTeacherAssignmentRows([row({ className: "5/A" }), row({ className: "5/B" })]);
    const summary = computeTeacherTimetableSummary(cells, 5, 10);
    expect(summary.weeklyLessonCount).toBe(1);
  });

  it("15) occupiedCellCount benzersiz gün+periyot hücresi sayısıdır", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1", periodId: "period-1" }),
      row({ cardId: "card-2", periodId: "period-2", className: "6/B" }),
    ]);
    const summary = computeTeacherTimetableSummary(cells, 5, 10);
    expect(summary.occupiedCellCount).toBe(2);
  });

  it("16) classCount öğretmenin ders verdiği benzersiz sınıf sayısıdır", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1", periodId: "period-1", className: "5/A" }),
      row({ cardId: "card-2", periodId: "period-2", className: "5/B" }),
      row({ cardId: "card-3", periodId: "period-3", className: "5/A" }), // tekrar eden sınıf
    ]);
    const summary = computeTeacherTimetableSummary(cells, 5, 10);
    expect(summary.classCount).toBe(2);
  });

  it("conflictCellCount çakışan hücre sayısını (satır değil) sayar", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1" }),
      row({ cardId: "card-2", className: "6/B" }),
    ]);
    const summary = computeTeacherTimetableSummary(cells, 5, 10);
    expect(summary.conflictCellCount).toBe(1);
    expect(summary.weeklyLessonCount).toBe(2);
  });

  it("ambiguousLessonCount yalnız ambiguous hücreleri sayar", () => {
    const cells = groupTeacherAssignmentRows([
      row({ cardId: "card-1", mappingStatus: "exact" }),
      row({ cardId: "card-2", periodId: "period-2", mappingStatus: "ambiguous", className: "6/B" }),
    ]);
    const summary = computeTeacherTimetableSummary(cells, 5, 10);
    expect(summary.ambiguousLessonCount).toBe(1);
  });
});
