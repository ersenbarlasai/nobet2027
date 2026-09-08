-- ============================================================================
-- Nöbet2027 — Uzun Nöbet 1/2 için komşu periyot uygunluk kuralı
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- Eski kural: "öğretmenin 5-OO/5-IO dersi YOKSA Uzun 1/2 için uygundur."
-- Bu, öğretmenin nöbetten önce/sonra hazırlanabilmesini/dersine
-- yetişebilmesini hiç dikkate almıyordu. Yeni kural: hedef periyot (5-OO
-- veya 5-IO) boş OLMALI, VE komşu periyotlardan (önceki/sonraki) EN AZ BİRİ
-- de boş olmalı. Aksi halde öğretmen "sıkışmış" (dersten çıkıp hemen nöbete
-- girip hemen derse dönmek zorunda) kalır.
--
--   LONG_BREAK_1 (5-OO) uygun = free(5-OO) AND (free(prev_of_5-OO) OR free(5-IO))
--   LONG_BREAK_2 (5-IO) uygun = free(5-IO) AND (free(5-OO) OR free(next_of_5-IO))
--
-- "prev_of_5-OO" ve "next_of_5-IO" HARD-CODE bir isim DEĞİL: güncel
-- importun lesson_periods.period_order sırasından türetilir (5-OO'nun tam
-- bir öncesi / 5-IO'nun tam bir sonrası). Yalnız 5-OO ve 5-IO'nun kendisi
-- kararlı XML adlarıyla ("5-OO"/"5-IO") bulunur.
--
-- ORTAKLAŞTIRMA
-- ----------------------------------------------------------------------------
-- Bu kural ÖNCEDEN üç ayrı yerde (get_teacher_duty_matrix, save_teacher_
-- duty_matrix'in hem doğrulama hem DELETE koruması, analyze_duty_plan_
-- feasibility'nin üç ayrı alt sorgusu) birbirinden bağımsız, basit
-- "tam o periyotta ders var mı" biçiminde tekrarlanıyordu. Artık TEK bir
-- salt-okunur fonksiyonda (evaluate_teacher_duty_block_time) toplanır; tüm
-- RPC'ler onu çağırır. Basit boolean gerekenler için ince bir sarmalayıcı
-- (is_teacher_eligible_for_duty_block_time) eklenir.
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- Yeni tablo yaratmaz, backfill çalıştırmaz, teacher_duty_block_availabilities
-- / fixed_duty_assignments / duty_location_blocks satırlarına HİÇ dokunmaz.
-- duty_blocks.conflict_period_name alanının anlamı DEĞİŞMEDİ — hâlâ hedef
-- periyot etiketidir; komşu periyot kuralı ayrıca uygulanır.
--
-- KORUNMUŞ TERCİHLER
-- ----------------------------------------------------------------------------
-- Yeni kural nedeniyle artık uygun OLMAYAN, ama önceden seçilmiş satırlar
-- save_teacher_duty_matrix'in atomik replace DELETE'inde AYNI fonksiyonla
-- korunur — fiziksel olarak SİLİNMEZ, yalnızca get_teacher_duty_matrix'in
-- selectedBlockCells'inde "korunmuş" olarak görünmeye devam eder (o alan
-- zaten yalnız duty_location_blocks tanımına bakar, ders çakışmasını
-- FİLTRELEMEZ — bkz. 20260910091000 bölüm 2 yorumu; bu migration o
-- davranışı değiştirmez).
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ============================================================================
-- 1. evaluate_teacher_duty_block_time — TEK ortak karar noktası (ayrıntılı)
-- ============================================================================
-- Dönüş: {eligible: boolean, reasonCode: text|null, busyPeriodNames: text[],
--         targetPeriodName: text|null}
--
-- reasonCode değerleri:
--   null                          — blokta zaman kısıtı yok (conflict_period_name boş)
--   target_period_busy            — hedef periyotta (5-OO/5-IO) ders var
--   no_adjacent_period_free       — hedef boş ama HER İKİ komşu periyot da dolu
--   period_configuration_missing  — güncel importta hedef VEYA (LONG_BREAK_1/2
--                                    için) gerekli komşu periyotlardan biri
--                                    bulunamadı (GÜVENLİ VARSAYILAN: uygun
--                                    DEĞİL kabul edilir)
--
-- "Boş" = seçilen öğretmen+gün+periyot için timetable_assignments'ta HİÇ
-- satır YOK demektir (aynı periyotta birden fazla satır olması sonucu
-- değiştirmez — exists/not exists mantığı kullanılır).
--
-- LONG_BREAK_1/LONG_BREAK_2 için hedef VE HER İKİ komşu periyodun (isimli +
-- sıralı) tanımı güncel importta MEVCUT olmalıdır — biri bile yoksa kural
-- doğrulanamaz ve GÜVENLİ VARSAYILAN uygulanır: eligible=false,
-- reasonCode=period_configuration_missing (sessizce "meşgul" varsayılmaz).
--
-- busyPeriodNames: target_period_busy durumunda YALNIZ hedef periyodun
-- adını içerir (o SATIRDA meşgul olan tek periyot budur). no_adjacent_
-- period_free durumunda ise hedef ZATEN BOŞTUR, bu yüzden dizide ASLA
-- görünmez — yalnız gerçekten dolu iki komşu, period_order sırasıyla yer
-- alır.
create or replace function public.evaluate_teacher_duty_block_time(
  p_timetable_import_id uuid,
  p_teacher_id uuid,
  p_day_order integer,
  p_duty_block_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_block_code text;
  v_target_name text;
  v_named_neighbor_name text;
  v_ordered_offset integer;
  v_target_id uuid;
  v_target_order integer;
  v_named_neighbor_id uuid;
  v_named_neighbor_order integer;
  v_ordered_neighbor_id uuid;
  v_ordered_neighbor_name text;
  v_target_busy boolean;
  v_named_neighbor_busy boolean;
  v_ordered_neighbor_busy boolean;
  v_busy_names jsonb;
begin
  select b.code, b.conflict_period_name into v_block_code, v_target_name
    from public.duty_blocks b where b.id = p_duty_block_id;

  -- Zaman tabanlı kısıt yalnız conflict_period_name dolu olan bloklarda var
  -- (bugün için LONG_BREAK_1/LONG_BREAK_2). Diğerlerinde her zaman uygundur.
  if v_target_name is null then
    return jsonb_build_object('eligible', true, 'reasonCode', null, 'busyPeriodNames', '[]'::jsonb, 'targetPeriodName', null);
  end if;

  if v_block_code = 'LONG_BREAK_1' then
    v_named_neighbor_name := '5-IO';
    v_ordered_offset := -1;
  elsif v_block_code = 'LONG_BREAK_2' then
    v_named_neighbor_name := '5-OO';
    v_ordered_offset := 1;
  else
    -- Bilinmeyen/gelecekte eklenebilecek başka bir conflict_period_name'li
    -- blok kodu için komşu kuralı tanımsızdır — eski (tek periyot) davranışa
    -- güvenli biçimde düşer, bkz. aşağıdaki "yalnız hedef" dalı.
    v_named_neighbor_name := null;
    v_ordered_offset := 0;
  end if;

  select lp.id, lp.period_order into v_target_id, v_target_order
    from public.lesson_periods lp
    where lp.timetable_import_id = p_timetable_import_id and lp.name = v_target_name;

  if v_target_id is null then
    return jsonb_build_object('eligible', false, 'reasonCode', 'period_configuration_missing', 'busyPeriodNames', '[]'::jsonb, 'targetPeriodName', v_target_name);
  end if;

  if v_named_neighbor_name is null and v_ordered_offset = 0 then
    -- Komşu kuralı tanımsız blok kodu: hedef boşsa yeterlidir.
    v_target_busy := exists (
      select 1 from public.timetable_assignments ta
      join public.timetable_days d on d.id = ta.timetable_day_id
      where ta.timetable_import_id = p_timetable_import_id and ta.teacher_id = p_teacher_id
        and d.day_order = p_day_order and ta.lesson_period_id = v_target_id
    );
    if v_target_busy then
      return jsonb_build_object('eligible', false, 'reasonCode', 'target_period_busy', 'busyPeriodNames', jsonb_build_array(v_target_name), 'targetPeriodName', v_target_name);
    end if;
    return jsonb_build_object('eligible', true, 'reasonCode', null, 'busyPeriodNames', '[]'::jsonb, 'targetPeriodName', v_target_name);
  end if;

  -- LONG_BREAK_1/LONG_BREAK_2: hedef VE HER İKİ komşu periyodun (isimli +
  -- sıralı) tanımı güncel importta MEVCUT olmalıdır. Biri bile eksikse kural
  -- doğrulanamaz — GÜVENLİ VARSAYILAN "uygun değil" (period_configuration_
  -- missing), "meşgul" olarak SESSİZCE varsayılmaz.
  select lp.id, lp.period_order into v_named_neighbor_id, v_named_neighbor_order
    from public.lesson_periods lp
    where lp.timetable_import_id = p_timetable_import_id and lp.name = v_named_neighbor_name;

  select lp.id, lp.name into v_ordered_neighbor_id, v_ordered_neighbor_name
    from public.lesson_periods lp
    where lp.timetable_import_id = p_timetable_import_id and lp.period_order = v_target_order + v_ordered_offset;

  if v_named_neighbor_id is null or v_ordered_neighbor_id is null then
    return jsonb_build_object('eligible', false, 'reasonCode', 'period_configuration_missing', 'busyPeriodNames', '[]'::jsonb, 'targetPeriodName', v_target_name);
  end if;

  v_target_busy := exists (
    select 1 from public.timetable_assignments ta
    join public.timetable_days d on d.id = ta.timetable_day_id
    where ta.timetable_import_id = p_timetable_import_id and ta.teacher_id = p_teacher_id
      and d.day_order = p_day_order and ta.lesson_period_id = v_target_id
  );
  if v_target_busy then
    return jsonb_build_object('eligible', false, 'reasonCode', 'target_period_busy', 'busyPeriodNames', jsonb_build_array(v_target_name), 'targetPeriodName', v_target_name);
  end if;

  v_named_neighbor_busy := exists (
    select 1 from public.timetable_assignments ta
    join public.timetable_days d on d.id = ta.timetable_day_id
    where ta.timetable_import_id = p_timetable_import_id and ta.teacher_id = p_teacher_id
      and d.day_order = p_day_order and ta.lesson_period_id = v_named_neighbor_id
  );
  v_ordered_neighbor_busy := exists (
    select 1 from public.timetable_assignments ta
    join public.timetable_days d on d.id = ta.timetable_day_id
    where ta.timetable_import_id = p_timetable_import_id and ta.teacher_id = p_teacher_id
      and d.day_order = p_day_order and ta.lesson_period_id = v_ordered_neighbor_id
  );

  if v_named_neighbor_busy and v_ordered_neighbor_busy then
    -- busyPeriodNames YALNIZ gerçekten dolu iki komşuyu, period_order
    -- sırasıyla içerir. Hedef (boş olduğu için buraya zaten gelinmez) ASLA
    -- eklenmez.
    select coalesce(jsonb_agg(x.name order by x.ord), '[]'::jsonb) into v_busy_names
      from (
        values (v_named_neighbor_name, v_named_neighbor_order),
               (v_ordered_neighbor_name, v_target_order + v_ordered_offset)
      ) as x(name, ord);
    return jsonb_build_object('eligible', false, 'reasonCode', 'no_adjacent_period_free', 'busyPeriodNames', v_busy_names, 'targetPeriodName', v_target_name);
  end if;

  return jsonb_build_object('eligible', true, 'reasonCode', null, 'busyPeriodNames', '[]'::jsonb, 'targetPeriodName', v_target_name);
end;
$$;

comment on function public.evaluate_teacher_duty_block_time(uuid, uuid, integer, uuid) is
  'Salt okunur TEK ortak karar noktası: bir öğretmenin belirli gün+blok için Uzun Nöbet zaman uygunluğunu (hedef periyot + komşu periyot kuralı) değerlendirir. get_teacher_duty_matrix, save_teacher_duty_matrix ve analyze_duty_plan_feasibility TÜMÜ bunu çağırır — kural üç yerde ayrışmaz. Hiçbir şey yazmaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 2. is_teacher_eligible_for_duty_block_time — ince boolean sarmalayıcı
-- ============================================================================
-- SQL dilinde: planlayıcı tarafından satır içine alınabilir (inline), bu
-- yüzden set-tabanlı sorgularda (feasibility'nin kenar/aday hesapları gibi)
-- ek fonksiyon-çağrısı yükü pratikte ihmal edilebilir düzeydedir.
create or replace function public.is_teacher_eligible_for_duty_block_time(
  p_timetable_import_id uuid,
  p_teacher_id uuid,
  p_day_order integer,
  p_duty_block_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(
    (public.evaluate_teacher_duty_block_time(p_timetable_import_id, p_teacher_id, p_day_order, p_duty_block_id) ->> 'eligible')::boolean,
    false
  );
$$;

comment on function public.is_teacher_eligible_for_duty_block_time(uuid, uuid, integer, uuid) is
  'Salt okunur: evaluate_teacher_duty_block_time''in boolean sarmalayıcısı. Ayrıntı (reasonCode/busyPeriodNames) gerekmeyen çağrılarda (save doğrulaması, DELETE koruması, feasibility kenarları) kullanılır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 3. get_teacher_duty_matrix — lessonConflicts artık komşu-periyot kuralını yansıtır
-- ============================================================================
-- GERİYE UYUMLULUK: dayOrder/dutyBlockId/periodName alanları AYNI kalır.
-- YENİ alanlar: reasonCode, busyPeriodNames — frontend'in doğru açıklama
-- göstermesi için (bkz. görev tanımı). conflictKeys (frontend'de gün×blok)
-- hâlâ bu listedeki (dayOrder,dutyBlockId) çiftlerinden türetilir; davranış
-- değişmez, yalnız AÇIKLAMA zenginleşir.
create or replace function public.get_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_teacher record;
  v_setting record;
  v_days jsonb;
  v_blocks jsonb;
  v_locations jsonb;
  v_block_cells jsonb;
  v_legacy_cells jsonb;
  v_lesson_conflicts jsonb;
  v_fixed jsonb;
  v_fixed_locations jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_teacher_id is null then
    raise exception 'teacher_id zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('hasImport', false, 'teacherFound', false);
  end if;

  select id, source_id, name into v_teacher
    from public.teachers
    where id = p_teacher_id and timetable_import_id = v_import.id;
  if not found then
    return jsonb_build_object('hasImport', true, 'teacherFound', false, 'importedAt', v_import.imported_at);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('order', d.day_order, 'name', d.name) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id
      and d.day_order between 1 and 5;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'name', b.name,
      'blockOrder', b.block_order, 'conflictPeriodName', b.conflict_period_name
      ) order by b.block_order), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b
    where b.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', dl.id, 'name', dl.name, 'shortCode', dl.short_code,
      'category', dl.category, 'capacity', dl.capacity, 'sortOrder', dl.sort_order,
      'allowsFixedAssignment', dl.allows_fixed_assignment,
      'blockIds', coalesce((
        select jsonb_agg(lb.duty_block_id order by b2.block_order)
        from public.duty_location_blocks lb
        join public.duty_blocks b2 on b2.id = lb.duty_block_id
        where lb.duty_location_id = dl.id and b2.is_active
      ), '[]'::jsonb)
      ) order by dl.sort_order, dl.name), '[]'::jsonb)
    into v_locations
    from public.duty_locations dl
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignmentId', a.id,
      'dayOrder', a.day_order,
      'dutyLocationId', a.duty_location_id,
      'dutyLocationName', dl.name,
      'dutyLocationShortCode', dl.short_code,
      'dutyLocationIsActive', (dl.is_active and dl.deleted_at is null)
      ) order by a.day_order), '[]'::jsonb)
    into v_fixed
    from public.fixed_duty_assignments a
    join public.duty_locations dl on dl.id = a.duty_location_id
    where a.academic_year_id = v_year_id and a.teacher_source_id = v_teacher.source_id;

  select coalesce(jsonb_agg(jsonb_build_object(
      'assignmentId', fa.id,
      'dayOrder', fa.day_order,
      'dutyLocationId', fa.duty_location_id,
      'dutyLocationName', dl.name,
      'dutyLocationShortCode', dl.short_code,
      'teacherSourceId', fa.teacher_source_id,
      'teacherName', coalesce(t.name, fa.teacher_name_snapshot),
      'dutyLocationIsActive', (dl.is_active and dl.deleted_at is null)
      ) order by fa.day_order, dl.sort_order), '[]'::jsonb)
    into v_fixed_locations
    from public.fixed_duty_assignments fa
    join public.duty_locations dl on dl.id = fa.duty_location_id
    left join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = fa.teacher_source_id
    where fa.campus_id = v_campus_id and fa.academic_year_id = v_year_id;

  -- YENİ: ders çakışması artık komşu-periyot kuralının TAMAMINI temsil eder
  -- (yalnız "hedef periyotta ders var" değil). Her (gün × zaman-kısıtlı-aktif-
  -- blok) çifti için evaluate_teacher_duty_block_time çağrılır; yalnız
  -- eligible=false olanlar listeye girer — davranış (conflictKeys'in hangi
  -- gün+blok çiftlerini içerdiği) tek periyot kuralına göre YALNIZCA
  -- GENİŞLER (öncekinden daha fazla/aynı sayıda kilit, asla daha az).
  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', d.day_order,
      'dutyBlockId', b.id,
      'periodName', ev ->> 'targetPeriodName',
      'reasonCode', ev ->> 'reasonCode',
      'busyPeriodNames', coalesce(ev -> 'busyPeriodNames', '[]'::jsonb)
      ) order by d.day_order, b.block_order),
    '[]'::jsonb)
    into v_lesson_conflicts
    from generate_series(1, 5) as d(day_order)
    cross join public.duty_blocks b
    cross join lateral public.evaluate_teacher_duty_block_time(v_import.id, v_teacher.id, d.day_order::smallint, b.id) as ev
    where b.is_active
      and b.conflict_period_name is not null
      and (ev ->> 'eligible')::boolean = false;

  select id, is_included, updated_at into v_setting
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id;

  if v_setting.id is null then
    v_block_cells := '[]'::jsonb;
    v_legacy_cells := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
        'dutyLocationId', av.duty_location_id,
        'dayOrder', av.day_order,
        'dutyBlockId', av.duty_block_id)), '[]'::jsonb)
      into v_block_cells
      from public.teacher_duty_block_availabilities av
      join public.duty_locations dl on dl.id = av.duty_location_id
      where av.teacher_duty_setting_id = v_setting.id
        and dl.is_active and dl.deleted_at is null
        and not dl.allows_fixed_assignment
        and exists (
          select 1 from public.duty_location_blocks lb
          where lb.duty_location_id = av.duty_location_id
            and lb.duty_block_id = av.duty_block_id
        )
        and not exists (
          select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id
            and fa.teacher_source_id = v_teacher.source_id
            and fa.day_order = av.day_order
        );

    select coalesce(jsonb_agg(jsonb_build_object(
        'dutyLocationId', a.duty_location_id, 'dayOrder', a.day_order)), '[]'::jsonb)
      into v_legacy_cells
      from public.teacher_duty_availabilities a
      where a.teacher_duty_setting_id = v_setting.id;
  end if;

  return jsonb_build_object(
    'hasImport', true,
    'teacherFound', true,
    'teacher', jsonb_build_object('id', v_teacher.id, 'sourceId', v_teacher.source_id, 'name', v_teacher.name),
    'isIncluded', coalesce(v_setting.is_included, true),
    'days', v_days,
    'blocks', v_blocks,
    'dutyLocations', v_locations,
    'selectedBlockCells', v_block_cells,
    'legacySelectedCells', v_legacy_cells,
    'lessonConflicts', v_lesson_conflicts,
    'fixedAssignments', v_fixed,
    'fixedLocationAssignments', v_fixed_locations,
    'updatedAt', v_setting.updated_at
  );
end;
$$;

comment on function public.get_teacher_duty_matrix(text, text, uuid) is
  'Salt okunur: blok bazlı nöbet uygunluk matrisi snapshot''ı. lessonConflicts artık evaluate_teacher_duty_block_time ile komşu-periyot kuralının TAMAMINI yansıtır (periodName + reasonCode + busyPeriodNames). selectedBlockCells allows_fixed_assignment=true yerler HARİÇ. fixedAssignments SEÇİLEN öğretmenin kendi sabiti, fixedLocationAssignments eğitim yılındaki TÜM sabit yer işgalleri. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 4. save_teacher_duty_matrix — aynı ortak kuralla doğrulama + DELETE koruması
-- ============================================================================
create or replace function public.save_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid,
  p_is_included boolean,
  p_cells jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_teacher record;
  v_cells jsonb := coalesce(p_cells, '[]'::jsonb);
  v_bad boolean;
  v_fixed_day_orders smallint[];
  v_locked_submitted boolean;
  v_lock_day integer;
  v_setting_id uuid;
  v_current_updated_at timestamptz;
  v_found boolean;
  v_final_updated_at timestamptz;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if p_teacher_id is null then
    raise exception 'teacher_id zorunludur.' using errcode = '22023';
  end if;
  if p_is_included is null then
    raise exception 'is_included zorunludur.' using errcode = '22023';
  end if;
  if jsonb_typeof(v_cells) <> 'array' then
    raise exception 'cells bir jsonb dizisi olmalıdır.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select id, source_id, name into v_teacher
    from public.teachers
    where id = p_teacher_id and timetable_import_id = v_import.id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- (1) Gün aralığı.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    where x.day_order is null or x.day_order < 1 or x.day_order > 5
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'day_order_out_of_range');
  end if;

  -- (2) Nöbet yeri: aynı kampüs, aktif, silinmemiş.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    where x.duty_location_id is null or x.duty_location_id not in (
      select id from public.duty_locations
      where campus_id = v_campus_id and is_active and deleted_at is null
    )
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'duty_location_not_available');
  end if;

  -- (2b) allows_fixed_assignment = true yerler (ILKOKUL1/ILKOKUL2) yalnız
  -- Sabit Nöbetler ekranından atanır.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    join public.duty_locations dl on dl.id = x.duty_location_id
    where dl.allows_fixed_assignment
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'fixed_assignment_only_location');
  end if;

  -- (3) Nöbet bloğu: var olmalı ve aktif olmalı.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    where x.duty_block_id is null or x.duty_block_id not in (
      select id from public.duty_blocks where is_active
    )
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'duty_block_not_available');
  end if;

  -- (4) Yer × blok gereksinimi.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    where not exists (
      select 1 from public.duty_location_blocks lb
      where lb.duty_location_id = x.duty_location_id
        and lb.duty_block_id = x.duty_block_id
    )
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'block_not_allowed_for_location');
  end if;

  -- (5) Zaman uygunluğu (komşu-periyot kuralı) — TEK ortak fonksiyon.
  -- Eskiden yalnız hedef periyotta ders var mı bakılırdı; artık
  -- evaluate_teacher_duty_block_time'ın komşu kuralının TAMAMI uygulanır.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    join public.duty_blocks b on b.id = x.duty_block_id
    where b.conflict_period_name is not null
      and not public.is_teacher_eligible_for_duty_block_time(v_import.id, v_teacher.id, x.day_order::smallint, b.id)
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'lesson_conflict');
  end if;

  -- (6) EŞZAMANLILIK: 1→5 artan sırada advisory lock (değişmedi).
  for v_lock_day in 1..5 loop
    perform pg_advisory_xact_lock(hashtext('fixed-duty:' || v_year_id::text || ':' || v_lock_day::text));
  end loop;

  select coalesce(array_agg(distinct fa.day_order), array[]::smallint[])
    into v_fixed_day_orders
    from public.fixed_duty_assignments fa
    where fa.academic_year_id = v_year_id and fa.teacher_source_id = v_teacher.source_id;

  if array_length(v_fixed_day_orders, 1) > 0 then
    select exists (
      select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
      where x.day_order::smallint = any (v_fixed_day_orders)
    ) into v_locked_submitted;
    if v_locked_submitted then
      return jsonb_build_object('status', 'fixed_day_locked', 'lockedDayOrders', to_jsonb(v_fixed_day_orders));
    end if;
  end if;

  -- (7) Ayar satırı: kilitle + optimistic concurrency (değişmedi).
  select id, updated_at into v_setting_id, v_current_updated_at
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id
    for update;
  v_found := found;

  if v_found then
    if v_current_updated_at is distinct from p_expected_updated_at then
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', v_current_updated_at);
    end if;
    update public.teacher_duty_settings
      set is_included = p_is_included, teacher_name_snapshot = v_teacher.name
      where id = v_setting_id;
  else
    if p_expected_updated_at is not null then
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', null);
    end if;
    begin
      insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included)
        values (v_campus_id, v_year_id, v_teacher.source_id, v_teacher.name, p_is_included)
        returning id into v_setting_id;
    exception when unique_violation then
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', null);
    end;
  end if;

  -- (8) Atomik tam değiştirme (replace) — YALNIZ yeni blok tablosunda.
  -- DELETE kapsamı artık AYNI ortak fonksiyonla korunur: o an komşu-periyot
  -- kuralını SAĞLAMAYAN (eligible=false) mevcut satır asla silinmez —
  -- istemci onu payload'a zaten gönderemez (adım 5 tüm isteği reddeder),
  -- ama bu satır "gönderilmediği için silinecek" durumuna da düşmez.
  -- allows_fixed_assignment=true yere ait tarihsel/hatalı bir satır da aynı
  -- şekilde korunur (bkz. 20260912090000).
  delete from public.teacher_duty_block_availabilities av
    using public.duty_locations dl
    where av.teacher_duty_setting_id = v_setting_id
      and av.duty_location_id = dl.id
      and dl.campus_id = v_campus_id
      and dl.is_active
      and dl.deleted_at is null
      and not dl.allows_fixed_assignment
      and exists (
        select 1 from public.duty_location_blocks lb
        where lb.duty_location_id = av.duty_location_id
          and lb.duty_block_id = av.duty_block_id
      )
      and not (av.day_order = any (v_fixed_day_orders))
      and public.is_teacher_eligible_for_duty_block_time(v_import.id, v_teacher.id, av.day_order, av.duty_block_id);

  insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
    select distinct v_campus_id, v_setting_id, x.duty_location_id, x.day_order::smallint, x.duty_block_id
    from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid);

  select updated_at into v_final_updated_at from public.teacher_duty_settings where id = v_setting_id;

  return jsonb_build_object('status', 'ok', 'updatedAt', v_final_updated_at);
end;
$$;

comment on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) is
  'Blok bazlı nöbet uygunluk matrisini tek transaction içinde atomik upsert+replace eder. Zaman uygunluğu (5-OO/5-IO hedef periyot + komşu periyot kuralı) is_teacher_eligible_for_duty_block_time ile TEK noktadan doğrulanır (invalid_cells/lesson_conflict). Replace (8) kapsamı aynı fonksiyonla korunan (o an uygun olmayan) mevcut satırları HARİÇ TUTAR — sessizce silinmez. allows_fixed_assignment=true yerlere yazma da ayrıca engellenir (invalid_cells/fixed_assignment_only_location). Yalnız service_role çağırabilir.';

-- ============================================================================
-- 5. analyze_duty_plan_feasibility — aynı ortak kuralla eşleştirme/aday/açık
-- ============================================================================
create or replace function public.analyze_duty_plan_feasibility(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_blocks jsonb;
  v_day record;

  v_t_loc uuid[];
  v_t_block uuid[];
  v_t_fixed boolean[];
  v_t_covered boolean[];
  v_t_cand integer[];
  v_task_count integer;

  v_norm_task_idx integer[];
  v_norm_count integer;

  v_teacher_src text[];
  v_teacher_count integer;

  v_adj boolean[];
  v_match_teacher integer[];
  v_visited boolean[];
  v_found boolean;
  v_edge record;
  v_i integer;
  v_j integer;
  v_matched_count integer;

  v_day_json jsonb;
  v_days jsonb := '[]'::jsonb;

  v_total_required bigint := 0;
  v_total_covered bigint := 0;
  v_total_uncovered bigint := 0;
  v_days_with_shortfall jsonb := '[]'::jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('hasImport', false);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'name', b.name,
      'blockOrder', b.block_order, 'conflictPeriodName', b.conflict_period_name
      ) order by b.block_order), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b
    where b.is_active;

  for v_day in
    select d.day_order, d.name
      from public.timetable_days d
      where d.timetable_import_id = v_import.id and d.day_order between 1 and 5
      order by d.day_order
  loop
    select coalesce(array_agg(t.loc order by t.blk_order, t.sort_order, t.loc_name, t.loc), '{}'::uuid[]),
           coalesce(array_agg(t.blk order by t.blk_order, t.sort_order, t.loc_name, t.loc), '{}'::uuid[]),
           coalesce(array_agg(t.is_fixed order by t.blk_order, t.sort_order, t.loc_name, t.loc), '{}'::boolean[])
      into v_t_loc, v_t_block, v_t_fixed
      from (
        select dl.id as loc, b.id as blk, b.block_order as blk_order,
               dl.sort_order, dl.name as loc_name,
               dl.allows_fixed_assignment as is_fixed
          from public.duty_locations dl
          join public.duty_location_blocks lb on lb.duty_location_id = dl.id
          join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
          where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
      ) t;

    v_task_count := coalesce(array_length(v_t_loc, 1), 0);
    v_t_covered := array_fill(false, array[greatest(v_task_count, 1)]);
    v_t_cand := array_fill(0, array[greatest(v_task_count, 1)]);

    if v_task_count > 0 then
      for v_i in 1..v_task_count loop
        if v_t_fixed[v_i] then
          v_t_covered[v_i] := exists (
            select 1 from public.fixed_duty_assignments fa
            where fa.academic_year_id = v_year_id
              and fa.day_order = v_day.day_order
              and fa.duty_location_id = v_t_loc[v_i]
          );
        end if;
      end loop;
    end if;

    select coalesce(array_agg(x.idx order by x.idx), '{}'::integer[])
      into v_norm_task_idx
      from unnest(v_t_fixed) with ordinality as x(is_fixed, idx)
      where v_task_count > 0 and not x.is_fixed;
    v_norm_count := coalesce(array_length(v_norm_task_idx, 1), 0);

    -- Aday öğretmen havuzu, kenar (edge) kriterleriyle BİREBİR AYNI evrenden
    -- gelir: en az bir satırı güncel, aktif, silinmemiş, allows_fixed_
    -- assignment=false bir yere, o yer×blok için GÜNCEL duty_location_blocks
    -- eşlemesine SAHİP OLMALI, VE o satırın zaman uygunluğu (komşu-periyot
    -- kuralı dahil) is_teacher_eligible_for_duty_block_time ile SAĞLANMALI.
    -- Kaldırılmış eşlemeye ait fiziksel olarak korunmuş (ama artık geçersiz)
    -- satırlar, VE o gün TÜM görünür tercihleri zaman kuralınca kilitli olan
    -- öğretmenler havuzu ŞİŞİRMEZ — böylece v_teacher_src, gerçek eşleştirme
    -- kenarlarını (aşağıdaki v_edge sorgusu) üretebilecek öğretmenlerle
    -- BİREBİR aynı kümedir.
    select coalesce(array_agg(x.source_id order by x.name, x.source_id), '{}'::text[])
      into v_teacher_src
      from (
        select distinct s.teacher_source_id as source_id, t.name
          from public.teacher_duty_settings s
          join public.teachers t
            on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
          where s.academic_year_id = v_year_id
            and s.is_included
            and not exists (
              select 1 from public.fixed_duty_assignments fa
              where fa.academic_year_id = v_year_id
                and fa.day_order = v_day.day_order
                and fa.teacher_source_id = s.teacher_source_id
            )
            and exists (
              select 1 from public.teacher_duty_block_availabilities av
              join public.duty_locations dl5 on dl5.id = av.duty_location_id
              where av.teacher_duty_setting_id = s.id and av.day_order = v_day.day_order
                and dl5.campus_id = v_campus_id
                and dl5.is_active and dl5.deleted_at is null and not dl5.allows_fixed_assignment
                and exists (
                  select 1 from public.duty_location_blocks lb5
                  where lb5.duty_location_id = av.duty_location_id and lb5.duty_block_id = av.duty_block_id
                )
                and public.is_teacher_eligible_for_duty_block_time(v_import.id, t.id, v_day.day_order, av.duty_block_id)
            )
      ) x;
    v_teacher_count := coalesce(array_length(v_teacher_src, 1), 0);

    v_matched_count := 0;

    if v_norm_count > 0 and v_teacher_count > 0 then
      v_adj := array_fill(false, array[v_norm_count * v_teacher_count]);

      -- Kenarlar: uygunluk satırı VAR ve ortak zaman uygunluk kuralı
      -- (evaluate_teacher_duty_block_time) SAĞLANIYOR. t2, teacher_source_id'yi
      -- GÜNCEL importtaki teachers.id'ye çözer (fonksiyon uuid teacher_id ister).
      for v_edge in
        select nt.n_idx, tc.idx as c_idx
          from unnest(v_norm_task_idx) with ordinality as nt(task_idx, n_idx)
          cross join unnest(v_teacher_src) with ordinality as tc(src, idx)
          join public.teachers t2
            on t2.timetable_import_id = v_import.id and t2.source_id = tc.src
          join public.teacher_duty_settings s
            on s.academic_year_id = v_year_id and s.teacher_source_id = tc.src
          join public.teacher_duty_block_availabilities av
            on av.teacher_duty_setting_id = s.id
           and av.duty_location_id = v_t_loc[nt.task_idx]
           and av.duty_block_id = v_t_block[nt.task_idx]
           and av.day_order = v_day.day_order
          where public.is_teacher_eligible_for_duty_block_time(v_import.id, t2.id, v_day.day_order, v_t_block[nt.task_idx])
      loop
        v_adj[(v_edge.n_idx - 1) * v_teacher_count + v_edge.c_idx] := true;
        v_t_cand[v_norm_task_idx[v_edge.n_idx]] := v_t_cand[v_norm_task_idx[v_edge.n_idx]] + 1;
      end loop;

      v_match_teacher := array_fill(0, array[v_teacher_count]);
      for v_i in 1..v_norm_count loop
        v_visited := array_fill(false, array[v_teacher_count]);
        select a.p_match_teacher, a.p_visited, a.o_found
          into v_match_teacher, v_visited, v_found
          from public.duty_feasibility_augment(
                 v_i, v_norm_count, v_teacher_count, v_adj, v_match_teacher, v_visited
               ) a;
        if v_found then
          v_matched_count := v_matched_count + 1;
        end if;
      end loop;

      for v_j in 1..v_teacher_count loop
        if v_match_teacher[v_j] <> 0 then
          v_t_covered[v_norm_task_idx[v_match_teacher[v_j]]] := true;
        end if;
      end loop;
    end if;

    with task as (
      select x.idx, x.loc, x.blk, x.is_fixed, x.covered, x.cand
        from unnest(v_t_loc, v_t_block, v_t_fixed, v_t_covered[1:v_task_count], v_t_cand[1:v_task_count])
             with ordinality as x(loc, blk, is_fixed, covered, cand, idx)
       where v_task_count > 0
    ),
    enriched as (
      select t.*, dl.name as loc_name, dl.short_code, b.code as block_code,
             b.name as block_name, b.block_order, b.conflict_period_name
        from task t
        join public.duty_locations dl on dl.id = t.loc
        join public.duty_blocks b on b.id = t.blk
    ),
    -- Aday şartlarının (aktif+aynı kampüs+silinmemiş yer, allows_fixed_
    -- assignment=false, GÜNCEL duty_location_blocks eşlemesi, o gün sabit
    -- nöbeti yok) TÜMÜNÜ sağlayıp yalnız ZAMAN uygunluğu (evaluate_teacher_
    -- duty_block_time) nedeniyle elenen öğretmen×blok çiftleri — reasonCode
    -- BİR KEZ hesaplanır, hem excludedByLessonConflict hem de
    -- excludedByConfigurationError bu tek CTE'den türetilir.
    excl_eval as (
      select distinct bb.id as block_id, s.teacher_source_id, (ev ->> 'reasonCode') as reason_code
        from public.duty_blocks bb
        join public.teacher_duty_block_availabilities av
          on av.duty_block_id = bb.id and av.day_order = v_day.day_order
        join public.teacher_duty_settings s
          on s.id = av.teacher_duty_setting_id and s.academic_year_id = v_year_id and s.is_included
        join public.teachers t4
          on t4.timetable_import_id = v_import.id and t4.source_id = s.teacher_source_id
        join public.duty_locations dl4 on dl4.id = av.duty_location_id
        cross join lateral public.evaluate_teacher_duty_block_time(v_import.id, t4.id, v_day.day_order, bb.id) as ev
       where bb.is_active and bb.conflict_period_name is not null
         and dl4.campus_id = v_campus_id
         and dl4.is_active and dl4.deleted_at is null and not dl4.allows_fixed_assignment
         and exists (
           select 1 from public.duty_location_blocks lb4
           where lb4.duty_location_id = av.duty_location_id and lb4.duty_block_id = bb.id
         )
         and not exists (
           select 1 from public.fixed_duty_assignments fa
           where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
             and fa.teacher_source_id = s.teacher_source_id
         )
         and (ev ->> 'eligible')::boolean = false
    )
    select jsonb_build_object(
      'order', v_day.day_order,
      'name', v_day.name,
      'totals', jsonb_build_object(
        'requiredTasks',       (select count(*) from enriched),
        'coveredTasks',        (select count(*) from enriched where covered),
        'uncoveredTasks',      (select count(*) from enriched where not covered),
        'fixedRequired',       (select count(*) from enriched where is_fixed),
        'fixedCovered',        (select count(*) from enriched where is_fixed and covered),
        'fixedMissing',        (select count(*) from enriched where is_fixed and not covered),
        'normalRequired',      v_norm_count,
        'normalMatched',       v_matched_count,
        'normalUncovered',     v_norm_count - v_matched_count,
        'candidateTeacherCount', v_teacher_count
      ),
      'blocks', coalesce((
        select jsonb_agg(jsonb_build_object(
            'blockId', bb.id, 'blockCode', bb.code, 'blockName', bb.name, 'blockOrder', bb.block_order,
            'required',            (select count(*) from enriched e where e.blk = bb.id),
            'fixedRequired',       (select count(*) from enriched e where e.blk = bb.id and e.is_fixed),
            'fixedCovered',        (select count(*) from enriched e where e.blk = bb.id and e.is_fixed and e.covered),
            'fixedMissing',        (select count(*) from enriched e where e.blk = bb.id and e.is_fixed and not e.covered),
            'normalRequired',      (select count(*) from enriched e where e.blk = bb.id and not e.is_fixed),
            'matchingUncovered',   (select count(*) from enriched e where e.blk = bb.id and not e.is_fixed and not e.covered),
            'candidateTeacherCount', (
              -- Aday evreni EŞLEŞTİRME KENARLARIYLA BİREBİR aynı süzgeçten
              -- geçer: aktif+silinmemiş+aynı kampüs yer, allows_fixed_
              -- assignment=false, GÜNCEL duty_location_blocks eşlemesi, o gün
              -- sabit nöbeti yok, VE zaman uygunluğu.
              select count(distinct s.teacher_source_id)
                from public.teacher_duty_settings s
                join public.teachers t3
                  on t3.timetable_import_id = v_import.id and t3.source_id = s.teacher_source_id
                join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s.id
                join public.duty_locations dl2 on dl2.id = av.duty_location_id
               where s.academic_year_id = v_year_id and s.is_included
                 and av.day_order = v_day.day_order and av.duty_block_id = bb.id
                 and dl2.campus_id = v_campus_id
                 and dl2.is_active and dl2.deleted_at is null and not dl2.allows_fixed_assignment
                 and exists (
                   select 1 from public.duty_location_blocks lb2
                   where lb2.duty_location_id = av.duty_location_id and lb2.duty_block_id = bb.id
                 )
                 and not exists (
                   select 1 from public.fixed_duty_assignments fa
                   where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
                     and fa.teacher_source_id = s.teacher_source_id
                 )
                 and public.is_teacher_eligible_for_duty_block_time(v_import.id, t3.id, v_day.day_order, bb.id)
            ),
            'independentShortfall', greatest(
              (select count(*) from enriched e where e.blk = bb.id and not e.is_fixed)
              - (
                select count(distinct s.teacher_source_id)
                  from public.teacher_duty_settings s
                  join public.teachers t3
                    on t3.timetable_import_id = v_import.id and t3.source_id = s.teacher_source_id
                  join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s.id
                  join public.duty_locations dl2 on dl2.id = av.duty_location_id
                 where s.academic_year_id = v_year_id and s.is_included
                   and av.day_order = v_day.day_order and av.duty_block_id = bb.id
                   and dl2.campus_id = v_campus_id
                   and dl2.is_active and dl2.deleted_at is null and not dl2.allows_fixed_assignment
                   and exists (
                     select 1 from public.duty_location_blocks lb2
                     where lb2.duty_location_id = av.duty_location_id and lb2.duty_block_id = bb.id
                   )
                   and not exists (
                     select 1 from public.fixed_duty_assignments fa
                     where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
                       and fa.teacher_source_id = s.teacher_source_id
                   )
                   and public.is_teacher_eligible_for_duty_block_time(v_import.id, t3.id, v_day.day_order, bb.id)
              ), 0)
          ) order by bb.block_order)
          from public.duty_blocks bb where bb.is_active
      ), '[]'::jsonb),
      'uncoveredTasks', coalesce((
        select jsonb_agg(jsonb_build_object(
            'dutyLocationId', e.loc, 'dutyLocationName', e.loc_name, 'shortCode', e.short_code,
            'blockId', e.blk, 'blockCode', e.block_code, 'blockName', e.block_name,
            'kind', case when e.is_fixed then 'fixed' else 'normal' end,
            'candidateCount', case when e.is_fixed then null else e.cand end,
            'reason', case
              when e.is_fixed then 'missing_fixed_assignment'
              when e.cand = 0 then 'no_candidate'
              else 'matching_conflict'
            end
          ) order by e.block_order, e.loc_name)
          from enriched e where not e.covered
      ), '[]'::jsonb),
      'missingFixedAssignments', coalesce((
        select jsonb_agg(x.item order by x.loc_name)
          from (
            select e.loc_name,
                   jsonb_build_object(
                     'dutyLocationId', e.loc, 'dutyLocationName', e.loc_name, 'shortCode', e.short_code,
                     'blockCodes', jsonb_agg(e.block_code order by e.block_order)
                   ) as item
              from enriched e
             where e.is_fixed and not e.covered
             group by e.loc, e.loc_name, e.short_code
          ) x
      ), '[]'::jsonb),
      -- Ders çakışması nedeniyle elenenler: adaylığın DİĞER TÜM şartlarını
      -- sağlayıp YALNIZ target_period_busy/no_adjacent_period_free
      -- reasonCode'larından biri nedeniyle elenen öğretmenler sayılır.
      -- period_configuration_missing bir DERS ÇAKIŞMASI DEĞİLDİR — bu sayaca
      -- KARIŞMAZ, ayrı excludedByConfigurationError alanında raporlanır.
      'excludedByLessonConflict', coalesce((
        select jsonb_agg(jsonb_build_object(
            'blockId', bb.id, 'blockCode', bb.code, 'blockName', bb.name,
            'periodName', bb.conflict_period_name,
            'teacherCount', (
              select count(distinct ee.teacher_source_id)
                from excl_eval ee
               where ee.block_id = bb.id
                 and ee.reason_code in ('target_period_busy', 'no_adjacent_period_free')
            )
          ) order by bb.block_order)
          from public.duty_blocks bb
         where bb.is_active and bb.conflict_period_name is not null
      ), '[]'::jsonb),
      -- Konfigürasyon hatası nedeniyle elenenler (güncel importta hedef/
      -- komşu periyot tanımı eksik) — DERS ÇAKIŞMASI SAYILMAZ, ayrı alan.
      'excludedByConfigurationError', coalesce((
        select jsonb_agg(jsonb_build_object(
            'blockId', bb.id, 'blockCode', bb.code, 'blockName', bb.name,
            'periodName', bb.conflict_period_name,
            'teacherCount', (
              select count(distinct ee.teacher_source_id)
                from excl_eval ee
               where ee.block_id = bb.id
                 and ee.reason_code = 'period_configuration_missing'
            )
          ) order by bb.block_order)
          from public.duty_blocks bb
         where bb.is_active and bb.conflict_period_name is not null
      ), '[]'::jsonb),
      'fixedAssignments', coalesce((
        select jsonb_agg(jsonb_build_object(
            'teacherSourceId', fa.teacher_source_id,
            'teacherName', coalesce(t5.name, fa.teacher_name_snapshot),
            'dutyLocationId', fa.duty_location_id,
            'dutyLocationName', dl3.name,
            'shortCode', dl3.short_code
          ) order by dl3.sort_order, dl3.name)
          from public.fixed_duty_assignments fa
          join public.duty_locations dl3 on dl3.id = fa.duty_location_id
          left join public.teachers t5
            on t5.timetable_import_id = v_import.id and t5.source_id = fa.teacher_source_id
         where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
      ), '[]'::jsonb)
    ) into v_day_json;

    v_days := v_days || jsonb_build_array(v_day_json);

    v_total_required := v_total_required + (v_day_json -> 'totals' ->> 'requiredTasks')::bigint;
    v_total_covered := v_total_covered + (v_day_json -> 'totals' ->> 'coveredTasks')::bigint;
    v_total_uncovered := v_total_uncovered + (v_day_json -> 'totals' ->> 'uncoveredTasks')::bigint;
    if (v_day_json -> 'totals' ->> 'uncoveredTasks')::bigint > 0 then
      v_days_with_shortfall := v_days_with_shortfall || jsonb_build_array(v_day.day_order);
    end if;
  end loop;

  return jsonb_build_object(
    'hasImport', true,
    'importedAt', v_import.imported_at,
    'analyzedAt', timezone('utc', now()),
    'blocks', v_blocks,
    'days', v_days,
    'summary', jsonb_build_object(
      'totalRequiredTasks', v_total_required,
      'totalCoveredTasks', v_total_covered,
      'totalUncoveredTasks', v_total_uncovered,
      'daysWithShortfall', v_days_with_shortfall,
      'feasible', (v_total_uncovered = 0)
    )
  );
end;
$$;

comment on function public.analyze_duty_plan_feasibility(text, text) is
  'Salt okunur planlanabilirlik analizi — HİÇBİR nöbet planı üretmez. Her gün için bipartite maksimum eşleştirme (Kuhn). v_teacher_src (aday havuzu), kenarlar, candidateTeacherCount ve independentShortfall TÜMÜ is_teacher_eligible_for_duty_block_time ortak fonksiyonunu kullanır (komşu-periyot kuralı GET/SAVE ile birebir aynı) — aynı evrenden gelirler. excludedByLessonConflict YALNIZ target_period_busy/no_adjacent_period_free (gerçek ders çakışması) nedeniyle elenenleri sayar; period_configuration_missing ayrı excludedByConfigurationError alanında raporlanır, ders çakışması sayısına karışmaz. Sabit nöbete uygun yerler yalnız sabit atama ile karşılanır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
-- get_teacher_duty_matrix / save_teacher_duty_matrix / analyze_duty_plan_
-- feasibility imzaları DEĞİŞMEDİ, bu yüzden önceki migration'lardaki GRANT'ler
-- geçerliliğini korur. Yalnız İKİ YENİ fonksiyon için yetki verilir.
revoke all on function public.evaluate_teacher_duty_block_time(uuid, uuid, integer, uuid) from public;
revoke all on function public.is_teacher_eligible_for_duty_block_time(uuid, uuid, integer, uuid) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.evaluate_teacher_duty_block_time(uuid, uuid, integer, uuid) from anon;
    revoke all on function public.is_teacher_eligible_for_duty_block_time(uuid, uuid, integer, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.evaluate_teacher_duty_block_time(uuid, uuid, integer, uuid) from authenticated;
    revoke all on function public.is_teacher_eligible_for_duty_block_time(uuid, uuid, integer, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.evaluate_teacher_duty_block_time(uuid, uuid, integer, uuid) to service_role;
    grant execute on function public.is_teacher_eligible_for_duty_block_time(uuid, uuid, integer, uuid) to service_role;
  end if;
end
$$;
