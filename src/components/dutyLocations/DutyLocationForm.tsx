import { useId, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Plus } from "lucide-react";
import {
  CATEGORY_LABELS,
  DUTY_LOCATION_CATEGORIES,
  type DutyBlock,
  type DutyLocationBlockPolicyInput,
  type DutyLocationCategory,
} from "../../lib/dutyLocations/types";
import { createDutyLocation, DutyLocationApiFieldError } from "../../lib/dutyLocations/api";
import DutyLocationBlockPolicyEditor from "./DutyLocationBlockPolicyEditor";
import "./DutyLocationForm.css";

interface FormValues {
  name: string;
  shortCode: string;
  capacity: string;
  category: DutyLocationCategory;
  description: string;
  isActive: boolean;
  blockPolicies: DutyLocationBlockPolicyInput[];
}

const INITIAL_VALUES: FormValues = {
  name: "",
  shortCode: "",
  capacity: "1",
  category: "garden",
  description: "",
  isActive: true,
  blockPolicies: [],
};

type FieldErrors = Partial<Record<keyof FormValues, string>>;

const SHORT_CODE_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;

function validate(values: FormValues): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (name.length < 2 || name.length > 80) {
    errors.name = "Nöbet yeri adı 2-80 karakter arasında olmalı.";
  }
  const shortCode = values.shortCode.trim().toUpperCase();
  if (shortCode.length < 2 || shortCode.length > 16 || !SHORT_CODE_PATTERN.test(shortCode)) {
    errors.shortCode = "Kısa kod yalnız büyük harf, rakam ve tek tirelerden oluşabilir (ör. ON-BAH).";
  }
  const capacity = Number(values.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 20) {
    errors.capacity = "Kapasite 1-20 arasında bir tam sayı olmalı.";
  }
  if (values.description.trim().length > 300) {
    errors.description = "Açıklama en fazla 300 karakter olabilir.";
  }
  return errors;
}

function defaultPolicies(blocks: DutyBlock[]): DutyLocationBlockPolicyInput[] {
  return blocks.map((block) => ({ dutyBlockId: block.id, assignmentMode: "normal" }));
}

export default function DutyLocationForm({ blocks, onCreated }: { blocks: DutyBlock[]; onCreated: () => void }) {
  const [values, setValues] = useState<FormValues>(() => ({ ...INITIAL_VALUES, blockPolicies: defaultPolicies(blocks) }));
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formId = useId();

  function updateField<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    setSuccessMessage(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const errors = validate(values);
    setFieldErrors(errors);
    setGeneralError(null);
    setSuccessMessage(null);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      await createDutyLocation({
        name: values.name.trim(),
        shortCode: values.shortCode.trim().toUpperCase(),
        category: values.category,
        capacity: Number(values.capacity),
        description: values.description.trim() === "" ? null : values.description.trim(),
        isActive: values.isActive,
        blockPolicies: values.blockPolicies,
      });
      setValues({ ...INITIAL_VALUES, blockPolicies: defaultPolicies(blocks) });
      setSuccessMessage("Nöbet yeri başarıyla eklendi.");
      onCreated();
    } catch (err) {
      if (err instanceof DutyLocationApiFieldError) {
        const field = err.apiError.field as keyof FormValues | undefined;
        if (field && field in INITIAL_VALUES) {
          setFieldErrors({ [field]: err.apiError.message });
        } else {
          setGeneralError(err.apiError.message);
        }
      } else {
        setGeneralError("Nöbet yeri eklenemedi. Yerel API bağlantısını kontrol edip tekrar deneyin.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dl-form-card">
      <h2 className="dl-form-title">Yeni Nöbet Yeri Ekle</h2>
      <form onSubmit={handleSubmit} noValidate>
        <div className="dl-field">
          <label htmlFor={`${formId}-name`}>Nöbet Yeri Adı</label>
          <input
            id={`${formId}-name`}
            type="text"
            placeholder="Örn: Ön Bahçe"
            value={values.name}
            onChange={(e) => updateField("name", e.target.value)}
            aria-invalid={!!fieldErrors.name}
            aria-describedby={fieldErrors.name ? `${formId}-name-error` : undefined}
          />
          {fieldErrors.name && (
            <p className="dl-field-error" id={`${formId}-name-error`}>
              {fieldErrors.name}
            </p>
          )}
        </div>

        <div className="dl-field">
          <label htmlFor={`${formId}-code`}>Kısa Kod</label>
          <input
            id={`${formId}-code`}
            type="text"
            placeholder="Örn: ON-BAH"
            value={values.shortCode}
            onChange={(e) => updateField("shortCode", e.target.value)}
            aria-invalid={!!fieldErrors.shortCode}
            aria-describedby={fieldErrors.shortCode ? `${formId}-code-error` : undefined}
          />
          {fieldErrors.shortCode && (
            <p className="dl-field-error" id={`${formId}-code-error`}>
              {fieldErrors.shortCode}
            </p>
          )}
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
            aria-describedby={`${formId}-capacity-hint${fieldErrors.capacity ? ` ${formId}-capacity-error` : ""}`}
          />
          <p className="dl-field-hint" id={`${formId}-capacity-hint`}>
            Aynı anda görevli
          </p>
          {fieldErrors.capacity && (
            <p className="dl-field-error" id={`${formId}-capacity-error`}>
              {fieldErrors.capacity}
            </p>
          )}
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
            placeholder="Görev talimatları veya notlar..."
            value={values.description}
            onChange={(e) => updateField("description", e.target.value)}
            aria-invalid={!!fieldErrors.description}
            aria-describedby={fieldErrors.description ? `${formId}-desc-error` : undefined}
          />
          {fieldErrors.description && (
            <p className="dl-field-error" id={`${formId}-desc-error`}>
              {fieldErrors.description}
            </p>
          )}
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
        {successMessage && (
          <div className="alert alert-success" role="status">
            <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" />
            <span>{successMessage}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary dl-form-submit" disabled={submitting || blocks.length !== 4}>
          {submitting ? (
            <>
              <Loader2 size={16} className="spin" aria-hidden="true" />
              Ekleniyor…
            </>
          ) : (
            <>
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
              Nöbet Yeri Ekle
            </>
          )}
        </button>
      </form>
    </div>
  );
}
