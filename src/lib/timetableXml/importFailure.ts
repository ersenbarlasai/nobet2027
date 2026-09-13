export type ImportBlockerType = "duty_plan" | "exam_plan" | "substitution_list";

export interface ImportBlocker {
  id: string;
  name: string;
  type: ImportBlockerType;
}

export interface ImportFailure {
  message: string;
  detail: string | null;
  blockers: ImportBlocker[];
  referenceId: string | null;
}

const FALLBACK_MESSAGE = "Veriler kaydedilemedi. Veritabanında değişiklik yapılmadı.";

function isBlocker(value: unknown): value is ImportBlocker {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.type === "duty_plan" || item.type === "exam_plan" || item.type === "substitution_list")
  );
}

/** Sunucunun güvenli hata gövdesini kullanıcıya anlamlı ve eyleme dönük hale getirir. */
export async function readImportFailure(response: Response): Promise<ImportFailure> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // HTML/boş platform yanıtında HTTP durumuna göre güvenli mesaj gösterilir.
  }

  const blockers = Array.isArray(body.items) ? body.items.filter(isBlocker) : [];
  const serverMessage = typeof body.message === "string" ? body.message : null;
  const detail = typeof body.detail === "string" && body.detail !== serverMessage ? body.detail : null;
  const referenceId = typeof body.referenceId === "string" ? body.referenceId : null;

  if (body.error === "open_work_blocks_import") {
    return {
      message: serverMessage ?? "Yeni XML yüklenmeden önce açık çalışmalar tamamlanmalı veya silinmelidir.",
      detail: "Aşağıdaki çalışmalar mevcut XML verisine bağlı olduğu için yeni dosya güvenli biçimde yüklenemez.",
      blockers,
      referenceId,
    };
  }
  if (response.status === 401) return { message: "Oturumunuz sona ermiş. Yeniden giriş yapıp tekrar deneyin.", detail: null, blockers: [], referenceId };
  if (response.status === 413) return { message: serverMessage ?? "İçe aktarma verisi sunucu boyut sınırını aşıyor.", detail, blockers: [], referenceId };
  if (response.status === 400) return { message: serverMessage ?? "XML verileri sunucu doğrulamasından geçemedi.", detail, blockers: [], referenceId };

  return { message: serverMessage ?? FALLBACK_MESSAGE, detail, blockers, referenceId };
}

export function networkImportFailure(): ImportFailure {
  return {
    message: "Sunucuya ulaşılamadı. İnternet bağlantısını kontrol edip tekrar deneyin.",
    detail: null,
    blockers: [],
    referenceId: null,
  };
}
