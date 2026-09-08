-- ============================================================================
-- Nöbet2027 — Planlanabilirlik Analizi (salt okunur)
-- ============================================================================
-- Bu migration BİR NÖBET PLANI ÜRETMEZ ve hiçbir atama YAZMAZ. Yalnızca
-- "mevcut nöbet yerleri, blok gereksinimleri, sabit nöbetler ve öğretmen
-- uygunlukları ile bir plan ÜRETİLEBİLİR Mİ?" sorusunu cevaplar.
--
-- Eklenen iki fonksiyon da salt okunurdur (STABLE / IMMUTABLE); hiçbir tabloya
-- INSERT/UPDATE/DELETE yapmaz.
--
-- ----------------------------------------------------------------------------
-- NEDEN BASİT SAYI KARŞILAŞTIRMASI YETMEZ
-- ----------------------------------------------------------------------------
-- "Bu blokta 4 görev var, 9 aday öğretmen var → sorun yok" çıkarımı YANLIŞTIR,
-- çünkü bir öğretmen aynı gün YALNIZ BİR normal nöbet bloğu alabilir. Aynı 9
-- öğretmen dört bloğun hepsinde aday görünüyor olabilir; gerçekte gün boyunca
-- toplam en fazla 9 görev karşılanabilir. Dahası, adaylar belirli nöbet
-- yerlerine bağlı olduğundan toplam sayı bile yanıltıcıdır: 10 aday ve 10
-- görev varken bile, adayların 9'u aynı tek nöbet yerine bağlıysa plan
-- ÜRETİLEMEZ.
--
-- Bu yüzden analiz, her gün için gerçek bir iki-parçalı (bipartite) MAKSİMUM
-- EŞLEŞTİRME hesaplar:
--   sol taraf  : o gün aday olan öğretmenler (her biri kapasite 1)
--   sağ taraf  : o günün normal (sabit olmayan) görevleri — her (yer, blok)
--                çifti tam olarak 1 öğretmen ister
--   kenar      : öğretmenin o (yer, gün, blok) için uygunluk satırı VARSA ve
--                ders çakışması YOKSA
-- Kullanılan algoritma Kuhn'un artırıcı yol (augmenting path) yöntemidir;
-- bulduğu eşleştirme boyutu MATEMATİKSEL OLARAK maksimumdur (König/Hall).
--
-- DETERMİNİZM: görevler (blok sırası, nöbet yeri sort_order, ad) ve
-- öğretmenler (ad, source_id) SABİT bir sırayla numaralandırılır. Maksimum
-- eşleştirmenin BOYUTU zaten sıradan bağımsızdır; sabit sıralama ayrıca HANGİ
-- görevlerin açıkta kaldığının da çağrılar arasında değişmemesini sağlar —
-- yani rapor tekrarlanabilirdir.
--
-- ----------------------------------------------------------------------------
-- SABİT NÖBET YERLERİ AYRI DEĞERLENDİRİLİR
-- ----------------------------------------------------------------------------
-- allows_fixed_assignment = true olan yerler (ILKOKUL1, ILKOKUL2) YALNIZ sabit
-- atama ile karşılanır; normal eşleştirme havuzuna hiç girmezler. O gün sabit
-- atama yoksa görev "eksik sabit atama" olarak raporlanır — sıradan bir
-- öğretmenle doldurulabilirmiş gibi gösterilmez. Bu, okulun kuralının birebir
-- karşılığıdır: bu koridorlarda görevli kişi o günün sabit öğretmenidir.
--
-- Sabit öğretmen O GÜN başka hiçbir göreve aday olamaz (sabah/öğleden sonra
-- kendi koridorunda, Uzun Nöbet 1'de korumalı dinlenmede, Uzun Nöbet 2'de
-- derste) — bu yüzden aday havuzundan tamamen çıkarılır.
--
-- OGLEARASIILKOKUL yalnız LONG_BREAK_1'de görev ister ve sabit nöbete uygun
-- DEĞİLDİR: tek öğretmenle her iki ilkokul koridorunu gözettiği için normal
-- eşleştirme havuzunda sıradan bir görev olarak yer alır.
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ============================================================================
-- 1. duty_feasibility_augment — Kuhn artırıcı yol adımı
-- ============================================================================
-- Saf (tablo okumayan) yardımcı fonksiyon: verilen bir görev için artırıcı yol
-- arar. IMMUTABLE'dır çünkü yalnızca argümanlarına bağlıdır.
--
-- Dizi düzeni:
--   p_adj        : uzunluk p_task_count * p_teacher_count. (görev i, öğretmen j)
--                  kenarı p_adj[(i-1) * p_teacher_count + j] konumundadır.
--   p_match_teacher : öğretmen j'nin atandığı görev indeksi; 0 = boşta.
--   p_visited    : bu artırıcı yol aramasında öğretmen j'ye bakıldı mı.
--
-- Özyineleme derinliği en fazla görev sayısı kadardır (pratikte < 50), bu
-- yüzden varsayılan max_stack_depth için güvenlidir.
create or replace function public.duty_feasibility_augment(
  p_task integer,
  p_task_count integer,
  p_teacher_count integer,
  p_adj boolean[],
  inout p_match_teacher integer[],
  inout p_visited boolean[],
  out o_found boolean
)
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_teacher integer;
  v_prev_task integer;
begin
  o_found := false;

  for v_teacher in 1..p_teacher_count loop
    if p_adj[(p_task - 1) * p_teacher_count + v_teacher] and not p_visited[v_teacher] then
      p_visited[v_teacher] := true;
      v_prev_task := p_match_teacher[v_teacher];

      if v_prev_task = 0 then
        -- Öğretmen boştaydı: doğrudan bu göreve atanır.
        p_match_teacher[v_teacher] := p_task;
        o_found := true;
        return;
      end if;

      -- Öğretmen doluydu: onun mevcut görevi başka bir öğretmene
      -- devredilebiliyorsa bu öğretmen serbest kalır (artırıcı yol).
      select a.p_match_teacher, a.p_visited, a.o_found
        into p_match_teacher, p_visited, o_found
        from public.duty_feasibility_augment(
               v_prev_task, p_task_count, p_teacher_count, p_adj, p_match_teacher, p_visited
             ) a;

      if o_found then
        p_match_teacher[v_teacher] := p_task;
        return;
      end if;
    end if;
  end loop;
end;
$$;

comment on function public.duty_feasibility_augment(integer, integer, integer, boolean[], integer[], boolean[]) is
  'Saf yardımcı: Kuhn maksimum eşleştirme algoritmasının artırıcı yol adımı. Tablo okumaz, hiçbir şey yazmaz. Yalnız analyze_duty_plan_feasibility tarafından kullanılır.';

-- ============================================================================
-- 2. analyze_duty_plan_feasibility — salt okunur analiz
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

  -- Günün TÜM görevleri (sabit-yer görevleri dahil), sabit sırada.
  v_t_loc uuid[];
  v_t_block uuid[];
  v_t_fixed boolean[];      -- görev sabit nöbete uygun bir yere mi ait
  v_t_covered boolean[];    -- karşılandı mı (sabit atama ya da eşleştirme)
  v_t_cand integer[];       -- normal görevler için aday öğretmen sayısı
  v_task_count integer;

  -- Normal (eşleştirmeye giren) görevlerin, tüm görev dizisindeki indeksleri.
  v_norm_task_idx integer[];
  v_norm_count integer;

  -- Günün aday öğretmenleri.
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

  -- ==========================================================================
  -- Gün döngüsü
  -- ==========================================================================
  for v_day in
    select d.day_order, d.name
      from public.timetable_days d
      where d.timetable_import_id = v_import.id and d.day_order between 1 and 5
      order by d.day_order
  loop
    -- ------------------------------------------------------------------
    -- (a) Günün görev listesi: her (aktif yer × o yerin tanımlı bloğu) = 1 kişi
    -- ------------------------------------------------------------------
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

    -- ------------------------------------------------------------------
    -- (b) Sabit nöbete uygun yerlerin görevleri: yalnız sabit atama karşılar
    -- ------------------------------------------------------------------
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

    -- Normal görevlerin indeksleri (sabit sırayı korur).
    select coalesce(array_agg(x.idx order by x.idx), '{}'::integer[])
      into v_norm_task_idx
      from unnest(v_t_fixed) with ordinality as x(is_fixed, idx)
      where v_task_count > 0 and not x.is_fixed;
    v_norm_count := coalesce(array_length(v_norm_task_idx, 1), 0);

    -- ------------------------------------------------------------------
    -- (c) Günün aday öğretmenleri
    -- ------------------------------------------------------------------
    -- Koşullar: nöbet planına dahil (is_included), GÜNCEL importta bir
    -- teachers satırına karşılık geliyor (aksi halde artık okulda değil ya da
    -- source_id değişmiş — plan yapılamaz), o gün sabit nöbeti YOK ve o gün
    -- için en az bir blok uygunluğu var.
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
              where av.teacher_duty_setting_id = s.id and av.day_order = v_day.day_order
            )
      ) x;
    v_teacher_count := coalesce(array_length(v_teacher_src, 1), 0);

    -- ------------------------------------------------------------------
    -- (d) Kenarlar (uygunluk + ders çakışması filtresi) ve eşleştirme
    -- ------------------------------------------------------------------
    v_matched_count := 0;

    if v_norm_count > 0 and v_teacher_count > 0 then
      v_adj := array_fill(false, array[v_norm_count * v_teacher_count]);

      for v_edge in
        select nt.n_idx, tc.idx as c_idx
          from unnest(v_norm_task_idx) with ordinality as nt(task_idx, n_idx)
          cross join unnest(v_teacher_src) with ordinality as tc(src, idx)
          join public.teacher_duty_settings s
            on s.academic_year_id = v_year_id and s.teacher_source_id = tc.src
          join public.teacher_duty_block_availabilities av
            on av.teacher_duty_setting_id = s.id
           and av.duty_location_id = v_t_loc[nt.task_idx]
           and av.duty_block_id = v_t_block[nt.task_idx]
           and av.day_order = v_day.day_order
          join public.duty_blocks b on b.id = v_t_block[nt.task_idx]
          where b.conflict_period_name is null
             or not exists (
               -- Ders çakışması: 5-OO → Uzun Nöbet 1, 5-IO → Uzun Nöbet 2.
               select 1
                 from public.timetable_assignments ta
                 join public.teachers t2 on t2.id = ta.teacher_id
                 join public.lesson_periods lp on lp.id = ta.lesson_period_id
                 join public.timetable_days dd on dd.id = ta.timetable_day_id
                where ta.timetable_import_id = v_import.id
                  and t2.source_id = tc.src
                  and dd.day_order = v_day.day_order
                  and lp.name = b.conflict_period_name
             )
      loop
        v_adj[(v_edge.n_idx - 1) * v_teacher_count + v_edge.c_idx] := true;
        v_t_cand[v_norm_task_idx[v_edge.n_idx]] := v_t_cand[v_norm_task_idx[v_edge.n_idx]] + 1;
      end loop;

      -- Kuhn: her normal görev için sırayla artırıcı yol dene.
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

      -- Eşleşen görevleri işaretle.
      for v_j in 1..v_teacher_count loop
        if v_match_teacher[v_j] <> 0 then
          v_t_covered[v_norm_task_idx[v_match_teacher[v_j]]] := true;
        end if;
      end loop;
    end if;

    -- ------------------------------------------------------------------
    -- (e) Gün raporu
    -- ------------------------------------------------------------------
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
      -- Blok bazlı özet. independentShortfall, "bu bloğu tek başına ele
      -- alırsak kaç görev açıkta kalır" değeridir; matchingUncovered ise
      -- "öğretmen günde tek blok alabilir" kuralı uygulandıktan SONRAKİ
      -- gerçek açıktır. İkincisi her zaman >= birincisidir ve asıl bakılması
      -- gereken değerdir.
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
              select count(distinct s.teacher_source_id)
                from public.teacher_duty_settings s
                join public.teachers t3
                  on t3.timetable_import_id = v_import.id and t3.source_id = s.teacher_source_id
                join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s.id
                join public.duty_locations dl2 on dl2.id = av.duty_location_id
               where s.academic_year_id = v_year_id and s.is_included
                 and av.day_order = v_day.day_order and av.duty_block_id = bb.id
                 and dl2.is_active and dl2.deleted_at is null and not dl2.allows_fixed_assignment
                 and not exists (
                   select 1 from public.fixed_duty_assignments fa
                   where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
                     and fa.teacher_source_id = s.teacher_source_id
                 )
                 and (bb.conflict_period_name is null or not exists (
                   select 1 from public.timetable_assignments ta
                     join public.lesson_periods lp on lp.id = ta.lesson_period_id
                     join public.timetable_days dd on dd.id = ta.timetable_day_id
                    where ta.timetable_import_id = v_import.id and ta.teacher_id = t3.id
                      and dd.day_order = v_day.day_order and lp.name = bb.conflict_period_name
                 ))
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
                   and dl2.is_active and dl2.deleted_at is null and not dl2.allows_fixed_assignment
                   and not exists (
                     select 1 from public.fixed_duty_assignments fa
                     where fa.academic_year_id = v_year_id and fa.day_order = v_day.day_order
                       and fa.teacher_source_id = s.teacher_source_id
                   )
                   and (bb.conflict_period_name is null or not exists (
                     select 1 from public.timetable_assignments ta
                       join public.lesson_periods lp on lp.id = ta.lesson_period_id
                       join public.timetable_days dd on dd.id = ta.timetable_day_id
                      where ta.timetable_import_id = v_import.id and ta.teacher_id = t3.id
                        and dd.day_order = v_day.day_order and lp.name = bb.conflict_period_name
                   ))
              ), 0)
          ) order by bb.block_order)
          from public.duty_blocks bb where bb.is_active
      ), '[]'::jsonb),
      -- Karşılanamayan görevler. reason:
      --   missing_fixed_assignment — sabit nöbete uygun yer, o gün sabit
      --                              öğretmeni atanmamış
      --   no_candidate             — hiç aday öğretmen yok (uygunluk veya
      --                              ders çakışması nedeniyle)
      --   matching_conflict        — adayı var ama adaylar başka görevlere
      --                              gerekiyor ("günde tek blok" kuralı)
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
      -- Eksik sabit atamalar, nöbet yeri bazında toplanmış hâli.
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
      -- Ders çakışması nedeniyle elenenler: o gün o blokta uygunluk BEYAN
      -- ETMİŞ ama çakışan dersi olduğu için aday olamayan öğretmenler.
      'excludedByLessonConflict', coalesce((
        select jsonb_agg(jsonb_build_object(
            'blockId', bb.id, 'blockCode', bb.code, 'blockName', bb.name,
            'periodName', bb.conflict_period_name,
            'teacherCount', (
              select count(distinct s.teacher_source_id)
                from public.teacher_duty_settings s
                join public.teachers t4
                  on t4.timetable_import_id = v_import.id and t4.source_id = s.teacher_source_id
                join public.teacher_duty_block_availabilities av on av.teacher_duty_setting_id = s.id
               where s.academic_year_id = v_year_id and s.is_included
                 and av.day_order = v_day.day_order and av.duty_block_id = bb.id
                 and exists (
                   select 1 from public.timetable_assignments ta
                     join public.lesson_periods lp on lp.id = ta.lesson_period_id
                     join public.timetable_days dd on dd.id = ta.timetable_day_id
                    where ta.timetable_import_id = v_import.id and ta.teacher_id = t4.id
                      and dd.day_order = v_day.day_order and lp.name = bb.conflict_period_name
                 )
            )
          ) order by bb.block_order)
          from public.duty_blocks bb
         where bb.is_active and bb.conflict_period_name is not null
      ), '[]'::jsonb),
      -- O günün sabit öğretmenleri (bilgi amaçlı; aday havuzunun dışındalar).
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
  'Salt okunur planlanabilirlik analizi — HİÇBİR nöbet planı üretmez, hiçbir atama yazmaz. Her gün için gerçek bipartite maksimum eşleştirme (Kuhn) hesaplar: "bir öğretmen aynı gün yalnız bir normal blok alabilir" kuralı uygulanır. Sabit nöbete uygun yerler yalnız sabit atama ile karşılanır; eksikleri missingFixedAssignments olarak raporlanır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme — yalnız service_role
-- ============================================================================
revoke all on function public.duty_feasibility_augment(integer, integer, integer, boolean[], integer[], boolean[]) from public;
revoke all on function public.analyze_duty_plan_feasibility(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.duty_feasibility_augment(integer, integer, integer, boolean[], integer[], boolean[]) from anon;
    revoke all on function public.analyze_duty_plan_feasibility(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.duty_feasibility_augment(integer, integer, integer, boolean[], integer[], boolean[]) from authenticated;
    revoke all on function public.analyze_duty_plan_feasibility(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.duty_feasibility_augment(integer, integer, integer, boolean[], integer[], boolean[]) to service_role;
    grant execute on function public.analyze_duty_plan_feasibility(text, text) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir tablo/kısıt/veri değiştirmez; yalnız iki salt-okunur
-- fonksiyon ekler.
