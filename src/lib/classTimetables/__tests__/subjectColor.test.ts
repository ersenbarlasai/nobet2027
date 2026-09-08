import { describe, expect, it } from "vitest";
import { subjectColor } from "../subjectColor";

describe("subjectColor", () => {
  it("27) aynı ders adı için her zaman aynı rengi üretir (deterministik)", () => {
    expect(subjectColor("Matematik")).toEqual(subjectColor("Matematik"));
    expect(subjectColor("Türkçe")).toEqual(subjectColor("Türkçe"));
  });

  it("farklı ders adları genellikle farklı renk verir", () => {
    expect(subjectColor("Matematik")).not.toEqual(subjectColor("Beden Eğitimi"));
  });

  it("null ders adı için de bir renk döner (çökmez)", () => {
    expect(() => subjectColor(null)).not.toThrow();
  });
});
