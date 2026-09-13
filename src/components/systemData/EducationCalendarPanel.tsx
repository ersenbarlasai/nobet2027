/* oxlint-disable react/set-state-in-effect -- İlk yükleme, harici API durumunu React görünümüne eşzamanlar. */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { addEducationClosure, deleteEducationClosure, fetchEducationCalendar, saveEducationTerm } from "../../lib/educationCalendar/api";
import type { ClosureType, EducationCalendar } from "../../lib/educationCalendar/types";

const today = () => new Date().toISOString().slice(0, 10);
const CLOSURE_LABELS: Record<ClosureType, string> = { ara_tatil: "Ara tatil", yariyil_tatili: "Yarıyıl tatili", tam_kapali_hafta: "Tamamen kapalı hafta", resmi_tatil: "Resmî tatil" };

export default function EducationCalendarPanel() {
  const [calendar, setCalendar] = useState<EducationCalendar | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [term, setTerm] = useState({ startDate: today(), endDate: today(), description: "" });
  const [closure, setClosure] = useState({ closureType: "resmi_tatil" as ClosureType, dateFrom: today(), dateTo: today(), description: "" });

  async function load() {
    try {
      const result = await fetchEducationCalendar();
      setCalendar(result);
      if (result.term) setTerm({ startDate: result.term.startDate, endDate: result.term.endDate, description: result.term.description ?? "" });
    } catch { setNotice("Eğitim takvimi alınamadı."); }
  }
  useEffect(() => { void load(); }, []);

  async function saveTerm() {
    setBusy(true); setNotice("");
    try { await saveEducationTerm(term); setNotice("Eğitim dönemi kaydedildi."); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Eğitim dönemi kaydedilemedi."); }
    finally { setBusy(false); }
  }

  async function addClosure() {
    setBusy(true); setNotice("");
    try { await addEducationClosure(closure); setClosure((v) => ({ ...v, description: "" })); setNotice("Tatil aralığı eklendi."); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Tatil aralığı eklenemedi."); }
    finally { setBusy(false); }
  }

  async function removeClosure(id: string) {
    if (!window.confirm("Bu tatil aralığı silinsin mi?")) return;
    try { await deleteEducationClosure(id); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Silinemedi."); }
  }

  return <div className="sd-section">
    <h2 className="sd-section-title">Eğitim Takvimi</h2>
    <p className="page-desc sd-section-desc">Aylık 28 saat eşiği hesabı yalnız bu takvimde aktif olan ve en az bir ders günü kalan haftaları sayar. Takvim eksikse dönem kapanışı beklemede kalır.</p>
    {notice && <div className="alert alert-info" role="status">{notice}</div>}
    <div className="sd-main-card">
      <h3 className="sd-column-title">Eğitim dönemi</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <label>Başlangıç<input type="date" value={term.startDate} onChange={(e) => setTerm((v) => ({ ...v, startDate: e.target.value }))} /></label>
        <label>Bitiş<input type="date" value={term.endDate} onChange={(e) => setTerm((v) => ({ ...v, endDate: e.target.value }))} /></label>
        <input placeholder="Açıklama" value={term.description} onChange={(e) => setTerm((v) => ({ ...v, description: e.target.value }))} />
        <button className="btn btn-primary" disabled={busy} onClick={() => void saveTerm()}>Kaydet</button>
      </div>
    </div>
    <div className="sd-main-card">
      <h3 className="sd-column-title">Tatil / kapalı hafta aralığı ekle</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={closure.closureType} onChange={(e) => setClosure((v) => ({ ...v, closureType: e.target.value as ClosureType }))}>
          {Object.entries(CLOSURE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input type="date" value={closure.dateFrom} onChange={(e) => setClosure((v) => ({ ...v, dateFrom: e.target.value }))} />
        <input type="date" value={closure.dateTo} onChange={(e) => setClosure((v) => ({ ...v, dateTo: e.target.value }))} />
        <input placeholder="Açıklama" value={closure.description} onChange={(e) => setClosure((v) => ({ ...v, description: e.target.value }))} />
        <button className="btn btn-primary" disabled={busy} onClick={() => void addClosure()}><Plus size={15}/>Ekle</button>
      </div>
      <ul className="sd-list">
        {(calendar?.closures ?? []).map((item) => <li key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span><b>{CLOSURE_LABELS[item.closureType]}</b> — {item.dateFrom} → {item.dateTo}{item.description ? ` · ${item.description}` : ""}</span>
          <button className="btn btn-danger" onClick={() => void removeClosure(item.id)}><Trash2 size={14}/></button>
        </li>)}
        {!calendar?.closures.length && <li>Henüz tatil aralığı tanımlanmadı.</li>}
      </ul>
    </div>
  </div>;
}
