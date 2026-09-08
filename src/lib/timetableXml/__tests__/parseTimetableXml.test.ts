import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTimetableXml } from "../parseTimetableXml";
import { decodeXmlBytes, sniffDeclaredEncoding } from "../xmlFile";

const __dirname = dirname(fileURLToPath(import.meta.url));
const validXml = readFileSync(join(__dirname, "fixtures/asc-sample.xml"), "utf-8");

function withoutSection(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, "m");
  return xml.replace(re, "");
}

describe("parseTimetableXml", () => {
  it("1) geçerli örnek XML'i hatasız ayrıştırır", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    expect(result.validationErrors).toEqual([]);
    expect(result.isValid).toBe(true);
  });

  it("2) bozuk XML sözdizimini XML_MALFORMED olarak raporlar", () => {
    const broken = validXml.replace("</teachers>", "");
    const result = parseTimetableXml(broken, "broken.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors[0].code).toBe("XML_MALFORMED");
  });

  it("3) boş dosyayı FILE_EMPTY olarak raporlar", () => {
    const result = parseTimetableXml("", "empty.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors[0].code).toBe("FILE_EMPTY");
  });

  it("4) beklenmeyen kök elemanı UNSUPPORTED_STRUCTURE olarak raporlar", () => {
    const result = parseTimetableXml("<foo><bar/></foo>", "wrong-root.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors[0].code).toBe("UNSUPPORTED_STRUCTURE");
  });

  it("5) eksik öğretmen bölümünü MISSING_SECTION olarak raporlar", () => {
    const xml = withoutSection(validXml, "teachers");
    const result = parseTimetableXml(xml, "no-teachers.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "MISSING_SECTION")).toBe(true);
  });

  it("6) eksik sınıf bölümünü MISSING_SECTION olarak raporlar", () => {
    const xml = withoutSection(validXml, "classes");
    const result = parseTimetableXml(xml, "no-classes.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "MISSING_SECTION")).toBe(true);
  });

  it("7) yinelenen öğretmen kimliğini DUPLICATE_ID olarak raporlar", () => {
    const xml = validXml.replace('id="T2" name="KAYA MEHMET"', 'id="T1" name="KAYA MEHMET"');
    const result = parseTimetableXml(xml, "dup-id.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "DUPLICATE_ID")).toBe(true);
  });

  it("8) tanımsız öğretmene referans veren kaydı uyarı olarak raporlar ve atlar", () => {
    const xml = validXml.replace('teacherids="T1"/>', 'teacherids="GHOST"/>');
    const result = parseTimetableXml(xml, "undefined-ref.xml");
    expect(result.validationWarnings.some((w) => w.code === "UNDEFINED_TEACHER_REF")).toBe(true);
    // Yalnızca L1 (tek başına teacherids="T1") değişti; L4 içindeki "T1,T2" etkilenmez.
    // L1/card1 atlandığı için kalan kayıtlar (L2→1, L3→2, L4→4) hâlâ üretilir.
    expect(result.scheduleEntries.length).toBe(7);
  });

  it("9) hiç atama kaydı bulunmadığında NO_SCHEDULE_ENTRIES kritik hatası verir", () => {
    const xml = withoutSection(validXml, "cards").replace(
      "</lessons>",
      '</lessons><cards options="canadd" columns="lessonid,period,days"></cards>',
    );
    const result = parseTimetableXml(xml, "no-cards.xml");
    expect(result.isValid).toBe(false);
    expect(result.validationErrors.some((e) => e.code === "NO_SCHEDULE_ENTRIES")).toBe(true);
    expect(result.scheduleEntries).toEqual([]);
  });

  it("10) gerçek istatistikleri doğru hesaplar (ham kart vs. normalize atama)", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    expect(result.stats).toEqual({
      teacherCount: 3,
      classCount: 2,
      dayCount: 5,
      periodCount: 2,
      sourceCardCount: 4, // L1,L2,L3,L4 için birer <card>
      scheduleEntryCount: 8, // L1→1, L2→1, L3(2 sınıf)→2, L4(2 öğretmen×2 sınıf)→4
    });
  });

  it("11) çoklu sınıflı lesson (L3) tek öğretmen × 2 sınıf için 2 atama üretir", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    const l3Entries = result.scheduleEntries.filter((e) => e.sourceLessonId === "L3");
    expect(l3Entries).toHaveLength(2);
    expect(new Set(l3Entries.map((e) => e.classId))).toEqual(new Set(["C1", "C2"]));
    expect(l3Entries.every((e) => e.teacherId === "T3")).toBe(true);
  });

  it("12) çoklu öğretmenli+çoklu sınıflı lesson (L4) kartezyen 2×2=4 atama üretir ve AMBIGUOUS_CARTESIAN_MAPPING uyarısı verir", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    const l4Entries = result.scheduleEntries.filter((e) => e.sourceLessonId === "L4");
    expect(l4Entries).toHaveLength(4);
    const pairs = new Set(l4Entries.map((e) => `${e.teacherId}-${e.classId}`));
    expect(pairs).toEqual(new Set(["T1-C1", "T1-C2", "T2-C1", "T2-C2"]));
    expect(result.validationWarnings.some((w) => w.code === "AMBIGUOUS_CARTESIAN_MAPPING")).toBe(true);
    expect(l4Entries.every((e) => e.mappingStatus === "ambiguous")).toBe(true);
  });

  it("12b) mappingStatus exact/expanded doğru atanır, ham koleksiyonlar (subjects/lessons/lessonTeachers/lessonClasses/cards) üretilir", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");

    const l1Entry = result.scheduleEntries.find((e) => e.sourceLessonId === "L1");
    expect(l1Entry?.mappingStatus).toBe("exact");

    const l3Entries = result.scheduleEntries.filter((e) => e.sourceLessonId === "L3");
    expect(l3Entries.every((e) => e.mappingStatus === "expanded")).toBe(true);

    expect(result.subjects).toEqual([{ id: "S1", name: "Matematik", shortName: "MAT" }]);
    expect(result.lessons.map((l) => l.id).sort()).toEqual(["L1", "L2", "L3", "L4"]);
    expect(result.lessons.every((l) => l.subjectId === "S1")).toBe(true);
    // Ham kart sayısı (sourceCardCount) tam olarak <card> eleman sayısıyla eşleşir.
    expect(result.cards).toHaveLength(4);
    expect(result.stats.sourceCardCount).toBe(4);
    // lessonTeachers/lessonClasses, XML'deki virgülle ayrılmış sırayı (sourceOrder) korur.
    const l4Teachers = result.lessonTeachers.filter((lt) => lt.lessonId === "L4").sort((a, b) => a.sourceOrder - b.sourceOrder);
    expect(l4Teachers.map((lt) => lt.teacherId)).toEqual(["T1", "T2"]);
    expect(l4Teachers.map((lt) => lt.sourceOrder)).toEqual([1, 2]);
  });

  it("13) her atama kaydı kaynak lesson/card kimliğini taşır (izlenebilirlik)", () => {
    const result = parseTimetableXml(validXml, "asc-sample.xml");
    for (const entry of result.scheduleEntries) {
      expect(entry.sourceLessonId).toBeTruthy();
      expect(entry.sourceCardId).toBeTruthy();
    }
    // L3'ün tek kartından üretilen 2 atama aynı sourceCardId'yi paylaşır.
    const l3Entries = result.scheduleEntries.filter((e) => e.sourceLessonId === "L3");
    expect(new Set(l3Entries.map((e) => e.sourceCardId)).size).toBe(1);
  });

  it("14) tanımsız lesson referansı UNDEFINED_LESSON_REF uyarısı verir ve o kartı atlar", () => {
    const xml = validXml.replace('<card lessonid="L1" period="1" days="10000"/>', '<card lessonid="GHOST_LESSON" period="1" days="10000"/>');
    const result = parseTimetableXml(xml, "undefined-lesson.xml");
    expect(result.validationWarnings.some((w) => w.code === "UNDEFINED_LESSON_REF")).toBe(true);
    expect(result.scheduleEntries.some((e) => e.sourceLessonId === "L1")).toBe(false);
  });

  it("15) tanımsız sınıf referansı UNDEFINED_CLASS_REF uyarısı verir ve o atamayı atlar", () => {
    const xml = validXml.replace('classids="C1" teacherids="T1"', 'classids="GHOST_CLASS" teacherids="T1"');
    const result = parseTimetableXml(xml, "undefined-class.xml");
    expect(result.validationWarnings.some((w) => w.code === "UNDEFINED_CLASS_REF")).toBe(true);
    expect(result.scheduleEntries.some((e) => e.sourceLessonId === "L1")).toBe(false);
  });

  it("16) tanımsız gün deseni UNDEFINED_DAY_REF uyarısı verir ve o kartı atlar", () => {
    const xml = validXml.replace('<card lessonid="L2" period="2" days="01000"/>', '<card lessonid="L2" period="2" days="00000"/>');
    const result = parseTimetableXml(xml, "undefined-day.xml");
    expect(result.validationWarnings.some((w) => w.code === "UNDEFINED_DAY_REF")).toBe(true);
    expect(result.scheduleEntries.some((e) => e.sourceLessonId === "L2")).toBe(false);
  });

  it("17) tanımsız ders saati referansı UNDEFINED_PERIOD_REF uyarısı verir ve o kartı atlar", () => {
    const xml = validXml.replace('<card lessonid="L2" period="2" days="01000"/>', '<card lessonid="L2" period="99" days="01000"/>');
    const result = parseTimetableXml(xml, "undefined-period.xml");
    expect(result.validationWarnings.some((w) => w.code === "UNDEFINED_PERIOD_REF")).toBe(true);
    expect(result.scheduleEntries.some((e) => e.sourceLessonId === "L2")).toBe(false);
  });

  it("18) benzersiz hatalı öğretmen kimliği sayısı ile etkilenen kayıt sayısı karıştırılmaz", () => {
    // 2 farklı geçersiz öğretmen kimliği (GHOST_A, GHOST_B), toplam 3 karttan referans veriliyor.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<timetable ascttversion="2023.12.1" importtype="database">
  <periods columns="period,name"><period name="1" period="1"/></periods>
  <daysdefs columns="id,days,name"><daysdef id="D1" name="Pazartesi" days="10000"/></daysdefs>
  <teachers columns="id,name"><teacher id="T1" name="TEST"/></teachers>
  <classes columns="id,name"><class id="C1" name="1/A"/></classes>
  <lessons columns="id,subjectid,classids,teacherids">
    <lesson id="L1" subjectid="" classids="C1" teacherids="GHOST_A"/>
    <lesson id="L2" subjectid="" classids="C1" teacherids="GHOST_A"/>
    <lesson id="L3" subjectid="" classids="C1" teacherids="GHOST_B"/>
  </lessons>
  <cards columns="lessonid,period,days">
    <card lessonid="L1" period="1" days="10000"/>
    <card lessonid="L2" period="1" days="10000"/>
    <card lessonid="L3" period="1" days="10000"/>
  </cards>
</timetable>`;
    const result = parseTimetableXml(xml, "unique-vs-affected.xml");
    const warning = result.validationWarnings.find((w) => w.code === "UNDEFINED_TEACHER_REF");
    expect(warning).toBeDefined();
    expect(warning!.distinctReferenceCount).toBe(2);
    expect(warning!.affectedCount).toBe(3);
  });

  it("19) windows-1254 kodlamalı Türkçe karakterleri doğru çözer", () => {
    // "ÇĞıŞİşöüğç" dizesinin windows-1254 bayt karşılıkları (elle doğrulanmış).
    const turkishBytes = [0xc7, 0xd0, 0xfd, 0xde, 0xdd, 0xfe, 0xf6, 0xfc, 0xf0, 0xe7];
    const prefix = '<?xml version="1.0" encoding="windows-1254"?><root name="';
    const suffix = '"/>';
    const bytes = new Uint8Array([
      ...Array.from(prefix, (c) => c.charCodeAt(0)),
      ...turkishBytes,
      ...Array.from(suffix, (c) => c.charCodeAt(0)),
    ]);

    expect(sniffDeclaredEncoding(bytes)).toBe("windows-1254");

    const decoded = decodeXmlBytes(bytes.buffer);
    expect(decoded).toContain('name="ÇĞıŞİşöüğç"');
  });
});
