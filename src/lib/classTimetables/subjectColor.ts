// Ders adına göre kararlı (deterministik) pastel renk üretir. Aynı ders adı
// her zaman aynı rengi alır; renk yalnız görsel ayırt edicilik sağlar, tek
// başına anlam taşımaz (ör. "kırmızı = tehlike" gibi bir kodlama yok).
// Kontrast okunabilir kalsın diye her giriş koyu bir metin rengiyle eşleşir.
const PALETTE: { bg: string; fg: string; border: string }[] = [
  { bg: "#eaf1ff", fg: "#1d4ed8", border: "#c6d9fb" },
  { bg: "#e8f8ee", fg: "#1a7a3f", border: "#b7e4c7" },
  { bg: "#fdf1e8", fg: "#bc4800", border: "#f5cba7" },
  { bg: "#fbe9f3", fg: "#a3175e", border: "#f3c2de" },
  { bg: "#f1ecfd", fg: "#5b21b6", border: "#dcd0fb" },
  { bg: "#fef6e7", fg: "#92610a", border: "#f5d99b" },
  { bg: "#e6f7f7", fg: "#0f6d6d", border: "#bfe8e8" },
  { bg: "#fdecec", fg: "#c0281c", border: "#f3b7b7" },
  { bg: "#eef4e0", fg: "#4d7c0f", border: "#d3e6b3" },
  { bg: "#ecebf9", fg: "#3730a3", border: "#cfcdf0" },
];

/** Basit, deterministik string hash (FNV benzeri) — aynı girdi her zaman aynı sayıyı üretir. */
function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface SubjectColor {
  bg: string;
  fg: string;
  border: string;
}

export function subjectColor(subjectName: string | null): SubjectColor {
  const key = subjectName ?? "";
  return PALETTE[hashString(key) % PALETTE.length];
}
