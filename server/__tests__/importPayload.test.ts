import { describe, expect, it } from "vitest";
import { validateImportRequest } from "../validation/importPayload";
import { buildValidImportRequestBody } from "./testFixtures";

describe("validateImportRequest", () => {
  it("2) geçerli payload kabul edilir", () => {
    const result = validateImportRequest(buildValidImportRequestBody());
    expect(result.ok).toBe(true);
  });

  it("2b) geçersiz payload (eksik alan) reddedilir", () => {
    const body = buildValidImportRequestBody();
    // @ts-expect-error kasıtlı olarak zorunlu alanı sil
    delete body.sourceFormat;
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
  });

  it("boş source_id reddedilir", () => {
    const body = buildValidImportRequestBody({ teachers: [{ sourceId: "", name: "X", branch: null }] });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
  });

  it("yinelenen source_id reddedilir", () => {
    const body = buildValidImportRequestBody({
      teachers: [
        { sourceId: "T1", name: "A", branch: null },
        { sourceId: "T1", name: "B", branch: null },
      ],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("yinelenen source_id"))).toBe(true);
  });

  it("negatif/uygunsuz sourceOrder reddedilir", () => {
    const body = buildValidImportRequestBody({
      lessonTeachers: [{ lessonSourceId: "L1", teacherSourceId: "T1", sourceOrder: -1 }],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
  });

  it("tanımsız referans (assignments içinde bilinmeyen teacher) reddedilir", () => {
    const body = buildValidImportRequestBody();
    body.assignments = [{ ...body.assignments[0], teacherSourceId: "GHOST" }];
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("tanımsız teacher referansı"))).toBe(true);
  });

  it("sayım uyuşmazlığı (normalizedAssignmentCount) reddedilir", () => {
    const body = buildValidImportRequestBody({ normalizedAssignmentCount: 99 });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
  });

  it("hatalı mapping_status (ambiguous olması gerekirken exact) reddedilir", () => {
    const body = buildValidImportRequestBody({
      teachers: [
        { sourceId: "T1", name: "A", branch: null },
        { sourceId: "T2", name: "B", branch: null },
      ],
      classes: [
        { sourceId: "C1", name: "1/A", grade: null, classTeacherSourceId: null },
        { sourceId: "C2", name: "1/B", grade: null, classTeacherSourceId: null },
      ],
      lessonTeachers: [
        { lessonSourceId: "L1", teacherSourceId: "T1", sourceOrder: 1 },
        { lessonSourceId: "L1", teacherSourceId: "T2", sourceOrder: 2 },
      ],
      lessonClasses: [
        { lessonSourceId: "L1", classSourceId: "C1", sourceOrder: 1 },
        { lessonSourceId: "L1", classSourceId: "C2", sourceOrder: 2 },
      ],
      // Gerçekte 2 öğretmen × 2 sınıf var (ambiguous olmalı) ama tek bir "exact" atama gönderiliyor.
      normalizedAssignmentCount: 1,
      assignments: [
        {
          sourceCardKey: "card-1",
          lessonSourceId: "L1",
          teacherSourceId: "T1",
          classSourceId: "C1",
          daySourceId: "D1",
          periodSourceId: "P1",
          subjectSourceId: "S1",
          classroom: null,
          mappingStatus: "exact",
        },
      ],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("hatalı mapping_status"))).toBe(true);
  });

  it("3) kritik (severity=error) doğrulama sorunu içeren payload reddedilir", () => {
    const body = buildValidImportRequestBody({
      validationIssues: [
        { severity: "error", code: "NO_SCHEDULE_ENTRIES", message: "test", affectedCount: null, distinctReferenceCount: null },
      ],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("Kritik doğrulama hatası"))).toBe(true);
  });

  it("severity=warning olan doğrulama sorunu importu engellemez", () => {
    const body = buildValidImportRequestBody({
      validationIssues: [
        { severity: "warning", code: "AMBIGUOUS_CARTESIAN_MAPPING", message: "test", affectedCount: 1, distinctReferenceCount: 1 },
      ],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(true);
  });

  it("geçerli classTeacherSourceId (teachers içinde mevcut) kabul edilir", () => {
    const body = buildValidImportRequestBody({
      classes: [{ sourceId: "C1", name: "1/A", grade: null, classTeacherSourceId: "T1" }],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(true);
  });

  it("null classTeacherSourceId kabul edilir", () => {
    const body = buildValidImportRequestBody({
      classes: [{ sourceId: "C1", name: "1/A", grade: null, classTeacherSourceId: null }],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(true);
  });

  it("tanımsız classTeacherSourceId reddedilir", () => {
    const body = buildValidImportRequestBody({
      classes: [{ sourceId: "C1", name: "1/A", grade: null, classTeacherSourceId: "GHOST_TEACHER" }],
    });
    const result = validateImportRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes("tanımsız sınıf öğretmeni"))).toBe(true);
  });
});
