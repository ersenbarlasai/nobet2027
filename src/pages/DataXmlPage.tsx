import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  UploadCloud,
  FileText,
  Info,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import {
  buildUnreadableFileResult,
  parseTimetableXml,
} from "../lib/timetableXml/parseTimetableXml";
import { readXmlFile, validateXmlFileCandidate } from "../lib/timetableXml/xmlFile";
import { buildImportPayload } from "../lib/timetableXml/buildImportPayload";
import { ASC_FORMAT_ID } from "../lib/timetableXml/ascAdapter";
import type { TimetableImportResult } from "../lib/timetableXml/types";
import { TIMETABLE_IMPORTS_URL } from "../lib/localApi";
import CurrentImportStatus from "../components/CurrentImportStatus";
import "./DataXmlPage.css";

type PreviewTab = "teachers" | "classes" | "schedule" | "validation";

const PREVIEW_ROW_LIMIT = 10;

interface ImportSuccessBody {
  importId: string;
  status: string;
  campusName: string;
  academicYearName: string;
  teacherCount: number;
  classCount: number;
  dayCount: number;
  periodCount: number;
  sourceCardCount: number;
  normalizedAssignmentCount: number;
  importedAt: string;
  alreadyImported: boolean;
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStat(value: number | null): string {
  return value === null ? "Tespit edilemedi" : String(value);
}

export default function DataXmlPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<TimetableImportResult | null>(null);
  const [fileMeta, setFileMeta] = useState<{ encoding: string; sha256: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importOutcome, setImportOutcome] = useState<{ kind: "success" | "duplicate" | "error"; message: string } | null>(null);
  const [activeTab, setActiveTab] = useState<PreviewTab>("teachers");
  const [currentImportRefreshKey, setCurrentImportRefreshKey] = useState(0);

  function resetOutcome() {
    setResult(null);
    setFileMeta(null);
    setImportOutcome(null);
    setActiveTab("teachers");
  }

  function handleFile(candidate: File) {
    resetOutcome();
    const validation = validateXmlFileCandidate(candidate);
    if (!validation.valid) {
      setFileError(validation.error ?? "Dosya geçersiz.");
      setFile(null);
      return;
    }
    setFileError(null);
    setFile(candidate);
  }

  function openFileDialog() {
    inputRef.current?.click();
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) handleFile(selected);
    e.target.value = "";
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFile(dropped);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDropzoneKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openFileDialog();
    }
  }

  async function handleCheckFile() {
    if (!file) return;
    setChecking(true);
    setResult(null);
    setFileMeta(null);
    setImportOutcome(null);
    try {
      const { text, encoding, sha256 } = await readXmlFile(file);
      setResult(parseTimetableXml(text, file.name));
      setFileMeta({ encoding, sha256 });
    } catch {
      setResult(buildUnreadableFileResult(file.name));
    } finally {
      setChecking(false);
    }
  }

  async function handleImport() {
    if (!file || !result || !result.isValid || !fileMeta) return;
    setImporting(true);
    setImportOutcome(null);

    const payload = buildImportPayload(result, {
      sourceFormat: ASC_FORMAT_ID,
      sourceFilename: file.name,
      sourceEncoding: fileMeta.encoding,
      sourceSha256: fileMeta.sha256,
    });

    try {
      const response = await fetch(TIMETABLE_IMPORTS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        setImportOutcome({ kind: "error", message: "Veriler kaydedilemedi. Veritabanında değişiklik yapılmadı." });
        return;
      }

      const body = (await response.json()) as ImportSuccessBody;
      if (body.alreadyImported) {
        setImportOutcome({ kind: "duplicate", message: "Bu XML dosyası daha önce içe aktarılmış." });
      } else {
        setImportOutcome({ kind: "success", message: "Ders programı kalıcı olarak kaydedildi." });
      }
      // Mevcut ders programı kartını, başarılı VEYA duplicate sonuçtan sonra
      // yeniden sorgula (duplicate'te veri değişmediği için kart aynı kalır —
      // sayfa yenilemeye gerek yok).
      setCurrentImportRefreshKey((k) => k + 1);
    } catch {
      setImportOutcome({ kind: "error", message: "Veriler kaydedilemedi. Veritabanında değişiklik yapılmadı." });
    } finally {
      setImporting(false);
    }
  }

  const hasCriticalErrors = !!result && result.validationErrors.length > 0;
  const hasWarningsOnly = !!result && result.isValid && result.validationWarnings.length > 0;
  const isClean = !!result && result.isValid && result.validationWarnings.length === 0;

  return (
    <div className="data-xml-page">
      <CurrentImportStatus refreshKey={currentImportRefreshKey} />
      <h1 className="page-title">Ders programını yükle</h1>
      <p className="page-desc">
        Öğretmen ve sınıf ders programlarını XML dosyasından içe aktarın.
      </p>

      <div className="data-xml-grid">
        <div className="main-column">
          <div
            className={dragActive ? "dropzone dropzone--active" : "dropzone"}
            role="button"
            tabIndex={0}
            aria-label="XML dosyası yüklemek için tıklayın veya sürükleyip bırakın"
            onClick={openFileDialog}
            onKeyDown={handleDropzoneKeyDown}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xml"
              className="visually-hidden"
              onChange={handleInputChange}
              aria-hidden="true"
              tabIndex={-1}
            />
            <UploadCloud size={40} strokeWidth={1.5} className="dropzone-icon" aria-hidden="true" />
            <p className="dropzone-title">XML Dosyasını Sürükleyip Bırakın</p>
            <p className="dropzone-subtitle">veya bilgisayarınızdan seçin</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={(e) => {
                e.stopPropagation();
                openFileDialog();
              }}
            >
              XML Dosyası Seç
            </button>
            <p className="dropzone-hint">Desteklenen format: .xml (Maks. 5MB)</p>
          </div>

          {fileError && (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={18} strokeWidth={2} aria-hidden="true" />
              <span>{fileError}</span>
            </div>
          )}

          {file && (
            <div className="file-row">
              <div className="file-row-info">
                <FileText size={20} strokeWidth={2} className="file-row-icon" aria-hidden="true" />
                <div>
                  <div className="file-row-name">{file.name}</div>
                  <div className="file-row-size">{formatFileSize(file.size)}</div>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCheckFile}
                disabled={checking}
              >
                {checking ? (
                  <>
                    <Loader2 size={16} className="spin" aria-hidden="true" />
                    Kontrol ediliyor…
                  </>
                ) : (
                  "Dosyayı Kontrol Et"
                )}
              </button>
            </div>
          )}

          {hasCriticalErrors && result && (
            <div className="alert alert-error alert-block" role="alert">
              <div className="alert-block-header">
                <AlertCircle size={18} strokeWidth={2} aria-hidden="true" />
                <span>XML dosyası doğrulanamadı.</span>
              </div>
              <ul className="alert-list">
                {result.validationErrors.map((err, i) => (
                  <li key={i}>{err.message}</li>
                ))}
              </ul>
            </div>
          )}

          {hasWarningsOnly && result && (
            <div className="alert alert-warning alert-block" role="status">
              <div className="alert-block-header">
                <AlertTriangle size={18} strokeWidth={2} aria-hidden="true" />
                <span>
                  XML dosyası uyarılarla doğrulandı ({result.validationWarnings.length} uyarı).
                </span>
              </div>
              <ul className="alert-list">
                {result.validationWarnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {isClean && (
            <div className="alert alert-success" role="status">
              <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" />
              <span>XML dosyası başarıyla doğrulandı. Veriler içe aktarmaya hazır.</span>
            </div>
          )}

          {result && result.isValid && (
            <>
              <SummaryCard stats={result.stats} />
              <PreviewCard result={result} activeTab={activeTab} onTabChange={setActiveTab} />
              <div className="summary-actions">
                <button type="button" className="btn btn-primary" onClick={handleImport} disabled={importing}>
                  {importing ? (
                    <>
                      <Loader2 size={16} className="spin" aria-hidden="true" />
                      İçe aktarılıyor…
                    </>
                  ) : (
                    "İçe Aktar"
                  )}
                </button>
              </div>
            </>
          )}

          {importOutcome && importOutcome.kind === "success" && (
            <div className="alert alert-success" role="status">
              <CheckCircle2 size={18} strokeWidth={2} aria-hidden="true" />
              <span>{importOutcome.message}</span>
            </div>
          )}
          {importOutcome && importOutcome.kind === "duplicate" && (
            <div className="alert alert-info" role="status">
              <Info size={18} strokeWidth={2} aria-hidden="true" />
              <span>{importOutcome.message}</span>
            </div>
          )}
          {importOutcome && importOutcome.kind === "error" && (
            <div className="alert alert-error" role="alert">
              <AlertCircle size={18} strokeWidth={2} aria-hidden="true" />
              <span>{importOutcome.message}</span>
            </div>
          )}
        </div>

        <div className="side-column">
          <div className="info-card">
            <div className="info-card-header">
              <Info size={18} strokeWidth={2} className="info-card-icon" aria-hidden="true" />
              <h2 className="info-card-title">Bilgi Notu</h2>
            </div>
            <p className="info-card-text">
              Yeni dosya mevcut kampüsün ders programını günceller. İçe aktarma
              işlemi önceki haftalık planlarınızı ve sabit nöbet kurallarınızı
              etkilemez, ancak yeni öğretmen ve sınıfları sisteme ekler.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ stats }: { stats: TimetableImportResult["stats"] }) {
  return (
    <div className="summary-card">
      <h2 className="summary-title">Yeni dosya özeti</h2>
      <div className="summary-stats">
        <div className="stat-box">
          <div className="stat-value">{formatStat(stats.teacherCount)}</div>
          <div className="stat-label">Öğretmen</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{formatStat(stats.classCount)}</div>
          <div className="stat-label">Sınıf</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{formatStat(stats.dayCount)}</div>
          <div className="stat-label">Gün</div>
        </div>
        <div className="stat-box">
          <div className="stat-value">{formatStat(stats.periodCount)}</div>
          <div className="stat-label">Ders Saati</div>
        </div>
        <div className="stat-box" title="XML'deki ham <card> sayısı: bir lesson'ın belirli gün+saate yerleşimi.">
          <div className="stat-value">{formatStat(stats.sourceCardCount)}</div>
          <div className="stat-label">Plan Kartı</div>
        </div>
        <div className="stat-box" title="Normalize edilmiş öğretmen–sınıf atama satırı sayısı (bir plan kartı, çoklu öğretmen/sınıf içeriyorsa birden çok atamaya açılabilir).">
          <div className="stat-value">{formatStat(stats.scheduleEntryCount)}</div>
          <div className="stat-label">Atama Kaydı</div>
        </div>
      </div>
    </div>
  );
}

function PreviewCard({
  result,
  activeTab,
  onTabChange,
}: {
  result: TimetableImportResult;
  activeTab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
}) {
  const dayById = useMemo(() => new Map(result.days.map((d) => [d.id, d.name])), [result.days]);
  const periodById = useMemo(() => new Map(result.periods.map((p) => [p.id, p.name])), [result.periods]);
  const classById = useMemo(() => new Map(result.classes.map((c) => [c.id, c.name])), [result.classes]);
  const teacherById = useMemo(() => new Map(result.teachers.map((t) => [t.id, t.name])), [result.teachers]);

  const hasBranch = result.teachers.some((t) => t.branch);
  const hasGrade = result.classes.some((c) => c.grade);
  const hasLessonName = result.scheduleEntries.some((s) => s.lessonName);

  const tabs: { id: PreviewTab; label: string }[] = [
    { id: "teachers", label: "Öğretmenler" },
    { id: "classes", label: "Sınıflar" },
    { id: "schedule", label: "Atama Kayıtları" },
    { id: "validation", label: "Doğrulama Sonuçları" },
  ];

  return (
    <div className="preview-card">
      <div className="preview-tabs" role="tablist" aria-label="Önizleme sekmeleri">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "preview-tab preview-tab--active" : "preview-tab"}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="preview-panel">
        {activeTab === "teachers" && (
          <TableView
            emptyText="Öğretmen kaydı bulunamadı."
            total={result.teachers.length}
            head={hasBranch ? ["ID", "Ad Soyad", "Branş"] : ["ID", "Ad Soyad"]}
            rows={result.teachers.slice(0, PREVIEW_ROW_LIMIT).map((t) =>
              hasBranch ? [t.id, t.name, t.branch ?? "—"] : [t.id, t.name],
            )}
          />
        )}
        {activeTab === "classes" && (
          <TableView
            emptyText="Sınıf kaydı bulunamadı."
            total={result.classes.length}
            head={hasGrade ? ["ID", "Sınıf Adı", "Seviye"] : ["ID", "Sınıf Adı"]}
            rows={result.classes.slice(0, PREVIEW_ROW_LIMIT).map((c) =>
              hasGrade ? [c.id, c.name, c.grade ?? "—"] : [c.id, c.name],
            )}
          />
        )}
        {activeTab === "schedule" && (
          <TableView
            emptyText="Atama kaydı bulunamadı."
            total={result.scheduleEntries.length}
            head={
              hasLessonName
                ? ["Gün", "Ders Saati", "Sınıf", "Öğretmen", "Ders"]
                : ["Gün", "Ders Saati", "Sınıf", "Öğretmen"]
            }
            rows={result.scheduleEntries.slice(0, PREVIEW_ROW_LIMIT).map((s) => {
              const base = [
                dayById.get(s.dayId) ?? s.dayId,
                periodById.get(s.periodId) ?? s.periodId,
                classById.get(s.classId) ?? s.classId,
                teacherById.get(s.teacherId) ?? s.teacherId,
              ];
              return hasLessonName ? [...base, s.lessonName ?? "—"] : base;
            })}
          />
        )}
        {activeTab === "validation" && (
          <div className="validation-list">
            <div className="validation-group">
              <h3 className="validation-group-title validation-group-title--error">
                Hatalar ({result.validationErrors.length})
              </h3>
              {result.validationErrors.length === 0 ? (
                <p className="validation-empty">Kritik hata bulunmuyor.</p>
              ) : (
                <ul className="alert-list">
                  {result.validationErrors.map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="validation-group">
              <h3 className="validation-group-title validation-group-title--warning">
                Uyarılar ({result.validationWarnings.length})
              </h3>
              {result.validationWarnings.length === 0 ? (
                <p className="validation-empty">Uyarı bulunmuyor.</p>
              ) : (
                <ul className="alert-list">
                  {result.validationWarnings.map((w, i) => (
                    <li key={i}>{w.message}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function TableView({
  head,
  rows,
  total,
  emptyText,
}: {
  head: string[];
  rows: string[][];
  total: number;
  emptyText: string;
}) {
  if (total === 0) {
    return <p className="validation-empty">{emptyText}</p>;
  }
  return (
    <div>
      <div className="table-scroll">
        <table className="preview-table">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="preview-total">
        Toplam {total} kayıttan {Math.min(total, PREVIEW_ROW_LIMIT)} tanesi gösteriliyor.
      </p>
    </div>
  );
}
