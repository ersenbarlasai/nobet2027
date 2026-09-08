-- ============================================================================
-- Nöbet2027 — Öğretmen Nöbet Uygunluğu: gün bazlı → gün + blok bazlı
-- ============================================================================
-- Bu migration, öğretmen nöbet uygunluğunu dört bloklu modele taşır.
--
-- MEVCUT VERİ KORUNUR — MUTLAK KURAL
-- ----------------------------------------------------------------------------
-- `teacher_duty_availabilities` tablosu (bkz. 20260907090000_*) HİÇ
-- DEĞİŞTİRİLMEZ: sütun eklenmez/çıkarılmaz, hiçbir satırı silinmez, hiçbir
-- satırı taşınmaz. Tablo geçiş ve denetim (audit) kaydı olarak olduğu gibi
-- kalır. Blok bazlı uygunluk AYRI bir tabloya
-- (`teacher_duty_block_availabilities`) yazılır.
--
-- Bunun sonucu bilinçlidir: bu migration uygulandıktan sonra eski tablo
-- ARTIK YAZILMAZ (save_teacher_duty_matrix yalnız yeni tabloya yazar) ve
-- donmuş bir anlık görüntü hâline gelir. Eski satırların yeni tabloya
-- kopyalanması AYRI ve AYRICA ONAYLANAN bir adımdır — bkz. bu dosyanın
-- sonundaki `backfill_teacher_duty_block_availabilities` fonksiyonu. O
-- fonksiyon burada yalnız TANIMLANIR, ÇALIŞTIRILMAZ; bu migration hiçbir
-- gerçek uygunluk verisini kopyalamaz.
--
-- RPC İMZALARI DEĞİŞMEDİ
-- ----------------------------------------------------------------------------
-- `get_teacher_duty_matrix(text, text, uuid)` ve
-- `save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz)`
-- CREATE OR REPLACE ile güncellenir; parametre listeleri ve dönüş tipleri
-- AYNI kalır. Bu bilinçlidir:
--   * mevcut GRANT/REVOKE blokları geçerliliğini korur,
--   * fonksiyon overload'u oluşmaz (aynı ada iki farklı imza = çağrı
--     belirsizliği riski),
--   * `p_cells` zaten jsonb olduğundan yeni `duty_block_id` alanı şema
--     değişikliği gerektirmez.
--
-- DERS ÇAKIŞMASI
-- ----------------------------------------------------------------------------
-- duty_blocks.conflict_period_name, lesson_periods.name ile birebir eşleşir:
--   LONG_BREAK_1 ↔ "5-OO"   LONG_BREAK_2 ↔ "5-IO"
-- O gün o ders saatinde dersi olan öğretmen, ilgili blokta nöbete aday
-- olamaz. Bu kural HEM kaydetmede (aşağıda, kontrollü red) HEM analizde
-- (bkz. 20260910092000_*) uygulanır. Sabah/öğleden sonra bloklarının
-- conflict_period_name'i NULL'dır (kısa teneffüsleri topluca temsil
-- ettiklerinden tek bir ders saatine bağlanamazlar).
--
-- SABİT NÖBET DAVRANIŞI
-- ----------------------------------------------------------------------------
-- Sabit nöbeti olan öğretmen O GÜN başka hiçbir nöbet görevine aday olamaz —
-- bu kural blok modelinde de GÜN düzeyindedir, blok düzeyinde değil:
--   MORNING_BREAKS   → sabit koridorunda görevli
--   LONG_BREAK_1     → korumalı dinlenme
--   LONG_BREAK_2     → nöbet gerekmiyor (katta ders var)
--   AFTERNOON_BREAKS → sabit koridorunda görevli
-- Bu yüzden sabit günün TÜM blokları uygunluk matrisinde kilitlidir ve o güne
-- ait hiçbir hücre kaydedilemez (mevcut fixed_day_locked davranışı korunur).
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ============================================================================
-- 1. teacher_duty_block_availabilities
-- ============================================================================
create table public.teacher_duty_block_availabilities (
  id uuid primary key default gen_random_uuid(),
  -- Composite FK deseni (bkz. teacher_duty_availabilities): ayar satırı ile
  -- nöbet yerinin AYNI kampüse ait olması veritabanı seviyesinde garanti
  -- edilir.
  campus_id uuid not null,
  teacher_duty_setting_id uuid not null,
  duty_location_id uuid not null,
  day_order smallint not null check (day_order between 1 and 5),
  -- ON DELETE RESTRICT: kullanımdaki bir blok yok edilemez.
  duty_block_id uuid not null references public.duty_blocks (id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),

  constraint teacher_duty_block_avail_setting_campus_fk
    foreign key (teacher_duty_setting_id, campus_id)
    references public.teacher_duty_settings (id, campus_id)
    on delete cascade,
  constraint teacher_duty_block_avail_location_campus_fk
    foreign key (duty_location_id, campus_id)
    references public.duty_locations (id, campus_id)
    on delete cascade,
  constraint teacher_duty_block_avail_unique_cell
    unique (teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
);

comment on table public.teacher_duty_block_availabilities is
  'Öğretmenin (ayar satırı) hangi gün + nöbet yeri + nöbet bloğunda görevlendirilebileceği TERCİHİ. Gerçek atama DEĞİLDİR. teacher_duty_availabilities''in blok bazlı halefidir; o tablo geçiş/denetim için olduğu gibi korunur ve artık yazılmaz.';
comment on column public.teacher_duty_block_availabilities.duty_block_id is
  'Dört nöbet bloğundan biri. (duty_location_id, duty_block_id) çiftinin duty_location_blocks içinde tanımlı olması save_teacher_duty_matrix tarafından zorunlu kılınır.';

create index teacher_duty_block_avail_setting_idx
  on public.teacher_duty_block_availabilities (teacher_duty_setting_id);
create index teacher_duty_block_avail_location_idx
  on public.teacher_duty_block_availabilities (duty_location_id);
create index teacher_duty_block_avail_campus_idx
  on public.teacher_duty_block_availabilities (campus_id);
-- Planlanabilirlik analizi aday öğretmenleri (gün, blok) ekseninde tarar.
create index teacher_duty_block_avail_day_block_idx
  on public.teacher_duty_block_availabilities (day_order, duty_block_id);

alter table public.teacher_duty_block_availabilities enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.teacher_duty_block_availabilities from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.teacher_duty_block_availabilities from authenticated;
  end if;
end
$$;

-- ============================================================================
-- 2. get_teacher_duty_matrix — blok modeli snapshot'ı
-- ============================================================================
-- Eklenen alanlar:
--   blocks               dört blok (id, kod, ad, sıra, çakışan ders saati)
--   dutyLocations[].blockIds            yerin aktif olduğu bloklar
--   dutyLocations[].allowsFixedAssignment
--   selectedBlockCells   yeni blok bazlı seçimler
--   lessonConflicts      öğretmenin ders çakışması nedeniyle aday OLAMADIĞI
--                        (gün, blok) çiftleri — frontend bunları kilitli
--                        gösterir, kullanıcı işaretleyemez
--   legacySelectedCells  eski gün bazlı tablodan salt-okunur denetim kaydı
--                        (frontend kullanmaz; veri kaybolmadığının kanıtı)
--
-- `selectedCells` alanı KALDIRILDI ve yerine `legacySelectedCells` geldi:
-- eski adın blok bilgisi taşımayan veriyle dönmeye devam etmesi, çağıranın
-- sessizce yanlış (bloksuz) bir matris çizmesine yol açardı. Ad değişikliği
-- uyumsuzluğu gizlemek yerine görünür kılar.
create or replace function public.get_teacher_duty_matrix(
  p_campus_name text,
  p_academic_year_name text,
  p_teacher_id uuid
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
  v_teacher record;
  v_setting record;
  v_days jsonb;
  v_blocks jsonb;
  v_locations jsonb;
  v_block_cells jsonb;
  v_legacy_cells jsonb;
  v_lesson_conflicts jsonb;
  v_fixed jsonb;
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

  -- Nöbet yerleri, hangi bloklarda aktif olduklarıyla birlikte. blockIds boş
  -- bir dizi olabilir (ör. soft-delete edilip yeniden aktif edilmiş, blok
  -- eşlemesi hiç kurulmamış bir yer) — frontend bu durumda o satırın hiçbir
  -- hücresini tıklanabilir göstermez.
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

  -- Öğretmenin sabit nöbetleri (mevcut davranış aynen korunur).
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

  -- Ders çakışması: öğretmenin, bloğun conflict_period_name'ine karşılık gelen
  -- ders saatinde dersi olan günleri. Bu (gün, blok) çiftleri hem UI'da
  -- kilitlidir hem de kaydetmede reddedilir.
  select coalesce(jsonb_agg(distinct jsonb_build_object(
      'dayOrder', d.day_order,
      'dutyBlockId', b.id,
      'periodName', lp.name
      )), '[]'::jsonb)
    into v_lesson_conflicts
    from public.timetable_assignments ta
    join public.lesson_periods lp on lp.id = ta.lesson_period_id
    join public.timetable_days d on d.id = ta.timetable_day_id
    join public.duty_blocks b on b.conflict_period_name = lp.name and b.is_active
    where ta.timetable_import_id = v_import.id
      and ta.teacher_id = v_teacher.id
      and d.day_order between 1 and 5;

  select id, is_included, updated_at into v_setting
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id;

  if v_setting.id is null then
    v_block_cells := '[]'::jsonb;
    v_legacy_cells := '[]'::jsonb;
  else
    -- Yalnız hâlâ aktif+silinmemiş nöbet yerlerine, HÂLÂ o yer için tanımlı
    -- bloklara VE sabit nöbeti OLMAYAN günlere ait hücreler döner. Gizlenen
    -- satırlar fiziksel olarak SİLİNMEZ; koşul ortadan kalkınca geri görünür
    -- (bkz. 20260907090000/20260909090000'daki aynı desen).
    select coalesce(jsonb_agg(jsonb_build_object(
        'dutyLocationId', av.duty_location_id,
        'dayOrder', av.day_order,
        'dutyBlockId', av.duty_block_id)), '[]'::jsonb)
      into v_block_cells
      from public.teacher_duty_block_availabilities av
      join public.duty_locations dl on dl.id = av.duty_location_id
      where av.teacher_duty_setting_id = v_setting.id
        and dl.is_active and dl.deleted_at is null
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

    -- Eski, gün bazlı tablo: salt-okunur denetim kaydı. Filtrelenmez —
    -- amacı "veri kaybolmadı" olduğunu göstermektir.
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
    'updatedAt', v_setting.updated_at
  );
end;
$$;

comment on function public.get_teacher_duty_matrix(text, text, uuid) is
  'Salt okunur: blok bazlı nöbet uygunluk matrisi snapshot''ı — günler, dört blok, aktif nöbet yerleri (blockIds + allowsFixedAssignment), selectedBlockCells, ders çakışmaları (lessonConflicts) ve sabit nöbetler. legacySelectedCells eski gün bazlı tablodan salt-okunur denetim kaydıdır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 3. save_teacher_duty_matrix — blok bazlı atomik upsert + replace
-- ============================================================================
-- p_cells öğe biçimi: {duty_location_id: uuid, day_order: int, duty_block_id: uuid}
--
-- Kontrollü red durumları (ham Postgres hatası ASLA sızmaz):
--   invalid_cells / day_order_out_of_range
--   invalid_cells / duty_location_not_available
--   invalid_cells / duty_block_not_available
--   invalid_cells / block_not_allowed_for_location   ← YENİ (yer×blok kuralı)
--   invalid_cells / lesson_conflict                  ← YENİ (5-OO / 5-IO)
--   fixed_day_locked                                 (sabit günün TÜM blokları)
--   conflict                                         (optimistic concurrency)
--   not_found
--
-- YAZMA KAPSAMI: yalnız teacher_duty_block_availabilities. Eski
-- teacher_duty_availabilities tablosuna BU FONKSİYON HİÇ DOKUNMAZ (ne siler
-- ne yazar) — geçiş/denetim kaydı olarak donmuş kalır.
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

  -- (4) Yer × blok gereksinimi: bir nöbet yeri yalnız AKTİF OLDUĞU bloklarda
  -- işaretlenebilir. Örn. OGLEARASIILKOKUL yalnız LONG_BREAK_1'de görev
  -- ister; sabah bloğunda işaretlenmesi anlamsızdır ve reddedilir. Bu kural
  -- frontend'de de uygulanır ama asıl zorlama BURADADIR.
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

  -- (5) Ders çakışması: 5-OO dersi olan öğretmen LONG_BREAK_1'e, 5-IO dersi
  -- olan öğretmen LONG_BREAK_2'ye aday OLAMAZ. Ders programı importtan gelir
  -- ve kullanıcı tercihiyle geçersiz kılınamaz.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
    join public.duty_blocks b on b.id = x.duty_block_id
    where b.conflict_period_name is not null
      and exists (
        select 1
        from public.timetable_assignments ta
        join public.lesson_periods lp on lp.id = ta.lesson_period_id
        join public.timetable_days d on d.id = ta.timetable_day_id
        where ta.timetable_import_id = v_import.id
          and ta.teacher_id = v_teacher.id
          and d.day_order = x.day_order
          and lp.name = b.conflict_period_name
      )
  ) into v_bad;
  if v_bad then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'lesson_conflict');
  end if;

  -- (6) EŞZAMANLILIK: create_fixed_duty_assignment ile BİREBİR aynı anahtar
  -- biçimini 1→5 ARTAN sırada kilitle. Bu davranış
  -- 20260909090000_integrate_fixed_duties_with_availability_matrix.sql'de
  -- gerçek eşzamanlı bağlantılarla doğrulanmıştı ve blok modelinde AYNEN
  -- korunur — artan sıra deadlock'u önler, kilitler transaction sonuna kadar
  -- tutulur.
  for v_lock_day in 1..5 loop
    perform pg_advisory_xact_lock(hashtext('fixed-duty:' || v_year_id::text || ':' || v_lock_day::text));
  end loop;

  select coalesce(array_agg(distinct fa.day_order), array[]::smallint[])
    into v_fixed_day_orders
    from public.fixed_duty_assignments fa
    where fa.academic_year_id = v_year_id and fa.teacher_source_id = v_teacher.source_id;

  if array_length(v_fixed_day_orders, 1) > 0 then
    -- Sabit gün TÜM bloklarıyla kilitlidir (bkz. dosya başlığındaki sabit
    -- nöbet davranışı) — blok ayrımı yapılmaz.
    select exists (
      select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid)
      where x.day_order::smallint = any (v_fixed_day_orders)
    ) into v_locked_submitted;
    if v_locked_submitted then
      return jsonb_build_object('status', 'fixed_day_locked', 'lockedDayOrders', to_jsonb(v_fixed_day_orders));
    end if;
  end if;

  -- (7) Ayar satırı: kilitle + optimistic concurrency (mevcut davranış aynen).
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
  -- Kapsam, get_teacher_duty_matrix'in GÖSTERDİĞİ hücrelerle BİREBİR AYNI
  -- DEĞİLDİR: o fonksiyon ders çakışmalı satırları da "seçili" olarak
  -- döndürür (bkz. yukarıdaki bölüm 2, v_block_cells), çünkü tercih orada
  -- salt-okunur gösterilir ve silinmez. Ama adım (5) burada, payload'a
  -- güncel ders çakışması taşıyan bir hücre gelirse TÜM isteği reddeder —
  -- yani istemci o hücreyi p_cells'e HİÇ dahil edemez. Kapsam bu yüzden ek
  -- olarak "o an ders çakışması İÇİNDE OLMAYAN" şartını taşır: aksi halde
  -- istemcinin gönderemediği (çünkü göndermesi tüm isteği reddettirir) ama
  -- yine de aktif+tanımlı+sabit-olmayan kapsamına giren kilitli satır burada
  -- sessizce silinirdi. Ders çakışması aynı (öğretmen, gün, blok) üçlüsü
  -- için adım (5) ile BİREBİR AYNI sorgu biçimiyle kontrol edilir — v_import
  -- (status='imported' en güncel snapshot) ve v_teacher.id (kararlı
  -- source_id üzerinden bu importa çözülmüş öğretmen) kullanılır.
  --
  -- Çakışma ortadan kalkarsa (ör. yeni XML import ders programını değiştirir,
  -- v_import artık farklı bir satır işaret eder ve eski çakışma bir daha
  -- eşleşmez): satır bu koşuldan geçer, normal replace kapsamına girer ve
  -- kullanıcı isterse artık silebilir/değiştirebilir — kilitliyken
  -- "sonsuza dek korunan" bir istisna DEĞİLDİR, yalnız o an çakışma
  -- SÜRERKEN fiziksel silinmeye karşı korunur.
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
      )
      and not (av.day_order = any (v_fixed_day_orders))
      and not exists (
        select 1
        from public.duty_blocks b
        join public.timetable_assignments ta on ta.timetable_import_id = v_import.id and ta.teacher_id = v_teacher.id
        join public.lesson_periods lp on lp.id = ta.lesson_period_id
        join public.timetable_days d on d.id = ta.timetable_day_id
        where b.id = av.duty_block_id
          and b.conflict_period_name is not null
          and d.day_order = av.day_order
          and lp.name = b.conflict_period_name
      );

  insert into public.teacher_duty_block_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
    select distinct v_campus_id, v_setting_id, x.duty_location_id, x.day_order::smallint, x.duty_block_id
    from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int, duty_block_id uuid);

  select updated_at into v_final_updated_at from public.teacher_duty_settings where id = v_setting_id;

  return jsonb_build_object('status', 'ok', 'updatedAt', v_final_updated_at);
end;
$$;

comment on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) is
  'Blok bazlı nöbet uygunluk matrisini tek transaction içinde atomik upsert+replace eder. p_cells öğeleri {duty_location_id, day_order, duty_block_id}. Yer×blok gereksinimini ve ders çakışmasını (5-OO/5-IO) DB seviyesinde zorunlu kılar; sabit günlerin tüm bloklarını reddeder (fixed_day_locked). Replace (8) kapsamı, o an ders çakışması İÇİNDE OLAN mevcut satırları HARİÇ TUTAR — istemci bu satırları p_cells''e dahil edemediği için (adım 5 tüm isteği reddeder) sessizce silinmezler; çakışma ortadan kalktığında normal replace kapsamına geri döner. create_fixed_duty_assignment ile aynı advisory lock anahtarlarını 1→5 sırada alır. YALNIZ teacher_duty_block_availabilities''e yazar; eski gün bazlı tabloya hiç dokunmaz. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 4. backfill_teacher_duty_block_availabilities — TANIMLANIR, ÇALIŞTIRILMAZ
-- ============================================================================
-- Bu migration'ın uygulanması hiçbir gerçek uygunluk verisini kopyalamaz.
-- Fonksiyon burada yalnız TANIMLANIR; gerçek veriyi taşımak AYRI ve AYRICA
-- ONAYLANAN bir adımdır (görev tanımındaki iki-onay kuralı: önce şema/RPC,
-- SONRA veri backfill'i).
--
-- Varsayılan p_dry_run = true: fonksiyon yanlışlıkla çağrılsa bile HİÇBİR
-- satır yazmaz, yalnızca ne yazacağını sayar. Yazmak için açıkça
-- `p_dry_run => false` geçilmelidir.
--
-- Taşıma kuralı: her eski (ayar, yer, gün) satırı, o YERİN duty_location_blocks
-- içinde tanımlı HER bloğuna bir satır olarak açılır. Örn. dört bloklu bir
-- yer için 1 eski satır → 4 yeni satır; ILKOKUL1 için → 2 satır;
-- OGLEARASIILKOKUL için → 1 satır.
--
-- p_apply_lesson_conflict_filter = true verilirse, öğretmenin o gün 5-OO
-- dersi varsa LONG_BREAK_1, 5-IO dersi varsa LONG_BREAK_2 satırı hiç
-- oluşturulmaz. Varsayılan false'tur: eski veri kullanıcının BEYAN ETTİĞİ
-- tercihtir ve backfill onu daraltmamalıdır; ders çakışması zaten hem
-- kaydetmede hem analizde ayrıca uygulanır. Hangi davranışın isteneceği
-- backfill onayı sırasında kararlaştırılır.
--
-- İdempotent: ON CONFLICT DO NOTHING ile tekrar çalıştırılabilir; mevcut blok
-- satırlarını ASLA silmez veya değiştirmez, yalnız eksik olanları ekler.
-- Eski tabloya da hiç dokunmaz.
-- ----------------------------------------------------------------------------
-- 4a. duty_block_backfill_candidates — taşınacak satırların TEK tanımı
-- ----------------------------------------------------------------------------
-- Aday satırlar hem sayım (dry-run) hem de gerçek ekleme tarafından AYNI
-- kaynaktan okunur; sorgunun iki kez elle yazılması (ve ikisinin zamanla
-- ayrışması) bu yüzden engellenir. Geçici tablo BİLİNÇLİ olarak
-- kullanılmadı: Supabase'in transaction-pooling modunda temp tablo davranışı
-- bağlantı yaşam döngüsüne bağlıdır, salt-okunur bir set-returning fonksiyon
-- ise her koşulda öngörülebilirdir.
create or replace function public.duty_block_backfill_candidates(
  p_apply_lesson_conflict_filter boolean
)
returns table (
  campus_id uuid,
  teacher_duty_setting_id uuid,
  duty_location_id uuid,
  day_order smallint,
  duty_block_id uuid
)
language sql
stable
set search_path = pg_catalog, public
as $$
  select distinct
      a.campus_id,
      a.teacher_duty_setting_id,
      a.duty_location_id,
      a.day_order,
      lb.duty_block_id
    from public.teacher_duty_availabilities a
    join public.duty_location_blocks lb on lb.duty_location_id = a.duty_location_id
    join public.duty_blocks b on b.id = lb.duty_block_id and b.is_active
    where not p_apply_lesson_conflict_filter
       or b.conflict_period_name is null
       or not exists (
         -- Öğretmenin o gün, o ders saatinde dersi var mı? Öğretmen kimliği
         -- ayar satırından (academic_year_id + teacher_source_id) ilgili
         -- eğitim yılının EN GÜNCEL importundaki teachers satırına eşlenir —
         -- get_teacher_duty_matrix/save_teacher_duty_matrix ile birebir aynı
         -- "en güncel import" seçimi kullanılır.
         select 1
         from public.teacher_duty_settings s
         cross join lateral (
           select ti.id
             from public.timetable_imports ti
             where ti.academic_year_id = s.academic_year_id and ti.status = 'imported'
             order by ti.imported_at desc nulls last, ti.created_at desc
             limit 1
         ) cur
         join public.teachers t
           on t.timetable_import_id = cur.id and t.source_id = s.teacher_source_id
         join public.timetable_assignments ta
           on ta.timetable_import_id = cur.id and ta.teacher_id = t.id
         join public.lesson_periods lp on lp.id = ta.lesson_period_id
         join public.timetable_days d on d.id = ta.timetable_day_id
         where s.id = a.teacher_duty_setting_id
           and d.day_order = a.day_order
           and lp.name = b.conflict_period_name
       );
$$;

comment on function public.duty_block_backfill_candidates(boolean) is
  'Salt okunur: eski gün bazlı uygunluk satırlarının blok bazlı karşılıklarını üretir (yer × o yerin tanımlı blokları). backfill fonksiyonunun hem dry-run sayımı hem gerçek eklemesi bu tek tanımı kullanır. Hiçbir şey yazmaz.';

-- ----------------------------------------------------------------------------
-- 4b. backfill_teacher_duty_block_availabilities
-- ----------------------------------------------------------------------------
create or replace function public.backfill_teacher_duty_block_availabilities(
  p_dry_run boolean default true,
  p_apply_lesson_conflict_filter boolean default false
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_candidate_count bigint;
  v_existing_count bigint;
  v_inserted_count bigint := 0;
  v_legacy_count bigint;
  v_unmapped_count bigint;
begin
  select count(*) into v_legacy_count from public.teacher_duty_availabilities;
  select count(*) into v_existing_count from public.teacher_duty_block_availabilities;

  select count(*) into v_candidate_count
    from public.duty_block_backfill_candidates(p_apply_lesson_conflict_filter);

  -- Hiçbir duty_location_blocks eşlemesi bulunmayan (dolayısıyla hiç
  -- taşınamayan) eski satırlar — ör. soft-delete edilmiş bir yere ait geçmiş
  -- tercihler. Bunlar SESSİZCE kaybolmaz, raporlanır; eski tabloda fiziksel
  -- olarak yerinde kalırlar.
  select count(*) into v_unmapped_count
    from public.teacher_duty_availabilities a
    where not exists (
      select 1 from public.duty_location_blocks lb where lb.duty_location_id = a.duty_location_id
    );

  if not p_dry_run then
    insert into public.teacher_duty_block_availabilities
      (campus_id, teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)
    select c.campus_id, c.teacher_duty_setting_id, c.duty_location_id, c.day_order, c.duty_block_id
      from public.duty_block_backfill_candidates(p_apply_lesson_conflict_filter) c
    on conflict on constraint teacher_duty_block_avail_unique_cell do nothing;
    get diagnostics v_inserted_count = row_count;
  end if;

  return jsonb_build_object(
    'dryRun', p_dry_run,
    'appliedLessonConflictFilter', p_apply_lesson_conflict_filter,
    'legacyRowCount', v_legacy_count,
    'blockRowCountBefore', v_existing_count,
    'candidateRowCount', v_candidate_count,
    'insertedRowCount', v_inserted_count,
    'legacyRowsWithoutBlockMapping', v_unmapped_count
  );
end;
$$;

comment on function public.backfill_teacher_duty_block_availabilities(boolean, boolean) is
  'Eski gün bazlı uygunlukları blok bazlı tabloya kopyalar. VARSAYILAN dry-run: hiçbir şey yazmaz, yalnız sayar. Yazmak için p_dry_run => false gerekir. İdempotent (ON CONFLICT DO NOTHING); eski tabloya ve mevcut blok satırlarına dokunmaz. Bu migration onu ÇALIŞTIRMAZ — veri backfill''i ayrıca onaylanır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- Yetkilendirme
-- ============================================================================
-- get_teacher_duty_matrix / save_teacher_duty_matrix imzaları değişmediği için
-- 20260907090000'daki GRANT'ler korunur. Yalnız yeni backfill fonksiyonu için
-- yetki verilir.
revoke all on function public.duty_block_backfill_candidates(boolean) from public;
revoke all on function public.backfill_teacher_duty_block_availabilities(boolean, boolean) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.duty_block_backfill_candidates(boolean) from anon;
    revoke all on function public.backfill_teacher_duty_block_availabilities(boolean, boolean) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.duty_block_backfill_candidates(boolean) from authenticated;
    revoke all on function public.backfill_teacher_duty_block_availabilities(boolean, boolean) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.duty_block_backfill_candidates(boolean) to service_role;
    grant execute on function public.backfill_teacher_duty_block_availabilities(boolean, boolean) to service_role;
  end if;
end
$$;
