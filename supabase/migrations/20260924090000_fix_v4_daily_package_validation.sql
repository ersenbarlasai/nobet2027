-- ============================================================================
-- Nöbet2027 — v4 günlük görev doğrulamasını hücreden pakete düzelt
-- ============================================================================
-- v4 modelinde Sabah + Öğleden Sonra iki hücre, tek TENEFFÜS paketidir.
-- 20260921090000 içindeki save RPC'sinin tarihsel R4 kontrolü blok saydığı
-- için geçerli bir TENEFFÜS paketini "iki görev" sanıyordu. Aynı tarihsel
-- varsayım publish ve bazı manuel-atama yollarında da bulunuyordu.
--
-- Bu ileri migration eski dosyaları değiştirmez. Uygulanmış fonksiyonların
-- yalnız hedeflenen karar parçalarını kontrollü olarak değiştirir; beklenen
-- kaynak parça bulunamazsa sessizce devam etmek yerine migration'ı durdurur.
-- ============================================================================

do $migration$
declare
  v_def text;
  v_next text;
begin
  -- --------------------------------------------------------------------------
  -- save_duty_plan_draft: v4 için günlük birim hücre/blok değil pakettir.
  -- Sabah+ÖS aynı yer = 1; Öğle-1 = 1; Öğle-2 = 1.
  -- --------------------------------------------------------------------------
  v_def := pg_get_functiondef(to_regprocedure(
    'public.save_duty_plan_draft(text,text,text,text,integer,jsonb,jsonb,jsonb,boolean,uuid,integer)'
  ));
  if v_def is null then
    raise exception 'save_duty_plan_draft fonksiyonu bulunamadı';
  end if;

  v_next := replace(v_def, $old_save_rule$
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
$old_save_rule$, $new_save_rule$
  select exists (
    select 1 from (
      select x.day_order, nullif(btrim(x.teacher_source_id), '') as teacher_source_id,
             count(distinct case
               when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then
                 x.duty_location_id::text || ':' ||
                 case when b.code in ('MORNING_BREAKS', 'AFTERNOON_BREAKS')
                   then 'SHORT_BREAKS' else b.code end
               else x.duty_block_id::text
             end) as duty_unit_count
        from jsonb_to_recordset(p_assignments)
          as x(day_order int, duty_location_id uuid, duty_block_id uuid, teacher_source_id text, assignment_kind text)
        join public.duty_blocks b on b.id = x.duty_block_id
       where x.assignment_kind in ('generated', 'manual') and nullif(btrim(x.teacher_source_id), '') is not null
       group by x.day_order, nullif(btrim(x.teacher_source_id), '')
    ) g
    where g.duty_unit_count > case
      when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then 1
      when public.teacher_half_day_rule_enabled(v_year_id, g.teacher_source_id) then 1
      else 4
    end
  ) into v_bad;
  if v_bad then
    return jsonb_build_object(
      'status', 'teacher_day_conflict',
      'reason', case
        when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then 'daily_package_limit'
        else 'half_day_rule'
      end
    );
  end if;
$new_save_rule$);
  if v_next = v_def then
    raise exception 'save_duty_plan_draft günlük kural parçası beklenen sürümde değil';
  end if;
  v_def := v_next;

  v_next := replace(v_def, $old_save_limits$
  if v_min < 0 or v_min > 5 or v_target < 0 or v_target > 5 or v_max < 0 or v_max > 5
     or not (v_min <= v_target and v_target <= v_max) then
$old_save_limits$, $new_save_limits$
  if v_min < 0
     or v_min > (case when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then 3 else 5 end)
     or v_target < 0
     or v_target > (case when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then 3 else 5 end)
     or v_max < 0
     or v_max > (case when p_algorithm_version like 'duty-plan-solver-v4-three-packages%' then 3 else 5 end)
     or not (v_min <= v_target and v_target <= v_max) then
$new_save_limits$);
  if v_next = v_def then
    raise exception 'save_duty_plan_draft haftalık sınır parçası beklenen sürümde değil';
  end if;
  execute v_next;

  -- --------------------------------------------------------------------------
  -- Tek-hücre manuel atama: v4'te toggle'dan bağımsız tek paket/gün.
  -- --------------------------------------------------------------------------
  v_def := pg_get_functiondef(to_regprocedure(
    'public.update_duty_plan_assignment(uuid,uuid,text,text,text,integer)'
  ));
  if v_def is null then raise exception 'update_duty_plan_assignment fonksiyonu bulunamadı'; end if;
  v_next := replace(v_def,
    $old_update$        and public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id)
      limit 1;$old_update$,
    $new_update$        and (
          v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%'
          or public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id)
        )
      limit 1;$new_update$
  );
  if v_next = v_def then
    raise exception 'update_duty_plan_assignment günlük kural parçası beklenen sürümde değil';
  end if;
  execute v_next;

  -- --------------------------------------------------------------------------
  -- Manuel paket atama: v4'te toggle'dan bağımsız tek paket/gün.
  -- --------------------------------------------------------------------------
  v_def := pg_get_functiondef(to_regprocedure(
    'public.set_duty_plan_manual_package(uuid,text,text,integer,uuid,text,text,integer,uuid[],uuid)'
  ));
  if v_def is null then raise exception 'set_duty_plan_manual_package fonksiyonu bulunamadı'; end if;
  v_next := replace(v_def,
    $old_set$        and public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id);$old_set$,
    $new_set$        and (
          v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%'
          or public.teacher_half_day_rule_enabled(v_year_id, v_teacher_source_id)
        );$new_set$
  );
  if v_next = v_def then
    raise exception 'set_duty_plan_manual_package günlük kural parçası beklenen sürümde değil';
  end if;
  execute v_next;

  -- --------------------------------------------------------------------------
  -- Publish: v4'te aynı package_id'ye bağlı iki TENEFFÜS hücresi tek birim.
  -- --------------------------------------------------------------------------
  v_def := pg_get_functiondef(to_regprocedure(
    'public.publish_duty_plan_draft(uuid,text,text,integer)'
  ));
  if v_def is null then raise exception 'publish_duty_plan_draft fonksiyonu bulunamadı'; end if;
  v_next := replace(v_def, $old_publish$
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
$old_publish$, $new_publish$
  select exists (
    select 1 from (
      select a.day_order, a.teacher_source_id,
             count(distinct case
               when v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%'
                 then a.package_id::text
               else a.duty_block_id::text
             end) as duty_unit_count
        from public.duty_plan_assignments a
       where a.plan_id = p_plan_id and a.assignment_kind in ('generated', 'manual')
         and a.teacher_source_id is not null
       group by a.day_order, a.teacher_source_id
    ) g
    where g.duty_unit_count > case
      when v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%' then 1
      when public.teacher_half_day_rule_enabled(v_year_id, g.teacher_source_id) then 1
      else 4
    end
  ) into v_bad;
  if v_bad then
    return jsonb_build_object(
      'status', 'rule_violation',
      'reason', case
        when v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%' then 'daily_package_limit_violation'
        else 'half_day_rule_violation'
      end
    );
  end if;
$new_publish$);
  if v_next = v_def then
    raise exception 'publish_duty_plan_draft günlük kural parçası beklenen sürümde değil';
  end if;
  execute v_next;

  -- --------------------------------------------------------------------------
  -- Aday listesi: TENEFFÜS paketinin diğer hücresi "ikinci görev" değildir.
  -- v4'te yalnız farklı package_id engeldir.
  -- --------------------------------------------------------------------------
  v_def := pg_get_functiondef(to_regprocedure(
    'public.get_duty_plan_task_candidates(uuid,uuid,text,text)'
  ));
  if v_def is null then raise exception 'get_duty_plan_task_candidates fonksiyonu bulunamadı'; end if;
  v_next := replace(v_def, $old_candidates$
            case when public.teacher_half_day_rule_enabled(v_year_id, s.teacher_source_id)
                  and exists (
                    select 1 from public.duty_plan_assignments other
                    where other.plan_id = p_plan_id and other.day_order = v_day_order
                      and other.teacher_source_id = s.teacher_source_id
                      and other.assignment_kind in ('generated', 'manual')
                      and other.id <> v_row.id
                  ) then 'half_day_daily_limit' end,
$old_candidates$, $new_candidates$
            case when (
                    v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%'
                    or public.teacher_half_day_rule_enabled(v_year_id, s.teacher_source_id)
                  )
                  and exists (
                    select 1 from public.duty_plan_assignments other
                    where other.plan_id = p_plan_id and other.day_order = v_day_order
                      and other.teacher_source_id = s.teacher_source_id
                      and other.assignment_kind in ('generated', 'manual')
                      and other.id <> v_row.id
                      and (
                        v_plan.algorithm_version not like 'duty-plan-solver-v4-three-packages%'
                        or other.package_id is distinct from v_row.package_id
                      )
                  ) then case
                    when v_plan.algorithm_version like 'duty-plan-solver-v4-three-packages%'
                      then 'daily_package_limit'
                    else 'half_day_daily_limit'
                  end end,
$new_candidates$);
  if v_next = v_def then
    raise exception 'get_duty_plan_task_candidates günlük kural parçası beklenen sürümde değil';
  end if;
  execute v_next;
end
$migration$;

comment on function public.save_duty_plan_draft(text,text,text,text,integer,jsonb,jsonb,jsonb,boolean,uuid,integer) is
  'Atomik taslak kaydı. v4 üçlü paket modelinde günlük limit hücre/blok değil görev paketi üzerinden hesaplanır: TENEFFÜS (Sabah+Öğleden Sonra), ÖĞLE_1 veya ÖĞLE_2. v4 haftalık sert tavanı 3''tür. Tarihsel v1/v2/v3 davranışları korunur.';

comment on function public.publish_duty_plan_draft(uuid,text,text,integer) is
  'Taslağı atomik yayımlar. v4 günlük tek-paket kuralını package_id üzerinden doğrular; aynı TENEFFÜS paketinin Sabah+Öğleden Sonra hücreleri tek görev sayılır. Tarihsel plan davranışları korunur.';
