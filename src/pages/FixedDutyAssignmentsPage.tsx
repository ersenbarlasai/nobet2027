import { useEffect, useMemo, useState } from "react";
import { LockKeyhole, Trash2 } from "lucide-react";
import { createFixedDuty, fetchFixedDuties, removeFixedDuty } from "../lib/fixedDutyAssignments/api";
import type { FixedDutySnapshot } from "../lib/fixedDutyAssignments/types";
import "./FixedDutyAssignmentsPage.css";

type Outcome = { status: "loading" } | { status: "error" } | { status: "ready"; data: FixedDutySnapshot };

export default function FixedDutyAssignmentsPage() {
  const [outcome, setOutcome] = useState<Outcome>({ status: "loading" });
  const [refreshKey, setRefreshKey] = useState(0);
  const [teacherId, setTeacherId] = useState("");
  const [dayOrder, setDayOrder] = useState("");
  const [locationId, setLocationId] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let ignore = false;
    fetchFixedDuties(controller.signal).then(
      (data) => { if (!ignore) setOutcome({ status: "ready", data }); },
      (error: unknown) => {
        if (!ignore && !(error instanceof DOMException && error.name === "AbortError")) setOutcome({ status: "error" });
      },
    );
    return () => { ignore = true; controller.abort(); };
  }, [refreshKey]);

  const data = outcome.status === "ready" ? outcome.data : null;
  const teachers = data?.teachers ?? [];
  const days = data?.days ?? [];
  const locations = data?.dutyLocations ?? [];
  const assignments = data?.assignments ?? [];

  const selectedTeacher = teachers.find((teacher) => teacher.id === teacherId);
  const blockedLocationIds = useMemo(
    () => new Set((data?.assignments ?? []).filter((a) => String(a.dayOrder) === dayOrder).map((a) => a.dutyLocationId)),
    [data, dayOrder],
  );
  const teacherAlreadyAssigned = Boolean(selectedTeacher && (data?.assignments ?? []).some((a) => String(a.dayOrder) === dayOrder && a.teacherSourceId === selectedTeacher.sourceId));

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!teacherId || !dayOrder || !locationId) return;
    setPending(true); setMessage(null);
    try {
      await createFixedDuty({ teacherId, dayOrder: Number(dayOrder), dutyLocationId: locationId });
      setMessage({ kind: "success", text: "Sabit nöbet atandı." });
      setTeacherId(""); setDayOrder(""); setLocationId("");
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Sabit nöbet kaydedilemedi." });
    } finally { setPending(false); }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Bu sabit nöbet atamasını kaldırmak istiyor musunuz?")) return;
    setPending(true); setMessage(null);
    try {
      await removeFixedDuty(id);
      setMessage({ kind: "success", text: "Sabit nöbet kaldırıldı." });
      setRefreshKey((key) => key + 1);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Sabit nöbet kaldırılamadı." });
    } finally { setPending(false); }
  }

  return (
    <section className="fd-page">
      <header><h1>Sabit nöbetler</h1><p>Öğretmeni belirli bir gün ve nöbet yerine sabitleyin.</p></header>

      {outcome.status === "loading" && <div className="fd-card" aria-busy="true">Sabit nöbetler yükleniyor…</div>}
      {outcome.status === "error" && <div className="fd-card fd-error">Sabit nöbetler alınamadı. <button className="btn btn-secondary" onClick={() => setRefreshKey((key) => key + 1)}>Tekrar Dene</button></div>}
      {data && !data.hasImport && <div className="fd-card">Sabit nöbet tanımlamak için önce bir XML ders programı yükleyin.</div>}

      {data?.hasImport && <>
        <form className="fd-card fd-form" onSubmit={handleSubmit}>
          <div className="fd-card-title"><LockKeyhole size={20} aria-hidden="true" /><div><h2>Yeni sabit nöbet</h2><p>Aynı öğretmen aynı gün başka yere; aynı yere de başka öğretmen atanamaz.</p></div></div>
          <label>Öğretmen<select value={teacherId} onChange={(e) => setTeacherId(e.target.value)} required><option value="">Seçiniz…</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <label>Gün<select value={dayOrder} onChange={(e) => { setDayOrder(e.target.value); setLocationId(""); }} required><option value="">Seçiniz…</option>{days.map((d) => <option key={d.order} value={d.order}>{d.name}</option>)}</select></label>
          <label>Nöbet yeri<select value={locationId} onChange={(e) => setLocationId(e.target.value)} required disabled={!dayOrder || teacherAlreadyAssigned}><option value="">Seçiniz…</option>{locations.map((l) => <option key={l.id} value={l.id} disabled={blockedLocationIds.has(l.id)}>{l.name}{blockedLocationIds.has(l.id) ? " — dolu" : ""}</option>)}</select></label>
          <button className="btn btn-primary" type="submit" disabled={pending || teacherAlreadyAssigned || !teacherId || !dayOrder || !locationId}>{pending ? "Kaydediliyor…" : "Sabit Nöbet Ata"}</button>
          {teacherAlreadyAssigned && <p className="fd-inline-warning">Bu öğretmenin seçilen günde zaten sabit nöbeti var.</p>}
        </form>

        {message && <div className={`fd-message fd-message--${message.kind}`} role="status">{message.text}</div>}

        <div className="fd-card fd-list">
          <h2>Mevcut sabit nöbetler</h2>
          {assignments.length === 0 ? <p className="fd-empty">Henüz sabit nöbet ataması yapılmadı.</p> : (
            <div className="fd-table-wrap"><table><thead><tr><th>Gün</th><th>Nöbet Yeri</th><th>Öğretmen</th><th aria-label="İşlem" /></tr></thead><tbody>
              {assignments.map((a) => <tr key={a.id}><td>{days.find((d) => d.order === a.dayOrder)?.name ?? a.dayOrder}</td><td>{a.dutyLocationName}</td><td>{a.teacherName}</td><td><button className="fd-delete" disabled={pending} onClick={() => handleDelete(a.id)} aria-label={`${a.teacherName} sabit nöbetini kaldır`}><Trash2 size={17} /></button></td></tr>)}
            </tbody></table></div>
          )}
        </div>
      </>}
    </section>
  );
}
