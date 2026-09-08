import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PuantajPage from "../PuantajPage";
import * as api from "../../lib/substitutions/api";

vi.mock("../../lib/substitutions/api");

const TYPE_ID="22222222-2222-4222-8222-222222222222";
const LIST_ID="33333333-3333-4333-8333-333333333333";
const TASK_ID="44444444-4444-4444-8444-444444444444";
const MANUAL_ID="55555555-5555-4555-8555-555555555555";
const lineBase={teacher_source_id:"T2",teacher_name_snapshot:"ATANAN ÖĞRETMEN",duty_date:"2026-09-14",compensation_type_id:TYPE_ID,compensation_type_name_snapshot:"Ders yerine görevlendirme",quantity:1,unit_rate_snapshot:150,amount_snapshot:150,detail_snapshot:"10/A · FİZİK · 5-ÖO",rate_missing:false,list_version:2,is_historical:false};

describe("Puantaj görev ayrıntıları",()=>{
  afterEach(cleanup);
  beforeEach(()=>{
    vi.clearAllMocks();
    window.history.replaceState({},"","/puantaj");
    vi.spyOn(window,"confirm").mockReturnValue(true);
    vi.mocked(api.fetchSubPreparation).mockResolvedValue({hasImport:true,teachers:[{sourceId:"T2",name:"ATANAN ÖĞRETMEN",branch:null},{sourceId:"T3",name:"İŞLEM GÖRMEYEN ÖĞRETMEN",branch:null}],lessons:[]});
    vi.mocked(api.fetchCompensation).mockResolvedValue({items:[{id:TYPE_ID,name:"Akşam Etütü",systemCode:null,entryMode:"manual",isActive:true,rates:[]}]});
    vi.mocked(api.fetchPayroll).mockResolvedValue({periodStart:"2026-09-01",periodEnd:"2026-09-30",status:"open",periodId:null,totals:[{teacher_source_id:"T4",teacher_name_snapshot:"YALNIZ ÖDEME ALAN ÖĞRETMEN",total_quantity:3,total_amount:450,breakdown:[{type:"Akşam Etütü",quantity:3,amount:450}]}],lines:[
      {...lineBase,source_id:TASK_ID,source_kind:"substitution",replaced_teacher_name_snapshot:"YERİNE GİRİLEN ÖĞRETMEN",day_list_id:LIST_ID},
      {...lineBase,source_id:MANUAL_ID,source_kind:"manual",replaced_teacher_name_snapshot:null,day_list_id:null,compensation_type_name_snapshot:"Akşam Etütü"},
    ]});
    vi.mocked(api.fetchSubList).mockResolvedValue({found:true,id:LIST_ID,assignmentDate:"2026-09-14",status:"completed",version:3,isHistorical:false,tasks:[]});
    vi.mocked(api.updateSubTask).mockResolvedValue({status:"ok",version:4});
    vi.mocked(api.updateManualPayroll).mockResolvedValue({status:"ok"});
    vi.mocked(api.deleteManualPayroll).mockResolvedValue({status:"ok"});
    vi.mocked(api.saveCompensation).mockResolvedValue({status:"ok"});
    vi.mocked(api.deleteCompensation).mockResolvedValue({status:"ok",action:"deleted"});
  });

  it("yalnız istenen altı sütunu ve yerine girilen öğretmeni gösterir",async()=>{
    render(<PuantajPage/>);
    const selector=await screen.findByRole("combobox",{name:"İşlem gören öğretmen"});
    expect(within(selector).queryByRole("option",{name:"İŞLEM GÖRMEYEN ÖĞRETMEN"})).toBeNull();
    expect(within(selector).getByRole("option",{name:"YALNIZ ÖDEME ALAN ÖĞRETMEN"})).toBeTruthy();
    fireEvent.change(selector,{target:{value:"T2"}});
    const table=await screen.findByRole("table",{name:"Görev ayrıntıları"});
    expect(within(table).getAllByRole("columnheader").map(x=>x.textContent)).toEqual(["Tarih","Atanan Öğretmen","Kimin Yerine","Adet","Açıklama","İşlem"]);
    expect(within(table).getByText("YERİNE GİRİLEN ÖĞRETMEN")).toBeTruthy();
    expect(within(table).queryByText("Birim ücret")).toBeNull();
    expect(within(table).queryByText("Tutar")).toBeNull();
  });

  it("yalnız ödeme toplamı bulunan öğretmeni de seçicide ve özet kartında gösterir",async()=>{
    render(<PuantajPage/>);const selector=await screen.findByRole("combobox",{name:"İşlem gören öğretmen"});
    fireEvent.change(selector,{target:{value:"T4"}});
    expect(screen.getAllByText("₺450,00")).toHaveLength(2);
    expect(screen.getAllByText("Akşam Etütü")).toHaveLength(2);
    expect(screen.queryByRole("table",{name:"Görev ayrıntıları"})).toBeNull();
  });

  it("otomatik satırı silerken güncel liste sürümüyle yalnız atamayı kaldırır",async()=>{
    render(<PuantajPage/>);fireEvent.change(await screen.findByRole("combobox",{name:"İşlem gören öğretmen"}),{target:{value:"T2"}});const teacher=await screen.findByText("YERİNE GİRİLEN ÖĞRETMEN");const row=teacher.closest("tr")!;
    fireEvent.click(within(row).getByRole("button",{name:/Sil/}));
    await waitFor(()=>expect(api.updateSubTask).toHaveBeenCalledWith(TASK_ID,{teacherSourceId:null,unfilledNote:null,expectedVersion:3}));
  });

  it("otomatik satırı düzenlerken doğru liste ve görevi çalışma ekranında açar",async()=>{
    render(<PuantajPage/>);fireEvent.change(await screen.findByRole("combobox",{name:"İşlem gören öğretmen"}),{target:{value:"T2"}});const teacher=await screen.findByText("YERİNE GİRİLEN ÖĞRETMEN");const row=teacher.closest("tr")!;
    fireEvent.click(within(row).getByRole("button",{name:/Düzenle/}));
    expect(window.location.pathname).toBe("/ders-yerine-gorevlendirme");
    expect(new URLSearchParams(window.location.search).get("listId")).toBe(LIST_ID);
    expect(new URLSearchParams(window.location.search).get("taskId")).toBe(TASK_ID);
  });

  it("manuel satırı düzenleme formuna taşır ve PUT ile kaydeder",async()=>{
    render(<PuantajPage/>);fireEvent.change(await screen.findByRole("combobox",{name:"İşlem gören öğretmen"}),{target:{value:"T2"}});const table=await screen.findByRole("table",{name:"Görev ayrıntıları"});const row=within(table).getAllByRole("row")[2];
    fireEvent.click(within(row).getByRole("button",{name:/Düzenle/}));
    expect(screen.getByRole("heading",{name:"Manuel görevi düzenle"})).toBeTruthy();
    fireEvent.click(screen.getByRole("button",{name:"Kaydet"}));
    await waitFor(()=>expect(api.updateManualPayroll).toHaveBeenCalledWith(MANUAL_ID,expect.objectContaining({teacherSourceId:"T2",quantity:1})));
  });

  it("özel ücret türünü kart içinde yeniden adlandırır",async()=>{
    render(<PuantajPage initialView="settings"/>);
    const card=(await screen.findByRole("button",{name:/Düzenle/})).closest("article")!;
    fireEvent.click(within(card).getByRole("button",{name:/Düzenle/}));
    fireEvent.change(within(card).getByRole("textbox",{name:"Akşam Etütü yeni adı"}),{target:{value:"Akşam Çalışması"}});
    fireEvent.click(within(card).getByRole("button",{name:"Kaydet"}));
    await waitFor(()=>expect(api.saveCompensation).toHaveBeenCalledWith({id:TYPE_ID,name:"Akşam Çalışması",isActive:true}));
    expect(await screen.findByText("Ücret türü güncellendi.")).toBeTruthy();
  });

  it("özel ücret türünü geçmiş kayıt uyarısıyla siler",async()=>{
    vi.mocked(api.deleteCompensation).mockResolvedValue({status:"ok",action:"deactivated"});
    render(<PuantajPage initialView="settings"/>);
    const card=(await screen.findByRole("button",{name:/Sil/})).closest("article")!;
    fireEvent.click(within(card).getByRole("button",{name:/Sil/}));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/geçmiş puantaj kayıtları korunur/));
    await waitFor(()=>expect(api.deleteCompensation).toHaveBeenCalledWith(TYPE_ID));
    expect(await screen.findByText("Ücret türü geçmiş kayıtlar korunarak kullanımdan kaldırıldı.")).toBeTruthy();
  });

  it("sistem ücret türünü değiştirme ve silme eylemlerine açmaz",async()=>{
    vi.mocked(api.fetchCompensation).mockResolvedValue({items:[
      {id:TYPE_ID,name:"Ders yerine görevlendirme",systemCode:"SUBSTITUTION",entryMode:"manual",isActive:true,rates:[]},
      {id:MANUAL_ID,name:"Pasif özel tür",systemCode:null,entryMode:"manual",isActive:false,rates:[]},
    ]});
    render(<PuantajPage initialView="settings"/>);
    const card=(await screen.findByText("Manuel giriş")).closest("article")!;
    expect(within(card).getByText("Manuel giriş")).toBeTruthy();
    expect(within(card).queryByRole("button",{name:/Düzenle|Sil/})).toBeNull();
    expect(screen.queryByText("Pasif özel tür")).toBeNull();
  });

  it("ders yerine görevlendirme türünü manuel görev seçiminde gösterir",async()=>{
    vi.mocked(api.fetchCompensation).mockResolvedValue({items:[
      {id:TYPE_ID,name:"Ders yerine görevlendirme",systemCode:"SUBSTITUTION",entryMode:"manual",isActive:true,rates:[]},
    ]});
    render(<PuantajPage/>);
    const taskType=await screen.findByRole("combobox",{name:"Görev türü"});
    expect(within(taskType).getByRole("option",{name:"Ders yerine görevlendirme"})).toBeTruthy();
  });
});
