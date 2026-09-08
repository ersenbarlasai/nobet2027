/**
 * Paket adayı üretimi — saf fonksiyon, DB'ye erişmez. Girdi tamamen
 * `get_duty_plan_generation_snapshot`'ın döndürdüğü `locations`/`tasks`/
 * `candidateEdges`'ten gelir. Hiçbir yer adı/UUID'i hard-code EDİLMEZ —
 * FULL_DAY/SHORT_BREAKS şablonları yerin `activeBlockCodes` kümesinden
 * türetilir (bkz. supabase migration classify_duty_plan_package_coverage
 * ile AYNI sınıflandırma mantığı, yalnız TS tarafında).
 */

import type { DutyBlockCode } from "../../services/dutyBlocks";
import type { CandidateEdge, DutyTask } from "./solver";
import { taskKey } from "./solver";

export const FULL_DAY_BLOCK_CODES: readonly DutyBlockCode[] = ["MORNING_BREAKS", "LONG_BREAK_1", "LONG_BREAK_2", "AFTERNOON_BREAKS"];
export const SHORT_BREAKS_BLOCK_CODES: readonly DutyBlockCode[] = ["MORNING_BREAKS", "AFTERNOON_BREAKS"];

export interface DutyPlanLocationRef {
  id: string;
  shortCode: string;
  category: string;
  allowsFixedAssignment: boolean;
  activeBlockCodes: DutyBlockCode[];
}

/** `DutyTask` + sınıflandırma için gereken `blockCode` (solveDutyPlan bunu istemez). */
export interface PackageDutyTask extends DutyTask {
  blockCode: DutyBlockCode;
}

export type PackageCoverageMode = "FULL_DAY" | "SHORT_BREAKS";

export interface PackageCandidate {
  dayOrder: number;
  dutyLocationId: string;
  coverageMode: PackageCoverageMode;
  /** Bu paketin kapsadığı hücreler (blockCode sırasına göre). */
  cells: PackageDutyTask[];
  /** Bu hücrelerin TAMAMINDA candidate olan öğretmenler (kesişim), artan sırada. */
  teacherSourceIds: string[];
}

function sameCodeSet(a: readonly DutyBlockCode[], b: readonly DutyBlockCode[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((code, i) => code === sortedB[i]);
}

/**
 * (day, location) çiftleri için FULL_DAY (yerin aktif blok kümesi TAM OLARAK
 * dört bloğun tümüyse) ve SHORT_BREAKS (yerin aktif blokları arasında
 * MORNING_BREAKS+AFTERNOON_BREAKS'in İKİSİ de varsa — dört bloklu yerlerde
 * FULL_DAY'e ek YEDEK olarak da üretilir) aday paketlerini üretir.
 * allowsFixedAssignment=true yerler (sabit nöbet) hiçbir zaman aday ÜRETMEZ
 * — onlar solver'ın candidateEdges'ine zaten girmiyor (bkz. snapshot).
 */
export function buildPackageCandidates(
  locations: DutyPlanLocationRef[],
  tasks: PackageDutyTask[],
  candidateEdges: CandidateEdge[],
): PackageCandidate[] {
  const locationById = new Map(locations.map((l) => [l.id, l]));

  const tasksByDayLocation = new Map<string, PackageDutyTask[]>();
  for (const t of tasks) {
    const key = `${t.dayOrder}|${t.dutyLocationId}`;
    const list = tasksByDayLocation.get(key);
    if (list) list.push(t);
    else tasksByDayLocation.set(key, [t]);
  }

  const teachersByCellKey = new Map<string, Set<string>>();
  for (const e of candidateEdges) {
    const key = taskKey(e);
    const set = teachersByCellKey.get(key);
    if (set) set.add(e.teacherSourceId);
    else teachersByCellKey.set(key, new Set([e.teacherSourceId]));
  }

  function intersectionOfCandidates(cells: PackageDutyTask[]): string[] {
    if (cells.length === 0) return [];
    let result: Set<string> | null = null;
    for (const cell of cells) {
      const teachers = teachersByCellKey.get(taskKey(cell)) ?? new Set<string>();
      if (result === null) {
        result = new Set(teachers);
      } else {
        for (const t of Array.from(result)) {
          if (!teachers.has(t)) result.delete(t);
        }
      }
      if (result.size === 0) break;
    }
    return Array.from(result ?? []).sort((a, b) => a.localeCompare(b));
  }

  const candidates: PackageCandidate[] = [];

  for (const [key, cellsForLocation] of tasksByDayLocation) {
    const [dayOrderStr, dutyLocationId] = key.split("|");
    const dayOrder = Number(dayOrderStr);
    const location = locationById.get(dutyLocationId);
    if (!location || location.allowsFixedAssignment) continue;

    const codesPresent = new Set(cellsForLocation.map((c) => c.blockCode));
    const blockByCode = new Map(cellsForLocation.map((c) => [c.blockCode, c]));

    if (sameCodeSet(location.activeBlockCodes, FULL_DAY_BLOCK_CODES) && FULL_DAY_BLOCK_CODES.every((c) => codesPresent.has(c))) {
      const cells = FULL_DAY_BLOCK_CODES.map((c) => blockByCode.get(c)).filter((c): c is PackageDutyTask => Boolean(c));
      if (cells.length === FULL_DAY_BLOCK_CODES.length) {
        const teacherSourceIds = intersectionOfCandidates(cells);
        if (teacherSourceIds.length > 0) {
          candidates.push({ dayOrder, dutyLocationId, coverageMode: "FULL_DAY", cells, teacherSourceIds });
        }
      }
    }

    if (SHORT_BREAKS_BLOCK_CODES.every((c) => codesPresent.has(c))) {
      const cells = SHORT_BREAKS_BLOCK_CODES.map((c) => blockByCode.get(c)).filter((c): c is PackageDutyTask => Boolean(c));
      if (cells.length === SHORT_BREAKS_BLOCK_CODES.length) {
        const teacherSourceIds = intersectionOfCandidates(cells);
        if (teacherSourceIds.length > 0) {
          candidates.push({ dayOrder, dutyLocationId, coverageMode: "SHORT_BREAKS", cells, teacherSourceIds });
        }
      }
    }
  }

  // Deterministik sıra — "en kısıtlı önce" (most-constrained-first, CSP'de
  // klasik bir sezgisel): gün, sonra coverageMode (o GÜNÜN TÜM FULL_DAY
  // adayları, o günün TÜM SHORT_BREAKS adaylarından ÖNCE — konum bazında
  // değil, GÜN GENELİNDE), sonra aday öğretmen havuzu KÜÇÜKTEN BÜYÜĞE
  // (kıtlığı en fazla olan yer ÖNCE işlenir — bol adaylı bir yer, kıt bir
  // yerin TEK adayını "çalıp" onu SINGLE_BLOCK'a düşürmesin diye), son
  // eşitlikte shortCode. BULGU: eski sıralama (yer sonra coverageMode)
  // greedy'nin, bol adaylı bir yeri ÖNCE işleyip kıt adaylı bir BAŞKA yerin
  // TEK adayını gereksiz yere kilitlemesine — dolayısıyla AYNI toplam
  // kapsamada ULAŞILABİLİR daha fazla FULL_DAY kombinasyonunu KAÇIRMASINA
  // yol açabiliyordu (bkz. packageSolver.test.ts "kıtlık sırası" testi).
  candidates.sort((a, b) => {
    if (a.dayOrder !== b.dayOrder) return a.dayOrder - b.dayOrder;
    if (a.coverageMode !== b.coverageMode) return a.coverageMode === "FULL_DAY" ? -1 : 1;
    if (a.teacherSourceIds.length !== b.teacherSourceIds.length) return a.teacherSourceIds.length - b.teacherSourceIds.length;
    const locA = locationById.get(a.dutyLocationId);
    const locB = locationById.get(b.dutyLocationId);
    const codeA = locA?.shortCode ?? a.dutyLocationId;
    const codeB = locB?.shortCode ?? b.dutyLocationId;
    return codeA.localeCompare(codeB);
  });

  return candidates;
}
