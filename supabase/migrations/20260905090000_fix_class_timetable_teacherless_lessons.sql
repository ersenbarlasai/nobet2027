-- ============================================================================
-- Nöbet2027 — Sınıf Ders Programı: öğretmensiz (teacherids="") lesson/card
-- veri kaybının düzeltilmesi
-- ============================================================================
-- KÖK NEDEN: public.get_class_timetable_snapshot, sınıf programını YALNIZ
-- public.timetable_assignments üzerinden üretiyordu. timetable_assignments
-- satırları yalnız ascAdapter.ts'nin teacherIds × classIds kartezyen
-- döngüsünden üretilir (bkz. buildCardsAndAssignments) — bir <lesson>'ın
-- teacherids="" (boş) olduğu durumda bu döngü hiç çalışmaz ve o lesson için
-- HİÇ assignment satırı üretilmez. Ancak <card> kayıtları (timetable_cards)
-- assignment'lardan BAĞIMSIZ, yalnız <lesson> geçerliyse üretilir — yani
-- öğretmensiz derslerin card'ları veritabanında zaten VARDIR, yalnızca
-- assignment-tabanlı okuma sorgusu onları asla görmüyordu.
--
-- Gerçek örnek: "ORTAOKUL DENEME" (8/A, 4 card, Cuma period 2-3-4-5) ve
-- "LİSE DENEME" (11/A, 11/B, 12/A, 12/B ortak, 4 card, Cuma period 2-3-4-5)
-- — ikisi de teacherids="" olduğu için sınıf programında tamamen kayboluyordu.
--
-- DÜZELTME: Bu migration YALNIZ public.get_class_timetable_snapshot(...)
-- fonksiyonunu CREATE OR REPLACE ile günceller. Sınıf programının
-- authoritative kaynağı artık:
--   lesson_classes (school_class_id = seçilen sınıf)
--     → lessons → timetable_cards (+ subjects)
--     → lesson_teachers → teachers (LEFT JOIN — öğretmen YOKSA satır
--       KAYBOLMAZ, yalnız teacher alanları NULL olur)
--
-- Hiçbir tabloya INSERT/UPDATE/DELETE yapılmaz. Sahte öğretmen/assignment
-- ÜRETİLMEZ. teacher_id kolonu NULLABLE yapılmadı (schema değişmedi).
--
-- Fonksiyon imzası (p_campus_name, p_academic_year_name, p_class_id)
-- DEĞİŞMEDİ — yalnız gövdesi (özellikle "rows" üretimi) güncellendi.
-- Kalan tüm mantık (campus/year/import çözümü, sınıf/sınıf öğretmeni
-- lookup, days/periods) önceki migrationla birebir aynıdır.
-- ============================================================================

create or replace function public.get_class_timetable_snapshot(
  p_campus_name text,
  p_academic_year_name text,
  p_class_id uuid
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_class record;
  v_days jsonb;
  v_periods jsonb;
  v_rows jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_class_id is null then
    raise exception 'class_id zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    return jsonb_build_object('hasImport', false, 'classFound', false);
  end if;

  select sc.id, sc.source_id, sc.name, sc.grade, sc.class_teacher_id, ct.name as class_teacher_name
    into v_class
    from public.school_classes sc
    left join public.teachers ct on ct.id = sc.class_teacher_id
    where sc.id = p_class_id and sc.timetable_import_id = v_import.id;

  if not found then
    return jsonb_build_object('hasImport', true, 'classFound', false, 'importedAt', v_import.imported_at);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'sourceId', d.source_id, 'name', d.name, 'order', d.day_order
      ) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'sourceId', p.source_id, 'name', p.name, 'order', p.period_order,
      'startTime', p.starts_at, 'endTime', p.ends_at
      ) order by p.period_order), '[]'::jsonb)
    into v_periods
    from public.lesson_periods p
    where p.timetable_import_id = v_import.id;

  -- === Ham lesson/card satırları (gruplama YOK — server/services/
  -- classTimetables.ts::groupAssignmentRows card bazında gruplar) ===
  --
  -- Authoritative kaynak: lesson_classes → lessons → timetable_cards
  -- (+ subjects). Öğretmen bilgisi lesson_teachers/teachers üzerinden
  -- LEFT JOIN ile EKLENİR — bir lesson'ın hiç öğretmeni yoksa (teacherids="")
  -- LEFT JOIN o satırı KAYBETMEZ, yalnız t.id/t.name NULL döner (tam olarak
  -- bir satır — teacher_count=0 olduğu için çoklanma da olmaz).
  --
  -- mappingStatus, lesson'un GERÇEK teacher/class çokluğundan (aşağıdaki
  -- lateral alt sorgular) hesaplanır; teacher_count=0 olan (öğretmensiz)
  -- derslerde mappingStatus BİLEREK NULL bırakılır — sahte 'exact' değeri
  -- verilmez (bkz. teacherAssignmentStatus='unassigned' ayrımı).
  select coalesce(jsonb_agg(jsonb_build_object(
      'cardId', tc.id,
      'sourceCardKey', tc.source_card_key,
      'dayId', tc.timetable_day_id,
      'periodId', tc.lesson_period_id,
      'subjectName', s.name,
      'teacherName', t.name,
      'classroomNames', to_jsonb(tc.classroom_source_ids),
      'mappingStatus', case
        when counts.teacher_count = 0 then null
        when counts.teacher_count > 1 and counts.class_count > 1 then 'ambiguous'
        when counts.teacher_count > 1 or counts.class_count > 1 then 'expanded'
        else 'exact'
      end,
      'teacherAssignmentStatus', case when counts.teacher_count = 0 then 'unassigned' else 'assigned' end
    )), '[]'::jsonb)
    into v_rows
    from public.lesson_classes lc
    join public.lessons l
      on l.id = lc.lesson_id and l.timetable_import_id = v_import.id
    join public.timetable_cards tc
      on tc.lesson_id = l.id and tc.timetable_import_id = v_import.id
    left join public.subjects s on s.id = l.subject_id
    left join public.lesson_teachers lt on lt.lesson_id = l.id
    left join public.teachers t on t.id = lt.teacher_id
    cross join lateral (
      select
        (select count(*) from public.lesson_teachers lt2 where lt2.lesson_id = l.id) as teacher_count,
        (select count(*) from public.lesson_classes lc2
           where lc2.lesson_id = l.id and lc2.timetable_import_id = v_import.id) as class_count
    ) counts
    where lc.school_class_id = p_class_id
      and lc.timetable_import_id = v_import.id;

  return jsonb_build_object(
    'hasImport', true,
    'classFound', true,
    'class', jsonb_build_object(
      'id', v_class.id, 'sourceId', v_class.source_id, 'name', v_class.name, 'grade', v_class.grade,
      'classTeacher', case
        when v_class.class_teacher_id is null then null
        else jsonb_build_object('id', v_class.class_teacher_id, 'name', v_class.class_teacher_name)
      end
    ),
    'importedAt', v_import.imported_at,
    'days', v_days,
    'periods', v_periods,
    'rows', v_rows
  );
end;
$$;

comment on function public.get_class_timetable_snapshot(text, text, uuid) is
  'Salt okunur: verilen class_id MEVCUT (en güncel status=imported) importa aitse, o sınıfın gün/ders saati/ham lesson-card satırlarını (lesson_classes→lessons→timetable_cards, öğretmen LEFT JOIN — teacherids="" olan dersler dahil, kaybolmaz) VE sınıf öğretmenini döner. Eski/bilinmeyen class_id için classFound=false. Yalnız service_role çağırabilir.';

revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_class_timetable_snapshot(text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_class_timetable_snapshot(text, text, uuid) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir RLS policy eklemez, mevcut policy'siz durumu
-- değiştirmez ve hiçbir tablo verisine INSERT/UPDATE/DELETE yapmaz.
