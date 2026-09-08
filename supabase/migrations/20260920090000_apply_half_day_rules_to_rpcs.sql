create or replace function public.compute_duty_plan_source_fingerprint(
  p_campus_name text,
  p_academic_year_name text
)
returns text
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_blocks jsonb;
  v_locations jsonb;
  v_location_blocks jsonb;
  v_settings jsonb;
  v_preferences jsonb;
  v_fixed jsonb;
  v_canonical jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return null; end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return null; end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'blockOrder', b.block_order, 'conflictPeriodName', b.conflict_period_name
      ) order by b.code, b.id), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b where b.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', dl.id, 'shortCode', dl.short_code, 'name', dl.name, 'category', dl.category,
      -- allowsFixedAssignment KASTEN YOK: artık authoritative değildir ve
      -- değiştirilmesi planı bayatlatmamalıdır. Blok politikası
      -- dutyLocationBlocks.assignmentMode üzerinden zaten hash'lenir.
      'capacity', dl.capacity, 'sortOrder', dl.sort_order
      ) order by dl.short_code, dl.id), '[]'::jsonb)
    into v_locations
    from public.duty_locations dl
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
      'dutyLocationId', dl.id, 'locationShortCode', dl.short_code,
      'dutyBlockId', b.id, 'blockCode', b.code,
      -- YENİ: blok düzeyinde atama politikası fingerprint'e DAHİL — bir hücre
      -- normal'den fixed_only'ye (veya tersine) geçtiğinde plan bayatlar.
      'assignmentMode', lb.assignment_mode
      ) order by dl.short_code, dl.id, b.code, b.id), '[]'::jsonb)
    into v_location_blocks
    from public.duty_location_blocks lb
    join public.duty_locations dl on dl.id = lb.duty_location_id
    join public.duty_blocks b on b.id = lb.duty_block_id
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null and b.is_active;

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id, 'isIncluded', s.is_included,
      -- Yarım gün kuralı plan çıktısını YALNIZ planlamaya DAHİL öğretmen için
      -- değiştirir. is_included=false öğretmende değer KARARLI biçimde null
      -- yazılır; böylece hariç bir öğretmenin toggle'ını değiştirmek planı
      -- GEREKSİZ YERE bayatlatmaz. Öğretmen yeniden dahil edildiğinde
      -- is_included zaten değiştiği için fingerprint değişir ve GÜNCEL yarım
      -- gün değeri o anda etkili olur.
      'halfDayRuleEnabled', case when s.is_included then s.half_day_rule_enabled else null end
      ) order by s.teacher_source_id), '[]'::jsonb)
    into v_settings
    from public.teacher_duty_settings s
    where s.academic_year_id = v_year_id;

  -- YALNIZ is_included=true öğretmenlerin GÖRÜNÜR/GEÇERLİ tercihleri: bir
  -- is_included=false öğretmenin (zaten planlamaya DAHİL EDİLMEYEN, yukarıda
  -- v_settings'te ayrıca hash'lenen) tercih hücrelerindeki değişiklik
  -- fingerprint'i GEREKSİZ YERE değiştirmemeli.
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id,
      'dutyLocationId', av.duty_location_id, 'locationShortCode', dl.short_code,
      'dayOrder', av.day_order,
      'dutyBlockId', av.duty_block_id, 'blockCode', b.code
      ) order by s.teacher_source_id, dl.short_code, dl.id, av.day_order, b.code, b.id), '[]'::jsonb)
    into v_preferences
    from public.teacher_duty_block_availabilities av
    join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
    join public.duty_locations dl on dl.id = av.duty_location_id
    join public.duty_blocks b on b.id = av.duty_block_id
    where s.academic_year_id = v_year_id
      and s.is_included
      and dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
      and b.is_active
      -- GÖRÜNÜRLÜK artık BLOK düzeyindedir: yalnız assignment_mode='normal'
      -- hücreler kullanıcıya gösterilir, bu yüzden yalnız onlar fingerprint'e
      -- girer. fixed_only ve eşlemesi olmayan hücrelerdeki tarihsel satırlar
      -- KORUNUR ama fingerprint'i DEĞİŞTİRMEZ.
      and exists (
        select 1 from public.duty_location_blocks lb
        where lb.duty_location_id = av.duty_location_id and lb.duty_block_id = av.duty_block_id
          and lb.assignment_mode = 'normal'
      );

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', fa.teacher_source_id, 'dayOrder', fa.day_order,
      'dutyLocationId', dl.id, 'locationShortCode', dl.short_code
      ) order by fa.teacher_source_id, fa.day_order), '[]'::jsonb)
    into v_fixed
    from public.fixed_duty_assignments fa
    join public.duty_locations dl on dl.id = fa.duty_location_id
    where fa.academic_year_id = v_year_id;

  v_canonical := jsonb_build_object(
    'timetableImportId', v_import.id,
    'dutyBlocks', v_blocks,
    'dutyLocations', v_locations,
    'dutyLocationBlocks', v_location_blocks,
    'teacherDutySettings', v_settings,
    'teacherDutyBlockPreferences', v_preferences,
    'fixedDutyAssignments', v_fixed
  );

  return encode(extensions.digest(convert_to(v_canonical::text, 'utf8'), 'sha256'), 'hex');
end;
$$;

comment on function public.compute_duty_plan_source_fingerprint(text, text) is
  'Salt okunur TEK ortak kaynak parmak izi (sha256 hex). Etkin girdiler: güncel import, aktif blok/yer, yer×blok eşlemesi VE assignment_mode, is_included, half_day_rule_enabled, GÖRÜNÜR (assignment_mode=normal) blok tercihleri, sabit atamalar. Görünmez/tarihsel korunmuş tercih satırları fingerprint''i DEĞİŞTİRMEZ. Yalnız service_role çağırabilir.';

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
      -- Geriye uyumluluk için KORUNUR; karar için KULLANILMAZ (bkz. blockPolicies).
      'allowsFixedAssignment', dl.allows_fixed_assignment,
      'blockIds', coalesce((
        select jsonb_agg(lb.duty_block_id order by b2.block_order)
        from public.duty_location_blocks lb
        join public.duty_blocks b2 on b2.id = lb.duty_block_id
        where lb.duty_location_id = dl.id and b2.is_active
      ), '[]'::jsonb),
      -- YENİ AUTHORITATIVE ALAN: her eşlenmiş blok için atama politikası.
      -- Frontend hücre durumunu (seçilebilir / sabit / gerekmiyor) YALNIZ
      -- buradan türetmeli — yer adı veya short_code hard-code ETMEMELİ.
      'blockPolicies', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'dutyBlockId', lb.duty_block_id,
                 'blockCode', b2.code,
                 'assignmentMode', lb.assignment_mode
               ) order by b2.block_order)
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

  select id, is_included, half_day_rule_enabled, updated_at into v_setting
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
        -- GÖRÜNÜRLÜK BLOK DÜZEYİNDE: İLKOKUL-1/2 × Öğle Arası-1 artık
        -- 'normal'dir ve GÖRÜNÜR; aynı yerin Sabah/Öğleden Sonra hücreleri
        -- fixed_only olduğu için görünmez. Görünmeyen tarihsel satırlar
        -- tabloda FİZİKSEL OLARAK KORUNUR, yalnız listelenmez.
        and exists (
          select 1 from public.duty_location_blocks lb
          where lb.duty_location_id = av.duty_location_id
            and lb.duty_block_id = av.duty_block_id
            and lb.assignment_mode = 'normal'
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
    -- Varsayılan AÇIK. Tercih GİRİŞİNİ kısıtlamaz; yalnız plan atamasını.
    'halfDayRuleEnabled', coalesce(v_setting.half_day_rule_enabled, true),
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
  'Blok bazlı nöbet uygunluk matrisi. dutyLocations[].blockPolicies her yer×blok için AUTHORITATIVE assignment_mode döner (normal | fixed_only; eşleme yoksa blok listede HİÇ yer almaz ⇒ nöbetçi gerekmiyor) — istemci kararını short_code/ad ile vermemelidir. halfDayRuleEnabled öğretmenin yarım gün kuralıdır (varsayılan true) ve YALNIZ plan atamasını sınırlar, tercih girişini DEĞİL. selectedBlockCells yalnız assignment_mode=normal hücreleri listeler; görünmeyen tarihsel satırlar fiziksel olarak korunur. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Ortak yardımcılar — yeni kuralların TEK karar noktası
-- ============================================================================

-- Bu yer×blok hücresi normal atamaya açık mı (assignment_mode = 'normal')?
create or replace function public.is_duty_cell_open_for_normal(
  p_duty_location_id uuid,
  p_duty_block_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.duty_location_blocks lb
    where lb.duty_location_id = p_duty_location_id
      and lb.duty_block_id = p_duty_block_id
      and lb.assignment_mode = 'normal'
  );
$$;

comment on function public.is_duty_cell_open_for_normal(uuid, uuid) is
  'AUTHORITATIVE: bir yer×blok hücresi normal (tercih/otomatik/manuel) atamaya açık mı. duty_locations.allows_fixed_assignment ARTIK KULLANILMAZ.';

-- Öğretmenin yarım gün kuralı (ayar satırı yoksa güvenli varsayılan: AÇIK).
create or replace function public.teacher_half_day_rule_enabled(
  p_academic_year_id uuid,
  p_teacher_source_id text
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select s.half_day_rule_enabled
       from public.teacher_duty_settings s
      where s.academic_year_id = p_academic_year_id
        and s.teacher_source_id = p_teacher_source_id),
    true
  );
$$;

comment on function public.teacher_half_day_rule_enabled(uuid, text) is
  'Öğretmenin yarım gün kuralı. Ayar satırı yoksa güvenli varsayılan TRUE (aynı gün en fazla bir normal blok).';

create or replace function public.save_teacher_duty_matrix_v2(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid,
  p_is_included boolean,
  p_half_day_rule_enabled boolean,
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

  -- (2b) YENİ: reddetme artık YER düzeyinde değil HÜCRE düzeyindedir.
  -- fixed_only hücreler (İLKOKUL-1/2 × Sabah / Öğleden Sonra) yalnız Sabit
  -- Nöbetler ekranından karşılanır ve tercih olarak seçilemez. AYNI yerin
  -- Öğle Arası-1 hücresi 'normal'dir ve SEÇİLEBİLİR — eski yer düzeyindeki
  -- kural bunu da yanlışlıkla engelliyordu.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    join public.duty_location_blocks lb
      on lb.duty_location_id = x.duty_location_id and lb.duty_block_id = x.duty_block_id
    where lb.assignment_mode <> 'normal'
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'fixed_assignment_only_cell');
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
    -- half_day_rule_enabled matris tercihleriyle AYNI transaction ve AYNI
    -- optimistic-concurrency penceresi içinde yazılır. NULL ⇒ "değiştirme"
    -- (eski 6 parametreli imzadan devreden çağrılar için).
    update public.teacher_duty_settings
      set is_included = p_is_included,
          teacher_name_snapshot = v_teacher.name,
          half_day_rule_enabled = coalesce(p_half_day_rule_enabled, half_day_rule_enabled)
      where id = v_setting_id;
  else
    if p_expected_updated_at is not null then
      return jsonb_build_object('status', 'conflict', 'currentUpdatedAt', null);
    end if;
    begin
      insert into public.teacher_duty_settings (campus_id, academic_year_id, teacher_source_id, teacher_name_snapshot, is_included, half_day_rule_enabled)
        values (v_campus_id, v_year_id, v_teacher.source_id, v_teacher.name, p_is_included, coalesce(p_half_day_rule_enabled, true))
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
  -- assignment_mode <> 'normal' (fixed_only) veya eşlemesi hiç olmayan
  -- hücrelere ait tarihsel satırlar da aynı şekilde KORUNUR — kullanıcıya hiç
  -- gösterilmedikleri için payload'da bulunamazlar, bu yüzden "gönderilmedi ⇒
  -- sil" kuralına DÜŞMEMELİDİRLER.
  delete from public.teacher_duty_block_availabilities av
    using public.duty_locations dl
    where av.teacher_duty_setting_id = v_setting_id
      and av.duty_location_id = dl.id
      and dl.campus_id = v_campus_id
      and dl.is_active
      and dl.deleted_at is null
      and exists (
        select 1 from public.duty_location_blocks lb
        where lb.duty_location_id = av.duty_location_id
          and lb.duty_block_id = av.duty_block_id
          and lb.assignment_mode = 'normal'
      )
      and not (av.day_order = any (v_fixed_day_orders))
      and public.is_teacher_eligible_for_duty_block_time(v_import.id, v_teacher.id, av.day_order, av.duty_block_id);

  insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
    select distinct v_campus_id, v_setting_id, x.duty_location_id, x.day_order::smallint, x.duty_block_id
    from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid);

  select updated_at into v_final_updated_at from public.teacher_duty_settings where id = v_setting_id;

  return jsonb_build_object(
    'status', 'ok',
    'updatedAt', v_final_updated_at,
    'halfDayRuleEnabled', (select half_day_rule_enabled from public.teacher_duty_settings where id = v_setting_id)
  );
end;
$$;

comment on function public.save_teacher_duty_matrix_v2(text, text, uuid, boolean, boolean, jsonb, timestamptz) is
  'Blok bazlı nöbet uygunluk matrisini VE half_day_rule_enabled ayarını TEK transaction / TEK optimistic-concurrency penceresinde atomik upsert+replace eder. p_half_day_rule_enabled NULL ⇒ mevcut değer korunur. Beklenen updatedAt bayatsa hiçbir alan KISMİ yazılmadan conflict döner. Hücre reddi artık BLOK düzeyindedir (invalid_cells/fixed_assignment_only_cell). Yalnız service_role çağırabilir.';

-- ----------------------------------------------------------------------------
-- Geriye uyumlu sarmalayıcı: ESKİ 6 parametreli imza AYNEN korunur ve v2'ye
-- devreder. Yeni bir OVERLOAD OLUŞMAZ (imza birebir aynı), bu yüzden
-- PostgREST'te belirsizlik doğmaz; rollout sırasında eski istemciler
-- çalışmaya devam eder ve half_day_rule_enabled'a DOKUNMAZ.
-- ----------------------------------------------------------------------------
create or replace function public.save_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid,
  p_is_included boolean,
  p_cells jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog, public
as $$
  select public.save_teacher_duty_matrix_v2(
    p_campus_name, p_academic_year_name, p_teacher_id, p_is_included,
    null::boolean, p_cells, p_expected_updated_at
  );
$$;

comment on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) is
  'GERİYE UYUMLU SARMALAYICI — save_teacher_duty_matrix_v2''ye devreder ve half_day_rule_enabled''ı DEĞİŞTİRMEZ (null geçer). Yeni istemciler v2''yi çağırmalıdır. İmza değişmediği için PostgREST overload belirsizliği oluşmaz.';
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
               -- AUTHORITATIVE: sabitlik YER değil BLOK düzeyindedir.
               (lb.assignment_mode = 'fixed_only') as is_fixed
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
                and dl5.is_active and dl5.deleted_at is null
                and exists (
                  select 1 from public.duty_location_blocks lb5
                  where lb5.duty_location_id = av.duty_location_id and lb5.duty_block_id = av.duty_block_id
                     and lb5.assignment_mode = 'normal'
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
         and dl4.is_active and dl4.deleted_at is null
         and exists (
           select 1 from public.duty_location_blocks lb4
           where lb4.duty_location_id = av.duty_location_id and lb4.duty_block_id = bb.id
                     and lb4.assignment_mode = 'normal'
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
                 and dl2.is_active and dl2.deleted_at is null
                 and exists (
                   select 1 from public.duty_location_blocks lb2
                   where lb2.duty_location_id = av.duty_location_id and lb2.duty_block_id = bb.id
                     and lb2.assignment_mode = 'normal'
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
                   and dl2.is_active and dl2.deleted_at is null
                   and exists (
                     select 1 from public.duty_location_blocks lb2
                     where lb2.duty_location_id = av.duty_location_id and lb2.duty_block_id = bb.id
                     and lb2.assignment_mode = 'normal'
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
  'Nöbet planı yapılabilirlik analizi. Görev evreni ve aday kenarları AUTHORITATIVE duty_location_blocks.assignment_mode üzerinden kurulur: fixed_only görevler yalnız sabit atamayla karşılanır ve NORMAL aday kenarı üretmez; normal görevler tercih + zaman kuralı + o gün sabit nöbeti olmama koşullarıyla eşleşir. duty_locations.allows_fixed_assignment ARTIK KULLANILMAZ. Yapılandırma hatası (period_configuration_missing) sayaçları ders/zaman çakışması sayaçlarından AYRI tutulur. Yalnız service_role çağırabilir.';

create or replace function public.get_duty_plan_generation_snapshot(
  p_campus_name text,
  p_academic_year_name text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_fingerprint text;
  v_days jsonb;
  v_blocks jsonb;
  v_locations jsonb;
  v_tasks jsonb;
  v_teachers jsonb;
  v_candidate_edges jsonb;
  v_teacher_fixed_loads jsonb;
  v_feasibility jsonb;
  v_configuration_errors jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('hasImport', false); end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('hasImport', false); end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then return jsonb_build_object('hasImport', false); end if;

  v_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object('order', d.day_order, 'name', d.name) order by d.day_order), '[]'::jsonb)
    into v_days
    from public.timetable_days d
    where d.timetable_import_id = v_import.id and d.day_order between 1 and 5;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'code', b.code, 'name', b.name, 'blockOrder', b.block_order,
      'conflictPeriodName', b.conflict_period_name
      ) order by b.block_order), '[]'::jsonb)
    into v_blocks
    from public.duty_blocks b where b.is_active;

  -- YENİ: her aktif/silinmemiş yerin GÜNCEL aktif blok kodu kümesi — solver'ın
  -- FULL_DAY/SHORT_BREAKS paket şablonunu hard-code ETMEDEN buradan türetmesi
  -- için (iş kuralı: konfigürasyon tabanlı, yer adı/UUID'i solver'da yok).
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'shortCode', x.short_code, 'category', x.category,
      -- Geriye uyumluluk için KORUNUR; karar için KULLANILMAZ.
      'allowsFixedAssignment', x.allows_fixed_assignment,
      'activeBlockCodes', x.codes,
      -- YENİ AUTHORITATIVE alanlar: solver ve feasibility normal görev
      -- evrenini YALNIZ normalBlockCodes/blockPolicies üzerinden kurar.
      'normalBlockCodes', x.normal_codes,
      'fixedOnlyBlockCodes', x.fixed_codes,
      'blockPolicies', x.policies
      ) order by x.short_code), '[]'::jsonb)
    into v_locations
    from (
      select dl.id, dl.short_code, dl.category, dl.allows_fixed_assignment,
             coalesce(array_agg(b.code order by b.code) filter (where b.id is not null), array[]::text[]) as codes,
             coalesce(array_agg(b.code order by b.code) filter (where b.id is not null and lb.assignment_mode = 'normal'), array[]::text[]) as normal_codes,
             coalesce(array_agg(b.code order by b.code) filter (where b.id is not null and lb.assignment_mode = 'fixed_only'), array[]::text[]) as fixed_codes,
             coalesce(jsonb_agg(jsonb_build_object(
                 'dutyBlockId', b.id, 'blockCode', b.code, 'assignmentMode', lb.assignment_mode
               ) order by b.block_order) filter (where b.id is not null), '[]'::jsonb) as policies
        from public.duty_locations dl
        left join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        left join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
       group by dl.id, dl.short_code, dl.category, dl.allows_fixed_assignment
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', t.day_order,
      'dutyLocationId', t.loc, 'dutyLocationName', t.loc_name, 'shortCode', t.short_code, 'category', t.category,
      'dutyBlockId', t.blk, 'blockCode', t.block_code, 'blockName', t.block_name, 'blockOrder', t.block_order,
      'kind', case when t.is_fixed then 'fixed' else 'normal' end,
      'fixedCoveredByTeacherSourceId', t.fixed_teacher_source_id,
      'fixedCoveredByTeacherName', t.fixed_teacher_name
      ) order by t.day_order, t.block_order, t.loc_name), '[]'::jsonb)
    into v_tasks
    from (
      select d.day_order, dl.id as loc, dl.name as loc_name, dl.short_code, dl.category,
             b.id as blk, b.code as block_code, b.name as block_name, b.block_order,
             -- AUTHORITATIVE: sabitlik BLOK düzeyindedir. İLKOKUL-1/2 ×
             -- Öğle Arası-1 artık NORMAL görevdir; aynı yerin Sabah /
             -- Öğleden Sonra hücreleri fixed_only kalır.
             (lb.assignment_mode = 'fixed_only') as is_fixed,
             fa.teacher_source_id as fixed_teacher_source_id,
             coalesce(ft.name, fa.teacher_name_snapshot) as fixed_teacher_name
        from generate_series(1, 5) as d(day_order)
        cross join public.duty_locations dl
        join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
        -- Bir fixed_duty_assignment (yıl, gün, yer) o yerin O GÜNKÜ
        -- fixed_only bloklarını (Sabah + Öğleden Sonra) karşılar; normal
        -- bloklara YAYILMAZ.
        left join public.fixed_duty_assignments fa
          on fa.academic_year_id = v_year_id and fa.day_order = d.day_order and fa.duty_location_id = dl.id
         and lb.assignment_mode = 'fixed_only'
        left join public.teachers ft
          on ft.timetable_import_id = v_import.id and ft.source_id = fa.teacher_source_id
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
    ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', e.day_order, 'dutyLocationId', e.loc, 'dutyBlockId', e.blk,
      'teacherSourceId', e.teacher_source_id, 'teacherName', e.teacher_name
      ) order by e.day_order, e.loc, e.blk, e.teacher_source_id), '[]'::jsonb)
    into v_candidate_edges
    from (
      select distinct d.day_order, dl.id as loc, b.id as blk, s.teacher_source_id, t.name as teacher_name
        from generate_series(1, 5) as d(day_order)
        cross join public.duty_locations dl
        join public.duty_location_blocks lb on lb.duty_location_id = dl.id
        join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
        join public.teacher_duty_block_availabilities av
          on av.duty_location_id = dl.id and av.duty_block_id = b.id and av.day_order = d.day_order
        join public.teacher_duty_settings s
          on s.id = av.teacher_duty_setting_id and s.academic_year_id = v_year_id and s.is_included
        join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
       where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
         -- Aday kenarı YALNIZ normal hücrelerde oluşur; fixed_only hücreler
         -- normal aday ÜRETMEZ.
         and lb.assignment_mode = 'normal'
         and not exists (
           select 1 from public.fixed_duty_assignments fa
           where fa.academic_year_id = v_year_id and fa.day_order = d.day_order and fa.teacher_source_id = s.teacher_source_id
         )
         and public.is_teacher_eligible_for_duty_block_time(v_import.id, t.id, d.day_order, b.id)
    ) e;

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id, 'teacherName', coalesce(t.name, s.teacher_name_snapshot),
      -- Solver günlük kapasiteyi buradan türetir: açık ⇒ 1 normal blok/gün,
      -- kapalı ⇒ farklı bloklarda en fazla 4 (aynı blokta asla iki yer).
      'halfDayRuleEnabled', s.half_day_rule_enabled,
      'maxDailyNormalBlocks', case when s.half_day_rule_enabled then 1 else 4 end
      ) order by s.teacher_source_id), '[]'::jsonb)
    into v_teachers
    from public.teacher_duty_settings s
    left join public.teachers t on t.timetable_import_id = v_import.id and t.source_id = s.teacher_source_id
    where s.academic_year_id = v_year_id and s.is_included;

  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', x.teacher_source_id, 'fixedDutyDayCount', x.day_count
      ) order by x.teacher_source_id), '[]'::jsonb)
    into v_teacher_fixed_loads
    from (
      select fa.teacher_source_id, count(distinct fa.day_order) as day_count
        from public.fixed_duty_assignments fa
        where fa.academic_year_id = v_year_id
        group by fa.teacher_source_id
    ) x;

  v_feasibility := public.analyze_duty_plan_feasibility(p_campus_name, p_academic_year_name);

  select coalesce(jsonb_agg(jsonb_build_object(
      'dayOrder', (dd ->> 'order')::int, 'blockCode', ce ->> 'blockCode', 'blockName', ce ->> 'blockName',
      'periodName', ce ->> 'periodName', 'teacherCount', (ce ->> 'teacherCount')::int
      )), '[]'::jsonb)
    into v_configuration_errors
    from jsonb_array_elements(v_feasibility -> 'days') as dd
    cross join lateral jsonb_array_elements(dd -> 'excludedByConfigurationError') as ce
    where (ce ->> 'teacherCount')::int > 0;

  return jsonb_build_object(
    'hasImport', true,
    'campusId', v_campus_id,
    'academicYearId', v_year_id,
    'timetableImportId', v_import.id,
    'importedAt', v_import.imported_at,
    'sourceFingerprint', v_fingerprint,
    'days', v_days,
    'blocks', v_blocks,
    'locations', v_locations,
    'tasks', v_tasks,
    'teachers', v_teachers,
    'candidateEdges', v_candidate_edges,
    'teacherFixedDutyLoads', v_teacher_fixed_loads,
    'feasibility', v_feasibility,
    'configurationErrors', v_configuration_errors
  );
end;
$$;

comment on function public.get_duty_plan_generation_snapshot(text, text) is
  'Üretim için TEK okunabilir görüntü. Görev evreni ve aday kenarları AUTHORITATIVE duty_location_blocks.assignment_mode ile kurulur: kind=fixed YALNIZ fixed_only bloklardan, normal aday kenarları YALNIZ normal bloklardan gelir. locations[].blockPolicies / normalBlockCodes / fixedOnlyBlockCodes solver''ın şablonu hard-code etmeden türetmesi içindir. teachers[].halfDayRuleEnabled ve maxDailyNormalBlocks günlük kapasiteyi taşır (açık ⇒ 1, kapalı ⇒ 4). Yalnız service_role çağırabilir.';
create or replace function public.save_duty_plan_draft(
  p_campus_name text,
  p_academic_year_name text,
  p_expected_source_fingerprint text,
  p_algorithm_version text,
  p_generation_seed integer,
  p_generation_options jsonb,
  p_assignments jsonb,
  p_summary jsonb,
  p_allow_partial boolean,
  p_expected_plan_id uuid default null,
  p_expected_plan_version integer default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, extensions
as $$
declare
  v_campus_id uuid;
  v_year_id uuid;
  v_import record;
  v_current_fingerprint text;
  v_min integer;
  v_target integer;
  v_max integer;
  v_bad boolean;
  v_analysis record;
  v_existing_plan_id uuid;
  v_existing_plan_version integer;
  v_plan_id uuid;
  v_plan record;
  v_summary_teacher_loads jsonb;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_algorithm_version), '') = '' then
    raise exception 'algorithm_version zorunludur.' using errcode = '22023';
  end if;
  if p_allow_partial is null then
    raise exception 'allow_partial zorunludur.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_assignments, 'null'::jsonb)) is distinct from 'array' then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'assignments_not_array');
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;
  if not found then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null);
  end if;

  v_current_fingerprint := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fingerprint is distinct from p_expected_source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fingerprint);
  end if;

  v_min := coalesce((p_generation_options ->> 'minWeeklyDuties')::integer, 1);
  v_target := coalesce((p_generation_options ->> 'targetWeeklyDuties')::integer, 2);
  v_max := coalesce((p_generation_options ->> 'maxWeeklyDuties')::integer, 3);
  if v_min < 0 or v_min > 5 or v_target < 0 or v_target > 5 or v_max < 0 or v_max > 5
     or not (v_min <= v_target and v_target <= v_max) then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_generation_options');
  end if;

  select exists (
    select 1 from jsonb_to_recordset(p_assignments)
      as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
    group by x.day_order, x.duty_location_id, x.duty_block_id
    having count(*) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'duplicate_cell');
  end if;

  -- ==========================================================================
  -- ÖĞRETMEN × GÜN KURALLARI — analizden ÖNCE, hiçbir satır yazılmadan.
  -- Sıra ÖNEMLİ: en NET ihlal önce döner (sabit gün > aynı blok > yarım gün),
  -- aksi halde aday geçerliliği gibi TÜREV bir gerekçe gerçek nedeni gizler.
  -- ==========================================================================

  -- (R1) SABİT nöbet günü: o gün HİÇBİR normal görev alınamaz — yarım gün
  -- ayarından BAĞIMSIZDIR.
  select exists (
    select 1 from (
      select distinct x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
    ) x
    join public.fixed_duty_assignments fa
      on fa.academic_year_id = v_year_id and fa.day_order = x.day_order and fa.teacher_source_id = x.teacher_source_id
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_has_fixed_duty');
  end if;

  -- (R2) AYNI GÜN + AYNI BLOK'ta ikinci görev HER ZAMAN yasaktır (yarım gün
  -- kuralı kapalı olsa bile aynı blokta iki farklı yerde bulunulamaz).
  select exists (
    select 1 from (
      select distinct x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             x.duty_block_id as blk, x.duty_location_id as loc
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('fixed', 'generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
    ) x
    group by x.day_order, x.teacher_source_id, x.blk
    having count(distinct x.loc) > 1
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_block_conflict');
  end if;

  -- (R3) solver-v3: normal paket ÇOK HÜCRELİ olamaz. INSERT aşamasındaki
  -- trigger'a bırakılmaz — burada, hiçbir satır yazılmadan reddedilir.
  if p_algorithm_version like 'duty-plan-solver-v3%' then
    select exists (
      select 1 from (
        select x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
               x.duty_location_id as loc, count(distinct x.duty_block_id) as block_count
          from jsonb_to_recordset(p_assignments)
            as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
         where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
         group by x.day_order, nullif(btrim(x.teacher_source_id), ''), x.duty_location_id
      ) g
      where g.block_count > 1
    ) into v_bad;
    if v_bad then
      return jsonb_build_object('status', 'invalid_assignment', 'reason', 'normal_package_must_be_single_block');
    end if;
  end if;

  -- (R4) YARIM GÜN kuralı AÇIK öğretmen: aynı gün EN FAZLA BİR normal blok.
  -- Kapalı öğretmende günlük tavan dört bloktur.
  select exists (
    select 1 from (
      select x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             count(distinct x.duty_block_id) as block_count
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
       group by x.day_order, nullif(btrim(x.teacher_source_id), '')
    ) g
    where g.block_count > case when public.teacher_half_day_rule_enabled(v_year_id, g.teacher_source_id) then 1 else 4 end
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'teacher_day_conflict', 'reason', 'half_day_rule');
  end if;

  with expected as (
    -- AUTHORITATIVE: sabitlik BLOK düzeyindedir (assignment_mode).
    select d.day_order, dl.id as loc, b.id as blk, (lb.assignment_mode = 'fixed_only') as is_fixed
      from generate_series(1, 5) as d(day_order)
      cross join public.duty_locations dl
      join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
     where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
  ),
  submitted as (
    select x.day_order, x.duty_location_id as loc, x.duty_block_id as blk,
           nullif(btrim(x.teacher_source_id), '') as teacher_source_id, x.assignment_kind
      from jsonb_to_recordset(p_assignments)
        as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
  ),
  joined as (
    select e.day_order as e_day, e.loc as e_loc, e.blk as e_blk, e.is_fixed as e_is_fixed,
           s.loc as s_loc, s.teacher_source_id, s.assignment_kind
      from expected e
      full outer join submitted s
        on s.day_order = e.day_order and s.loc = e.loc and s.blk = e.blk
  ),
  existing_fixed as (
    select fa.day_order, fa.duty_location_id as loc, fa.teacher_source_id, fa.id as fixed_id
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
  ),
  candidate_valid as (
    select distinct d.day_order, dl.id as loc, b.id as blk, ts.teacher_source_id
      from generate_series(1, 5) as d(day_order)
      cross join public.duty_locations dl
      join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
      join public.teacher_duty_block_availabilities av
        on av.duty_location_id = dl.id and av.duty_block_id = b.id and av.day_order = d.day_order
      join public.teacher_duty_settings ts
        on ts.id = av.teacher_duty_setting_id and ts.academic_year_id = v_year_id and ts.is_included
      join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = ts.teacher_source_id
     where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
       -- Normal aday YALNIZ assignment_mode='normal' hücrelerde oluşur.
       and lb.assignment_mode = 'normal'
       and not exists (
         select 1 from public.fixed_duty_assignments fa2
         where fa2.academic_year_id = v_year_id and fa2.day_order = d.day_order and fa2.teacher_source_id = ts.teacher_source_id
       )
       and public.is_teacher_eligible_for_duty_block_time(v_import.id, tt.id, d.day_order, b.id)
  ),
  -- PAKET GRUPLARI: aynı gün+öğretmen+yer bir arada — coverage_mode geçerli
  -- bir şablona (FULL_DAY/SHORT_BREAKS/FIXED_SHORT_BREAKS/SINGLE_BLOCK) uymalı
  -- VE grup içinde TEK bir assignment_kind olmalı.
  package_groups as (
    select s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
           array_agg(distinct b.code) as block_codes
      from submitted s
      join public.duty_blocks b on b.id = s.blk
     where s.teacher_source_id is not null and s.assignment_kind in ('fixed', 'generated', 'manual')
     group by s.day_order, s.loc, s.teacher_source_id, s.assignment_kind
  ),
  package_kind_variety as (
    select day_order, loc, teacher_source_id, count(distinct assignment_kind) as kind_variety
      from package_groups
      group by day_order, loc, teacher_source_id
  ),
  package_groups_classified as (
    select pg.*, public.classify_duty_plan_package_coverage(pg.loc, pg.assignment_kind, pg.block_codes) as coverage_mode
      from package_groups pg
  ),
  teacher_universe as (
    select s.teacher_source_id
      from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
  ),
  -- YENİ haftalık yük: satır değil PAKET-GÜN sayısı (aynı gün+yer+öğretmen
  -- grubu = 1 paket = 1 gün, kapsadığı hücre sayısından BAĞIMSIZ).
  normal_by_teacher as (
    select teacher_source_id, count(*) as normal_count
      from package_groups
      where assignment_kind in ('generated', 'manual')
      group by teacher_source_id
  ),
  fixed_days_by_teacher as (
    select fa.teacher_source_id, count(distinct fa.day_order) as fixed_days
      from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id
      group by fa.teacher_source_id
  ),
  teacher_loads as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'teacherSourceId', tu.teacher_source_id,
        'normalDutyCount', coalesce(nb.normal_count, 0),
        'fixedDutyDayCount', coalesce(fb.fixed_days, 0),
        'totalDutyCount', coalesce(nb.normal_count, 0) + coalesce(fb.fixed_days, 0)
        ) order by tu.teacher_source_id), '[]'::jsonb) as arr
      from teacher_universe tu
      left join normal_by_teacher nb on nb.teacher_source_id = tu.teacher_source_id
      left join fixed_days_by_teacher fb on fb.teacher_source_id = tu.teacher_source_id
  )
  select
    bool_or(j.e_loc is not null and j.s_loc is null) as missing_task,
    bool_or(j.e_loc is null and j.s_loc is not null) as extra_task,
    bool_or(j.e_loc is not null and j.assignment_kind is null) as missing_kind,
    bool_or(j.e_is_fixed and j.assignment_kind not in ('fixed', 'unassigned')) as fixed_task_wrong_kind,
    bool_or(not j.e_is_fixed and j.assignment_kind = 'fixed') as normal_task_marked_fixed,
    bool_or(j.e_is_fixed and j.assignment_kind = 'fixed' and ef.fixed_id is null) as fixed_missing_underlying,
    bool_or(j.e_is_fixed and j.assignment_kind = 'fixed' and ef.fixed_id is not null and ef.teacher_source_id is distinct from j.teacher_source_id) as fixed_teacher_mismatch,
    bool_or(j.e_is_fixed and j.assignment_kind = 'unassigned' and ef.fixed_id is not null) as fixed_wrongly_unassigned,
    bool_or(not j.e_is_fixed and j.assignment_kind = 'unassigned' and not p_allow_partial) as unassigned_not_allowed,
    bool_or(j.e_loc is not null and (j.assignment_kind = 'unassigned') is distinct from (j.teacher_source_id is null)) as teacher_null_mismatch,
    bool_or(not j.e_is_fixed and j.assignment_kind in ('generated', 'manual') and cv.teacher_source_id is null) as candidate_invalid,
    count(*) filter (where j.e_loc is not null) as total_task_count,
    count(*) filter (where j.e_is_fixed) as fixed_task_count,
    count(*) filter (where j.e_is_fixed and j.assignment_kind = 'fixed') as fixed_covered_count,
    count(*) filter (where not j.e_is_fixed) as normal_task_count,
    count(*) filter (where not j.e_is_fixed and j.assignment_kind in ('generated', 'manual')) as normal_covered_count,
    count(*) filter (where j.assignment_kind = 'unassigned') as uncovered_count,
    (select bool_or(kind_variety > 1) from package_kind_variety) as package_mixed_kind,
    (select bool_or(coverage_mode is null) from package_groups_classified) as package_invalid_combination,
    (select arr from teacher_loads) as teacher_loads_json
    into v_analysis
  from joined j
  left join existing_fixed ef on j.e_is_fixed and ef.day_order = j.e_day and ef.loc = j.e_loc
  left join candidate_valid cv
    on not j.e_is_fixed and j.assignment_kind in ('generated', 'manual')
   and cv.day_order = j.e_day and cv.loc = j.e_loc and cv.blk = j.e_blk and cv.teacher_source_id = j.teacher_source_id;

  if v_analysis.missing_task or v_analysis.extra_task then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'task_set_mismatch');
  end if;
  if v_analysis.missing_kind or v_analysis.teacher_null_mismatch or v_analysis.normal_task_marked_fixed then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_assignment_kind');
  end if;
  if v_analysis.fixed_task_wrong_kind or v_analysis.fixed_wrongly_unassigned then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'fixed_task_requires_fixed_or_unassigned');
  end if;
  if v_analysis.fixed_missing_underlying or v_analysis.fixed_teacher_mismatch then
    return jsonb_build_object('status', 'fixed_assignment_changed');
  end if;
  if v_analysis.unassigned_not_allowed then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'partial_not_allowed');
  end if;
  if v_analysis.candidate_invalid then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'candidate_no_longer_valid');
  end if;


  -- (5b) Paket içi: TEK assignment_kind, block kümesi GEÇERLİ bir şablona uymalı.
  if v_analysis.package_mixed_kind then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_package_combination');
  end if;
  if v_analysis.package_invalid_combination then
    return jsonb_build_object('status', 'invalid_assignment', 'reason', 'invalid_package_combination');
  end if;

  -- (6) Haftalık üst sınır — artık PAKET-GÜN sayısı (satır değil).
  select exists (
    select 1 from jsonb_array_elements(v_analysis.teacher_loads_json) as tl
    where (tl ->> 'totalDutyCount')::int > v_max
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'weekly_limit_exceeded');
  end if;

  v_summary_teacher_loads := coalesce(p_summary -> 'teacherLoads', '[]'::jsonb);
  if (p_summary ->> 'totalTaskCount')::int is distinct from v_analysis.total_task_count
     or (p_summary ->> 'fixedTaskCount')::int is distinct from v_analysis.fixed_task_count
     or (p_summary ->> 'fixedCoveredCount')::int is distinct from v_analysis.fixed_covered_count
     or (p_summary ->> 'normalTaskCount')::int is distinct from v_analysis.normal_task_count
     or (p_summary ->> 'normalCoveredCount')::int is distinct from v_analysis.normal_covered_count
     or (p_summary ->> 'uncoveredCount')::int is distinct from v_analysis.uncovered_count
     or v_summary_teacher_loads is distinct from v_analysis.teacher_loads_json
  then
    return jsonb_build_object(
      'status', 'invalid_summary',
      'authoritative', jsonb_build_object(
        'totalTaskCount', v_analysis.total_task_count,
        'fixedTaskCount', v_analysis.fixed_task_count,
        'fixedCoveredCount', v_analysis.fixed_covered_count,
        'normalTaskCount', v_analysis.normal_task_count,
        'normalCoveredCount', v_analysis.normal_covered_count,
        'uncoveredCount', v_analysis.uncovered_count,
        'teacherLoads', v_analysis.teacher_loads_json
      )
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('duty-plan-draft:' || v_year_id::text));

  select id, version into v_existing_plan_id, v_existing_plan_version
    from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft'
    for update;

  if v_existing_plan_id is distinct from p_expected_plan_id then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
  end if;

  if v_existing_plan_id is not null and p_expected_plan_version is not null
     and v_existing_plan_version is distinct from p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentPlanId', v_existing_plan_id, 'currentVersion', v_existing_plan_version);
  end if;

  delete from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'draft';

  insert into public.duty_plans (
    campus_id, academic_year_id, timetable_import_id, status,
    source_fingerprint, algorithm_version, generation_seed, generation_options, summary, version
  ) values (
    v_campus_id, v_year_id, v_import.id, 'draft',
    v_current_fingerprint, p_algorithm_version, p_generation_seed,
    coalesce(p_generation_options, '{}'::jsonb), coalesce(p_summary, '{}'::jsonb), 1
  ) returning id into v_plan_id;

  -- Önce PAKETLER yazılır (submitted'tan aynı gruplama ile), sonra hücreler
  -- bu paketlere package_id ile bağlanır.
  with submitted2 as (
    select x.day_order, x.duty_location_id as loc, x.duty_block_id as blk,
           nullif(btrim(x.teacher_source_id), '') as teacher_source_id, x.assignment_kind
      from jsonb_to_recordset(p_assignments)
        as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
  ),
  groups2 as (
    select s.day_order, s.loc, s.teacher_source_id, s.assignment_kind,
           array_agg(distinct b.code) as block_codes
      from submitted2 s
      join public.duty_blocks b on b.id = s.blk
     where s.teacher_source_id is not null and s.assignment_kind in ('fixed', 'generated', 'manual')
     group by s.day_order, s.loc, s.teacher_source_id, s.assignment_kind
  )
  insert into public.duty_plan_assignment_packages (
    plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
    coverage_mode, assignment_kind, fixed_duty_assignment_id
  )
  select
    v_plan_id, v_campus_id, g.day_order, g.loc, g.teacher_source_id,
    coalesce(tt.name, ef3.teacher_name_snapshot),
    public.classify_duty_plan_package_coverage(g.loc, g.assignment_kind, g.block_codes),
    g.assignment_kind,
    case when g.assignment_kind = 'fixed' then ef3.id else null end
  from groups2 g
  left join public.teachers tt on tt.timetable_import_id = v_import.id and tt.source_id = g.teacher_source_id
  left join public.fixed_duty_assignments ef3
    on g.assignment_kind = 'fixed'
   and ef3.academic_year_id = v_year_id and ef3.day_order = g.day_order and ef3.duty_location_id = g.loc
   and ef3.teacher_source_id = g.teacher_source_id;

  insert into public.duty_plan_assignments (
    plan_id, campus_id, day_order, duty_location_id, duty_block_id,
    teacher_source_id, teacher_name_snapshot, duty_location_name_snapshot, duty_block_name_snapshot,
    assignment_kind, fixed_duty_assignment_id, score_details, package_id
  )
  select
    v_plan_id, v_campus_id, x.day_order, x.duty_location_id, x.duty_block_id,
    nullif(btrim(x.teacher_source_id), ''),
    case when nullif(btrim(x.teacher_source_id), '') is not null
      then coalesce(tt.name, ef2.teacher_name_snapshot)
      else null
    end,
    dl.name, b.name,
    x.assignment_kind, ef2.id,
    coalesce(x.score_details, '{}'::jsonb),
    pkg.id
  from jsonb_to_recordset(p_assignments) as x(
    day_order int, duty_location_id uuid, duty_block_id uuid,
    teacher_source_id text, assignment_kind text, score_details jsonb
  )
  join public.duty_locations dl on dl.id = x.duty_location_id
  join public.duty_blocks b on b.id = x.duty_block_id
  left join public.teachers tt
    on tt.timetable_import_id = v_import.id and tt.source_id = nullif(btrim(x.teacher_source_id), '')
  left join public.fixed_duty_assignments ef2
    on x.assignment_kind = 'fixed'
   and ef2.academic_year_id = v_year_id and ef2.day_order = x.day_order and ef2.duty_location_id = x.duty_location_id
   and ef2.teacher_source_id = nullif(btrim(x.teacher_source_id), '')
  left join public.duty_plan_assignment_packages pkg
    on pkg.plan_id = v_plan_id and pkg.day_order = x.day_order and pkg.duty_location_id = x.duty_location_id
   and pkg.teacher_source_id = nullif(btrim(x.teacher_source_id), '') and pkg.assignment_kind = x.assignment_kind;

  select * into v_plan from public.duty_plans where id = v_plan_id;

  return jsonb_build_object(
    'status', 'ok',
    'planId', v_plan.id,
    'version', v_plan.version,
    'sourceFingerprint', v_plan.source_fingerprint,
    'createdAt', v_plan.created_at,
    'updatedAt', v_plan.updated_at
  );
end;
$$;

comment on function public.save_duty_plan_draft(text, text, text, text, integer, jsonb, jsonb, jsonb, boolean, uuid, integer) is
  'Volatile, atomik: PAKET-FARKINDA yeniden doğrulama. Görev evreni ve aday geçerliliği AUTHORITATIVE duty_location_blocks.assignment_mode ile kurulur (normal atama YALNIZ normal hücreye, fixed görev YALNIZ fixed_only hücreye). Yeni kurallar: aynı gün+blok ikinci görev ⇒ teacher_block_conflict; yarım gün kuralı açık öğretmende günde birden fazla normal görev ⇒ teacher_day_conflict/half_day_rule (kapalıda tavan dört blok); sabit nöbet gününde normal görev ⇒ teacher_has_fixed_duty. Atomiklik, fingerprint, expected version ve FOR UPDATE korumaları DEĞİŞMEDİ. Yalnız service_role çağırabilir.';

create or replace function public.update_duty_plan_assignment(
  p_plan_id uuid,
  p_task_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_source_id text,
  p_expected_plan_version integer
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
  v_plan record;
  v_current_fp text;
  v_row record;
  v_day_order integer;
  v_duty_location_id uuid;
  v_duty_block_id uuid;
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_teacher record;
  -- v_teacher (record) hiç atanmadan (ör. temizleme yolunda) alanına
  -- erişmek PL/pgSQL'de dal ALINMASA BİLE "record is not assigned yet"
  -- hatası verir; bu yüzden son dönüşte v_teacher.name YERİNE bu düz text
  -- değişken kullanılır (yalnız atama dalında doldurulur).
  v_teacher_name text;
  v_pkg_cell_count integer;
  v_conflict_pkg record;
  v_max integer;
  v_current_total integer;
  v_new_pkg_id uuid;
  v_new_summary jsonb;
  v_new_version integer;
begin
  if p_plan_id is null or p_task_id is null then
    raise exception 'plan_id ve task_id zorunludur.' using errcode = '22023';
  end if;
  if p_expected_plan_version is null then
    raise exception 'expected_plan_version zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;

  select * into v_plan from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
    for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.status <> 'draft' then return jsonb_build_object('status', 'plan_not_draft'); end if;
  if v_plan.version <> p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fp is distinct from v_plan.source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fp);
  end if;

  select * into v_row from public.duty_plan_assignments
    where id = p_task_id and plan_id = p_plan_id
    for update;
  if not found then return jsonb_build_object('status', 'task_not_found'); end if;
  if v_row.assignment_kind = 'fixed' then return jsonb_build_object('status', 'fixed_task_immutable'); end if;
  v_day_order := v_row.day_order;
  v_duty_location_id := v_row.duty_location_id;
  v_duty_block_id := v_row.duty_block_id;

  -- Hücre çok-hücreli bir pakete (FULL_DAY/SHORT_BREAKS) aitse bu RPC ARTIK
  -- DOĞRUDAN YAZMAZ — sessiz bölme yok. Paket 1 hücreliyse (SINGLE_BLOCK)
  -- veya hiç paketi yoksa (unassigned) eskisi gibi çalışır.
  if v_row.package_id is not null then
    select count(*) into v_pkg_cell_count from public.duty_plan_assignments where package_id = v_row.package_id;
    if v_pkg_cell_count > 1 then
      return jsonb_build_object(
        'status', 'requires_package_action',
        'package', (
          select jsonb_build_object(
            'id', p.id, 'coverageMode', p.coverage_mode, 'teacherSourceId', p.teacher_source_id,
            'teacherName', p.teacher_name_snapshot, 'dutyLocationId', p.duty_location_id,
            'coveredTaskIds', (select coalesce(jsonb_agg(a2.id), '[]'::jsonb) from public.duty_plan_assignments a2 where a2.package_id = p.id)
          )
          from public.duty_plan_assignment_packages p where p.id = v_row.package_id
        )
      );
    end if;
  end if;

  if v_teacher_source_id is null then
    if v_row.package_id is not null then
      update public.duty_plan_assignments
        set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
            package_id = null, updated_at = timezone('utc', now())
        where id = v_row.id;
      delete from public.duty_plan_assignment_packages where id = v_row.package_id;
    end if;
  else
    select id, name into v_teacher from public.teachers
      where timetable_import_id = v_plan.timetable_import_id and source_id = v_teacher_source_id;
    if not found then return jsonb_build_object('status', 'teacher_not_in_import'); end if;
    v_teacher_name := v_teacher.name;

    if not exists (
      select 1 from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id and s.is_included
    ) then
      return jsonb_build_object('status', 'teacher_not_included');
    end if;

    -- YENİ: hedef HÜCRE normal atamaya açık olmalı. fixed_only hücreler
    -- yalnız Sabit Nöbetler üzerinden karşılanır.
    if not public.is_duty_cell_open_for_normal(v_duty_location_id, v_duty_block_id) then
      return jsonb_build_object('status', 'cell_not_open_for_normal');
    end if;

    if exists (
      select 1 from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id and fa.day_order = v_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      return jsonb_build_object('status', 'teacher_has_fixed_duty');
    end if;

    -- YENİ: aynı gün AYNI BLOK'ta başka bir yerde görev — yarım gün kuralı
    -- KAPALI olsa bile yasaktır. Sessiz taşıma/değiştirme YAPILMAZ.
    if exists (
      select 1 from public.duty_plan_assignments a2
      where a2.plan_id = p_plan_id and a2.day_order = v_day_order
        and a2.duty_block_id = v_duty_block_id
        and a2.teacher_source_id = v_teacher_source_id
        and a2.id is distinct from v_row.id
    ) then
      return jsonb_build_object('status', 'teacher_block_conflict');
    end if;

    -- Hedef öğretmenin o gün BAŞKA (bu hücrenin kendi paketi DIŞINDA) bir
    -- paketi varsa sessizce taşınmaz — conflictingPackage ile bildirilir.
    -- YARIM GÜN kuralı AÇIK ise o gün başka HERHANGİ bir paket engeldir.
    -- KAPALI ise farklı bloklardaki paketler serbesttir (blok çakışması
    -- yukarıda ayrıca reddedildi).
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = v_day_order and p.teacher_source_id = v_teacher_source_id
        and p.id is distinct from v_row.package_id
        and public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id)
      limit 1;
    if found then
      return jsonb_build_object(
        'status', 'teacher_day_conflict',
        'conflictingPackage', jsonb_build_object(
          'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
          'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
        )
      );
    end if;

    if not exists (
      select 1 from public.teacher_duty_block_availabilities av
      join public.teacher_duty_settings s2 on s2.id = av.teacher_duty_setting_id
      where s2.academic_year_id = v_year_id and s2.teacher_source_id = v_teacher_source_id
        and av.duty_location_id = v_duty_location_id and av.duty_block_id = v_duty_block_id and av.day_order = v_day_order
    ) then
      return jsonb_build_object('status', 'no_preference_for_cell');
    end if;

    if not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, v_teacher.id, v_day_order, v_duty_block_id) then
      return jsonb_build_object('status', 'time_rule_violation');
    end if;

    -- Haftalık toplam artık PAKET sayısı — bu hücrenin KENDİ eski paketi
    -- (varsa) hariç tutularak sayılır, çünkü o zaten değiştirilecek/silinecek.
    select count(*) into v_current_total
      from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and id is distinct from v_row.package_id;

    v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
    if v_current_total + 1 > v_max then
      return jsonb_build_object('status', 'weekly_limit_exceeded');
    end if;

    -- TÜM doğrulamalar geçti — ancak ŞİMDİ (erken dönüşle yarım kalmış bir
    -- yazma asla olmasın diye) hücreyi eski paketinden AYIR. Bu, hedef
    -- öğretmenin BİZZAT bu hücrenin kendi eski (SINGLE_BLOCK) paketini
    -- tutuyor olması (kendine yeniden atama) dahil HER durumda, yeni paketin
    -- (plan_id, day_order, teacher_source_id) anahtarının eskisiyle
    -- çakışmamasını garanti eder — insert ÖNCE detach yapılmazsa aynı
    -- anahtarla iki satır aynı anda var olmaya çalışır (unique ihlali).
    if v_row.package_id is not null then
      update public.duty_plan_assignments
        set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
            package_id = null, updated_at = timezone('utc', now())
        where id = v_row.id;
      delete from public.duty_plan_assignment_packages where id = v_row.package_id;
    end if;

    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
      coverage_mode, assignment_kind
    ) values (
      p_plan_id, v_plan.campus_id, v_day_order, v_duty_location_id, v_teacher_source_id, v_teacher.name,
      'SINGLE_BLOCK', 'manual'
    ) returning id into v_new_pkg_id;

    update public.duty_plan_assignments
      set teacher_source_id = v_teacher_source_id, teacher_name_snapshot = v_teacher.name,
          assignment_kind = 'manual', package_id = v_new_pkg_id, updated_at = timezone('utc', now())
      where id = v_row.id;
  end if;

  -- Planın summary'sini TÜM plan paketlerinden (yetkili) yeniden hesapla —
  -- KANONİK formül: totalDutyCount = teacher_source_id başına PAKET sayısı.
  with teacher_universe as (
    select s.teacher_source_id from public.teacher_duty_settings s where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id from public.fixed_duty_assignments fa where fa.academic_year_id = v_year_id
  ),
  fixed_days as (
    select p.teacher_source_id, count(*) as fixed_days
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
      group by p.teacher_source_id
  ),
  normal_counts as (
    select p.teacher_source_id, count(*) as normal_count
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind in ('generated', 'manual')
      group by p.teacher_source_id
  ),
  loads as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'teacherSourceId', tu.teacher_source_id,
        'normalDutyCount', coalesce(nc.normal_count, 0),
        'fixedDutyDayCount', coalesce(fd.fixed_days, 0),
        'totalDutyCount', coalesce(nc.normal_count, 0) + coalesce(fd.fixed_days, 0)
      ) order by tu.teacher_source_id), '[]'::jsonb) as arr
      from teacher_universe tu
      left join normal_counts nc on nc.teacher_source_id = tu.teacher_source_id
      left join fixed_days fd on fd.teacher_source_id = tu.teacher_source_id
  )
  select coalesce(v_plan.summary, '{}'::jsonb)
      || jsonb_build_object(
           'teacherLoads', (select arr from loads),
           'uncoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'unassigned'),
           'normalCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind in ('generated', 'manual')),
           'fixedCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'fixed')
         )
    into v_new_summary;

  update public.duty_plans
    set version = version + 1, summary = v_new_summary, updated_at = timezone('utc', now())
    where id = p_plan_id
    returning version into v_new_version;

  return jsonb_build_object(
    'status', 'ok',
    'version', v_new_version,
    'assignment', jsonb_build_object(
      'taskId', p_task_id, 'dayOrder', v_day_order, 'dutyLocationId', v_duty_location_id, 'dutyBlockId', v_duty_block_id,
      'teacherSourceId', v_teacher_source_id,
      'teacherName', v_teacher_name,
      'assignmentKind', case when v_teacher_source_id is null then 'unassigned' else 'manual' end
    ),
    'summary', v_new_summary
  );
end;
$$;

comment on function public.update_duty_plan_assignment(uuid, uuid, text, text, text, integer) is
  'Tek hücre manuel atama. Hedef hücre assignment_mode=normal olmalıdır (aksi halde cell_not_open_for_normal). Sabit nöbet gününde normal görev reddedilir (teacher_has_fixed_duty). Aynı gün+blok ikinci yer reddedilir (teacher_block_conflict). Yarım gün kuralı AÇIK öğretmende o gün başka paket varsa teacher_day_conflict (conflictingPackage ile) — KAPALI öğretmende farklı bloklar serbesttir. Haftalık üst sınır PAKET-GÜN sayısıdır. Sessiz swap/taşıma YOKTUR. Yalnız service_role çağırabilir.';
create or replace function public.preview_duty_plan_manual_package(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_day_order integer,
  p_duty_location_id uuid,
  p_teacher_source_id text,
  p_coverage_mode text,
  p_duty_block_id uuid default null
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
  v_plan record;
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_target_blocks uuid[];
  v_dl record;
  v_change jsonb;
  v_touched_package_ids uuid[];
  v_eligible boolean := true;
  v_reasons text[] := array[]::text[];
  v_conflict_pkg record;
  -- 0 satır dönen bir SELECT INTO, `record` tipli değişkeni "unassigned"
  -- bırakır — sonraki jsonb_build_object'te v_conflict_pkg.id erişimi HİÇ
  -- dal alınmasa bile hata verir. Bu yüzden sonuç jsonb'si burada, YALNIZ
  -- satır bulunduğunda, ayrı bir değişkene önceden hazırlanır.
  v_conflict_pkg_json jsonb;
begin
  if p_plan_id is null or p_day_order is null or p_duty_location_id is null or coalesce(btrim(p_coverage_mode), '') = '' then
    raise exception 'plan_id, day_order, duty_location_id ve coverage_mode zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;
  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan from public.duty_plans where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_dl from public.duty_locations where id = p_duty_location_id and campus_id = v_campus_id;
  if not found then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['location_not_available_for_manual_package']);
  end if;

  v_target_blocks := public.resolve_duty_plan_package_target_blocks(p_duty_location_id, p_coverage_mode, p_duty_block_id);
  if v_target_blocks is null then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['invalid_package_combination']);
  end if;

  -- YENİ: reddetme YER düzeyinde değil, HEDEF BLOKLAR düzeyindedir. Bir yerin
  -- bazı blokları fixed_only, bazıları normal olabilir (İLKOKUL-1/2). Paket
  -- yalnız hedeflediği blokların TAMAMI 'normal' ise kurulabilir.
  if exists (
    select 1 from unnest(v_target_blocks) as tb(blk)
    where not public.is_duty_cell_open_for_normal(p_duty_location_id, tb.blk)
  ) then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['cell_not_open_for_normal']);
  end if;

  -- YENİ (solver-v3 savunması): v3 planlarda normal paketler YALNIZ tek blok
  -- olabilir. Çok bloklu bir istek DB trigger'ına (ham exception) bırakılmaz;
  -- burada YAPILANDIRILMIŞ bir sonuçla reddedilir. Eski v1/v2 planlar bu
  -- kuraldan ETKİLENMEZ (tarihsel okunabilirlik korunur).
  if v_plan.algorithm_version like 'duty-plan-solver-v3%'
     and coalesce(array_length(v_target_blocks, 1), 0) > 1 then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['normal_package_must_be_single_block']);
  end if;

  -- TEK KARAR MANTIĞI: hedef+dokunulan+etkilenen küme set_duty_plan_manual_
  -- package ile AYNI fonksiyondan gelir (bkz. bölüm 9).
  v_change := public.compute_duty_plan_manual_package_change(p_plan_id, p_day_order, p_duty_location_id, v_target_blocks);

  if (v_change ->> 'targetTaskCount')::int <> array_length(v_target_blocks, 1) then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['task_not_found']);
  end if;
  if (v_change ->> 'anyTargetFixed')::boolean then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['fixed_task_immutable']);
  end if;
  if (v_change ->> 'anyTouchedPackageFixed')::boolean then
    return jsonb_build_object('found', true, 'eligible', false, 'reasons', array['fixed_task_immutable']);
  end if;

  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_touched_package_ids
    from jsonb_array_elements_text(v_change -> 'touchedPackageIds') as x;

  if v_teacher_source_id is not null then
    if exists (
      select 1 from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id and fa.day_order = p_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      v_eligible := false; v_reasons := v_reasons || 'teacher_has_fixed_duty';
    end if;

    -- Çakışan paket: hedef teacher'ın o gün BAŞKA (dokunulan/bölünecek
    -- paketler DIŞINDA) bir paketi var mı — dokunulan paketler zaten
    -- çözülecek olduğu için "çakışma" SAYILMAZ.
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = p_day_order and p.teacher_source_id = v_teacher_source_id
        and not (p.id = any(v_touched_package_ids));
    if found then
      v_eligible := false; v_reasons := v_reasons || 'teacher_day_conflict';
      v_conflict_pkg_json := jsonb_build_object(
        'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
        'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
      );
    end if;

    if exists (
      select b.id from unnest(v_target_blocks) as b(id)
      where not exists (
        select 1 from public.teacher_duty_block_availabilities av
        join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
        where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id
          and av.duty_location_id = p_duty_location_id and av.duty_block_id = b.id and av.day_order = p_day_order
      )
    ) then
      v_eligible := false; v_reasons := v_reasons || 'no_preference_for_cell';
    end if;

    if exists (
      select 1 from unnest(v_target_blocks) as b(id)
      join public.teachers t on t.timetable_import_id = v_plan.timetable_import_id and t.source_id = v_teacher_source_id
      where not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t.id, p_day_order, b.id)
    ) then
      v_eligible := false; v_reasons := v_reasons || 'time_rule_violation';
    end if;

    -- Haftalık limit: dokunulan (zaten çözülecek) paketler HARİÇ tutularak
    -- sayılır — aksi halde öğretmenin KENDİ paketini büyütmesi/küçültmesi
    -- (ör. SINGLE_BLOCK → SHORT_BREAKS) yanlışlıkla weekly_limit_exceeded'a
    -- takılırdı.
    if (
      select count(*) from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and not (id = any(v_touched_package_ids))
    ) + 1 > coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3) then
      v_eligible := false; v_reasons := v_reasons || 'weekly_limit_exceeded';
    end if;
  end if;

  return jsonb_build_object(
    'found', true,
    'planStatus', v_plan.status,
    'planVersion', v_plan.version,
    'targetTaskIds', v_change -> 'targetTaskIds',
    'targetTasks', v_change -> 'targetTasks',
    'affectedTasks', v_change -> 'affectedTasks',
    'eligible', v_eligible,
    'reasons', to_jsonb(v_reasons),
    'conflictingPackage', v_conflict_pkg_json
  );
end;
$$;

comment on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) is
  'Manuel paket ön izlemesi. Uygunluk artık YER düzeyinde değil HEDEF BLOK düzeyinde belirlenir: hedeflenen blokların tamamı assignment_mode=normal olmalıdır (aksi halde cell_not_open_for_normal). Yalnız service_role çağırabilir.';

create or replace function public.set_duty_plan_manual_package(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_day_order integer,
  p_duty_location_id uuid,
  p_teacher_source_id text,
  p_coverage_mode text,
  p_expected_plan_version integer,
  p_expected_affected_task_ids uuid[] default null,
  p_duty_block_id uuid default null
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
  v_plan record;
  v_current_fp text;
  v_dl record;
  v_teacher_source_id text := nullif(btrim(p_teacher_source_id), '');
  v_teacher record;
  v_target_blocks uuid[];
  v_change jsonb;
  v_target_task_ids uuid[];
  v_target_task_count integer;
  v_any_target_fixed boolean;
  v_any_touched_fixed boolean;
  v_affected_task_ids uuid[];
  v_affected_tasks jsonb;
  v_touched_package_ids uuid[];
  v_conflict_pkg record;
  v_current_total integer;
  v_max integer;
  v_new_pkg_id uuid;
  v_new_summary jsonb;
  v_new_version integer;
begin
  if p_plan_id is null or p_day_order is null or p_duty_location_id is null
     or coalesce(btrim(p_coverage_mode), '') = '' or p_expected_plan_version is null then
    raise exception 'plan_id, day_order, duty_location_id, coverage_mode ve expected_plan_version zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;
  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', null); end if;

  select * into v_plan from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
    for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.status <> 'draft' then return jsonb_build_object('status', 'plan_not_draft'); end if;
  if v_plan.version <> p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fp is distinct from v_plan.source_fingerprint then
    return jsonb_build_object('status', 'source_changed', 'currentSourceFingerprint', v_current_fp);
  end if;

  select * into v_dl from public.duty_locations where id = p_duty_location_id and campus_id = v_campus_id;
  if not found then
    return jsonb_build_object('status', 'invalid_package_combination');
  end if;

  v_target_blocks := public.resolve_duty_plan_package_target_blocks(p_duty_location_id, p_coverage_mode, p_duty_block_id);
  if v_target_blocks is null then
    return jsonb_build_object('status', 'invalid_package_combination');
  end if;

  -- YENİ: reddetme YER düzeyinde değil, HEDEF BLOKLAR düzeyindedir. Bir yerin
  -- bazı blokları fixed_only, bazıları normal olabilir (İLKOKUL-1/2). Paket
  -- yalnız hedeflediği blokların TAMAMI 'normal' ise kurulabilir.
  if exists (
    select 1 from unnest(v_target_blocks) as tb(blk)
    where not public.is_duty_cell_open_for_normal(p_duty_location_id, tb.blk)
  ) then
    return jsonb_build_object('status', 'cell_not_open_for_normal');
  end if;

  -- YENİ (solver-v3 savunması): v3 planlarda normal paketler YALNIZ tek blok
  -- olabilir. Çok bloklu bir istek DB trigger'ına (ham exception) bırakılmaz;
  -- burada YAPILANDIRILMIŞ bir sonuçla reddedilir. Eski v1/v2 planlar bu
  -- kuraldan ETKİLENMEZ (tarihsel okunabilirlik korunur).
  if v_plan.algorithm_version like 'duty-plan-solver-v3%'
     and coalesce(array_length(v_target_blocks, 1), 0) > 1 then
    return jsonb_build_object('status', 'normal_package_must_be_single_block');
  end if;

  -- TEK KARAR MANTIĞI: preview_duty_plan_manual_package İLE AYNI fonksiyon.
  -- Yalnız GERÇEKTEN hedef hücrelerin (id bazlı) sahibi olan paketler
  -- "dokunulan" sayılır — başka gün/yer/öğretmenin, yalnız aynı blok TÜRÜNÜ
  -- paylaşan paketleri ASLA etkilenmez.
  v_change := public.compute_duty_plan_manual_package_change(p_plan_id, p_day_order, p_duty_location_id, v_target_blocks);
  v_target_task_count := (v_change ->> 'targetTaskCount')::int;
  v_any_target_fixed := (v_change ->> 'anyTargetFixed')::boolean;
  v_any_touched_fixed := (v_change ->> 'anyTouchedPackageFixed')::boolean;
  v_affected_tasks := v_change -> 'affectedTasks';
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_target_task_ids from jsonb_array_elements_text(v_change -> 'targetTaskIds') as x;
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_touched_package_ids from jsonb_array_elements_text(v_change -> 'touchedPackageIds') as x;
  select coalesce(array_agg((x)::uuid), array[]::uuid[]) into v_affected_task_ids from jsonb_array_elements_text(v_change -> 'affectedTaskIds') as x;

  if v_target_task_count is distinct from array_length(v_target_blocks, 1) then
    return jsonb_build_object('status', 'task_not_found');
  end if;
  if v_any_target_fixed or v_any_touched_fixed then
    return jsonb_build_object('status', 'fixed_task_immutable');
  end if;

  -- affectedTasks onayı — HENÜZ HİÇBİR SATIR YAZILMADI (aşağıdaki dissolve/
  -- insert/update adımlarının HİÇBİRİ bu noktadan önce ÇALIŞMAZ).
  if array_length(v_affected_task_ids, 1) > 0 then
    if p_expected_affected_task_ids is null
       or (select coalesce(array_agg(x order by x), array[]::uuid[]) from unnest(p_expected_affected_task_ids) x)
          is distinct from (select coalesce(array_agg(x order by x), array[]::uuid[]) from unnest(v_affected_task_ids) x)
    then
      return jsonb_build_object(
        'status', case when p_expected_affected_task_ids is null then 'requires_confirmation' else 'stale_affected_set' end,
        'affectedTasks', v_affected_tasks
      );
    end if;
  end if;

  -- ================================================================
  -- ATOMİKLİK: yeni öğretmenin TÜM kuralları (import/dahil/tercih/zaman/
  -- sabit-gün/günlük-tekillik/haftalık-limit) burada, HERHANGİ BİR
  -- UPDATE/DELETE'DEN ÖNCE tamamen doğrulanır. Bu blok reddederse (return),
  -- şu ana kadar TEK BİR SATIR bile değişmemiş olur — kısmi yazma YOKTUR.
  -- ================================================================
  if v_teacher_source_id is not null then
    select id, name into v_teacher from public.teachers
      where timetable_import_id = v_plan.timetable_import_id and source_id = v_teacher_source_id;
    if not found then return jsonb_build_object('status', 'teacher_not_in_import'); end if;

    if not exists (
      select 1 from public.teacher_duty_settings s
      where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id and s.is_included
    ) then
      return jsonb_build_object('status', 'teacher_not_included');
    end if;

    if exists (
      select 1 from public.fixed_duty_assignments fa
      where fa.academic_year_id = v_year_id and fa.day_order = p_day_order and fa.teacher_source_id = v_teacher_source_id
    ) then
      return jsonb_build_object('status', 'teacher_has_fixed_duty');
    end if;

    -- AYNI GÜN + AYNI BLOK'ta başka bir YERDE görev: yarım gün kuralı KAPALI
    -- olsa bile yasaktır. Dokunulan/çözülecek hücreler hariç tutulur.
    if exists (
      select 1 from public.duty_plan_assignments a2
      where a2.plan_id = p_plan_id and a2.day_order = p_day_order
        and a2.teacher_source_id = v_teacher_source_id
        and a2.duty_block_id = any(v_target_blocks)
        and not (a2.id in (select (jsonb_array_elements_text(v_change -> 'targetTaskIds'))::uuid))
        and (a2.package_id is null or not (a2.package_id = any(v_touched_package_ids)))
    ) then
      return jsonb_build_object('status', 'teacher_block_conflict');
    end if;

    -- Çakışan paket: hedef teacher'ın o gün BAŞKA (dokunulan/çözülecek
    -- paketler DIŞINDA) bir paketi var mı. YARIM GÜN kuralı KAPALI öğretmende
    -- farklı bloklardaki paketler ENGEL DEĞİLDİR (blok çakışması yukarıda
    -- ayrıca reddedildi).
    select p.* into v_conflict_pkg from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.day_order = p_day_order and p.teacher_source_id = v_teacher_source_id
        and not (p.id = any(v_touched_package_ids))
        and public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id);
    if found then
      return jsonb_build_object(
        'status', 'teacher_day_conflict',
        'conflictingPackage', jsonb_build_object(
          'id', v_conflict_pkg.id, 'coverageMode', v_conflict_pkg.coverage_mode,
          'dutyLocationId', v_conflict_pkg.duty_location_id, 'assignmentKind', v_conflict_pkg.assignment_kind
        )
      );
    end if;

    if exists (
      select b.id from unnest(v_target_blocks) as b(id)
      where not exists (
        select 1 from public.teacher_duty_block_availabilities av
        join public.teacher_duty_settings s on s.id = av.teacher_duty_setting_id
        where s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_source_id
          and av.duty_location_id = p_duty_location_id and av.duty_block_id = b.id and av.day_order = p_day_order
      )
    ) then
      return jsonb_build_object('status', 'no_preference_for_cell');
    end if;

    if exists (
      select 1 from unnest(v_target_blocks) as b(id)
      where not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, v_teacher.id, p_day_order, b.id)
    ) then
      return jsonb_build_object('status', 'time_rule_violation');
    end if;

    -- Haftalık limit: dokunulan (zaten çözülecek) paketler HARİÇ tutularak
    -- sayılır — öğretmenin KENDİ paketini büyütmesi/küçültmesi yanlışlıkla
    -- weekly_limit_exceeded'a takılmasın diye.
    select count(*) into v_current_total
      from public.duty_plan_assignment_packages
      where plan_id = p_plan_id and teacher_source_id = v_teacher_source_id
        and not (id = any(v_touched_package_ids));
    v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
    if v_current_total + 1 > v_max then
      return jsonb_build_object('status', 'weekly_limit_exceeded');
    end if;
  end if;

  -- ================================================================
  -- YAZMA — buraya kadar HİÇBİR satır değişmedi. TÜM doğrulamalar geçti.
  -- ================================================================
  if array_length(v_touched_package_ids, 1) > 0 then
    update public.duty_plan_assignments
      set teacher_source_id = null, teacher_name_snapshot = null, assignment_kind = 'unassigned',
          package_id = null, updated_at = timezone('utc', now())
      where package_id = any(v_touched_package_ids);
    delete from public.duty_plan_assignment_packages where id = any(v_touched_package_ids);
  end if;

  if v_teacher_source_id is not null then
    insert into public.duty_plan_assignment_packages (
      plan_id, campus_id, day_order, duty_location_id, teacher_source_id, teacher_name_snapshot,
      coverage_mode, assignment_kind
    ) values (
      p_plan_id, v_plan.campus_id, p_day_order, p_duty_location_id, v_teacher_source_id, v_teacher.name,
      p_coverage_mode, 'manual'
    ) returning id into v_new_pkg_id;

    update public.duty_plan_assignments
      set teacher_source_id = v_teacher_source_id, teacher_name_snapshot = v_teacher.name,
          assignment_kind = 'manual', package_id = v_new_pkg_id, updated_at = timezone('utc', now())
      where id = any(v_target_task_ids);
  end if;

  with teacher_universe as (
    select s.teacher_source_id from public.teacher_duty_settings s where s.academic_year_id = v_year_id and s.is_included
    union
    select fa.teacher_source_id from public.fixed_duty_assignments fa where fa.academic_year_id = v_year_id
  ),
  fixed_days as (
    select p.teacher_source_id, count(*) as fixed_days
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
      group by p.teacher_source_id
  ),
  normal_counts as (
    select p.teacher_source_id, count(*) as normal_count
      from public.duty_plan_assignment_packages p
      where p.plan_id = p_plan_id and p.assignment_kind in ('generated', 'manual')
      group by p.teacher_source_id
  ),
  loads as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'teacherSourceId', tu.teacher_source_id,
        'normalDutyCount', coalesce(nc.normal_count, 0),
        'fixedDutyDayCount', coalesce(fd.fixed_days, 0),
        'totalDutyCount', coalesce(nc.normal_count, 0) + coalesce(fd.fixed_days, 0)
      ) order by tu.teacher_source_id), '[]'::jsonb) as arr
      from teacher_universe tu
      left join normal_counts nc on nc.teacher_source_id = tu.teacher_source_id
      left join fixed_days fd on fd.teacher_source_id = tu.teacher_source_id
  )
  select coalesce(v_plan.summary, '{}'::jsonb)
      || jsonb_build_object(
           'teacherLoads', (select arr from loads),
           'uncoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'unassigned'),
           'normalCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind in ('generated', 'manual')),
           'fixedCoveredCount', (select count(*) from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'fixed')
         )
    into v_new_summary;

  update public.duty_plans
    set version = version + 1, summary = v_new_summary, updated_at = timezone('utc', now())
    where id = p_plan_id
    returning version into v_new_version;

  return jsonb_build_object(
    'status', 'ok',
    'version', v_new_version,
    'packageId', v_new_pkg_id,
    'summary', v_new_summary
  );
end;
$$;

comment on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) is
  'Manuel paket yazımı. Hedef blokların tamamı assignment_mode=normal olmalıdır (cell_not_open_for_normal). Sabit nöbet gününde normal paket reddedilir. Aynı gün+blok ikinci yer duty_plan_assignments_teacher_day_block_uq ile, yarım gün kuralı ise DEFERRED constraint trigger ile transaction sonunda ayrıca zorlanır. Atomiklik, fingerprint, expected version ve advisory/row lock korumaları DEĞİŞMEDİ. Yalnız service_role çağırabilir.';

create or replace function public.publish_duty_plan_draft(
  p_plan_id uuid,
  p_campus_name text,
  p_academic_year_name text,
  p_expected_plan_version integer
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
  v_plan record;
  v_current_fp text;
  v_uncovered integer;
  v_bad boolean;
  v_max integer;
  v_existing_published uuid;
  v_final record;
begin
  if p_plan_id is null then raise exception 'plan_id zorunludur.' using errcode = '22023'; end if;
  if p_expected_plan_version is null then raise exception 'expected_plan_version zorunludur.' using errcode = '22023'; end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', null); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', null); end if;

  select * into v_plan from public.duty_plans
    where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id
    for update;
  if not found then return jsonb_build_object('status', 'plan_not_found'); end if;
  if v_plan.status <> 'draft' then return jsonb_build_object('status', 'plan_not_draft'); end if;
  if v_plan.version <> p_expected_plan_version then
    return jsonb_build_object('status', 'version_conflict', 'currentVersion', v_plan.version);
  end if;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  if v_current_fp is distinct from v_plan.source_fingerprint then
    return jsonb_build_object('status', 'source_stale', 'currentSourceFingerprint', v_current_fp);
  end if;

  select count(*) into v_uncovered from public.duty_plan_assignments where plan_id = p_plan_id and assignment_kind = 'unassigned';
  if v_uncovered > 0 then
    return jsonb_build_object('status', 'open_tasks_remaining', 'uncoveredCount', v_uncovered);
  end if;

  -- Paket-hücre tutarlılığı: her generated/manual/fixed hücrenin package_id'si
  -- dolu olmalı (unassigned dışında hiç boş kalmamalı — DB CHECK zaten
  -- garanti eder, ama savunma amaçlı bağımsız kontrol).
  select exists (
    select 1 from public.duty_plan_assignments
    where plan_id = p_plan_id and assignment_kind <> 'unassigned' and package_id is null
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'package_task_mismatch'); end if;

  -- Her paketin kapsadığı block_code kümesi HÂLÂ kendi coverage_mode'una uyuyor
  -- mu (config drift'e karşı son savunma — normalde source_fingerprint bunu
  -- zaten yakalar).
  select exists (
    select 1 from (
      select p.id, p.coverage_mode, p.duty_location_id, p.assignment_kind,
             array_agg(b.code) as codes
        from public.duty_plan_assignment_packages p
        join public.duty_plan_assignments a on a.package_id = p.id
        join public.duty_blocks b on b.id = a.duty_block_id
        where p.plan_id = p_plan_id
        group by p.id, p.coverage_mode, p.duty_location_id, p.assignment_kind
    ) x
    where public.classify_duty_plan_package_coverage(x.duty_location_id, x.assignment_kind, x.codes) is distinct from x.coverage_mode
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'invalid_package_combination'); end if;

  -- Haftalık üst sınır — artık PAKET sayısı (satır değil).
  v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);
  select exists (
    select 1 from (
      select teacher_source_id, count(*) as total
        from public.duty_plan_assignment_packages
        where plan_id = p_plan_id
        group by teacher_source_id
    ) x where x.total > v_max
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'weekly_limit_exceeded'); end if;

  -- Normal görevlerin TAMAMI bağımsız NOT EXISTS/anti-join ile doğrulanır.
  select exists (
    select 1
      from public.duty_plan_assignments a
     where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
       and not (
         exists (
           select 1 from public.teachers t
            where t.timetable_import_id = v_plan.timetable_import_id and t.source_id = a.teacher_source_id
         )
         and exists (
           select 1 from public.teacher_duty_settings s
            where s.academic_year_id = v_year_id and s.teacher_source_id = a.teacher_source_id and s.is_included
         )
         and exists (
           select 1
             from public.teacher_duty_settings s2
             join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s2.id
            where s2.academic_year_id = v_year_id and s2.teacher_source_id = a.teacher_source_id
              and av.duty_location_id = a.duty_location_id and av.duty_block_id = a.duty_block_id and av.day_order = a.day_order
         )
         and exists (
           select 1 from public.teachers t2
            where t2.timetable_import_id = v_plan.timetable_import_id and t2.source_id = a.teacher_source_id
              and public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t2.id, a.day_order, a.duty_block_id)
         )
         and not exists (
           select 1 from public.fixed_duty_assignments fa
            where fa.academic_year_id = v_year_id and fa.day_order = a.day_order and fa.teacher_source_id = a.teacher_source_id
         )
         and exists (
           select 1 from public.duty_locations dl
            where dl.id = a.duty_location_id and dl.is_active and dl.deleted_at is null
         )
         and exists (
           select 1 from public.duty_location_blocks lb
            where lb.duty_location_id = a.duty_location_id and lb.duty_block_id = a.duty_block_id
              -- Normal görev YALNIZ assignment_mode='normal' hücrede olabilir.
              and lb.assignment_mode = 'normal'
         )
       )
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'candidate_invalid'); end if;

  -- YENİ: sabit görev YALNIZ fixed_only hücreyi karşılayabilir.
  select exists (
    select 1 from public.duty_plan_assignments a
      join public.duty_location_blocks lb
        on lb.duty_location_id = a.duty_location_id and lb.duty_block_id = a.duty_block_id
     where a.plan_id = p_plan_id and a.assignment_kind = 'fixed'
       and lb.assignment_mode <> 'fixed_only'
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'fixed_task_not_fixed_only_cell'); end if;

  -- YENİ: aynı öğretmen + gün + BLOK ikinci görev (aynı blokta iki farklı yer).
  select exists (
    select 1 from public.duty_plan_assignments a
     where a.plan_id = p_plan_id and a.teacher_source_id is not null
     group by a.day_order, a.teacher_source_id, a.duty_block_id
    having count(*) > 1
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'teacher_block_conflict'); end if;

  -- YENİ: sabit nöbet gününde normal görev yok.
  select exists (
    select 1 from public.duty_plan_assignments a
      join public.fixed_duty_assignments fa
        on fa.academic_year_id = v_year_id and fa.day_order = a.day_order and fa.teacher_source_id = a.teacher_source_id
     where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'teacher_has_fixed_duty'); end if;

  -- YENİ: yarım gün kuralı AÇIK öğretmende günde en fazla BİR normal blok;
  -- KAPALI öğretmende en fazla dört (farklı bloklar).
  select exists (
    select 1 from (
      select a.day_order, a.teacher_source_id, count(distinct a.duty_block_id) as block_count
        from public.duty_plan_assignments a
       where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
         and a.teacher_source_id is not null
       group by a.day_order, a.teacher_source_id
    ) g
    where g.block_count > case when public.teacher_half_day_rule_enabled(v_year_id, g.teacher_source_id) then 1 else 4 end
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'half_day_rule_violation'); end if;

  -- YENİ: yeni modelde (solver v3) normal paketlerin tamamı SINGLE_BLOCK olmalı.
  select exists (
    select 1 from public.duty_plan_assignment_packages p
     where p.plan_id = p_plan_id and p.assignment_kind in ('generated', 'manual')
       and v_plan.algorithm_version like 'duty-plan-solver-v3%'
       and p.coverage_mode <> 'SINGLE_BLOCK'
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'normal_package_must_be_single_block'); end if;

  select exists (
    select 1
      from (
        select d.day_order, dl.id as loc, b.id as blk
          from generate_series(1, 5) as d(day_order)
          cross join public.duty_locations dl
          join public.duty_location_blocks lb on lb.duty_location_id = dl.id
          join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
         where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null
      ) expected
      full outer join (
        select id, day_order, duty_location_id, duty_block_id
          from public.duty_plan_assignments
         where plan_id = p_plan_id
      ) a
        on a.day_order = expected.day_order
       and a.duty_location_id = expected.loc and a.duty_block_id = expected.blk
     where expected.day_order is null or a.id is null
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'task_set_mismatch'); end if;

  -- Fixed PAKETLER güncel fixed_duty_assignments ile gün×yer×öğretmen
  -- açısından BİREBİR eşleşmeli (iki yönlü anti-join, paket seviyesinde).
  select exists (
    select 1 from public.duty_plan_assignment_packages p
     where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
       and not exists (
         select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id and fa.day_order = p.day_order
            and fa.duty_location_id = p.duty_location_id and fa.teacher_source_id = p.teacher_source_id
       )
    union all
    select 1 from public.fixed_duty_assignments fa
     where fa.academic_year_id = v_year_id
       and not exists (
         select 1 from public.duty_plan_assignment_packages p
          where p.plan_id = p_plan_id and p.assignment_kind = 'fixed'
            and p.day_order = fa.day_order and p.duty_location_id = fa.duty_location_id and p.teacher_source_id = fa.teacher_source_id
       )
  ) into v_bad;
  if v_bad then return jsonb_build_object('status', 'rule_violation', 'reason', 'fixed_assignment_mismatch'); end if;

  select id into v_existing_published from public.duty_plans
    where campus_id = v_campus_id and academic_year_id = v_year_id and status = 'published';
  if v_existing_published is not null then
    update public.duty_plans set status = 'archived', updated_at = timezone('utc', now()) where id = v_existing_published;
  end if;

  update public.duty_plans
    set status = 'published', version = version + 1, updated_at = timezone('utc', now())
    where id = p_plan_id
    returning * into v_final;

  return jsonb_build_object(
    'status', 'ok',
    'planId', v_final.id,
    'version', v_final.version,
    'publishedAt', v_final.updated_at,
    'archivedPreviousPlanId', v_existing_published
  );
end;
$$;

comment on function public.publish_duty_plan_draft(uuid, text, text, integer) is
  'Taslağı yayımlar. YAYIM ANINDA yeniden doğrular: açık görev yok, fingerprint ve expected version güncel, görev kümesi tam, normal görevler YALNIZ assignment_mode=normal hücrelerde, sabit görevler YALNIZ fixed_only hücrelerde, aynı öğretmen+gün+blok tekrarı yok, sabit gününde normal görev yok, yarım gün kuralı açıkta günde tek normal blok (kapalıda en fazla dört), solver-v3 planlarında normal paketler yalnız SINGLE_BLOCK. Eski (v1/v2) yayımlanmış planlara bu kurallar GERİYE DÖNÜK uygulanmaz — okunabilir kalırlar. Yalnız service_role çağırabilir.';
create or replace function public.get_duty_plan_task_candidates(
  p_plan_id uuid,
  p_task_id uuid,
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
  v_plan record;
  v_row record;
  v_current_fp text;
  v_max integer;
  v_candidates jsonb;
  v_day_order integer;
  v_duty_location_id uuid;
  v_duty_block_id uuid;
  v_cell_open boolean;
begin
  if p_plan_id is null or p_task_id is null then
    raise exception 'plan_id ve task_id zorunludur.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then return jsonb_build_object('found', false); end if;

  select id into v_year_id from public.academic_years where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_plan from public.duty_plans where id = p_plan_id and campus_id = v_campus_id and academic_year_id = v_year_id;
  if not found then return jsonb_build_object('found', false); end if;

  select * into v_row from public.duty_plan_assignments where id = p_task_id and plan_id = p_plan_id;
  if not found then
    return jsonb_build_object('found', true, 'taskFound', false, 'planStatus', v_plan.status, 'planVersion', v_plan.version);
  end if;
  v_day_order := v_row.day_order;
  v_duty_location_id := v_row.duty_location_id;
  v_duty_block_id := v_row.duty_block_id;

  v_current_fp := public.compute_duty_plan_source_fingerprint(p_campus_name, p_academic_year_name);
  v_max := coalesce((v_plan.generation_options ->> 'maxWeeklyDuties')::int, 3);

  -- Hedef hücre normal atamaya AÇIK mı? Sabit görev hücresi VEYA
  -- assignment_mode <> 'normal' ise HİÇBİR öğretmen normal aday olamaz.
  v_cell_open := v_row.assignment_kind <> 'fixed'
             and public.is_duty_cell_open_for_normal(v_duty_location_id, v_duty_block_id);

  -- TEK KARAR MANTIĞI: gerekçeler bir kez hesaplanır, `eligible` yalnız
  -- "hiç gerekçe yok" demektir. Böylece uygunluk ile gerekçe listesi
  -- birbirinden AYRIŞAMAZ (eski gövdede iki ayrı kopya vardı).
  select coalesce(jsonb_agg(jsonb_build_object(
      'teacherSourceId', s.teacher_source_id,
      'teacherName', coalesce(t.name, s.teacher_name_snapshot),
      'isCurrent', s.teacher_source_id = v_row.teacher_source_id,
      'eligible', (r.reasons = '[]'::jsonb),
      'reasons', r.reasons
      ) order by coalesce(t.name, s.teacher_name_snapshot)), '[]'::jsonb)
    into v_candidates
    from public.teacher_duty_settings s
    join public.teachers t on t.timetable_import_id = v_plan.timetable_import_id and t.source_id = s.teacher_source_id
    cross join lateral (
      select coalesce(jsonb_agg(z), '[]'::jsonb) as reasons
        from (
          select unnest(array_remove(array[
            -- Hedef hücre normal atamaya kapalı (sabit görev veya fixed_only /
            -- eşlemesi olmayan hücre) — öğretmenden BAĞIMSIZ tek gerekçe.
            case when not v_cell_open then 'cell_not_open_for_normal' end,

            -- O gün sabit nöbeti var: yarım gün ayarından BAĞIMSIZ olarak
            -- hiçbir normal görev alamaz.
            case when exists (
              select 1 from public.fixed_duty_assignments fa
              where fa.academic_year_id = v_year_id and fa.day_order = v_day_order
                and fa.teacher_source_id = s.teacher_source_id
            ) then 'fixed_duty_day' end,

            -- AYNI GÜN AYNI BLOK'ta başka bir yerde görevli: yarım gün kuralı
            -- KAPALI olsa bile engeldir. Hücrenin KENDİ satırı hariç tutulur.
            case when exists (
              select 1 from public.duty_plan_assignments other
              where other.plan_id = p_plan_id and other.day_order = v_day_order
                and other.duty_block_id = v_duty_block_id
                and other.teacher_source_id = s.teacher_source_id
                and other.id <> v_row.id
            ) then 'already_assigned_same_block' end,

            -- Yarım gün kuralı AÇIK ve o gün BAŞKA bir normal görevi var.
            -- KAPALI öğretmende farklı bloktaki görev ENGEL DEĞİLDİR.
            case when public.teacher_half_day_rule_enabled(v_year_id, s.teacher_source_id)
                  and exists (
                    select 1 from public.duty_plan_assignments other
                    where other.plan_id = p_plan_id and other.day_order = v_day_order
                      and other.teacher_source_id = s.teacher_source_id
                      and other.assignment_kind in ('generated', 'manual')
                      and other.id <> v_row.id
                  ) then 'half_day_daily_limit' end,

            case when not exists (
              select 1 from public.teacher_duty_block_availabilities av
              where av.teacher_duty_setting_id = s.id and av.duty_location_id = v_duty_location_id
                and av.duty_block_id = v_duty_block_id and av.day_order = v_day_order
            ) then 'no_preference_for_cell' end,

            case when not public.is_teacher_eligible_for_duty_block_time(v_plan.timetable_import_id, t.id, v_day_order, v_duty_block_id)
              then 'time_rule_violation' end,

            -- Haftalık yük = DISTINCT sabit gün + normal PAKET sayısı.
            -- Hücrenin KENDİ paketi hariç tutulur (o zaten değişecek).
            case when (
              (
                select count(distinct fa.day_order)
                  from public.fixed_duty_assignments fa
                  where fa.academic_year_id = v_year_id and fa.teacher_source_id = s.teacher_source_id
              )
              + (
                select count(*)
                  from public.duty_plan_assignment_packages pk
                  where pk.plan_id = p_plan_id and pk.teacher_source_id = s.teacher_source_id
                    and pk.assignment_kind in ('generated', 'manual')
                    and pk.id is distinct from v_row.package_id
              )
              + 1
            ) > v_max then 'weekly_limit_reached' end
          ], null)) as z
        ) q
    ) r
    where s.academic_year_id = v_year_id and s.is_included;

  return jsonb_build_object(
    'found', true,
    'taskFound', true,
    'planStatus', v_plan.status,
    'planVersion', v_plan.version,
    'isFixed', v_row.assignment_kind = 'fixed',
    'currentAssignment', jsonb_build_object(
      'teacherSourceId', v_row.teacher_source_id,
      'teacherName', v_row.teacher_name_snapshot,
      'assignmentKind', v_row.assignment_kind
    ),
    'isStale', (v_current_fp is distinct from v_plan.source_fingerprint),
    'currentSourceFingerprint', v_current_fp,
    'candidates', v_candidates
  );
end;
$$;

comment on function public.get_duty_plan_task_candidates(uuid, uuid, text, text) is
  'Bir görev hücresi için manuel atama adayları. Uygunluk ve gerekçeler TEK yerden türetilir (eligible ⇔ gerekçe listesi boş). Gerekçeler DÜRÜSTÇE ayrışır: cell_not_open_for_normal (sabit görev veya assignment_mode<>normal), fixed_duty_day, already_assigned_same_block (aynı gün+blok başka yer — yarım gün kapalı olsa bile), half_day_daily_limit (yalnız yarım gün AÇIKken o gün başka normal görev), no_preference_for_cell, time_rule_violation, weekly_limit_reached (distinct sabit gün + normal paket sayısı; hücrenin kendi paketi hariç). Hücrenin KENDİ atama/paket kaydı kendisiyle çakışma sayılmaz. Yalnız service_role çağırabilir.';


-- ============================================================================
-- Yeni fonksiyonların YETKİLERİ
-- ============================================================================
-- Bu migration ile EKLENEN üç fonksiyon, mevcut RPC'lerle AYNI güvenlik
-- profiline sahiptir: SECURITY INVOKER, sabit search_path, PUBLIC/anon/
-- authenticated için EXECUTE YOK, yalnız service_role çağırabilir.
-- (Yerel vanilla PostgreSQL'de anon/authenticated/service_role rolleri
-- bulunmayabilir — bu yüzden varlık kontrolüyle idempotent uygulanır.)

revoke all on function public.is_duty_cell_open_for_normal(uuid, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.is_duty_cell_open_for_normal(uuid, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.is_duty_cell_open_for_normal(uuid, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.is_duty_cell_open_for_normal(uuid, uuid) to service_role;
  end if;
end
$$;

revoke all on function public.teacher_half_day_rule_enabled(uuid, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.teacher_half_day_rule_enabled(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.teacher_half_day_rule_enabled(uuid, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.teacher_half_day_rule_enabled(uuid, text) to service_role;
  end if;
end
$$;

revoke all on function public.save_teacher_duty_matrix_v2(text, text, uuid, boolean, boolean, jsonb, timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.save_teacher_duty_matrix_v2(text, text, uuid, boolean, boolean, jsonb, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.save_teacher_duty_matrix_v2(text, text, uuid, boolean, boolean, jsonb, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.save_teacher_duty_matrix_v2(text, text, uuid, boolean, boolean, jsonb, timestamptz) to service_role;
  end if;
end
$$;

revoke all on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.preview_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, uuid) to service_role;
  end if;
end
$$;

revoke all on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.set_duty_plan_manual_package(uuid, text, text, integer, uuid, text, text, integer, uuid[], uuid) to service_role;
  end if;
end
$$;

revoke all on function public.classify_duty_plan_package_coverage(uuid, text, text[]) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.classify_duty_plan_package_coverage(uuid, text, text[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.classify_duty_plan_package_coverage(uuid, text, text[]) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.classify_duty_plan_package_coverage(uuid, text, text[]) to service_role;
  end if;
end
$$;

revoke all on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.resolve_duty_plan_package_target_blocks(uuid, text, uuid) to service_role;
  end if;
end
$$;

revoke all on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.compute_duty_plan_manual_package_change(uuid, integer, uuid, uuid[]) to service_role;
  end if;
end
$$;

revoke all on function public.get_teacher_lesson_period_counts(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_teacher_lesson_period_counts(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_teacher_lesson_period_counts(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_teacher_lesson_period_counts(uuid) to service_role;
  end if;
end
$$;