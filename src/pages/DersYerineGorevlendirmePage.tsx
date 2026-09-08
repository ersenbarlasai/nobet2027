/* oxlint-disable react/set-state-in-effect -- İlk yükleme, harici API durumunu React görünümüne eşzamanlar. */
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, CalendarDays, Check, CheckCircle2, ClipboardList, Plus, RefreshCw, Trash2, UserCheck, UserRoundX } from "lucide-react";
import { completeSubList, createAbsence, deleteAbsence, deleteSubList, fetchSubCandidates, fetchSubList, fetchSubLists, fetchSubPreparation, previewDeleteAbsence, updateSubTask } from "../lib/substitutions/api";
import type { SubCandidate, SubDayList, SubListItem, SubPreparation, SubTask } from "../lib/substitutions/types";
import "./DersYerineGorevlendirmePage.css";

const today = () => new Date().toISOString().slice(0, 10);
const reasons = { medical_report: "Raporlu", leave: "İzinli", official_duty: "Görevli", other: "Diğer" };
type Scope = "all_day" | "selected_lessons";
type View = "create" | "records" | "work";
type NoticeTone = "error" | "info" | "success";

export default function DersYerineGorevlendirmePage() {
  const [prep, setPrep] = useState<SubPreparation | null>(null);
  const [lists, setLists] = useState<SubListItem[]>([]);
  const [list, setList] = useState<SubDayList | null>(null);
  const [task, setTask] = useState<SubTask | null>(null);
  const [candidates, setCandidates] = useState<SubCandidate[]>([]);
  const [view, setView] = useState<View>("create");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("error");
  const [savingAbsence, setSavingAbsence] = useState(false);
  const [completingListId, setCompletingListId] = useState<string | null>(null);
  const [form, setForm] = useState({ teacherSourceId: "", dateFrom: today(), dateTo: today(), absenceScope: "all_day" as Scope, reasonCode: "medical_report", note: "", selected: new Set<string>() });

  const lessons = prep?.lessons ?? [];
  const selectedLessons = lessons.filter((lesson) => form.selected.has(lesson.key));
  const editable = Boolean(list && !list.isHistorical);
  const stats = useMemo(() => list ? {
    assigned: list.tasks.filter((item) => item.resolutionStatus === "assigned").length,
    open: list.tasks.filter((item) => item.resolutionStatus === "open").length,
    unfilled: list.tasks.filter((item) => item.resolutionStatus === "unfilled").length,
  } : null, [list]);
  const currentStep = view === "create" ? (lessons.length ? 2 : 1) : list?.status === "completed" ? 3 : stats?.open === 0 ? 3 : 2;

  const showNotice = (message: string, tone: NoticeTone = "error") => { setNotice(message); setNoticeTone(tone); };
  const clearLoadedLessons = () => setPrep((value) => value ? { ...value, lessons: [] } : value);
  const changeLessonCriteria = (patch: Partial<Pick<typeof form, "teacherSourceId" | "dateFrom" | "dateTo">>) => {
    setForm((value) => ({ ...value, ...patch, selected: new Set<string>() }));
    clearLoadedLessons();
  };

  async function load() {
    setBusy(true);
    try {
      const [preparation, response] = await Promise.all([fetchSubPreparation(new URLSearchParams()), fetchSubLists()]);
      setPrep(preparation); setLists(response.items);
      if (list) setList(await fetchSubList(list.id));
      return response.items;
    } catch { showNotice("Ders yerine görevlendirme verileri alınamadı."); return []; }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const params=new URLSearchParams(window.location.search);const listId=params.get("listId"),taskId=params.get("taskId");
    void (async()=>{await load();if(listId)await openList(listId,taskId)})();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadLessons() {
    if (!form.teacherSourceId || !form.dateFrom || !form.dateTo) return;
    setBusy(true); showNotice("Dersler yükleniyor…", "info");
    try {
      const preparation = await fetchSubPreparation(new URLSearchParams({ teacherSourceId: form.teacherSourceId, dateFrom: form.dateFrom, dateTo: form.dateTo }));
      setPrep(preparation);
      setForm((value) => ({ ...value, selected: new Set(preparation.lessons.map((lesson) => lesson.key)) }));
      showNotice(preparation.lessons.length ? `${preparation.lessons.length} ders bulundu. Kapsamı kontrol edip kaydedin.` : "Bu tarih aralığında öğretmenin dersi bulunamadı.", preparation.lessons.length ? "success" : "info");
    } catch { showNotice("Öğretmenin dersleri alınamadı."); }
    finally { setBusy(false); }
  }

  async function chooseTask(value: SubTask) {
    setTask(value); setCandidates([]);
    try { setCandidates((await fetchSubCandidates(value.id)).items); }
    catch { showNotice("Aday listesi alınamadı."); }
  }

  async function openList(id: string, focusTaskId?: string | null) {
    setBusy(true);
    try {
      const detail = await fetchSubList(id); setList(detail); setView("work");
      const first = detail.tasks.find((item) => item.id === focusTaskId) ?? detail.tasks.find((item) => item.resolutionStatus === "open") ?? detail.tasks[0] ?? null;
      setTask(first); setCandidates([]);
      if (first && !detail.isHistorical) {
        try { setCandidates((await fetchSubCandidates(first.id)).items); }
        catch { showNotice("Aday listesi alınamadı."); }
      }
    } catch { showNotice("Görevlendirme listesi alınamadı."); }
    finally { setBusy(false); }
  }

  async function saveAbsence() {
    if (!prep || !form.teacherSourceId || !selectedLessons.length) return;
    const targetDate = [...selectedLessons].sort((a, b) => a.assignmentDate.localeCompare(b.assignmentDate))[0]?.assignmentDate ?? form.dateFrom;
    setBusy(true); setSavingAbsence(true); showNotice("Yokluk kaydediliyor…", "info");
    try {
      await createAbsence({ teacherSourceId: form.teacherSourceId, dateFrom: form.dateFrom, dateTo: form.dateTo, absenceScope: form.absenceScope, reasonCode: form.reasonCode, note: form.note, lessons: selectedLessons.map((lesson) => ({ assignmentDate: lesson.assignmentDate, timetableCardId: lesson.timetableCardId })) });
      const refreshed = await load();
      setForm((value) => ({ ...value, teacherSourceId: "", note: "", selected: new Set<string>() }));
      showNotice("Yokluk kaydedildi. Şimdi derslere öğretmen atayın.", "success");
      const target = refreshed.find((item) => item.assignmentDate === targetDate);
      if (target) await openList(target.id);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Yokluk kaydedilemedi."); }
    finally { setSavingAbsence(false); setBusy(false); }
  }

  async function assign(candidate: SubCandidate, override = false, note: string | null = null) {
    if (!list || !task) return;
    try {
      await updateSubTask(task.id, { teacherSourceId: candidate.teacherSourceId, expectedVersion: list.version, overrideAcknowledged: override, overrideNote: note });
      await openList(list.id); showNotice(`${candidate.teacherName} görevlendirildi.`, "success");
    } catch (error) {
      const apiError = error as Error & { status?: string };
      if (apiError.status === "daily_limit_acknowledgement_required") {
        const reason = window.prompt(`Bu öğretmen günlük ${candidate.dailyLimit} görev sınırına ulaştı. Sınır aşımı gerekçesini yazın:`);
        if (reason) await assign(candidate, true, reason); return;
      }
      showNotice(apiError.message);
    }
  }

  async function unresolved() {
    if (!list || !task) return;
    const note = window.prompt("Görevlendirilememe açıklamasını yazın:"); if (!note?.trim()) return;
    try { await updateSubTask(task.id, { teacherSourceId: null, unfilledNote: note, expectedVersion: list.version }); await openList(list.id); showNotice("Ders, açıklamasıyla birlikte görevlendirilemedi olarak işaretlendi.", "success"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "Ders güncellenemedi."); }
  }

  async function removeAbsence() {
    if (!task) return;
    try {
      const preview = await previewDeleteAbsence(task.absenceId);
      const assigned = preview.affectedTasks.filter((item) => item.resolutionStatus === "assigned").length;
      if (!window.confirm(`${preview.teacherName} için ${preview.affectedTasks.length} ders görevi ve ${assigned} geçici puan etkilenecek. Yokluk kaydı silinsin mi?`)) return;
      await deleteAbsence(preview.absenceId, preview.affectedTasks.map((item) => item.id));
      setTask(null); setList(null); setView("records"); await load(); showNotice("Yokluk kaydı ve bağlı görevler silindi.", "success");
    } catch (error) { showNotice(error instanceof Error ? error.message : "Yokluk kaydı silinemedi."); }
  }

  async function removeList() {
    if (!list || !window.confirm("Bu liste, görevlendirmeler ve geçici puanları silinsin mi?")) return;
    try { await deleteSubList(list.id, list.version); setList(null); setTask(null); setView("records"); await load(); showNotice("Görevlendirme listesi silindi.", "success"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "Liste silinemedi."); }
  }

  async function completeCurrentList() {
    if (!list) return;
    setCompletingListId(list.id); showNotice("Görevlendirme listesi tamamlanıyor…", "info");
    try {
      await completeSubList(list.id, list.version);
      const refreshed=await fetchSubLists();
      setLists(refreshed.items);setList(null);setTask(null);setCandidates([]);setView("records");
      showNotice("Görevlendirme listesi tamamlandı ve Kayıtlı Listeler'e kaydedildi.", "success");
    }
    catch (error) { showNotice(error instanceof Error ? error.message : "Liste tamamlanamadı."); }
    finally { setCompletingListId(null); }
  }

  function startNew() {
    setView("create"); setList(null); setTask(null); setCandidates([]); clearLoadedLessons();
    setForm((value) => ({ ...value, teacherSourceId: "", note: "", selected: new Set<string>() })); setNotice("");
  }

  return <div className="sub-page">
    <header className="sub-page-header"><div><span>DERS OPERASYONLARI</span><h1>Ders Yerine Görevlendirme</h1><p>Yokluğu kaydedin, dersleri çözün ve günlük listeyi tamamlayın.</p></div><div className="sub-header-actions"><button className={view === "create" ? "btn btn-primary" : "btn btn-secondary"} onClick={startNew}><Plus size={16}/>Yeni yokluk</button><button className={view === "records" ? "btn btn-primary" : "btn btn-secondary"} onClick={() => { setView("records"); setList(null); setTask(null); }}><ClipboardList size={16}/>Kayıtlı listeler <span>{lists.length}</span></button></div></header>
    <nav className="sub-progress" aria-label="Görevlendirme aşamaları"><ProgressStep number={1} title="Yokluğu tanımla" detail="Öğretmen ve tarih" state={currentStep > 1 ? "done" : "active"}/><ProgressStep number={2} title="Dersleri çöz" detail="Öğretmenleri ata" state={currentStep > 2 ? "done" : currentStep === 2 ? "active" : "future"}/><ProgressStep number={3} title="Listeyi tamamla" detail="Kontrol et ve kapat" state={currentStep === 3 ? "active" : "future"}/></nav>
    {notice && <div className={`sub-alert sub-alert--${noticeTone}`} role={noticeTone === "error" ? "alert" : "status"} aria-live="polite">{noticeTone === "success" ? <CheckCircle2 size={18}/> : <AlertCircle size={18}/>}<span>{notice}</span></div>}

    {view === "create" && <section className="sub-card sub-create-card"><div className="sub-section-heading"><span>1</span><div><h2>Yokluğu tanımlayın</h2><p>Öğretmeni ve yokluk aralığını seçip dersleri getirin.</p></div></div><div className="sub-form">
      <label>Öğretmen<select value={form.teacherSourceId} onChange={(event) => changeLessonCriteria({ teacherSourceId: event.target.value })}><option value="">Seçin</option>{prep?.teachers.map((teacher) => <option key={teacher.sourceId} value={teacher.sourceId}>{teacher.name}</option>)}</select></label>
      <label>Başlangıç<input type="date" value={form.dateFrom} onChange={(event) => changeLessonCriteria({ dateFrom: event.target.value })}/></label><label>Bitiş<input type="date" value={form.dateTo} onChange={(event) => changeLessonCriteria({ dateTo: event.target.value })}/></label>
      <label>Yokluk kapsamı<select value={form.absenceScope} onChange={(event) => { const absenceScope = event.target.value as Scope; setForm((value) => ({ ...value, absenceScope, selected: absenceScope === "all_day" ? new Set(lessons.map((lesson) => lesson.key)) : value.selected })); }}><option value="all_day">Tüm gün</option><option value="selected_lessons">Seçili ders saatleri</option></select></label>
      <label>Neden<select value={form.reasonCode} onChange={(event) => setForm((value) => ({ ...value, reasonCode: event.target.value }))}>{Object.entries(reasons).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div><label className="sub-note-field">İdari not<input value={form.note} onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}/></label><div className="sub-create-next"><button className="btn btn-primary" disabled={busy || !form.teacherSourceId} onClick={() => void loadLessons()}>{busy && !savingAbsence ? <RefreshCw className="sub-spinner" size={15}/> : <ArrowRight size={15}/>}Dersleri getir ve devam et</button></div>
    {lessons.length > 0 && <div className="sub-lesson-step"><div className="sub-section-heading"><span>2</span><div><h2>Ders kapsamını kontrol edin</h2><p>{form.absenceScope === "all_day" ? "Tüm dersler otomatik olarak kapsama alındı." : "Yalnız görevlendirme oluşturulacak dersleri seçin."}</p></div></div><div className="sub-lessons"><div><b>{selectedLessons.length}/{lessons.length} ders seçili</b>{form.absenceScope === "selected_lessons" && <button className="btn btn-secondary" onClick={() => setForm((value) => ({ ...value, selected: new Set(lessons.map((lesson) => lesson.key)) }))}>Tümünü seç</button>}</div>{lessons.map((lesson) => <label key={lesson.key}><input type="checkbox" disabled={form.absenceScope === "all_day"} checked={form.selected.has(lesson.key)} onChange={() => setForm((value) => { const selected = new Set(value.selected); if (selected.has(lesson.key)) selected.delete(lesson.key); else selected.add(lesson.key); return { ...value, selected }; })}/><span><b>{lesson.assignmentDate} · {lesson.periodName}</b>{lesson.classNames} · {lesson.subjectName}</span></label>)}</div><div className="sub-create-next sub-create-next--final"><div><b>Sıradaki aşama</b><span>Kayıttan sonra ilgili günlük liste otomatik açılır.</span></div><button className="btn btn-primary" disabled={busy || !form.teacherSourceId || !selectedLessons.length} aria-busy={savingAbsence} onClick={() => void saveAbsence()}>{savingAbsence ? <RefreshCw className="sub-spinner" size={15}/> : <ArrowRight size={15}/>} {savingAbsence ? "Kaydediliyor…" : "Yokluğu kaydet ve görevlendirmeye geç"}</button></div></div>}
    </section>}

    {view === "records" && <section className="sub-card"><div className="sub-section-heading"><CalendarDays/><div><h2>Günlük görevlendirme listeleri</h2><p>Düzenlemek veya incelemek istediğiniz günü seçin.</p></div></div><div className="sub-list-cards">{lists.map((item) => <button key={item.id} onClick={() => void openList(item.id)}><b>{item.assignmentDate}</b><span>{item.assignedCount}/{item.taskCount} atandı · {item.unfilledCount} görevlendirilemedi</span><em>{item.isHistorical ? "Tarihsel · kilitli" : item.status === "completed" ? "Tamamlandı" : "Devam ediyor"}</em><ArrowRight size={16}/></button>)}{!lists.length && <div className="sub-empty"><ClipboardList/><b>Henüz görevlendirme listesi yok.</b><p>İlk yokluk kaydınızı oluşturarak başlayın.</p><button className="btn btn-primary" onClick={startNew}>Yeni yokluk oluştur</button></div>}</div></section>}

    {view === "work" && list && <><section className="sub-card sub-work-head"><div><span className={list.status === "completed" ? "sub-status sub-status--done" : "sub-status"}>{list.status === "completed" ? "Tamamlandı" : "Devam ediyor"}</span><h2>{list.assignmentDate} görevlendirme listesi</h2><p>{stats?.assigned} atandı · {stats?.open} açık · {stats?.unfilled} görevlendirilemedi</p></div>{editable && <button className="btn btn-secondary" onClick={() => void removeList()}><Trash2 size={15}/>Listeyi sil</button>}</section>
    {list.status === "completed" && <section className="sub-done-panel"><CheckCircle2/><div><h2>Bu günlük liste tamamlandı</h2><p>Yeni bir yokluk ekleyebilir veya kayıtlı listelerden başka bir günü açabilirsiniz.</p></div><button className="btn btn-primary" onClick={startNew}><Plus size={16}/>Yeni yokluk kaydı oluştur</button><button className="btn btn-secondary" onClick={() => { setView("records"); setList(null); setTask(null); }}>Kayıtlı listelere dön</button></section>}
    <div className="sub-workspace"><section className="sub-card sub-task-panel"><div className="sub-section-heading"><span>2</span><div><h2>Dersleri çözün</h2><p>Bir ders seçin; uygun öğretmenler sağda sıralansın.</p></div></div><div className="sub-task-grid">{list.tasks.map((item) => <button key={item.id} onClick={() => void chooseTask(item)} className={task?.id === item.id ? "active" : ""}><span>{item.periodName}</span><b>{item.absentTeacherName}</b><small>{item.classNames} · {item.subjectName}</small><em className={`sub-task-state sub-task-state--${item.resolutionStatus}`}>{item.resolutionStatus === "assigned" ? item.substituteTeacherName : item.resolutionStatus === "unfilled" ? "Görevlendirilemedi" : "Öğretmen seçilmedi"}</em></button>)}</div></section>
    <section className="sub-card sub-candidate-panel">{!task ? <div className="sub-empty"><UserCheck/><b>Önce bir ders seçin</b><p>Seçtiğiniz dersin uygun öğretmenleri burada gösterilir.</p></div> : <><div className="sub-section-heading"><UserCheck/><div><h2>{task.classNames} · {task.periodName}</h2><p>{task.subjectName} dersi için sıralı adaylar</p></div></div><AssignmentRelation task={task}/>{!editable ? <div className="sub-alert sub-alert--info">Geçmiş XML’e bağlı liste salt okunurdur.</div> : <><div className="sub-candidates">{candidates.map((candidate) => <article key={candidate.teacherSourceId}><div><b>{candidate.teacherName}</b><small>{candidate.branch ?? "Branş bilgisi yok"}</small><p>{candidate.sameSubject && <span>Aynı ders</span>}{candidate.branchSupportsSubject && <span>Branş desteği</span>}{candidate.sameClass && <span>Aynı sınıf</span>}{candidate.sameStage && <span>Aynı kademe</span>}{candidate.limitExceeded && <span className="warn">Günlük sınır aşılıyor</span>}</p><em>{candidate.substitutionPoints} geçmiş puan · {candidate.scheduledLessonCount} ders · bugün {candidate.assignedToday} görevlendirme</em></div><button className="btn btn-primary" onClick={() => void assign(candidate)}>Ata</button></article>)}</div>{!candidates.length && <div className="sub-empty sub-empty--compact"><b>Uygun öğretmen bulunamadı.</b><p>Dersi açıklama girerek “Görevlendirilemedi” olarak çözebilirsiniz.</p></div>}<div className="sub-candidate-actions"><button className="btn btn-secondary" onClick={() => void unresolved()}><UserRoundX size={15}/>Görevlendirilemedi</button><button className="btn btn-secondary" onClick={() => void removeAbsence()}><Trash2 size={15}/>Bu yokluğu sil</button></div></>}</>}</section></div>
    {editable && list.status !== "completed" && <section className={`sub-complete-bar ${stats?.open === 0 ? "sub-complete-bar--ready" : ""}`}><div>{stats?.open === 0 ? <CheckCircle2/> : <ClipboardList/>}<span><b>{stats?.open === 0 ? "Tüm dersler çözümlendi" : `${stats?.open} ders daha çözülmeli`}</b><small>{stats?.open === 0 ? "Listeyi kontrol edip işlemi tamamlayın." : "Her derse öğretmen atayın veya açıklamayla görevlendirilemedi olarak işaretleyin."}</small></span></div><button className="btn btn-primary" disabled={stats?.open !== 0 || completingListId === list.id} aria-busy={completingListId === list.id} onClick={() => void completeCurrentList()}>{completingListId === list.id ? <RefreshCw className="sub-spinner" size={16}/> : <Check size={16}/>} {completingListId === list.id ? "Tamamlanıyor…" : "Listeyi tamamla"}</button></section>}</>}
  </div>;
}

function ProgressStep({ number, title, detail, state }: { number: number; title: string; detail: string; state: "done" | "active" | "future" }) {
  return <div className={`sub-progress-step sub-progress-step--${state}`} aria-current={state === "active" ? "step" : undefined}><span>{state === "done" ? <Check size={15}/> : number}</span><div><b>{title}</b><small>{detail}</small></div></div>;
}

function AssignmentRelation({ task }: { task: SubTask }) {
  const replacement = task.resolutionStatus === "assigned"
    ? task.substituteTeacherName ?? "Atanan öğretmen"
    : task.resolutionStatus === "unfilled" ? "Görevlendirilemedi" : "Henüz seçilmedi";
  return <div className={`sub-assignment-relation sub-assignment-relation--${task.resolutionStatus}`} aria-label={`${task.absentTeacherName} öğretmenin yerine ${replacement}`}>
    <div><small>Dersi bulunan öğretmen</small><strong>{task.absentTeacherName}</strong></div>
    <ArrowRight aria-hidden="true"/>
    <div><small>Yerine görevlendirilen öğretmen</small><strong>{replacement}</strong>{task.resolutionStatus === "unfilled" && task.unfilledNote && <span>{task.unfilledNote}</span>}</div>
  </div>;
}
