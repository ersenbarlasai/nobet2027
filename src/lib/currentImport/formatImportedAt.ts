/**
 * ISO-8601 UTC zaman damgasını, veritabanındaki değeri DEĞİŞTİRMEDEN,
 * yalnızca görüntüleme amacıyla tr-TR/Europe-Istanbul biçiminde metne çevirir.
 * Örnek: "2026-08-31T20:15:00Z" → "31 Ağustos 2026, 23:15".
 */
export function formatImportedAt(iso: string): string {
  const date = new Date(iso);
  const datePart = new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Istanbul",
  }).format(date);
  const capitalizedDatePart = datePart.replace(/\p{L}+/u, (word) => word.charAt(0).toLocaleUpperCase("tr-TR") + word.slice(1));
  return `${capitalizedDatePart}, ${timePart}`;
}
