import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, CalendarDays, Check, ClipboardCheck, Eye, FileSpreadsheet, ListFilter, LockKeyhole, Plus, Printer, RefreshCw, Search, ShieldAlert, Trash2, UserPlus, Users } from "lucide-react";
import { completeExamScope, createExamPlan, deleteExamPlan, discardExamScope, fetchExamCandidates, fetchExamPlan, fetchExamPlans, fetchExamPreparation, setExamAssignment } from "../lib/examInvigilation/api";
import { EXAM_SCOPE_LABELS, EXAM_SCOPE_LIST_STATUS_LABELS, EXAM_SCOPE_ORDER, ExamInvigilationApiError, type CreateExamSessionSpec, type ExamCandidate, type ExamCandidates, type ExamPlanListFilters, type ExamPlanListItem, type ExamPreparation, type ExamSchoolClass, type ExamScope, type ExamScopeCode, type ExamSession } from "../lib/examInvigilation/types";
import { buildScopeDayMatrix, cellTeacherName, planExamDates, planIsCompleted, scopeIsReadOnly, scopeListStatus, sessionExamDate, teacherSummaryRows, type FoundExamPlan } from "../lib/examInvigilation/planView";
import "./DenemeSinaviGozetmenPage.css";

const addDays = (iso:string,n:number) => { const d=new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const formatDate = (iso:string) => new Date(`${iso}T00:00:00`).toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric",weekday:"long"});
const formatShortDate = (iso:string) => new Date(`${iso}T00:00:00`).toLocaleDateString("tr-TR",{day:"numeric",month:"short",weekday:"short"});
const formatDateTime = (iso:string) => { const value=new Date(iso); return Number.isNaN(value.getTime())?"—":value.toLocaleDateString("tr-TR",{day:"numeric",month:"long",year:"numeric"}); };
interface ExamCreateForm { name:string; examDate:string; schoolClassIds:string[]; periodOrders:number[] }

function classScope(schoolClass:ExamSchoolClass):ExamScopeCode {
  const text=`${schoolClass.grade??""} ${schoolClass.name}`.toLocaleLowerCase("tr-TR");
  if(/anaokul|ana\s*sınıf|okul öncesi|preschool|yaş|yas/.test(text))return "PRESCHOOL";
  const match=(schoolClass.grade?.trim()||schoolClass.name).match(/\d{1,2}/);
  const grade=match?Number(match[0]):Number.NaN;
  if(grade>=1&&grade<=4)return "PRIMARY_SCHOOL";
  if(grade>=5&&grade<=8)return "MIDDLE_SCHOOL";
  if(grade>=9&&grade<=12)return "HIGH_SCHOOL";
  return "OTHER";
}

type LoadState = "loading" | "ready" | "error";
type PageView = "plan" | "records" | "create";
interface PendingDutyCandidate { candidate: ExamCandidate; session: ExamSession; slotNumber: number }

const DEFAULT_FILTERS:Required<ExamPlanListFilters> = { status:"all", scopeCode:null, search:"", dateFrom:null, dateTo:null, sort:"newest" };

export default function DenemeSinaviGozetmenPage() {
  const [state,setState]=useState<LoadState>("loading");
  const [preparation,setPreparation]=useState<ExamPreparation|null>(null);
  const [plans,setPlans]=useState<ExamPlanListItem[]>([]);
  const [plansLoading,setPlansLoading]=useState(false);
  const [filters,setFilters]=useState<Required<ExamPlanListFilters>>(DEFAULT_FILTERS);
  const [plan,setPlan]=useState<FoundExamPlan|null>(null);
  const [view,setView]=useState<PageView>("plan");
  const [activeScope,setActiveScope]=useState<ExamScopeCode>("MIDDLE_SCHOOL");
  const [selectedExamDate,setSelectedExamDate]=useState<string|null>(null);
  const [selectedSessionId,setSelectedSessionId]=useState<string|null>(null);
  const [selectedSlot,setSelectedSlot]=useState(1);
  const [candidates,setCandidates]=useState<ExamCandidates|null>(null);
  const [candidateLoading,setCandidateLoading]=useState(false);
  const [search,setSearch]=useState("");
  const [notice,setNotice]=useState<string|null>(null);
  const [noticeTone,setNoticeTone]=useState<"error"|"success"|"info">("error");
  const [busy,setBusy]=useState(false);
  const [deletingPlanId,setDeletingPlanId]=useState<string|null>(null);
  const [pendingDuty,setPendingDuty]=useState<PendingDutyCandidate|null>(null);
  const [dutyNote,setDutyNote]=useState("");
  const [createForm,setCreateForm]=useState<ExamCreateForm>({name:"Deneme Sınavı",examDate:"",schoolClassIds:[],periodOrders:[]});
  const showNotice=(message:string|null,tone:"error"|"success"|"info"="error")=>{setNotice(message);setNoticeTone(tone);};

  const openPlanDetail=useCallback((detail:FoundExamPlan)=>{
    setPlan(detail);
    const nextScope=detail.scopes.find(s=>s.scopeCode===activeScope&&s.sessions.length>0)??detail.scopes.find(s=>s.sessions.length>0)??detail.scopes[0];
    setActiveScope(nextScope.scopeCode);
    const first=nextScope.sessions[0]??null;
    setSelectedExamDate(first?sessionExamDate(first,detail.examDate):null);
    setSelectedSessionId(first?.id??null);
  },[activeScope]);

  async function load(selectId?:string) {
    setState("loading"); setNotice(null);
    try {
      const [prep,list]=await Promise.all([fetchExamPreparation(),fetchExamPlans(filters)]);
      setPreparation(prep); setPlans(list.items);
      setCreateForm(f=>{const selectedWeek=prep.publishedWeeks.find(w=>f.examDate>=w.weekStartDate&&f.examDate<=addDays(w.weekStartDate,4));return {...f,examDate:selectedWeek?f.examDate:"",schoolClassIds:f.schoolClassIds.filter(id=>prep.classes.some(c=>c.id===id)),periodOrders:f.periodOrders.filter(order=>prep.periods.some(p=>p.periodOrder===order))};});
      const target=selectId??list.items[0]?.id;
      if(target){ const detail=await fetchExamPlan(target); if(detail.found){openPlanDetail(detail);setView("plan");} }
      else { setPlan(null); setView("create"); }
      setState("ready");
    } catch { setState("error"); }
  }
  useEffect(()=>{void Promise.resolve().then(()=>load());},[]); // eslint-disable-line react-hooks/exhaustive-deps

  // Süzgeçler değiştikçe listeyi SUNUCUDAN yeniden çeker; durum istemcide türetilmez.
  const filterKey=`${filters.status}|${filters.scopeCode??""}|${filters.search??""}|${filters.dateFrom??""}|${filters.dateTo??""}|${filters.sort}`;
  const lastFetchedFilterKey=useRef<string|null>(null);
  useEffect(()=>{
    if(state!=="ready")return;
    if(lastFetchedFilterKey.current===null||lastFetchedFilterKey.current===filterKey){lastFetchedFilterKey.current=filterKey;return;}
    lastFetchedFilterKey.current=filterKey;
    const controller=new AbortController();
    setPlansLoading(true);
    fetchExamPlans(filters,controller.signal).then(list=>setPlans(list.items)).catch((error:unknown)=>{
      if(!(error instanceof DOMException&&error.name==="AbortError"))showNotice("Plan kayıtları alınamadı.");
    }).finally(()=>{if(!controller.signal.aborted)setPlansLoading(false);});
    return()=>controller.abort();
  },[filterKey,state]); // eslint-disable-line react-hooks/exhaustive-deps

  const scope=plan?.scopes.find(s=>s.scopeCode===activeScope)??null;
  const scopeRequired=scope?.sessions.reduce((n,item)=>n+item.requiredCount,0)??0;
  const scopeAssigned=scope?.sessions.flatMap(item=>item.assignments).length??0;
  const scopeOpen=Math.max(0,scopeRequired-scopeAssigned);
  const readOnly=Boolean(plan&&scope&&scopeIsReadOnly(plan,scope));
  const planCompleted=Boolean(plan&&planIsCompleted(plan));
  const scopeDates=useMemo(()=>Array.from(new Set((scope?.sessions??[]).map(s=>sessionExamDate(s,plan?.examDate??"")))).filter(Boolean).sort(),[scope,plan?.examDate]);
  const visibleSessions=useMemo(()=>scope?.sessions.filter(s=>!selectedExamDate||sessionExamDate(s,plan?.examDate??"")===selectedExamDate)??[],[scope,selectedExamDate,plan?.examDate]);
  const visiblePeriods=useMemo(()=>Array.from(new Map(visibleSessions.map(session=>[session.periodOrder,{periodOrder:session.periodOrder,periodName:session.periodName,startsAt:session.startsAt,endsAt:session.endsAt}])).values()).sort((a,b)=>a.periodOrder-b.periodOrder),[visibleSessions]);
  const visibleClasses=useMemo(()=>Array.from(new Map(visibleSessions.filter(session=>session.schoolClassId).map(session=>[session.schoolClassId!,{id:session.schoolClassId!,name:session.schoolClassName??session.schoolClassSourceId??"Sınıf"}])).values()).sort((a,b)=>a.name.localeCompare(b.name,"tr")),[visibleSessions]);
  const selectedSession=scope?.sessions.find(s=>s.id===selectedSessionId)??visibleSessions[0]??scope?.sessions[0]??null;
  const planId=plan?.id;
  const sessionId=selectedSession?.id;
  const scopeVersion=scope?.version;
  useEffect(()=>{
    if(!planId||!sessionId||readOnly)return;
    const controller=new AbortController();
    Promise.resolve().then(()=>{setCandidateLoading(true);setCandidates(null);});
    fetchExamCandidates(planId,sessionId,controller.signal).then(setCandidates).catch((error:unknown)=>{
      if(!(error instanceof DOMException&&error.name==="AbortError"))showNotice("Uygun öğretmen listesi alınamadı.");
    }).finally(()=>{if(!controller.signal.aborted)setCandidateLoading(false);});
    return()=>controller.abort();
  },[planId,sessionId,scopeVersion,readOnly]);

  const totals=useMemo(()=>{
    const scopes=plan?.scopes??[]; const required=scopes.reduce((n,s)=>n+s.sessions.reduce((x,q)=>x+q.requiredCount,0),0);
    const assignments=scopes.flatMap(s=>s.sessions.flatMap(x=>x.assignments));
    return {required,assigned:assignments.length,middle:scopes.find(s=>s.scopeCode==="MIDDLE_SCHOOL")?.sessions.flatMap(x=>x.assignments).length??0,high:scopes.find(s=>s.scopeCode==="HIGH_SCHOOL")?.sessions.flatMap(x=>x.assignments).length??0,warnings:assignments.filter(a=>a.dutyWarning?.length).length};
  },[plan]);
  const isLegacyPlan=Boolean(plan?.scopes.some(s=>s.sessions.some(session=>!session.schoolClassId)));

  const selectedPublishedWeek=preparation?.publishedWeeks.find(w=>createForm.examDate>=w.weekStartDate&&createForm.examDate<=addDays(w.weekStartDate,4))??null;
  const stages=useMemo(()=>EXAM_SCOPE_ORDER.map(scopeCode=>({scopeCode,classes:(preparation?.classes??[]).filter(schoolClass=>classScope(schoolClass)===scopeCode)})).filter(stage=>stage.classes.length>0),[preparation]);
  const expandedSessionCount=createForm.schoolClassIds.length*createForm.periodOrders.length;
  const createStep=!createForm.name.trim()?1:!createForm.examDate?2:createForm.schoolClassIds.length===0?3:4;
  const createReady=Boolean(preparation?.hasImport&&selectedPublishedWeek&&createForm.name.trim().length>=2&&createForm.schoolClassIds.length>0&&createForm.periodOrders.length>0);
  async function submitCreate(e:React.FormEvent){e.preventDefault();if(!createReady||!selectedPublishedWeek)return;const sessions:CreateExamSessionSpec[]=stages.flatMap(stage=>{const ids=stage.classes.filter(c=>createForm.schoolClassIds.includes(c.id)).map(c=>c.id);return ids.length?createForm.periodOrders.map(periodOrder=>({scopeCode:stage.scopeCode,examDate:createForm.examDate,periodOrder,schoolClassIds:ids,requiredCount:1 as const})):[];});setBusy(true);setNotice(null);try{const result=await createExamPlan({name:createForm.name,weekStartDate:selectedPublishedWeek.weekStartDate,sessions});await load(result.planId);}catch(err){showNotice(err instanceof Error?err.message:"Plan oluşturulamadı.");}finally{setBusy(false);}}
  function chooseSession(session:ExamSession,slot=1){setSelectedExamDate(sessionExamDate(session,plan?.examDate??""));setSelectedSessionId(session.id);setSelectedSlot(slot);setSearch("");setCandidates(null);setCandidateLoading(true);}
  async function assign(candidate:ExamCandidate,ack=false,note:string|null=null){if(!plan||!scope||!selectedSession)return;setBusy(true);setNotice(null);try{await setExamAssignment(plan.id,selectedSession.id,{slotNumber:selectedSlot,teacherSourceId:candidate.teacherSourceId,expectedScopeVersion:scope.version,dutyCoverageAcknowledged:ack,dutyCoverageNote:note});setPendingDuty(null);setDutyNote("");await reloadPlan();}catch(err){if(err instanceof ExamInvigilationApiError&&err.status==="duty_coverage_acknowledgement_required"){setPendingDuty({candidate,session:selectedSession,slotNumber:selectedSlot});}else showNotice(err instanceof Error?err.message:"Atama yapılamadı.");}finally{setBusy(false);}}
  async function remove(session:ExamSession,slotNumber:number){if(!plan||!scope)return;setBusy(true);try{await setExamAssignment(plan.id,session.id,{slotNumber,teacherSourceId:null,expectedScopeVersion:scope.version});await reloadPlan();}catch(err){showNotice(err instanceof Error?err.message:"Atama kaldırılamadı.");}finally{setBusy(false);}}
  async function reloadPlan(){if(!plan)return null;const fresh=await fetchExamPlan(plan.id);if(fresh.found){setPlan(fresh);setPlans((await fetchExamPlans(filters)).items);return fresh;}return null;}
  async function finishScope(){if(!plan||!scope)return;const completedScopeLabel=EXAM_SCOPE_LABELS[scope.scopeCode];setBusy(true);showNotice("Liste tamamlanıyor…","info");try{await completeExamScope(plan.id,scope.scopeCode,scope.version);const fresh=await reloadPlan();if(fresh&&planIsCompleted(fresh)){setView("records");showNotice(`${fresh.name} tamamlandı ve Plan Kayıtları'na kaydedildi.`,"success");}else if(fresh){const next=fresh.scopes.find(item=>item.sessions.length>0&&item.status!=="completed");if(next){setActiveScope(next.scopeCode);const first=next.sessions.find(item=>item.assignments.length<item.requiredCount)??next.sessions[0];setSelectedExamDate(first?sessionExamDate(first,fresh.examDate):null);setSelectedSessionId(first?.id??null);}showNotice(`${completedScopeLabel} listesi tamamlandı.${next?` Sıradaki: ${EXAM_SCOPE_LABELS[next.scopeCode]}.`:""}`,"success");}}catch(err){showNotice(err instanceof Error?err.message:"Liste tamamlanamadı.");}finally{setBusy(false);}}
  async function discardScope(){if(!plan||!scope||!window.confirm(`${EXAM_SCOPE_LABELS[scope.scopeCode]} taslağındaki oturumlar ve atamalar silinsin mi?`))return;setBusy(true);setNotice(null);try{await discardExamScope(plan.id,scope.scopeCode,scope.version);await reloadPlan();}catch(err){showNotice(err instanceof Error?err.message:"Gözetmen taslağı silinemedi.");}finally{setBusy(false)}}
  async function openPlan(planRecordId:string){setNotice(null);try{const detail=await fetchExamPlan(planRecordId);if(detail.found){openPlanDetail(detail);setView("plan");}else showNotice("Gözetmen planı bulunamadı.");}catch(err){showNotice(err instanceof Error?err.message:"Gözetmen planı alınamadı.");}}
  // exceljs yalnız indirme anında yüklenir; ana paketi şişirmez.
  async function downloadXlsx(){if(!plan)return;setBusy(true);try{const {downloadExamInvigilationXlsx}=await import("../lib/examInvigilationExport/downloadExamInvigilationXlsx");await downloadExamInvigilationXlsx(plan);}catch{showNotice("XLSX dosyası oluşturulamadı.");}finally{setBusy(false);}}

  if(state==="loading")return <main className="eig-page"><div className="eig-card eig-loading" aria-busy="true">Gözetmen planları yükleniyor…</div></main>;
  if(state==="error")return <main className="eig-page"><div className="eig-card eig-error" role="alert"><AlertCircle/><div><strong>Gözetmen planları alınamadı.</strong><p>Yerel API bağlantısını kontrol edip tekrar deneyin.</p><button className="btn btn-secondary" onClick={()=>void load()}><RefreshCw size={15}/>Tekrar Dene</button></div></div></main>;

  return <main className="eig-page">
    <header className="eig-header"><div><span className="eig-eyebrow">Sınav operasyonları</span><h1>Deneme Sınavı Gözetmen Planlama</h1><p>Sınavı tanımlayın, gözetmenleri sırayla atayın ve listeleri tamamlayın.</p></div><div className="eig-header-actions eig-hide-print"><button className={view==="create"?"btn btn-primary":"btn btn-secondary"} onClick={()=>setView("create")}><Plus size={16}/>Yeni Plan</button><button aria-label="Plan kayıtları" className={view==="records"?"btn btn-primary":"btn btn-secondary"} onClick={()=>setView("records")}><ListFilter size={15}/>Plan kayıtları <span>{plans.length}</span></button></div></header>

    <ExamWorkflow view={view} plan={plan} assigned={totals.assigned} required={totals.required} createStep={createStep}/>

    {notice&&<div className={`eig-alert eig-alert--${noticeTone} eig-hide-print`} role={noticeTone==="error"?"alert":"status"} aria-live="polite">{noticeTone==="success"?<Check size={17}/>:<AlertCircle size={17}/>}<span>{notice}</span></div>}

    {view==="create"&&<form className="eig-card eig-create eig-create-wizard" onSubmit={submitCreate}>
      <div className="eig-section-title"><div><CalendarDays size={17}/><h2>Yeni sınav planı</h2></div><span>Dört seçimi tamamlayın; ardından uygun öğretmenlere geçin.</span></div>
      {!preparation?.hasImport?<div className="eig-alert">Güncel ders programı bulunamadı.</div>:<div className="eig-wizard-fields">
        <fieldset className="eig-wizard-field"><legend><span>1</span><div><b>Sınav adını yazın</b><small>Kayıtlar ekranında ayırt edebileceğiniz bir ad kullanın.</small></div></legend><input aria-label="Sınav adı" value={createForm.name} onChange={e=>setCreateForm(f=>({...f,name:e.target.value}))} placeholder="Örn. 1. Dönem genel deneme sınavı" required/></fieldset>
        <fieldset className="eig-wizard-field" disabled={createForm.name.trim().length<2}><legend><span>2</span><div><b>Sınav tarihini seçin</b><small>Yayımlanmış nöbet planı bulunan bir iş günü seçin.</small></div></legend><input aria-label="Sınav tarihi" type="date" value={createForm.examDate} onChange={e=>setCreateForm(f=>({...f,examDate:e.target.value,schoolClassIds:[],periodOrders:[]}))}/>{createForm.examDate&&!selectedPublishedWeek&&<p className="eig-row-hint">Bu tarih için yayımlanmış haftalık nöbet planı bulunamadı.</p>}</fieldset>
        <fieldset className="eig-wizard-field" disabled={!selectedPublishedWeek}><legend><span>3</span><div><b>Sınava girecek kademe ve sınıfları seçin</b><small>Kademeler ve sınıflar yüklediğiniz XML ders programından gelir.</small></div></legend>{stages.map(stage=><section className="eig-stage-group" key={stage.scopeCode}><header><b>{EXAM_SCOPE_LABELS[stage.scopeCode]}</b><span>{stage.classes.filter(c=>createForm.schoolClassIds.includes(c.id)).length}/{stage.classes.length} seçili</span></header><div className="eig-class-picks">{stage.classes.map(schoolClass=><label key={schoolClass.id} className={createForm.schoolClassIds.includes(schoolClass.id)?"eig-class-pick eig-class-pick--active":"eig-class-pick"}><input type="checkbox" checked={createForm.schoolClassIds.includes(schoolClass.id)} onChange={()=>setCreateForm(f=>({...f,schoolClassIds:f.schoolClassIds.includes(schoolClass.id)?f.schoolClassIds.filter(id=>id!==schoolClass.id):[...f.schoolClassIds,schoolClass.id]}))}/><span>{schoolClass.name}</span></label>)}</div></section>)}{createForm.schoolClassIds.length===0&&<p className="eig-row-hint">En az bir sınıf seçin.</p>}</fieldset>
        <fieldset className="eig-wizard-field" disabled={createForm.schoolClassIds.length===0}><legend><span>4</span><div><b>Sınavın yapılacağı ders saatlerini seçin</b><small>Her sınıf × ders saati kesişimi bir gözetmen görevi oluşturur.</small></div></legend><div className="eig-choice-grid eig-choice-grid--periods">{preparation.periods.map(period=><button type="button" key={period.periodOrder} aria-pressed={createForm.periodOrders.includes(period.periodOrder)} className={createForm.periodOrders.includes(period.periodOrder)?"eig-choice-card eig-choice-card--active":"eig-choice-card"} onClick={()=>setCreateForm(f=>({...f,periodOrders:f.periodOrders.includes(period.periodOrder)?f.periodOrders.filter(order=>order!==period.periodOrder):[...f.periodOrders,period.periodOrder].sort((a,b)=>a-b)}))}><b>{period.name}</b><small>{period.startsAt?.slice(0,5)??"—"}{period.endsAt?`–${period.endsAt.slice(0,5)}`:""}</small>{createForm.periodOrders.includes(period.periodOrder)&&<Check size={14}/>}</button>)}</div>{createForm.periodOrders.length===0&&<p className="eig-row-hint">En az bir ders saati seçin.</p>}</fieldset>
        <div className="eig-schedule-summary"><CalendarDays size={16}/><span><b>{createForm.schoolClassIds.length}</b> sınıf</span><span><b>{createForm.periodOrders.length}</b> ders saati</span><span><b>{expandedSessionCount}</b> gözetmen görevi</span><small>Sonraki adımda her görev için yalnız uygun öğretmenler gösterilir.</small></div>
      </div>}
      <div className="eig-form-actions">{plan&&<button type="button" className="btn btn-secondary" onClick={()=>setView("plan")}>Vazgeç</button>}<button className="btn btn-primary" disabled={busy||!createReady}>{busy?"Plan hazırlanıyor…":"Uygun öğretmenleri seçmeye geç"}</button></div>
    </form>}

    {view==="records"&&<PlanRecords plans={plans} loading={plansLoading} deletingPlanId={deletingPlanId} filters={filters} onFilters={setFilters} onOpen={id=>void openPlan(id)} onDelete={async record=>{const completed=record.overallStatus==="completed";const message=completed?`“${record.name}” tamamlanmış planı kalıcı olarak silinecek. Oturumlar ve gözetmen atamaları da kaldırılacak. Devam edilsin mi?`:`“${record.name}” taslağı, oturumları ve atamalarıyla birlikte silinsin mi?`;if(!window.confirm(message))return;setBusy(true);setDeletingPlanId(record.id);try{await deleteExamPlan(record.id);const list=await fetchExamPlans(filters);setPlans(list.items);if(plan?.id===record.id)setPlan(null);showNotice(`${record.name} silindi.`,"success");}catch(err){showNotice(err instanceof Error?err.message:"Gözetmen planı silinemedi.");}finally{setBusy(false);setDeletingPlanId(null);}}} onCreate={()=>setView("create")}/>} 

    {view==="plan"&&plan&&<>
      <div className="eig-plan-breadcrumb eig-hide-print"><button type="button" className="btn btn-secondary" onClick={()=>setView("records")}><ArrowLeft size={15}/>Plan kayıtlarına dön</button>{planCompleted&&<div className="eig-readonly-actions"><button type="button" className="btn btn-secondary" onClick={()=>window.print()}><Printer size={15}/>Yazdır</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void downloadXlsx()}><FileSpreadsheet size={15}/>XLSX indir</button></div>}</div>

      {planCompleted&&<div className="eig-readonly-badge" role="status"><LockKeyhole size={18}/><b>Tamamlanmış plan · Salt okunur</b></div>}

      <div className="eig-print-header print-only"><h2>{plan.name}</h2><p>{plan.campusName} · {plan.academicYearName}</p><p>{planExamDates(plan).map(formatDate).join(" · ")}</p><p>Okul grubu: {EXAM_SCOPE_LABELS[activeScope]} · Nöbet planı haftası: {formatDate(plan.weekStartDate)}</p></div>

      <section className="eig-card eig-hero">
        <div className="eig-hero-title"><div><strong>{plan.name}</strong><span>{planExamDates(plan).length} sınav günü · {formatDate(plan.weekStartDate)} haftası</span></div>{plan.isStale?<span className="eig-chip eig-chip--danger">Kaynak değişti</span>:<span className="eig-chip eig-chip--success">Ders ve nöbet kaynağı güncel</span>}</div>
        <div className="eig-stats"><Stat label="Toplam öğretmen" value={preparation?.teacherCount??"—"}/><Stat label="Planlanan kademe" value={plan.scopes.filter(s=>s.sessions.length>0).length}/><Stat label="Toplam görev" value={totals.required}/><Stat label="Atanan görev" value={totals.assigned}/><Stat label="Açık görev" value={totals.required-totals.assigned} tone="danger"/><Stat label="Nöbet devri uyarısı" value={totals.warnings} tone="warning"/></div>
        <p className="eig-pool-note"><Users size={15}/><b>Ortak öğretmen havuzu:</b> Bir kademede görevlendirilen öğretmen diğer kademe listelerinden otomatik çıkarılır.</p>
        {isLegacyPlan&&!planCompleted&&<div className="eig-legacy-note" role="alert"><AlertCircle size={17}/><span><b>Bu eski planla atama yapılamaz.</b> Plan oluşturulurken sınıflar seçilmediği için görev adetleri sınıf ve saat seçimlerinden türetilmemiştir. Gün → sınıf → ders saati akışıyla yeni plan oluşturun.</span><button type="button" className="btn btn-secondary" onClick={()=>setView("create")}>Doğru yapıyla yeni plan oluştur</button></div>}
      </section>

      <nav className="eig-scope-tabs" aria-label="Okul grupları">{plan.scopes.map(s=>{const req=s.sessions.reduce((n,x)=>n+x.requiredCount,0),assigned=s.sessions.flatMap(x=>x.assignments).length;return <button key={s.scopeCode} className={activeScope===s.scopeCode?"eig-scope-tab eig-scope-tab--active":"eig-scope-tab"} onClick={()=>{const first=s.sessions[0]??null;setActiveScope(s.scopeCode);setSelectedExamDate(first?sessionExamDate(first,plan.examDate):null);setSelectedSessionId(first?.id??null)}}><ClipboardCheck size={15}/><strong>{EXAM_SCOPE_LABELS[s.scopeCode]} Planı</strong><span>{s.sessions.length===0?EXAM_SCOPE_LIST_STATUS_LABELS.not_planned:`${assigned}/${req} · ${EXAM_SCOPE_LIST_STATUS_LABELS[scopeListStatus(s)]}`}</span></button>})}</nav>

      {scope&&<>
        <div className="eig-card eig-scope-bar"><span>İhtiyaç: <b>{scopeRequired}</b></span><span>Atanan: <b>{scopeAssigned}</b></span><span>Açık: <b>{scopeOpen}</b></span><span>Durum: <b>{EXAM_SCOPE_LIST_STATUS_LABELS[scopeListStatus(scope)]}</b></span>{!readOnly&&<><button className="btn btn-secondary eig-hide-print" onClick={()=>void discardScope()} disabled={busy||scope.sessions.length===0}><Trash2 size={15}/>Taslağı Sil</button><div className="eig-finish-action"><small>{scopeOpen>0?`${scopeOpen} görev daha atanmalı`:"Tüm görevler hazır"}</small><button className="btn btn-primary eig-hide-print" onClick={()=>void finishScope()} disabled={busy||scope.sessions.length===0||scopeOpen>0||plan.isStale||isLegacyPlan}>{busy?"Tamamlanıyor…":`${EXAM_SCOPE_LABELS[scope.scopeCode]} Listesini Tamamla`}</button></div></>}</div>
        {!readOnly&&scope.sessions.length>0&&<div className="eig-assignment-guide eig-hide-print"><span><b>1</b> Günü ve saati seç</span><span><b>2</b> Sınıf hücresini seç</span><span><b>3</b> Sağdan gözetmen ata</span><span className={scopeOpen===0?"is-ready":""}><b>4</b> Listeyi tamamla</span></div>}
        {scope.sessions.length>0?<section className="eig-card"><div className="eig-section-title"><div><CalendarDays size={16}/><h2>Sınav oturumları</h2></div><span>Önce günü seçin; saat kartı matristeki ilgili sütunu temsil eder.</span></div><nav className="eig-day-tabs" aria-label="Sınav günleri">{scopeDates.map(date=><button type="button" key={date} className={selectedExamDate===date?"eig-day-tab eig-day-tab--active":"eig-day-tab"} onClick={()=>{const first=scope.sessions.find(s=>sessionExamDate(s,plan.examDate)===date)??null;setSelectedExamDate(date);setSelectedSessionId(first?.id??null)}}><b>{formatShortDate(date)}</b><span>{scope.sessions.filter(s=>sessionExamDate(s,plan.examDate)===date).length} sınıf oturumu</span></button>)}</nav>{!readOnly&&(isLegacyPlan?<div className="eig-timeline">{visibleSessions.map(s=>{const filled=s.assignments.length;return <button key={s.id} className={selectedSession?.id===s.id?"eig-time eig-time--active":filled===s.requiredCount?"eig-time eig-time--done":"eig-time"} onClick={()=>chooseSession(s)}><small>{s.periodName} · {s.startsAt?.slice(0,5)??"—"}</small><b>Genel oturum</b><span>{filled}/{s.requiredCount} gözetmen</span></button>})}</div>:<div className="eig-timeline">{visiblePeriods.map(period=>{const periodSessions=visibleSessions.filter(session=>session.periodOrder===period.periodOrder);const filled=periodSessions.reduce((count,session)=>count+session.assignments.length,0);const target=periodSessions.find(session=>session.assignments.length<session.requiredCount)??periodSessions[0];const active=selectedSession?.periodOrder===period.periodOrder;return <button key={period.periodOrder} className={active?"eig-time eig-time--active":filled===periodSessions.length?"eig-time eig-time--done":"eig-time"} onClick={()=>target&&chooseSession(target)}><small>{period.startsAt?.slice(0,5)??"—"}{period.endsAt?`–${period.endsAt.slice(0,5)}`:""}</small><b>{period.periodName}</b><span>{periodSessions.length} sınıf · {filled}/{periodSessions.length} atandı</span></button>})}</div>)}</section>:<section className="eig-card eig-scope-empty"><CalendarDays size={22}/><b>Bu okul grubu için sınav oturumu planlanmadı.</b><span>Diğer okul grubu bağımsız olarak tamamlanabilir.</span></section>}

        {scope.sessions.length>0&&(readOnly
          ? <ReadOnlyScopeMatrix plan={plan} scope={scope} examDate={selectedExamDate}/>
          : <div className="eig-workspace"><section className="eig-card eig-matrix"><div className="eig-section-title"><div><ClipboardCheck size={17}/><h2>{EXAM_SCOPE_LABELS[scope.scopeCode]} Gözetmen Matrisi</h2></div><span>{selectedExamDate&&formatDate(selectedExamDate)} · Satırlar sınıfları, sütunlar ders saatlerini gösterir.</span></div><div className="eig-table-wrap">{isLegacyPlan?<table><thead><tr><th>Görev</th>{visibleSessions.map(s=><th key={s.id}>Genel oturum<small>{s.periodName} · {s.startsAt?.slice(0,5)??""}</small></th>)}</tr></thead><tbody>{Array.from({length:Math.max(0,...visibleSessions.map(s=>s.requiredCount))},(_,i)=><tr key={i}><th>Gözetmen {i+1}</th>{visibleSessions.map(s=>{if(i>=s.requiredCount)return <td key={s.id} className="eig-na">—</td>;const a=s.assignments.find(x=>x.slotNumber===i+1);return <td key={s.id}><div className="eig-assignment-wrap"><button disabled className={a?.dutyWarning?.length?"eig-assignment eig-assignment--warning":a?"eig-assignment eig-assignment--filled":"eig-assignment"}>{a?<><b>{a.teacherName}</b><small>{a.dutyWarning?.length?"Nöbet devri":"Uygun"}</small></>:<><UserPlus size={16}/><b>Eski plan — salt okunur</b><small>Yeni plan oluşturun</small></>}</button></div></td>})}</tr>)}</tbody></table>:<table className="eig-class-period-matrix" aria-label={`${EXAM_SCOPE_LABELS[scope.scopeCode]} sınıf ve ders saati gözetmen matrisi`}><thead><tr><th>Sınıf</th>{visiblePeriods.map(period=><th key={period.periodOrder}>{period.periodName}<small>{period.startsAt?.slice(0,5)??"—"}{period.endsAt?`–${period.endsAt.slice(0,5)}`:""}</small></th>)}</tr></thead><tbody>{visibleClasses.map(schoolClass=><tr key={schoolClass.id}><th><b>{schoolClass.name}</b></th>{visiblePeriods.map(period=>{const session=visibleSessions.find(item=>item.schoolClassId===schoolClass.id&&item.periodOrder===period.periodOrder);if(!session)return <td key={period.periodOrder} className="eig-na" aria-label={`${schoolClass.name} ${period.periodName} için sınav yok`}>—</td>;const assignment=session.assignments.find(item=>item.slotNumber===1);const isSelected=selectedSession?.id===session.id;return <td key={period.periodOrder}><div className="eig-assignment-wrap"><button className={`${assignment?.dutyWarning?.length?"eig-assignment eig-assignment--warning":assignment?"eig-assignment eig-assignment--filled":"eig-assignment"}${isSelected?" eig-assignment--selected":""}`} onClick={()=>chooseSession(session,1)}>{assignment?<><b>{assignment.teacherName}</b><small>{assignment.dutyWarning?.length?"Nöbet devri":"Uygun"}</small></>:<><UserPlus size={16}/><b>Gözetmen seç</b><small>{schoolClass.name} · {period.periodName}</small></>}</button>{assignment&&<button type="button" className="eig-remove-assignment" onClick={()=>void remove(session,1)} aria-label={`${assignment.teacherName} atamasını kaldır`}>Kaldır</button>}</div></td>})}</tr>)}</tbody></table>}</div></section>

          <aside className="eig-card eig-candidates"><div className="eig-candidate-head"><div><span>{EXAM_SCOPE_LABELS[scope.scopeCode]} · {selectedSession&&formatShortDate(sessionExamDate(selectedSession,plan.examDate))}</span><h2>{selectedSession?.schoolClassName??"Genel oturum"} · {selectedSession?.periodName??"Oturum"} · Gözetmen {selectedSlot}</h2></div><span className="eig-chip">{candidates?.candidates.length??0} aday</span></div><p>Dersi veya diğer okul grubunda görevi bulunan öğretmenler listeden çıkarılmıştır.</p><label className="eig-search"><Search size={15}/><input placeholder="Öğretmen ara…" value={search} onChange={e=>setSearch(e.target.value)}/></label>
            {candidateLoading?<div className="eig-candidate-empty">Adaylar hesaplanıyor…</div>:<CandidateList candidates={(candidates?.candidates??[]).filter(c=>(c.teacherName+" "+(c.branch??"")).toLocaleLowerCase("tr").includes(search.toLocaleLowerCase("tr")))} onAssign={c=>void assign(c)} disabled={busy||plan.isStale||isLegacyPlan}/>}
            {candidates&&<div className="eig-filter-summary"><b>Filtreleme özeti</b><span>{candidates.excludedCounts.lessonConflict} öğretmen derste</span><span>{candidates.excludedCounts.otherScope} öğretmen diğer okul grubunda</span><span>{candidates.excludedCounts.otherSession} öğretmen aynı saatte görevli</span></div>}
          </aside></div>)}
      </>}

      <details className="eig-audit-details eig-card"><summary><span><ClipboardCheck size={17}/><b>Kontrol ve raporlar</b></span><small>Nöbet devri, ortak öğretmen kaydı ve dağılım özeti</small></summary><div><DutyTransferTable plan={plan}/><SharedRegistry plan={plan}/><TeacherInvigilationSummary plan={plan}/></div></details>
    </>}

    {view==="plan"&&!plan&&<div className="eig-card eig-empty"><ClipboardCheck size={28}/><h2>Henüz deneme sınavı planı yok.</h2><p>Yayımlanmış nöbet planı bulunan bir hafta için ilk planı oluşturun.</p><button className="btn btn-primary" onClick={()=>setView("create")}>Yeni Plan Başlat</button></div>}

    {pendingDuty&&<div className="eig-modal-backdrop" role="presentation"><div className="eig-modal" role="dialog" aria-modal="true" aria-labelledby="duty-title"><ShieldAlert size={24}/><h2 id="duty-title">Nöbet devri gerekiyor</h2><p><b>{pendingDuty.candidate.teacherName}</b> aynı gün nöbetçi. Gözetmen olarak atanabilir; kısa süreli nöbet açıklığı için idari düzenleme yapılmalıdır.</p><ul>{pendingDuty.candidate.dutyWarnings.map(w=><li key={w.packageId}>{w.locationName} · {w.coverageMode}</li>)}</ul><label>Düzenleme notu<textarea value={dutyNote} onChange={e=>setDutyNote(e.target.value)} placeholder="Örn. Teneffüslerde rehber öğretmen görev alacak."/></label><div><button className="btn btn-secondary" onClick={()=>setPendingDuty(null)}>Vazgeç</button><button className="btn btn-primary" onClick={()=>void assign(pendingDuty.candidate,true,dutyNote||null)}>Onayla ve Ata</button></div></div></div>}
  </main>;
}

function ExamWorkflow({view,plan,assigned,required,createStep}:{view:PageView;plan:FoundExamPlan|null;assigned:number;required:number;createStep:number}){
  const current=view==="create"?createStep:view==="records"?6:plan&&planIsCompleted(plan)?6:required>0&&assigned>=required?6:5;
  const steps=[{number:1,title:"Sınav adı",detail:"Planı adlandır"},{number:2,title:"Sınav tarihi",detail:"Takvimden seç"},{number:3,title:"Kademe ve sınıflar",detail:"XML verisinden seç"},{number:4,title:"Ders saatleri",detail:"Oturumları oluştur"},{number:5,title:"Gözetmenleri seç",detail:"Uygun öğretmenleri ata"},{number:6,title:"Görev listesini tamamla",detail:"Kaydet ve kayıtlara geç"}];
  return <nav className="eig-workflow eig-hide-print" aria-label="Gözetmen planlama aşamaları">{steps.map(step=>{const state=step.number<current?"done":step.number===current?"active":"future";return <div key={step.number} className={`eig-workflow-step eig-workflow-step--${state}`} aria-current={state==="active"?"step":undefined}><span>{state==="done"?<Check size={15}/>:step.number}</span><div><b>{step.title}</b><small>{step.detail}</small></div></div>})}</nav>;
}

/** Salt okunur sınıf × ders saati matrisi — hiçbir yazma eylemi içermez. */
function ReadOnlyScopeMatrix({plan,scope,examDate}:{plan:FoundExamPlan;scope:ExamScope;examDate:string|null}) {
  const day=examDate??sessionExamDate(scope.sessions[0],plan.examDate);
  const matrix=buildScopeDayMatrix(scope,day,plan.examDate);
  return <section className="eig-card eig-matrix">
    <div className="eig-section-title"><div><ClipboardCheck size={17}/><h2>{EXAM_SCOPE_LABELS[scope.scopeCode]} Gözetmen Matrisi</h2></div><span>{formatDate(day)} · Satırlar sınıfları, sütunlar ders saatlerini gösterir.</span></div>
    <div className="eig-table-wrap"><table className="eig-class-period-matrix eig-class-period-matrix--readonly" aria-label={`${EXAM_SCOPE_LABELS[scope.scopeCode]} sınıf ve ders saati gözetmen matrisi`}>
      <thead><tr><th>Sınıf</th>{matrix.periods.map(period=><th key={period.periodOrder}>{period.periodName}<small>{period.startsAt?.slice(0,5)??"—"}{period.endsAt?`–${period.endsAt.slice(0,5)}`:""}</small></th>)}</tr></thead>
      <tbody>{matrix.rows.map(row=><tr key={row.key}><th><b>{row.label}</b></th>{row.cells.map((session,index)=>{const period=matrix.periods[index];if(!session)return <td key={period.periodOrder} className="eig-na" aria-label={`${row.label} ${period.periodName} için sınav yok`}>—</td>;const assignment=session.assignments.find(item=>item.slotNumber===1)??session.assignments[0];return <td key={period.periodOrder} className={assignment?.dutyWarning?.length?"eig-readonly-cell eig-readonly-cell--warning":"eig-readonly-cell"}><b>{cellTeacherName(session)}</b>{assignment?.dutyWarning?.length?<small>Nöbet devri</small>:null}</td>})}</tr>)}</tbody>
    </table></div>
  </section>;
}

function PlanRecords({plans,loading,deletingPlanId,filters,onFilters,onOpen,onDelete,onCreate}:{
  plans:ExamPlanListItem[];
  loading:boolean;
  deletingPlanId:string|null;
  filters:Required<ExamPlanListFilters>;
  onFilters:(next:Required<ExamPlanListFilters>)=>void;
  onOpen:(planId:string)=>void;
  onDelete:(plan:ExamPlanListItem)=>void;
  onCreate:()=>void;
}) {
  const statusTabs=[["all","Tümü"],["draft","Taslaklar"],["completed","Tamamlananlar"],["stale","Kaynağı değişenler"]] as const;
  const scopeOptions=EXAM_SCOPE_ORDER.filter(code=>plans.some(plan=>plan.scopes.some(scope=>scope.scopeCode===code)));
  return <section className="eig-card eig-records">
    <div className="eig-section-title"><div><ListFilter size={17}/><h2>Plan kayıtları</h2></div><span>Daha önce oluşturulan taslak ve tamamlanmış gözetmen planları.</span></div>
    <nav className="eig-record-status-tabs" aria-label="Plan durumu süzgeci">{statusTabs.map(([value,label])=>
      <button type="button" key={value} aria-pressed={filters.status===value} className={filters.status===value?"eig-status-tab eig-status-tab--active":"eig-status-tab"} onClick={()=>onFilters({...filters,status:value})}>{label}</button>)}
    </nav>
    <div className="eig-record-filters">
      <label>Sınav adı ara<input type="search" value={filters.search??""} placeholder="Sınav adı…" onChange={e=>onFilters({...filters,search:e.target.value})}/></label>
      <label>Başlangıç tarihi<input type="date" value={filters.dateFrom??""} onChange={e=>onFilters({...filters,dateFrom:e.target.value||null})}/></label>
      <label>Bitiş tarihi<input type="date" value={filters.dateTo??""} onChange={e=>onFilters({...filters,dateTo:e.target.value||null})}/></label>
      <label>Kademe<select value={filters.scopeCode??""} onChange={e=>onFilters({...filters,scopeCode:(e.target.value||null) as ExamScopeCode|null})}><option value="">Tüm kademeler</option>{scopeOptions.map(code=><option key={code} value={code}>{EXAM_SCOPE_LABELS[code]}</option>)}</select></label>
      <label>Sıralama<select value={filters.sort} onChange={e=>onFilters({...filters,sort:e.target.value as "newest"|"oldest"})}><option value="newest">En yeni</option><option value="oldest">En eski</option></select></label>
    </div>
    {loading&&<p className="eig-record-loading" aria-busy="true">Plan kayıtları yükleniyor…</p>}
    {!loading&&plans.length===0&&<div className="eig-record-empty"><ClipboardCheck size={22}/><b>Bu süzgeçlerle plan kaydı bulunamadı.</b><button type="button" className="btn btn-secondary" onClick={onCreate}>Yeni plan oluştur</button></div>}
    <ul className="eig-record-list">{plans.map(record=>{
      return <li key={record.id} className="eig-record" aria-label={record.name}>
        <div className="eig-record-head">
          <div><b>{record.name}</b><span>{record.examDates.map(formatShortDate).join(" · ")}</span></div>
          <div className="eig-record-badges" aria-label="Plan durumu">
            <span className={record.overallStatus==="completed"?"eig-chip eig-chip--success":"eig-chip"}>{record.overallStatus==="completed"?"Tamamlandı":"Taslak"}</span>
            {record.isStale?<span className="eig-chip eig-chip--danger">Kaynak değişmiş</span>:<span className="eig-chip eig-chip--success">Kaynak güncel</span>}
          </div>
        </div>
        <dl className="eig-record-meta">
          <div><dt>Nöbet planı haftası</dt><dd>{formatDate(record.weekStartDate)}</dd></div>
          <div><dt>Oluşturulma tarihi</dt><dd>{formatDateTime(record.createdAt)}</dd></div>
          {record.scopes.map(scope=><div key={scope.scopeCode}><dt>{EXAM_SCOPE_LABELS[scope.scopeCode]} durumu</dt><dd>{EXAM_SCOPE_LIST_STATUS_LABELS[scope.status]}</dd></div>)}
          <div><dt>Toplam görev</dt><dd>{record.requiredCount}</dd></div>
          <div><dt>Atanmış görev</dt><dd>{record.assignedCount}</dd></div>
          <div><dt>Açık görev</dt><dd>{record.openCount}</dd></div>
          <div><dt>Nöbet devri uyarısı</dt><dd>{record.dutyWarningCount}</dd></div>
        </dl>
        <div className="eig-record-actions"><button type="button" className="btn btn-secondary" disabled={deletingPlanId!==null} onClick={()=>onDelete(record)}><Trash2 size={15}/>{deletingPlanId===record.id?"Siliniyor…":"Sil"}</button><button type="button" className="btn btn-primary" disabled={deletingPlanId!==null} onClick={()=>onOpen(record.id)}><Eye size={15}/>{record.overallStatus==="draft"?"Düzenle":"Görüntüle"}</button></div>
      </li>;
    })}</ul>
  </section>;
}

function Stat({label,value,tone}:{label:string;value:string|number;tone?:"danger"|"warning"}){return <div className={`eig-stat${tone?` eig-stat--${tone}`:""}`}><b>{value}</b><span>{label}</span></div>}
function CandidateList({candidates,onAssign,disabled}:{candidates:ExamCandidate[];onAssign:(c:ExamCandidate)=>void;disabled:boolean}){const direct=candidates.filter(c=>c.suitability==="direct"),warning=candidates.filter(c=>c.suitability!=="direct");const group=(title:string,list:ExamCandidate[],warn=false)=><section className={warn?"eig-candidate-group eig-candidate-group--warning":"eig-candidate-group"}><h3>{title}<span>{list.length}</span></h3>{list.map(c=><article key={c.teacherSourceId}><div><b>{c.teacherName}</b><small>{c.branch??"Branş bilgisi yok"}</small><span>{c.dailyLessonCount} ders · {c.weeklyDutyPoints} nöbet puanı · {c.previousInvigilationCount} önceki gözetmenlik</span>{warn&&<em>{c.dutyWarnings.map(w=>`${w.locationName} (${w.coverageMode})`).join(", ")}</em>}</div><button className={warn?"btn eig-warn-btn":"btn btn-primary"} disabled={disabled} onClick={()=>onAssign(c)}>Ata</button></article>)}</section>;return <>{group("Doğrudan uygun",direct)}{warning.length>0&&group("Uygun — nöbet devri gerekiyor",warning,true)}{candidates.length===0&&<div className="eig-candidate-empty">Bu oturum için uygun öğretmen bulunamadı.</div>}</>}
function DutyTransferTable({plan}:{plan:FoundExamPlan}){const rows=plan.scopes.flatMap(s=>s.sessions.flatMap(x=>x.assignments.filter(a=>a.dutyWarning?.length).map(a=>({scope:s.scopeCode,session:x,assignment:a}))));if(!rows.length)return null;return <section className="eig-card eig-transfers eig-avoid-break"><div className="eig-section-title"><div><ShieldAlert size={18}/><h2>Nöbet Devri Gereken Görevlendirmeler</h2></div><span>{rows.length} uyarı</span></div><div className="eig-table-wrap"><table><thead><tr><th>Öğretmen</th><th>Sınav oturumu</th><th>Mevcut nöbet</th><th>Onay</th><th>Düzenleme notu</th></tr></thead><tbody>{rows.map(r=><tr key={r.assignment.id}><td><b>{r.assignment.teacherName}</b></td><td>{EXAM_SCOPE_LABELS[r.scope]} · {r.session.schoolClassName??"Genel"} · {formatShortDate(sessionExamDate(r.session,plan.examDate))} · {r.session.periodName}</td><td>{r.assignment.dutyWarning?.map(w=>`${w.locationName} · ${w.coverageMode}`).join(", ")}</td><td><span className="eig-chip eig-chip--success">Onaylandı</span></td><td>{r.assignment.dutyCoverageNote??"—"}</td></tr>)}</tbody></table></div></section>}
function SharedRegistry({plan}:{plan:FoundExamPlan}){const rows=plan.scopes.flatMap(s=>s.sessions.flatMap(x=>x.assignments.map(a=>({scope:s,session:x,assignment:a}))));return <section className="eig-card eig-avoid-break"><div className="eig-section-title"><div><Users size={18}/><h2>Ortak Öğretmen Görevlendirme Kaydı</h2></div><span>{rows.length} kayıt</span></div><div className="eig-table-wrap"><table><thead><tr><th>Öğretmen</th><th>Okul grubu / sınıf</th><th>Sınav tarihi</th><th>Ders saati</th><th>Nöbet uyarısı</th><th>Durum</th></tr></thead><tbody>{rows.map(r=><tr key={r.assignment.id}><td><b>{r.assignment.teacherName}</b></td><td>{EXAM_SCOPE_LABELS[r.scope.scopeCode]} · {r.session.schoolClassName??"Genel oturum"}</td><td>{formatDate(sessionExamDate(r.session,plan.examDate))}</td><td>{r.session.periodName}</td><td>{r.assignment.dutyWarning?.length?"Nöbet devri gerekli":"Nöbet yok"}</td><td><span className={`eig-chip ${r.scope.status==="completed"?"eig-chip--success":""}`}>{r.scope.status==="completed"?"Kesinleşti":"Taslakta"}</span></td></tr>)}{!rows.length&&<tr><td colSpan={6}>Henüz gözetmen atanmadı.</td></tr>}</tbody></table></div></section>}
function TeacherInvigilationSummary({plan}:{plan:FoundExamPlan}){const rows=teacherSummaryRows(plan);if(!rows.length)return null;const scopes=EXAM_SCOPE_ORDER.filter(code=>plan.scopes.some(scope=>scope.scopeCode===code&&scope.sessions.length>0));return <section className="eig-card eig-avoid-break"><div className="eig-section-title"><div><Users size={18}/><h2>Öğretmen Bazlı Gözetmenlik Özeti</h2></div><span>{rows.length} öğretmen</span></div><div className="eig-table-wrap"><table aria-label="Öğretmen bazlı gözetmenlik özeti"><thead><tr><th>Öğretmen</th><th>Toplam görev</th>{scopes.map(code=><th key={code}>{EXAM_SCOPE_LABELS[code]}</th>)}<th>Nöbet devri</th><th>Görev günleri</th></tr></thead><tbody>{rows.map(row=><tr key={row.teacherSourceId}><td><b>{row.teacherName}</b></td><td>{row.totalCount}</td>{scopes.map(code=><td key={code}>{row.scopeCounts[code]??0}</td>)}<td>{row.warningCount}</td><td>{row.dates.map(formatShortDate).join(" · ")}</td></tr>)}</tbody></table></div></section>}
