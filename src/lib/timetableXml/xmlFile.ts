export const MAX_XML_FILE_SIZE = 5 * 1024 * 1024;

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

/** İstemci tarafı ön kontrol: yalnızca uzantı ve boyut. İçerik burada okunmaz. */
export function validateXmlFileCandidate(file: File): FileValidationResult {
  if (!file.name.toLowerCase().endsWith(".xml")) {
    return { valid: false, error: "Yalnızca .xml uzantılı dosyalar desteklenir." };
  }
  if (file.size > MAX_XML_FILE_SIZE) {
    return { valid: false, error: "Dosya boyutu 5MB sınırını aşıyor." };
  }
  return { valid: true };
}

const SUPPORTED_DECODERS = new Set([
  "utf-8",
  "utf8",
  "windows-1254",
  "iso-8859-9",
  "windows-1252",
  "iso-8859-1",
]);

/**
 * XML bildirimindeki encoding beyanını, dosyanın ilk birkaç yüz baytını
 * ASCII olarak okuyup regex ile arayarak tespit eder. `<?xml ... ?>`
 * bildirimi her zaman ASCII uyumlu baytlarla başladığı için bu güvenlidir.
 */
export function sniffDeclaredEncoding(bytes: Uint8Array): string {
  const head = bytes.subarray(0, Math.min(bytes.length, 200));
  let ascii = "";
  for (let i = 0; i < head.length; i++) {
    ascii += String.fromCharCode(head[i]);
  }
  const match = ascii.match(/^<\?xml[^>]*encoding=["']([^"']+)["']/i);
  const declared = match?.[1]?.toLowerCase().trim();
  if (declared && SUPPORTED_DECODERS.has(declared)) {
    return declared;
  }
  return "utf-8";
}

/** Ham dosya baytlarını, XML bildirimindeki encoding'e göre metne çözer. */
export function decodeXmlBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const encoding = sniffDeclaredEncoding(bytes);
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function bytesToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface XmlFileReadResult {
  text: string;
  encoding: string;
  /** Ham dosya baytlarının SHA-256 özeti (hex), Web Crypto ile tarayıcıda hesaplanır. */
  sha256: string;
  byteLength: number;
}

/**
 * Dosyayı tarayıcıda okur; sunucuya hiçbir istek yapmaz. Metni, tespit
 * edilen encoding'i ve ham baytların SHA-256 özetini birlikte döner —
 * içe aktarma isteği bu üçünü de taşımak zorundadır (bkz. buildImportPayload.ts).
 */
export async function readXmlFile(file: File): Promise<XmlFileReadResult> {
  const buffer = await file.arrayBuffer();
  const encoding = sniffDeclaredEncoding(new Uint8Array(buffer));
  const text = decodeXmlBytes(buffer);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return { text, encoding, sha256: bytesToHex(digest), byteLength: buffer.byteLength };
}
