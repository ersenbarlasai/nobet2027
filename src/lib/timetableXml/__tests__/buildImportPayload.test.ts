import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportPayload } from "../buildImportPayload";
import { parseTimetableXml } from "../parseTimetableXml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const validXml = readFileSync(join(__dirname, "fixtures/asc-sample.xml"), "utf-8");

describe("buildImportPayload", () => {
  it("ham kart ve normalize atama sayımlarını doğru taşır", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    const payload = buildImportPayload(result, {
      sourceFormat: "asc-timetables",
      sourceFilename: "asc-sample.xml",
      sourceEncoding: "utf-8",
      sourceSha256: "a".repeat(64),
    });

    expect(payload.sourceCardCount).toBe(4);
    expect(payload.normalizedAssignmentCount).toBe(8);
    expect(payload.cards).toHaveLength(4);
    expect(payload.assignments).toHaveLength(8);
    expect(payload.teachers).toHaveLength(3);
    expect(payload.classes).toHaveLength(2);
  });

  it("ambiguous mapping_status'u payload'a olduğu gibi aktarır", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    const payload = buildImportPayload(result, {
      sourceFormat: "asc-timetables",
      sourceFilename: "asc-sample.xml",
      sourceEncoding: "utf-8",
      sourceSha256: "a".repeat(64),
    });

    const l4Assignments = payload.assignments.filter((a) => a.lessonSourceId === "L4");
    expect(l4Assignments).toHaveLength(4);
    expect(l4Assignments.every((a) => a.mappingStatus === "ambiguous")).toBe(true);
  });

  it("hata ve uyarıları severity ile birleştirip validationIssues dizisine koyar", () => {
    const xml = validXml.replace('teacherids="T1"/>', 'teacherids="GHOST"/>');
    const result = parseTimetableXml(xml, "undefined-ref.xml");
    const payload = buildImportPayload(result, {
      sourceFormat: "asc-timetables",
      sourceFilename: "undefined-ref.xml",
      sourceEncoding: "utf-8",
      sourceSha256: "b".repeat(64),
    });

    const warning = payload.validationIssues.find((i) => i.code === "UNDEFINED_TEACHER_REF");
    expect(warning?.severity).toBe("warning");
    expect(warning?.distinctReferenceCount).toBe(1);
  });
});
