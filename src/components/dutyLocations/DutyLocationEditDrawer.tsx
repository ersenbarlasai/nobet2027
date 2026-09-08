import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2, X } from "lucide-react";
import {
  CATEGORY_LABELS,
  DUTY_LOCATION_CATEGORIES,
  type DutyBlock,
  type DutyLocation,
  type DutyLocationBlockPolicyInput,
  type DutyLocationCategory,
} from "../../lib/dutyLocations/types";
import { DutyLocationApiFieldError, updateDutyLocation } from "../../lib/dutyLocations/api";
import DutyLocationBlockPolicyEditor from "./DutyLocationBlockPolicyEditor";
import "./DutyLocationEditDrawer.css";

interface Props {
  item: DutyLocation;
  blocks: DutyBlock[];
  onClose: () => void;
  onSaved: () => void;
}

interface FormValues {
  name: string;
  shortCode: string;
  capacity: string;
  category: DutyLocationCategory;
  description: string;
  isActive: boolean;
  blockPolicies: DutyLocationBlockPolicyInput[];
}

type FieldErrors = Partial<Record<keyof FormValues, string>>;

function completeBlockPolicies(blocks: DutyBlock[], current: DutyLocation["blockPolicies"]): DutyLocationBlockPolicyInput[] {
  return blocks.map((block) => ({
    dutyBlockId: block.id,
    assignmentMode: current.find((policy) => policy.dutyBlockId === block.id)?.assignmentMode ?? "off",
  }));
}

function toValues(item: DutyLocation, blocks: DutyBlock[]): FormValues {
  return {
    name: item.name,
    shortCode: item.shortCode,
    capacity: String(item.capacity),
    category: item.category,
    description: item.description ?? "",
    isActive: item.isActive,
    blockPolicies: completeBlockPolicies(blocks, item.blockPolicies),
  };
}

// shortCode burada KASITLI OLARAK doğrulanmaz/karşılaştırılmaz — salt-okunur
// gösterilir, PATCH isteğine hiç eklenmez (bkz. aşağıdaki input'un
// `disabled` özelliği ve handleSubmit).
function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (name.length < 2 || name.length > 80) errors.name = "Nöbet yeri adı 2-80 karakter arasında olmalı.";
  const capacity = Number(values.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) errors.capacity = "Kapasite 1-20 arasında bir tam sayı olmalı.";
  if (values.description.trim().length > 300) errors.description = "Açıklama en fazla 300 karakter olabilir.";
  return errors;
}

function isDirty(a: FormValues, b: FormValues): boolean {
  return (
    a.name.trim() !== b.name.trim() ||
    a.capacity !== b.capacity ||
    a.category !== b.category ||
    a.description.trim() !== b.description.trim() ||
    a.isActive !== b.isActive
    || JSON.stringify(a.blockPolicies) !== JSON.stringify(b.blockPolicies)
  );
}

export default function DutyLocationEditDrawer({ item, blocks, onClose, onSaved }: Props) {
  const initial = toValues(item, blocks);
  const [values, setValues] = useState<FormValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const firstInput = panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button");
    firstInput?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateField<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(
      "input, select, textarea, button:not(:disabled), [tabindex]:not([tabindex='-1'])",
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const errors = validate(values);
    setFieldErrors(errors);
    setGeneralError(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await updateDutyLocation(item.id, {
        name: values.name.trim(),
        category: values.category,
        capacity: Number(values.capacity),
        description: values.description.trim() === "" ? null : values.description.trim(),
        isActive: values.isActive,
        blockPolicies: values.blockPolicies,
        expectedUpdatedAt: item.updatedAt,
      });
      onSaved();
    } catch (err) {
      if (err instanceof DutyLocationApiFieldError) {
        const field = err.apiError.field as keyof FormValues | undefined;
        if (field && field in initial) {
          setFieldErrors({ [field]: err.apiError.message });
        } else {
          setGeneralError(err.apiError.message);
        }
      } else {
        setGeneralError("Değişiklikler kaydedilemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const dirty = isDirty(values, initial);

  return (
    <div className="dl-drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dl-drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${formId}-title`}
        ref={panelRef}
        onKeyDown={handleKeyDown}
      >
        <div className="dl-drawer-header">
          <h2 id={`${formId}-title`}>Nöbet Yerini Düzenle</h2>
          <button type="button" className="dl-icon-btn" aria-label="Kapat" onClick={onClose}>
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="dl-drawer-form">
          <div className="dl-field">
            <label htmlFor={`${formId}-name`}>Nöbet Yeri Adı</label>
            <input
              id={`${formId}-name`}
              type="text"
              value={values.name}
              onChange={(e) => updateField("name", e.target.value)}
              aria-invalid={!!fieldErrors.name}
            />
            {fieldErrors.name && <p className="dl-field-error">{fieldErrors.name}</p>}
          </div>

          <div className="dl-field">
            <label htmlFor={`${formId}-code`}>Kısa Kod</label>
            <input
              id={`${formId}-code`}
              type="text"
              value={values.shortCode}
              readOnly
              disabled
              aria-describedby={`${formId}-code-hint`}
            />
            <p className="dl-field-hint" id={`${formId}-code-hint`}>
              Kısa kod oluşturulduktan sonra değiştirilemez.
            </p>
          </div>

          <div className="dl-field">
            <label htmlFor={`${formId}-capacity`}>Kapasite</label>
            <input
              id={`${formId}-capacity`}
              type="number"
              min={1}
              max={20}
              value={values.capacity}
              onChange={(e) => updateField("capacity", e.target.value)}
              aria-invalid={!!fieldErrors.capacity}
            />
            {fieldErrors.capacity && <p className="dl-field-error">{fieldErrors.capacity}</p>}
          </div>

          <div className="dl-field">
            <label htmlFor={`${formId}-category`}>Bölge/Kategori</label>
            <select
              id={`${formId}-category`}
              value={values.category}
              onChange={(e) => updateField("category", e.target.value as DutyLocationCategory)}
            >
              {DUTY_LOCATION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="dl-field">
            <label htmlFor={`${formId}-desc`}>Açıklama</label>
            <textarea
              id={`${formId}-desc`}
              rows={3}
              value={values.description}
              onChange={(e) => updateField("description", e.target.value)}
              aria-invalid={!!fieldErrors.description}
            />
            {fieldErrors.description && <p className="dl-field-error">{fieldErrors.description}</p>}
          </div>

          <label className="dl-toggle-row" htmlFor={`${formId}-toggle`}>
            <span className="dl-toggle-text">
              <span className="dl-toggle-title">Nöbet planında kullan</span>
              <span className="dl-toggle-desc">Bu yer otomatik atamalara dahil edilsin</span>
            </span>
            <input
              id={`${formId}-toggle`}
              type="checkbox"
              className="dl-toggle-input"
              checked={values.isActive}
              onChange={(e) => updateField("isActive", e.target.checked)}
            />
            <span className="dl-toggle-switch" aria-hidden="true" />
          </label>

          <DutyLocationBlockPolicyEditor
            blocks={blocks}
            value={values.blockPolicies}
            onChange={(blockPolicies) => updateField("blockPolicies", blockPolicies)}
            disabled={submitting}
          />

          {generalError && (
            <div className="alert alert-error" role="alert">
              <span>{generalError}</span>
            </div>
          )}

          <div className="dl-drawer-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
              Vazgeç
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting || !dirty}>
              {submitting ? (
                <>
                  <Loader2 size={16} className="spin" aria-hidden="true" />
                  Kaydediliyor…
                </>
              ) : (
                "Değişiklikleri Kaydet"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
