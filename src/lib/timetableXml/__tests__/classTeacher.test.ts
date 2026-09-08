import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTimetableXml } from "../parseTimetableXml";
import { buildImportPayload } from "../buildImportPayload";

const __dirname = dirname(fileURLToPath(import.meta.url));
const validXml = readFileSync(join(__dirname, "fixtures/asc-sample.xml"), "utf-8");

const FILE_META = {
  sourceFormat: "asc-timetables",
  sourceFilename: "asc-sample.xml",
  sourceEncoding: "utf-8",
  sourceSha256: "a".repeat(64),
};

describe("SchoolClass.teacherId (sınıf öğretmeni) ayrıştırma", () => {
  it("1) dolu <class teacherid> normalize ediliyor", () => {
    const xml = validXml.replace('<class id="C1" name="5/A" grade="5"/>', '<class id="C1" name="5/A" grade="5" teacherid="T1"/>');
    const result = parseTimetableXml(xml, "with-teacher.xml");
    expect(result.isValid).toBe(true);
    const c1 = result.classes.find((c) => c.id === "C1");
    expect(c1?.teacherId).toBe("T1");
  });

  it("2) boş <class teacherid=\"\"> null/undefined olur", () => {
    const xml = validXml.replace('<class id="C1" name="5/A" grade="5"/>', '<class id="C1" name="5/A" grade="5" teacherid=""/>');
    const result = parseTimetableXml(xml, "empty-teacher.xml");
    expect(result.isValid).toBe(true);
    const c1 = result.classes.find((c) => c.id === "C1");
    expect(c1?.teacherId).toBeUndefined();
  });

  it("teacherid attribute'u hiç yoksa da teacherId undefined olur", () => {
    const result = parseTimetableXml(validXml, "no-teacher-attr.xml");
    expect(result.isValid).toBe(true);
    const c1 = result.classes.find((c) => c.id === "C1");
    expect(c1?.teacherId).toBeUndefined();
  });

  it("3) tanımsız teacherid içeren sınıf reddediliyor (import engellenir)", () => {
    const xml = validXml.replace('<class id="C1" name="5/A" grade="5"/>', '<class id="C1" name="5/A" grade="5" teacherid="GHOST_TEACHER"/>');
    const result = parseTimetableXml(xml, "ghost-teacher.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "UNDEFINED_CLASS_TEACHER_REF")).toBe(true);
    // Sınıf sorumluluğu net olmayan bir kayıt sessizce kabul edilmez: sınıf listeden düşer.
    expect(result.classes.find((c) => c.id === "C1")).toBeUndefined();
  });

  it("whitespace içeren teacherid trim edilerek saklanır", () => {
    const xml = validXml.replace('<class id="C1" name="5/A" grade="5"/>', '<class id="C1" name="5/A" grade="5" teacherid=" T1 "/>');
    const result = parseTimetableXml(xml, "whitespace-teacher.xml");
    expect(result.isValid).toBe(true);
    expect(result.classes.find((c) => c.id === "C1")?.teacherId).toBe("T1");
  });

  it("4) import payload'a classTeacherSourceId doğru aktarılıyor", () => {
    const xmlWithTeacher = validXml.replace(
      '<class id="C1" name="5/A" grade="5"/>',
      '<class id="C1" name="5/A" grade="5" teacherid="T1"/>',
    );
    const result = parseTimetableXml(xmlWithTeacher, "with-teacher.xml");
    const payload = buildImportPayload(result, FILE_META);

    const c1 = payload.classes.find((c) => c.sourceId === "C1");
    const c2 = payload.classes.find((c) => c.sourceId === "C2");
    expect(c1?.classTeacherSourceId).toBe("T1");
    expect(c2?.classTeacherSourceId).toBeNull();
  });
});
