/* oxlint-disable react/set-state-in-effect -- İlk yükleme, harici API durumunu React görünümüne eşzamanlar. */
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { deleteAbsenceType, fetchAbsenceTypes, saveAbsenceType } from "../../lib/absenceTypes/api";
import type { AbsenceType } from "../../lib/absenceTypes/types";

const today = () => new Date().toISOString().slice(0, 10);

export default function AbsenceTypesPanel() {
  const [items, setItems] = useState<AbsenceType[]>([]);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", createsDebt: true, effectiveFrom: today() });
  const [editing, setEditing] = useState<{ id: string; name: string; createsDebt: boolean; effectiveFrom: string } | null>(null);

  async function load() {
    try { setItems((await fetchAbsenceTypes()).items); }
    catch { setNotice("Yokluk türleri alınamadı."); }
  }
  useEffect(() => { void load(); }, []);

  async function createType() {
    setBusyId("new"); setNotice("");
    try { await saveAbsenceType({ name: form.name, createsDebt: form.createsDebt, effectiveFrom: form.effectiveFrom, isActive: true }); setForm({ name: "", createsDebt: true, effectiveFrom: today() }); setNotice("Yokluk türü eklendi."); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Yokluk türü eklenemedi."); }
    finally { setBusyId(null); }
  }

  async function saveVersion(item: AbsenceType) {
    if (!editing) return;
    setBusyId(item.id); setNotice("");
    try { await saveAbsenceType({ id: item.id, name: editing.name, createsDebt: editing.createsDebt, effectiveFrom: editing.effectiveFrom, isActive: item.isActive }); setEditing(null); setNotice("Yeni sürüm kaydedildi; yalnız yürürlük tarihinden sonraki kayıtları etkiler."); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Kaydedilemedi."); }
    finally { setBusyId(null); }
  }

  async function toggleActive(item: AbsenceType) {
    setBusyId(item.id); setNotice("");
    try { const current = item.versions[0] ?? { name: item.currentName, createsDebt: item.currentCreatesDebt, effectiveFrom: today() }; await saveAbsenceType({ id: item.id, name: current.name, createsDebt: current.createsDebt, effectiveFrom: current.effectiveFrom, isActive: !item.isActive }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Güncellenemedi."); }
    finally { setBusyId(null); }
  }

  async function remove(item: AbsenceType) {
    if (!window.confirm(`"${item.currentName}" yokluk türü silinsin mi? Kullanılmışsa geçmiş kayıtlar korunur ve tür pasife alınır.`)) return;
    setBusyId(item.id); setNotice("");
    try { const result = await deleteAbsenceType(item.id); setNotice(result.action === "deactivated" ? "Kullanılmış tür pasife alındı; geçmiş kayıtlar korunur." : "Yokluk türü silindi."); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Silinemedi."); }
    finally { setBusyId(null); }
  }

  return <div className="sd-section">
    <h2 className="sd-section-title">Yokluk Türleri</h2>
    <p className="page-desc sd-section-desc">Her türün borç durumu ve adı tarih sürümlüdür — değişiklik yalnız yürürlük tarihinden sonraki kayıtları etkiler, geçmiş puantaj değişmez.</p>
    {notice && <div className="alert alert-info" role="status">{notice}</div>}
    <div className="sd-main-card">
      <div className="sd-columns" style={{ gridTemplateColumns: "2fr 1fr 1fr auto" }}>
        <input placeholder="Yeni tür adı" value={form.name} onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))} />
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={form.createsDebt} onChange={(e) => setForm((v) => ({ ...v, createsDebt: e.target.checked }))} />Borç oluşturur</label>
        <input type="date" value={form.effectiveFrom} onChange={(e) => setForm((v) => ({ ...v, effectiveFrom: e.target.value }))} />
        <button className="btn btn-primary" disabled={form.name.trim().length < 2 || busyId !== null} onClick={() => void createType()}><Plus size={15}/>Ekle</button>
      </div>
      <ul className="sd-list" style={{ gap: 12 }}>
        {items.map((item) => <li key={item.id} style={{ paddingLeft: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div><b>{item.currentName}</b> — {item.currentCreatesDebt ? "borç oluşturur" : "borçtan muaf"}{!item.isActive && " · pasif"}{item.inUse && " · kullanımda"}</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn btn-secondary" disabled={busyId !== null} onClick={() => setEditing({ id: item.id, name: item.currentName, createsDebt: item.currentCreatesDebt, effectiveFrom: today() })}>Yeni sürüm</button>
              <button className="btn btn-secondary" disabled={busyId !== null} onClick={() => void toggleActive(item)}>{item.isActive ? "Pasife al" : "Etkinleştir"}</button>
              <button className="btn btn-danger" disabled={busyId !== null} onClick={() => void remove(item)}><Trash2 size={14}/></button>
            </div>
          </div>
          {editing?.id === item.id && <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input value={editing.name} onChange={(e) => setEditing((v) => v && { ...v, name: e.target.value })} />
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={editing.createsDebt} onChange={(e) => setEditing((v) => v && { ...v, createsDebt: e.target.checked })} />Borç oluşturur</label>
            <input type="date" value={editing.effectiveFrom} onChange={(e) => setEditing((v) => v && { ...v, effectiveFrom: e.target.value })} />
            <button className="btn btn-primary" onClick={() => void saveVersion(item)}>Kaydet</button>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>Vazgeç</button>
          </div>}
        </li>)}
      </ul>
    </div>
  </div>;
}
