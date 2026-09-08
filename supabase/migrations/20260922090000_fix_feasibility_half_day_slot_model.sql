-- ============================================================================
-- 20260922090000 — analyze_duty_plan_feasibility: yarım gün kuralına duyarlı
--                  KAPASİTE SLOTU modeli
-- ============================================================================
-- SORUN
--   20260920090000'deki maksimum eşleştirme, sağ tarafta ÖĞRETMEN başına TEK
--   düğüm kullanıyordu. Bu, half_day_rule_enabled = false olan öğretmenleri de
--   günde tek normal blokla sınırlandırıyor ve kapasiteyi OLDUĞUNDAN DÜŞÜK
--   gösteriyordu: gerçekte üretilebilir bir plan "karşılanamıyor" diye
--   raporlanabiliyordu.
--
-- ÇÖZÜM
--   Eşleştirmenin sağ tarafı artık ÖĞRETMEN değil KAPASİTE SLOTUDUR:
--     half_day_rule_enabled = true  → öğretmene günde TEK ortak slot
--     half_day_rule_enabled = false → öğretmen × duty_block_id başına bir slot
--   Böylece:
--     * kuralı AÇIK öğretmen aynı gün en fazla BİR normal blok alır,
--     * kuralı KAPALI öğretmen aynı gün FARKLI bloklarda görev alabilir,
--     * kuralı KAPALI öğretmen AYNI blokta iki yere atanamaz (tek blok slotu),
--     * o gün sabit nöbeti olan öğretmen — toggle değerinden BAĞIMSIZ olarak —
--       aday havuzuna hiç girmediği için HİÇ slot almaz.
--   Bu, 20260919090000'deki DB kuralıyla (açıkken günde en fazla 1, kapalıyken
--   en fazla 4 normal görev) BİREBİR tutarlıdır.
--
-- KORUNANLAR
--   * candidateTeacherCount ve görev başına aday sayısı ÖĞRETMEN sayısıdır;
--     slot sayısına dönüşmez (ayrı, öğretmen düzeyinde sayımla hesaplanır).
--   * Ders çakışması (target_period_busy / no_adjacent_period_free) ve
--     yapılandırma hatası (period_configuration_missing) sayaçlarının anlamı
--     ve ayrılığı aynen korunur.
--   * Görev evreni yine AUTHORITATIVE duty_location_blocks.assignment_mode
--     üzerinden kurulur; fixed_only görevler normal aday kenarı üretmez.
--   * security invoker, sabit search_path ve yalnız service_role EXECUTE
--     düzeni korunur.
--
-- İLERİ YÖNLÜ: hiçbir önceki migration dosyası değiştirilmemiştir.
-- Yardımcı public.duty_feasibility_augment DEĞİŞMEDİ — saf bir Kuhn artırıcı
-- yol adımıdır ve sağ taraf düğümlerinin ne anlama geldiğini bilmez; burada
-- aynı fonksiyona öğretmen yerine SLOT indeksleri verilir.
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
  -- Öğretmen başına yarım gün kuralı bayrağı; v_teacher_src ile AYNI sırada.
  v_teacher_half boolean[];

  -- KAPASİTE SLOTLARI (eşleştirmenin sağ tarafı). Öğretmen DEĞİL slot eşleşir:
  --   half_day_rule_enabled = true  → öğretmene günde TEK ortak slot
  --   half_day_rule_enabled = false → öğretmen × BLOK başına bir slot
  -- v_slot_block NULL ise slot ortak (kurallı) slottur ve her bloğa uyar.
  v_slot_teacher integer[];
  v_slot_block uuid[];
  v_slot_count integer;

  v_adj boolean[];
  v_match_slot integer[];
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
    select coalesce(array_agg(x.source_id order by x.name, x.source_id), '{}'::text[]),
           coalesce(array_agg(x.half_day order by x.name, x.source_id), '{}'::boolean[])
      into v_teacher_src, v_teacher_half
      from (
        -- half_day, (academic_year_id, teacher_source_id) tekil olduğu için
        -- source_id'ye FONKSİYONEL BAĞLIDIR; distinct satır sayısını artırmaz.
        select distinct s.teacher_source_id as source_id, t.name,
               s.half_day_rule_enabled as half_day
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

    -- ADAY SAYAÇLARI (v_t_cand) SLOTTAN BAĞIMSIZDIR: görev başına kaç FARKLI
    -- ÖĞRETMEN aday, o kadar sayılır. Slot modeline geçiş bu sayaçları
    -- ŞİŞİRMEMELİDİR; bu yüzden ayrı, öğretmen düzeyinde bir döngüyle
    -- hesaplanır.
    if v_norm_count > 0 and v_teacher_count > 0 then
      for v_edge in
        select nt.n_idx, count(distinct tc.src)::integer as cand_count
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
          group by nt.n_idx
      loop
        v_t_cand[v_norm_task_idx[v_edge.n_idx]] := v_edge.cand_count;
      end loop;
    end if;

    -- SLOT ÜRETİMİ. Kural AÇIK öğretmen günde en fazla BİR normal blok
    -- alabildiği için tek ortak slot alır. Kural KAPALI öğretmen aynı gün
    -- FARKLI bloklarda görev alabilir, ama AYNI blokta iki yere atanamaz —
    -- bu yüzden blok başına bir slot alır. O gün sabit nöbeti olan öğretmen
    -- zaten v_teacher_src'ye girmez, dolayısıyla HİÇ slotu olmaz.
    v_slot_teacher := '{}'::integer[];
    v_slot_block := '{}'::uuid[];
    v_slot_count := 0;

    if v_teacher_count > 0 then
      select coalesce(array_agg(sl.t_idx order by sl.t_idx, sl.blk_order), '{}'::integer[]),
             coalesce(array_agg(sl.blk order by sl.t_idx, sl.blk_order), '{}'::uuid[])
        into v_slot_teacher, v_slot_block
        from (
          select tt.idx::integer as t_idx, null::uuid as blk, 0 as blk_order
            from unnest(v_teacher_half) with ordinality as tt(is_half, idx)
           where tt.is_half
          union all
          select tt.idx::integer, b2.id, b2.block_order
            from unnest(v_teacher_half) with ordinality as tt(is_half, idx)
            cross join public.duty_blocks b2
           where not tt.is_half and b2.is_active
        ) sl;
      v_slot_count := coalesce(array_length(v_slot_teacher, 1), 0);
    end if;

    if v_norm_count > 0 and v_slot_count > 0 then
      v_adj := array_fill(false, array[v_norm_count * v_slot_count]);

      -- Kenarlar: uygunluk satırı VAR, ortak zaman uygunluk kuralı
      -- (evaluate_teacher_duty_block_time) SAĞLANIYOR ve slot bu bloğa uyuyor
      -- (ortak slot her bloğa uyar; blok slotu yalnız kendi bloğuna).
      -- t2, teacher_source_id'yi GÜNCEL importtaki teachers.id'ye çözer.
      for v_edge in
        select nt.n_idx, sl.idx::integer as c_idx
          from unnest(v_norm_task_idx) with ordinality as nt(task_idx, n_idx)
          cross join unnest(v_slot_teacher, v_slot_block) with ordinality as sl(t_idx, blk, idx)
          join public.teachers t2
            on t2.timetable_import_id = v_import.id and t2.source_id = v_teacher_src[sl.t_idx]
          join public.teacher_duty_settings s
            on s.academic_year_id = v_year_id and s.teacher_source_id = v_teacher_src[sl.t_idx]
          join public.teacher_duty_block_availabilities av
            on av.teacher_duty_setting_id = s.id
           and av.duty_location_id = v_t_loc[nt.task_idx]
           and av.duty_block_id = v_t_block[nt.task_idx]
           and av.day_order = v_day.day_order
          where (sl.blk is null or sl.blk = v_t_block[nt.task_idx])
            and public.is_teacher_eligible_for_duty_block_time(v_import.id, t2.id, v_day.day_order, v_t_block[nt.task_idx])
      loop
        v_adj[(v_edge.n_idx - 1) * v_slot_count + v_edge.c_idx] := true;
      end loop;

      v_match_slot := array_fill(0, array[v_slot_count]);
      for v_i in 1..v_norm_count loop
        v_visited := array_fill(false, array[v_slot_count]);
        select a.p_match_teacher, a.p_visited, a.o_found
          into v_match_slot, v_visited, v_found
          from public.duty_feasibility_augment(
                 v_i, v_norm_count, v_slot_count, v_adj, v_match_slot, v_visited
               ) a;
        if v_found then
          v_matched_count := v_matched_count + 1;
        end if;
      end loop;

      for v_j in 1..v_slot_count loop
        if v_match_slot[v_j] <> 0 then
          v_t_covered[v_norm_task_idx[v_match_slot[v_j]]] := true;
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
  'Nöbet planı yapılabilirlik analizi. Görev evreni ve aday kenarları AUTHORITATIVE duty_location_blocks.assignment_mode üzerinden kurulur: fixed_only görevler yalnız sabit atamayla karşılanır ve NORMAL aday kenarı üretmez. Günlük eşleştirmenin sağ tarafı KAPASİTE SLOTUDUR: half_day_rule_enabled açık öğretmen günde tek ortak slot, kapalı öğretmen blok başına bir slot alır; o gün sabit nöbeti olan öğretmen hiç slot almaz. candidateTeacherCount ÖĞRETMEN sayısıdır, slot sayısı DEĞİLDİR. Yapılandırma hatası (period_configuration_missing) sayaçları ders/zaman çakışması sayaçlarından AYRI tutulur. Analiz HAFTALIK min/hedef/max yük sınırlarını uygulamaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkiler — 20260910092000'deki düzenin AYNISI, create or replace sonrasında
-- yeniden uygulanır (replace varsayılan PUBLIC EXECUTE'u geri getirebilir).
-- ============================================================================
revoke all on function public.analyze_duty_plan_feasibility(text, text) from public;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.analyze_duty_plan_feasibility(text, text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    revoke all on function public.analyze_duty_plan_feasibility(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant execute on function public.analyze_duty_plan_feasibility(text, text) to service_role;
  end if;
end
$grants$;
