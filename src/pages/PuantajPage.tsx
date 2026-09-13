/* oxlint-disable react/set-state-in-effect -- Seçili dönem değişince harici puantaj API'si yeniden okunur. */
import { useEffect, useState } from "react";
import { BadgeTurkishLira, CalendarClock, FileSpreadsheet, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { addCompensationRate, addManualPayroll, closePayroll, deleteCompensation, deleteManualPayroll, fetchCompensation, fetchPayroll, fetchSubList, fetchSubPreparation, saveCompensation, updateManualPayroll, updateSubTask } from "../lib/substitutions/api";
import type { CompensationType, PayrollLine, PayrollOverview, SubTeacher } from "../lib/substitutions/types";
import { addPayrollCorrection, closeMonthlyPayrollForTeacher, fetchMonthlyOverview, fetchPayrollCorrections, fetchRelevantTeachers, setSubstitutionCompensationType, yearEndClearDebt } from "../lib/monthlyPayroll/api";
import type { MonthlyPayrollOverview, PayrollCorrection, RelevantTeacher } from "../lib/monthlyPayroll/types";
import { useAuth } from "../auth/AuthContext";
import { navigate, ROUTES } from "../lib/router";
import "./PuantajPage.css";

const today = () => new Date().toISOString().slice(0, 10);
const currentMonthStart = () => `${today().slice(0, 7)}-01`;
type View = "payroll" | "settings" | "monthly";

export default function PuantajPage({initialView="payroll"}:{initialView?:View}) {
  const [view,setView]=useState<View>(initialView);
  const [types,setTypes]=useState<CompensationType[]>([]);
  const [teachers,setTeachers]=useState<SubTeacher[]>([]);
  const [payroll,setPayroll]=useState<PayrollOverview|null>(null);
  const [anchor,setAnchor]=useState(today());
  const [notice,setNotice]=useState("");
  const [typeName,setTypeName]=useState("");
  const [editingTypeId,setEditingTypeId]=useState<string|null>(null);
  const [editingTypeName,setEditingTypeName]=useState("");
  const [typeBusyId,setTypeBusyId]=useState<string|null>(null);
  const [rate,setRate]=useState({typeId:"",effectiveFrom:today(),unitRate:""});
  const [entry,setEntry]=useState({teacherSourceId:"",replacedTeacherSourceId:"",dutyDate:today(),compensationTypeId:"",quantity:"1",note:""});
  const [editingEntryId,setEditingEntryId]=useState<string|null>(null);
  const [selectedTeacherId,setSelectedTeacherId]=useState("");
  const { user } = useAuth();
  const [monthStart,setMonthStart]=useState(currentMonthStart());
  const [monthlyTeachers,setMonthlyTeachers]=useState<RelevantTeacher[]>([]);
  const [monthlyTeacherId,setMonthlyTeacherId]=useState("");
  const [monthlyOverview,setMonthlyOverview]=useState<MonthlyPayrollOverview|null>(null);
  const [monthlyCorrections,setMonthlyCorrections]=useState<PayrollCorrection[]>([]);
  const [correctionForm,setCorrectionForm]=useState({type:"debt_adjust",amount:"",reason:""});
  const [substitutionTypeId,setSubstitutionTypeId]=useState("");

  async function loadMonthly(){
    try{const teachers=await fetchRelevantTeachers(monthStart);setMonthlyTeachers(teachers.items);}
    catch{setNotice("Bu aya ait öğretmen listesi alınamadı.");}
  }
  useEffect(()=>{void loadMonthly();},[monthStart]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadMonthlyTeacher(){
    if(!monthlyTeacherId){setMonthlyOverview(null);return;}
    try{
      const[overview,corrections]=await Promise.all([fetchMonthlyOverview(monthStart,monthlyTeacherId),fetchPayrollCorrections(monthStart,monthlyTeacherId)]);
      setMonthlyOverview(overview);setMonthlyCorrections(corrections.items);
    }catch{setNotice("Aylık puantaj alınamadı.");}
  }
  useEffect(()=>{void loadMonthlyTeacher();},[monthlyTeacherId,monthStart]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitCorrection(){
    if(!monthlyTeacherId||!correctionForm.reason.trim())return;
    try{
      await addPayrollCorrection({teacherSourceId:monthlyTeacherId,monthStart,type:correctionForm.type,amount:Number(correctionForm.amount),reason:correctionForm.reason,createdBy:user?.email??null});
      setCorrectionForm({type:"debt_adjust",amount:"",reason:""});setNotice("Düzeltme eklendi.");await loadMonthlyTeacher();
    }catch(error){setNotice(error instanceof Error?error.message:"Düzeltme eklenemedi.");}
  }
  async function closeTeacherMonth(){
    if(!monthlyTeacherId)return;
    try{const result=await closeMonthlyPayrollForTeacher(monthStart,monthlyTeacherId) as {status?:string};if(result.status==="ok"||result.status==="already_closed")setNotice("Öğretmen için ay kapatıldı.");await loadMonthlyTeacher();}
    catch(error){setNotice(error instanceof Error?error.message:"Kapanamadı.");}
  }
  async function runYearEndClear(){
    if(!monthlyTeacherId||!monthlyOverview)return;
    const debt=Number((monthlyOverview as any).debtCarryOut??(monthlyOverview as any).debt_carry_out??0);
    if(debt<=0){setNotice("Bu öğretmenin devreden yokluk borcu yok.");return;}
    const reason=window.prompt(`${debt} ders borcu tamamen kapatılacak. Bu işlem geri alınamaz. Gerekçeyi yazın:`);
    if(!reason?.trim())return;
    try{await yearEndClearDebt({teacherSourceId:monthlyTeacherId,debtAmount:debt,reason,targetMonthStart:monthStart,createdBy:user?.email??null});setNotice("Yokluk borcu kapatıldı.");await loadMonthlyTeacher();}
    catch(error){setNotice(error instanceof Error?error.message:"Borç kapatılamadı.");}
  }
  async function saveSubstitutionType(){
    try{await setSubstitutionCompensationType(substitutionTypeId||null);setNotice("Ders yerine görevlendirme ücret türü kaydedildi.");}
    catch(error){setNotice(error instanceof Error?error.message:"Kaydedilemedi.");}
  }
  const tryFmt=(cents:number|undefined)=>((cents??0)/100).toLocaleString("tr-TR",{style:"currency",currency:"TRY"});
  const mv=(a:keyof MonthlyPayrollOverview,b:keyof MonthlyPayrollOverview):number=>Number((monthlyOverview as any)?.[a]??(monthlyOverview as any)?.[b]??0);

  async function load(){try{const[t,p,c]=await Promise.all([fetchSubPreparation(new URLSearchParams()),fetchPayroll(anchor),fetchCompensation()]);setTeachers(t.teachers);setPayroll(p);setTypes(c.items)}catch{setNotice("Puantaj bilgileri alınamadı.")}}
  useEffect(()=>{void load()},[anchor]);// eslint-disable-line react-hooks/exhaustive-deps
  const totals=payroll?.totals??[];
  const lines=payroll?.lines??[];
  const manualTypes=types.filter((item)=>item.entryMode==="manual"&&(item.isActive||item.id===entry.compensationTypeId));
  const selectedEntryType=manualTypes.find((item)=>item.id===entry.compensationTypeId);
  const replacementRequired=selectedEntryType?.systemCode==="SUBSTITUTION";
  const processedTeachers=[...new Map([...totals.map((item)=>[item.teacher_source_id,item.teacher_name_snapshot] as const),...lines.map((item)=>[item.teacher_source_id,item.teacher_name_snapshot] as const)]).entries()].map(([sourceId,name])=>({sourceId,name})).sort((a,b)=>a.name.localeCompare(b.name,"tr"));
  const activeTeacherId=processedTeachers.some((item)=>item.sourceId===selectedTeacherId)?selectedTeacherId:"";
  const selectedTeacher=processedTeachers.find((item)=>item.sourceId===activeTeacherId)??null;
  const selectedTotal=totals.find((item)=>item.teacher_source_id===activeTeacherId)??null;
  const selectedLines=lines.filter((item)=>item.teacher_source_id===activeTeacherId);

  function beginManualEdit(line:PayrollLine){setEditingEntryId(line.source_id);setEntry({teacherSourceId:line.teacher_source_id,replacedTeacherSourceId:line.replaced_teacher_source_id??"",dutyDate:line.duty_date,compensationTypeId:line.compensation_type_id,quantity:String(line.quantity),note:line.detail_snapshot??""});const formElement=document.getElementById("manual-payroll-form");if(typeof formElement?.scrollIntoView==="function")formElement.scrollIntoView({behavior:"smooth",block:"center"})}
  function cancelManualEdit(){setEditingEntryId(null);setEntry({teacherSourceId:"",replacedTeacherSourceId:"",dutyDate:today(),compensationTypeId:"",quantity:"1",note:""})}
  async function saveManualEntry(){try{const body={...entry,quantity:Number(entry.quantity)};if(editingEntryId){await updateManualPayroll(editingEntryId,body);setNotice("Manuel görev güncellendi.")}else{await addManualPayroll(body);setNotice("Manuel görev eklendi.")}cancelManualEdit();await load()}catch(error){setNotice(error instanceof Error?error.message:"Manuel görev kaydedilemedi.")}}
  async function removePayrollLine(line:PayrollLine){try{if(line.source_kind==="manual"){if(!window.confirm("Bu manuel görev ve geçici puantaj hesabı silinsin mi?"))return;await deleteManualPayroll(line.source_id)}else{if(!line.day_list_id||!window.confirm(`${line.teacher_name_snapshot} öğretmeninin ${line.replaced_teacher_name_snapshot??"ilgili öğretmen"} yerine görevlendirmesi kaldırılsın mı? Günlük liste yeniden taslak durumuna döner.`))return;const dayList=await fetchSubList(line.day_list_id);await updateSubTask(line.source_id,{teacherSourceId:null,unfilledNote:null,expectedVersion:dayList.version})}setNotice("Görev ve geçici puantaj kaydı silindi.");await load()}catch(error){setNotice(error instanceof Error?error.message:"Görev silinemedi.")}}
  function editPayrollLine(line:PayrollLine){if(line.source_kind==="manual")beginManualEdit(line);else if(line.day_list_id)navigate(`${ROUTES.substitutions}?listId=${encodeURIComponent(line.day_list_id)}&taskId=${encodeURIComponent(line.source_id)}`)}

  async function createCompensationType(){setTypeBusyId("new");setNotice("");try{await saveCompensation({name:typeName,isActive:true});setTypeName("");setNotice("Ücret türü eklendi.");await load()}catch(error){setNotice(error instanceof Error?error.message:"Ücret türü eklenemedi.")}finally{setTypeBusyId(null)}}
  function beginTypeEdit(type:CompensationType){setEditingTypeId(type.id);setEditingTypeName(type.name);setNotice("")}
  function cancelTypeEdit(){setEditingTypeId(null);setEditingTypeName("")}
  async function updateCompensationType(type:CompensationType){setTypeBusyId(type.id);setNotice("");try{await saveCompensation({id:type.id,name:editingTypeName,isActive:true});cancelTypeEdit();setNotice("Ücret türü güncellendi.");await load()}catch(error){setNotice(error instanceof Error?error.message:"Ücret türü güncellenemedi.")}finally{setTypeBusyId(null)}}
  async function removeCompensationType(type:CompensationType){if(!window.confirm(`“${type.name}” ücret türü silinsin mi? Kullanılmışsa geçmiş puantaj kayıtları korunur ve tür yeni işlemlere kapatılır.`))return;setTypeBusyId(type.id);setNotice("");try{const result=await deleteCompensation(type.id);if(rate.typeId===type.id)setRate(value=>({...value,typeId:""}));if(entry.compensationTypeId===type.id)setEntry(value=>({...value,compensationTypeId:""}));if(editingTypeId===type.id)cancelTypeEdit();setNotice(result.action==="deactivated"?"Ücret türü geçmiş kayıtlar korunarak kullanımdan kaldırıldı.":"Ücret türü silindi.");await load()}catch(error){setNotice(error instanceof Error?error.message:"Ücret türü silinemedi.")}finally{setTypeBusyId(null)}}

  async function exportXlsx(){
    if(!payroll)return;
    const{Workbook}=await import("exceljs");const workbook=new Workbook();const summary=workbook.addWorksheet("Öğretmen Özeti");
    const typeNames=[...new Set(lines.map((line)=>line.compensation_type_name_snapshot))].sort((a,b)=>a.localeCompare(b,"tr"));
    summary.addRow(["Puantaj dönemi",payroll.periodStart,payroll.periodEnd,"Para birimi","TRY"]);summary.addRow([]);summary.addRow(["Öğretmen",...typeNames,"Toplam puan/adet","Toplam ödeme (TRY)"]);
    for(const total of totals){const byType=new Map(total.breakdown.map((item)=>[item.type,item.quantity]));summary.addRow([total.teacher_name_snapshot,...typeNames.map((name)=>byType.get(name)??0),total.total_quantity,total.total_amount])}
    summary.getRow(3).font={bold:true};summary.columns.forEach((column)=>{column.width=22});
    const details=workbook.addWorksheet("Görev Ayrıntıları");details.addRow(["Tarih","Atanan Öğretmen","Kimin Yerine","Adet","Açıklama"]);details.getRow(1).font={bold:true};
    for(const line of lines)details.addRow([line.duty_date,line.teacher_name_snapshot,line.replaced_teacher_name_snapshot??"—",line.quantity,line.detail_snapshot]);details.columns.forEach((column)=>{column.width=24});
    const buffer=await workbook.xlsx.writeBuffer();const url=URL.createObjectURL(new Blob([buffer as ArrayBuffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));const link=document.createElement("a");link.href=url;link.download=`puantaj_${payroll.periodStart}_${payroll.periodEnd}.xlsx`;link.click();URL.revokeObjectURL(url);
  }

  return <div className="pay-page"><header><div><span>ÖDEME VE PUANTAJ</span><h1>Puantaj Yönetimi</h1><p>Ders yerine görevlendirme dahil tüm ek görevleri manuel kaydedip dönemsel olarak hesaplayın.</p></div><nav><button className={view==="payroll"?"active":""} onClick={()=>setView("payroll")}><BadgeTurkishLira size={16}/>Puantaj (Manuel)</button><button className={view==="monthly"?"active":""} onClick={()=>setView("monthly")}><CalendarClock size={16}/>Aylık Puantaj</button><button className={view==="settings"?"active":""} onClick={()=>setView("settings")}><Settings size={16}/>Ücret Türleri</button></nav></header>{notice&&<div className="pay-alert">{notice}</div>}
  {view==="payroll"&&<><section className="pay-card pay-toolbar"><label>Dönem içinden bir tarih<input type="date" value={anchor} onChange={(event)=>setAnchor(event.target.value)}/></label>{payroll&&<><div><b>{payroll.periodStart} – {payroll.periodEnd}</b><span>{payroll.status==="closed"?"Kapandı":payroll.status==="pending_rate"?"Kapanış bekliyor · ücret eksik":"Açık · geçici toplamlar"}</span></div><button className="btn btn-secondary" disabled={payroll.status!=="closed"} title={payroll.status==="closed"?undefined:"XLSX, dondurulmuş kapanış verisinden alınır."} onClick={()=>void exportXlsx()}><FileSpreadsheet size={15}/>XLSX indir</button><button className="btn btn-primary" disabled={payroll.status==="closed"} onClick={async()=>{const result=await closePayroll(anchor,true) as{status?:string};setNotice(result.status==="pending_rate"?"Kullanılan görev türlerinden birinin ücreti eksik.":"Puantaj kapatıldı.");await load()}}>Puantajı Kapat</button></>}</section>
  {payroll?.status!=="closed"&&<section className="pay-card"><p>Bu dönem henüz kapanmadı. Aşağıdaki adet ve tutarlar canlı, geçici değerlerdir; kapanışta snapshot olarak dondurulur.</p></section>}
  <section className="pay-card" id="manual-payroll-form"><h2>{editingEntryId?"Manuel görevi düzenle":"Manuel görev ekle"}</h2><div className="pay-form"><label>Atanan öğretmen<select aria-label="Atanan öğretmen" value={entry.teacherSourceId} onChange={(event)=>setEntry((value)=>({...value,teacherSourceId:event.target.value,replacedTeacherSourceId:value.replacedTeacherSourceId===event.target.value?"":value.replacedTeacherSourceId}))}><option value="">Seçin</option>{teachers.map((teacher)=><option key={teacher.sourceId} value={teacher.sourceId}>{teacher.name}</option>)}</select></label><label>Tarih<input aria-label="Görev tarihi" type="date" value={entry.dutyDate} onChange={(event)=>setEntry((value)=>({...value,dutyDate:event.target.value}))}/></label><label>Görev türü<select aria-label="Görev türü" value={entry.compensationTypeId} onChange={(event)=>setEntry((value)=>({...value,compensationTypeId:event.target.value,replacedTeacherSourceId:""}))}><option value="">Seçin</option>{manualTypes.map((type)=><option key={type.id} value={type.id}>{type.name}</option>)}</select></label>{replacementRequired&&<label>Kimin yerine<select aria-label="Kimin yerine" value={entry.replacedTeacherSourceId} onChange={(event)=>setEntry((value)=>({...value,replacedTeacherSourceId:event.target.value}))}><option value="">Seçin</option>{teachers.filter((teacher)=>teacher.sourceId!==entry.teacherSourceId).map((teacher)=><option key={teacher.sourceId} value={teacher.sourceId}>{teacher.name}</option>)}</select></label>}<label>Adet<input aria-label="Görev adedi" type="number" step="0.5" value={entry.quantity} onChange={(event)=>setEntry((value)=>({...value,quantity:event.target.value}))}/></label><label className="pay-note-field">Açıklama<input aria-label="Görev açıklaması" value={entry.note} onChange={(event)=>setEntry((value)=>({...value,note:event.target.value}))}/></label><div className="pay-form-actions">{editingEntryId&&<button className="btn btn-secondary" onClick={cancelManualEdit}>Vazgeç</button>}<button className="btn btn-primary" onClick={()=>void saveManualEntry()} disabled={!entry.teacherSourceId||!entry.compensationTypeId||(replacementRequired&&!entry.replacedTeacherSourceId)}><Plus size={15}/>{editingEntryId?"Kaydet":"Ekle"}</button></div></div>{replacementRequired&&<p className="pay-form-hint">Ders yerine görevlendirme kayıtlarında, görevi alan öğretmen ile yerine girilen öğretmen birlikte saklanır.</p>}</section>
  <section className="pay-card pay-teacher-focus"><div className="pay-focus-heading"><div><h2>Öğretmen puantajı</h2><p>Ödeme veya görevlendirme kaydı bulunan öğretmeni seçin.</p></div><label>İşlem gören öğretmen<select aria-label="İşlem gören öğretmen" value={activeTeacherId} onChange={(event)=>setSelectedTeacherId(event.target.value)}><option value="">Öğretmen seçin</option>{processedTeachers.map((teacher)=><option key={teacher.sourceId} value={teacher.sourceId}>{teacher.name}</option>)}</select></label></div>{!processedTeachers.length?<div className="pay-empty">Bu dönemde henüz ödeme veya görevlendirme kaydı yok.</div>:!selectedTeacher?<div className="pay-empty">Ödeme özetini ve görev ayrıntılarını görmek için bir öğretmen seçin.</div>:<><div className="pay-teacher-strip"><div><span>SEÇİLİ ÖĞRETMEN</span><strong>{selectedTeacher.name}</strong></div><div><span>TOPLAM ADET</span><strong>{selectedTotal?.total_quantity??selectedLines.reduce((sum,line)=>sum+Number(line.quantity),0)}</strong></div><div><span>TOPLAM ÖDEME</span><strong>{selectedTotal?Number(selectedTotal.total_amount).toLocaleString("tr-TR",{style:"currency",currency:"TRY"}):"—"}</strong></div></div><div className="pay-focus-grid"><article className="pay-summary-card"><h3>Öğretmen ödeme özeti</h3>{selectedTotal?<><dl><div><dt>Toplam adet</dt><dd>{selectedTotal.total_quantity}</dd></div><div><dt>Toplam ödeme</dt><dd>{Number(selectedTotal.total_amount).toLocaleString("tr-TR",{style:"currency",currency:"TRY"})}</dd></div></dl><div className="pay-breakdown"><span>Görev dağılımı</span>{selectedTotal.breakdown.map((item)=><div key={item.type}><b>{item.type}</b><strong>{item.quantity}</strong></div>)}</div></>:<p>Bu öğretmen için ödeme toplamı henüz oluşmadı.</p>}</article><article className="pay-detail-card"><div className="pay-detail-heading"><div><h3>Görev ayrıntıları</h3><span>{selectedLines.length} kayıt</span></div><small>Liste kart içinde kaydırılır.</small></div>{!selectedLines.length?<div className="pay-empty">Bu öğretmenin görev ayrıntısı yok.</div>:<div className="pay-table-scroll pay-detail-scroll"><table aria-label="Görev ayrıntıları"><thead><tr><th>Tarih</th><th>Atanan Öğretmen</th><th>Kimin Yerine</th><th>Adet</th><th>Açıklama</th><th>İşlem</th></tr></thead><tbody>{selectedLines.map((line)=>{const hasActionData=line.source_kind==="manual"?Boolean(line.compensation_type_id):Boolean(line.day_list_id);const editable=payroll?.status!=="closed"&&!line.is_historical&&hasActionData;return <tr key={`${line.source_kind}-${line.source_id}`}><td>{line.duty_date}</td><td><strong>{line.teacher_name_snapshot}</strong></td><td>{line.replaced_teacher_name_snapshot??"—"}</td><td>{line.quantity}</td><td>{line.detail_snapshot??"—"}</td><td>{editable?<div className="pay-row-actions"><button className="btn btn-secondary" onClick={()=>editPayrollLine(line)}><Pencil size={14}/>Düzenle</button><button className="btn btn-danger" onClick={()=>void removePayrollLine(line)}><Trash2 size={14}/>Sil</button></div>:<span className="pay-locked">Dönem kilitli</span>}</td></tr>})}</tbody></table></div>}</article></div></>}</section></>}
  {view==="monthly"&&<><section className="pay-card pay-toolbar"><label>Ay<input type="month" value={monthStart.slice(0,7)} onChange={(event)=>setMonthStart(`${event.target.value}-01`)}/></label><label>Öğretmen<select value={monthlyTeacherId} onChange={(event)=>setMonthlyTeacherId(event.target.value)}><option value="">Seçin</option>{monthlyTeachers.map((teacher)=><option key={teacher.sourceId} value={teacher.sourceId}>{teacher.name}</option>)}</select></label></section>
  {!monthlyTeachers.length&&<section className="pay-card"><p>Bu ayda henüz yokluk veya ders yerine görevlendirme kaydı bulunan öğretmen yok.</p></section>}
  {monthlyOverview&&<section className="pay-card pay-teacher-focus"><div className="pay-focus-heading"><div><h2>{monthlyOverview.teacherNameSnapshot??monthlyTeachers.find(t=>t.sourceId===monthlyTeacherId)?.name}</h2><p>{monthlyOverview.source==="closed"?"Dönem kapandı — değerler dondurulmuş snapshot'tır.":"Açık dönem · canlı önizleme"}</p></div>{monthlyOverview.source!=="closed"&&<button className="btn btn-primary" onClick={()=>void closeTeacherMonth()}>Bu Öğretmen İçin Ayı Kapat</button>}</div>
  <dl className="pay-breakdown"><div><dt>Normal aylık ders</dt><dd>{mv("normalMonthlyLoad","normal_monthly_load")}</dd></div><div><dt>Aylık eşik</dt><dd>{mv("monthlyThreshold","monthly_threshold")}</dd></div><div><dt>Devreden yokluk borcu</dt><dd>{mv("debtCarryIn","debt_carry_in")}</dd></div><div><dt>Bu ay oluşan borç</dt><dd>{mv("debtCreatedThisMonth","debt_created_this_month")}</dd></div><div><dt>Borca mahsup edilen ders</dt><dd>{mv("debtOffsetCount","debt_offset_count")}</dd></div><div><dt>28 saate mahsup edilen ders</dt><dd>{mv("thresholdFillCount","threshold_fill_count")}</dd></div><div><dt>Ücretli ders adedi</dt><dd>{mv("paidLessonCount","paid_lesson_count")}</dd></div><div><dt>Devreden borç</dt><dd>{mv("debtCarryOut","debt_carry_out")}</dd></div><div><dt>Brüt ödeme</dt><dd>{tryFmt(mv("grossAmountCents","gross_amount_cents"))}</dd></div><div><dt>Mali mahsup</dt><dd>{tryFmt(mv("financialOffsetApplied","financial_offset_applied_cents"))}</dd></div><div><dt>Net ödeme</dt><dd>{tryFmt(mv("netAmountCents","net_amount_cents"))}</dd></div></dl>
  {monthlyOverview.hasEducationCalendar===false&&<div className="pay-alert">Kapanış bekliyor — eğitim takvimi eksik.</div>}
  {monthlyOverview.hasCompensationType===false&&<div className="pay-alert">Kapanış bekliyor — ders yerine görevlendirme için ücret türü seçilmedi.</div>}
  {monthlyOverview.hasMissingRate&&<div className="pay-alert">Kapanış bekliyor — bazı görevlerin tarihinde geçerli birim ücret eksik.</div>}
  <div className="pay-detail-card"><h3>Yönetici düzeltmesi ekle</h3><div className="pay-inline"><select value={correctionForm.type} onChange={(event)=>setCorrectionForm(v=>({...v,type:event.target.value}))}><option value="debt_adjust">Ders borcu +/-</option><option value="paid_count_adjust">Ücretli ders adedi +/-</option><option value="payment_amount_adjust">Ödeme tutarı (kuruş) +/-</option></select><input type="number" placeholder="Miktar" value={correctionForm.amount} onChange={(event)=>setCorrectionForm(v=>({...v,amount:event.target.value}))}/><input placeholder="Gerekçe (zorunlu)" value={correctionForm.reason} onChange={(event)=>setCorrectionForm(v=>({...v,reason:event.target.value}))}/><button className="btn btn-primary" disabled={!correctionForm.amount||!correctionForm.reason.trim()} onClick={()=>void submitCorrection()}>Ekle</button></div>
  <ul className="sd-list">{monthlyCorrections.map(item=><li key={item.id}>{item.type} · {item.amount} · {item.reason}</li>)}</ul></div>
  <div className="pay-detail-card"><h3>Eğitim yılı sonu borç kapatma</h3><p>Devreden yokluk borcunu tamamen kapatır. Geri alınamaz; gerekçe ve tutar denetim kaydında saklanır.</p><button className="btn btn-danger" onClick={()=>void runYearEndClear()}>Bu Öğretmenin Borcunu Kapat</button></div>
  </section>}
  </>}
  {view==="settings"&&<><section className="pay-card"><h2>Ders yerine görevlendirme ücret türü</h2><div className="pay-inline"><select value={substitutionTypeId} onChange={(event)=>setSubstitutionTypeId(event.target.value)}><option value="">Seçilmedi</option>{types.filter(t=>t.isActive).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><button className="btn btn-primary" onClick={()=>void saveSubstitutionType()}>Kaydet</button></div><p className="pay-form-hint">Aylık puantaj motoru, öğretmenlerin üstlendiği ek dersleri burada seçilen ücret türünün birim ücretiyle hesaplar.</p></section>
  <section className="pay-card"><h2>Yeni ücret türü</h2><div className="pay-inline"><input aria-label="Yeni görev türü adı" placeholder="Görev türü adı" value={typeName} onChange={(event)=>setTypeName(event.target.value)}/><button className="btn btn-primary" disabled={typeName.trim().length<2||typeBusyId!==null} onClick={()=>void createCompensationType()}><Plus size={15}/>{typeBusyId==="new"?"Ekleniyor…":"Ekle"}</button></div></section><section className="pay-card"><h2>Tarih sürümlü birim ücretler</h2><div className="pay-rate-form"><select value={rate.typeId} onChange={(event)=>setRate((value)=>({...value,typeId:event.target.value}))}><option value="">Görev türü seçin</option>{types.filter((type)=>type.isActive).map((type)=><option key={type.id} value={type.id}>{type.name}</option>)}</select><input type="date" value={rate.effectiveFrom} onChange={(event)=>setRate((value)=>({...value,effectiveFrom:event.target.value}))}/><input type="number" min="0" step="0.01" placeholder="Birim ücret (₺)" value={rate.unitRate} onChange={(event)=>setRate((value)=>({...value,unitRate:event.target.value}))}/><button className="btn btn-primary" disabled={!rate.typeId||rate.unitRate===""} onClick={async()=>{await addCompensationRate(rate.typeId,{effectiveFrom:rate.effectiveFrom,unitRate:Number(rate.unitRate)});setRate((value)=>({...value,unitRate:""}));await load()}}>Ücreti Kaydet</button></div><div className="pay-types">{types.filter(type=>type.isActive).map((type)=><article key={type.id}>{editingTypeId===type.id?<div className="pay-type-editor"><label>Görev türü adı<input aria-label={`${type.name} yeni adı`} value={editingTypeName} onChange={event=>setEditingTypeName(event.target.value)} autoFocus/></label><div className="pay-type-actions"><button className="btn btn-secondary" disabled={typeBusyId===type.id} onClick={cancelTypeEdit}>Vazgeç</button><button className="btn btn-primary" disabled={editingTypeName.trim().length<2||typeBusyId===type.id} onClick={()=>void updateCompensationType(type)}>{typeBusyId===type.id?"Kaydediliyor…":"Kaydet"}</button></div></div>:<div className="pay-type-head"><div><b>{type.name}</b><small>{type.entryMode==="automatic"?"Sistemden otomatik":"Manuel giriş"}</small></div>{type.entryMode==="manual"&&type.systemCode===null&&<div className="pay-type-actions"><button className="btn btn-secondary" disabled={typeBusyId!==null} onClick={()=>beginTypeEdit(type)}><Pencil size={14}/>Düzenle</button><button className="btn btn-danger" disabled={typeBusyId!==null} onClick={()=>void removeCompensationType(type)}><Trash2 size={14}/>{typeBusyId===type.id?"Siliniyor…":"Sil"}</button></div>}</div>}<ul>{type.rates.map((item)=><li key={item.id}><span>{item.effectiveFrom}</span><b>{Number(item.unitRate).toLocaleString("tr-TR",{style:"currency",currency:"TRY"})}</b></li>)}{!type.rates.length&&<li>Henüz ücret tanımlanmadı.</li>}</ul></article>)}</div></section></>}
  </div>;
}
