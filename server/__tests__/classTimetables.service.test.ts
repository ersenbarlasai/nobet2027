import { describe, expect, it } from "vitest";
import {
  compareClassNames,
  computeClassTimetableSummary,
  groupAssignmentRows,
  type RawAssignmentRow,
} from "../services/classTimetables";

describe("compareClassNames", () => {
  it("3) numeric-aware Türkçe sıralama: '10/A' '5/A''dan sonra gelir", () => {
    const names = ["10/A", "10/B", "5/A", "5/B"];
    const sorted = [...names].sort(compareClassNames);
    expect(sorted).toEqual(["5/A", "5/B", "10/A", "10/B"]);
  });
});

function row(overrides: Partial<RawAssignmentRow> = {}): RawAssignmentRow {
  return {
    cardId: "card-1",
    sourceCardKey: "card-1",
    dayId: "day-1",
    periodId: "period-1",
    subjectName: "Matematik",
    teacherName: "A. Yılmaz",
    classroomNames: [],
    mappingStatus: "exact",
    teacherAssignmentStatus: "assigned",
    ...overrides,
  };
}

/** teacherids="" olan bir lesson'ın DB'den geldiği ham satır (bkz. migration 20260905090000). */
function unassignedRow(overrides: Partial<RawAssignmentRow> = {}): RawAssignmentRow {
  return row({
    teacherName: null,
    mappingStatus: null,
    teacherAssignmentStatus: "unassigned",
    subjectName: "ORTAOKUL DENEME",
    ...overrides,
  });
}

describe("groupAssignmentRows", () => {
  it("8) aynı card için tek satır -> tek hücre", () => {
    const cells = groupAssignmentRows([row()]);
    expect(cells).toHaveLength(1);
    expect(cells[0].teacherNames).toEqual(["A. Yılmaz"]);
  });

  it("9) çoklu öğretmen aynı card -> tek hücrede benzersiz öğretmen listesi", () => {
    const cells = groupAssignmentRows([
      row({ teacherName: "A. Yılmaz", mappingStatus: "expanded" }),
      row({ teacherName: "M. Kaya", mappingStatus: "expanded" }),
      row({ teacherName: "A. Yılmaz", mappingStatus: "expanded" }), // yinelenen isim tekrar gösterilmemeli
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0].teacherNames).toEqual(["A. Yılmaz", "M. Kaya"]);
  });

  it("benzersiz derslik adları listesi üretir", () => {
    const cells = groupAssignmentRows([
      row({ classroomNames: ["5A-D1", "5A-D2"] }),
      row({ teacherName: "M. Kaya", classroomNames: ["5A-D1"] }),
    ]);
    expect(cells[0].classroomNames.sort()).toEqual(["5A-D1", "5A-D2"]);
  });

  it("10) ambiguous mapping tek hücrede korunur, ders gizlenmez", () => {
    const cells = groupAssignmentRows([
      row({ teacherName: "A. Yılmaz", mappingStatus: "ambiguous" }),
      row({ teacherName: "M. Kaya", mappingStatus: "ambiguous" }),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0].mappingStatus).toBe("ambiguous");
    expect(cells[0].subjectName).toBe("Matematik");
  });

  it("mapping status önceliği: ambiguous > expanded > exact", () => {
    const cells = groupAssignmentRows([row({ mappingStatus: "exact" }), row({ mappingStatus: "ambiguous" })]);
    expect(cells[0].mappingStatus).toBe("ambiguous");
  });

  it("11) aynı gün+saatte farklı card -> conflict=true her iki hücrede de", () => {
    const cells = groupAssignmentRows([
      row({ cardId: "card-1", sourceCardKey: "card-1" }),
      row({ cardId: "card-2", sourceCardKey: "card-2", subjectName: "Türkçe", teacherName: "M. Kaya" }),
    ]);
    expect(cells).toHaveLength(2);
    expect(cells.every((c) => c.conflict)).toBe(true);
  });

  it("farklı gün/saatteki cardlar conflict oluşturmaz", () => {
    const cells = groupAssignmentRows([
      row({ cardId: "card-1", periodId: "period-1" }),
      row({ cardId: "card-2", periodId: "period-2", teacherName: "M. Kaya" }),
    ]);
    expect(cells.every((c) => !c.conflict)).toBe(true);
  });

  it("1/2/3) öğretmensiz (teacherids=\"\") lesson card'ı döner: teacherNames=[], teacherAssignmentStatus=unassigned", () => {
    const cells = groupAssignmentRows([unassignedRow()]);
    expect(cells).toHaveLength(1);
    expect(cells[0].teacherNames).toEqual([]);
    expect(cells[0].teacherAssignmentStatus).toBe("unassigned");
    expect(cells[0].mappingStatus).toBeNull();
    expect(cells[0].subjectName).toBe("ORTAOKUL DENEME");
  });

  it("4) normal öğretmenli ders assigned olur", () => {
    const cells = groupAssignmentRows([row()]);
    expect(cells[0].teacherAssignmentStatus).toBe("assigned");
  });

  it("7/8) aynı sınavın dört card'ı dört benzersiz ders sayılır, doğru gün/periyotlarda", () => {
    const cells = groupAssignmentRows([
      unassignedRow({ cardId: "card-1", sourceCardKey: "card-1", periodId: "p2" }),
      unassignedRow({ cardId: "card-2", sourceCardKey: "card-2", periodId: "p3" }),
      unassignedRow({ cardId: "card-3", sourceCardKey: "card-3", periodId: "p4" }),
      unassignedRow({ cardId: "card-4", sourceCardKey: "card-4", periodId: "p5oo" }),
    ]);
    expect(cells).toHaveLength(4);
    expect(new Set(cells.map((c) => c.periodId))).toEqual(new Set(["p2", "p3", "p4", "p5oo"]));
    expect(cells.every((c) => c.teacherAssignmentStatus === "unassigned")).toBe(true);
  });

  it("13) ambiguous mantığı normal (öğretmenli) derslerde korunur", () => {
    const cells = groupAssignmentRows([
      row({ teacherName: "A. Yılmaz", mappingStatus: "ambiguous" }),
      row({ teacherName: "M. Kaya", mappingStatus: "ambiguous" }),
    ]);
    expect(cells[0].mappingStatus).toBe("ambiguous");
    expect(cells[0].teacherAssignmentStatus).toBe("assigned");
  });
});

describe("computeClassTimetableSummary", () => {
  it("12) weeklyLessonCount ham assignment satırı değil benzersiz card/hücre sayısını kullanır", () => {
    const cells = groupAssignmentRows([
      row({ teacherName: "A. Yılmaz" }),
      row({ teacherName: "M. Kaya" }), // aynı card -> aynı hücre, 2 assignment satırı ama 1 hücre
    ]);
    const summary = computeClassTimetableSummary(cells, 5, 10);
    expect(summary.weeklyLessonCount).toBe(1);
    expect(summary.occupiedCellCount).toBe(1);
  });

  it("conflictCellCount, çakışan hücre sayısını (satır değil) sayar", () => {
    const cells = groupAssignmentRows([row({ cardId: "card-1" }), row({ cardId: "card-2", teacherName: "M. Kaya" })]);
    const summary = computeClassTimetableSummary(cells, 5, 10);
    expect(summary.conflictCellCount).toBe(1);
    expect(summary.weeklyLessonCount).toBe(2);
  });

  it("ambiguousCellCount yalnız ambiguous hücreleri sayar", () => {
    const cells = groupAssignmentRows([
      row({ cardId: "card-1", mappingStatus: "exact" }),
      row({ cardId: "card-2", periodId: "period-2", mappingStatus: "ambiguous", teacherName: "M. Kaya" }),
    ]);
    const summary = computeClassTimetableSummary(cells, 5, 10);
    expect(summary.ambiguousCellCount).toBe(1);
  });

  it("5/6) öğretmensiz card weeklyLessonCount ve occupiedCellCount'a dahil edilir", () => {
    const cells = groupAssignmentRows([
      row({ cardId: "card-1", periodId: "period-1" }),
      unassignedRow({ cardId: "card-2", periodId: "period-2" }),
    ]);
    const summary = computeClassTimetableSummary(cells, 5, 10);
    expect(summary.weeklyLessonCount).toBe(2);
    expect(summary.occupiedCellCount).toBe(2);
    // Öğretmensiz ders ambiguous SAYILMAZ (mappingStatus null, 'ambiguous' değil).
    expect(summary.ambiguousCellCount).toBe(0);
  });
});
