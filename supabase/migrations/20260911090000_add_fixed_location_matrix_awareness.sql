-- ============================================================================
-- Nöbet2027 — Sabit nöbet yerlerinin (ILKOKUL1/ILKOKUL2) matriste doğru
-- gösterilmesi ve normal uygunluk seçiminden kesin olarak kapatılması
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- get_teacher_duty_matrix yalnız SEÇİLEN öğretmenin kendi fixed_duty_assignments
-- kayıtlarını döndürüyordu. Başka bir öğretmenin aynı gün+yerdeki sabit
-- ataması matris tarafından hiç bilinmiyordu; frontend bu yüzden ILKOKUL1/2
-- hücrelerini "boş normal uygunluk hücresi" gibi çizebiliyor, hatta
-- save_teacher_duty_matrix bu yerlere normal tercih YAZILMASINI DB seviyesinde
-- engellemiyordu (yalnız yer×blok ve aktiflik kontrolü vardı).
--
-- BU MIGRATION YENİ TABLO YARATMAZ, VERİ BACKFILL ETMEZ. Yalnız iki RPC'yi
-- (get_teacher_duty_matrix, save_teacher_duty_matrix) CREATE OR REPLACE ile
-- günceller. İmzaları AYNI kalır (parametre listesi ve dönüş tipi), bu yüzden
-- 20260910091000'daki GRANT/REVOKE blokları geçerliliğini korur — burada
-- yetkiler yeniden tanımlanmaz.
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ============================================================================
-- 1. get_teacher_duty_matrix — fixedLocationAssignments (yeni, global alan)
-- ============================================================================
-- EKLENEN ALAN: fixedLocationAssignments — bu eğitim yılı+kampüsteki TÜM
-- sabit yer işgalleri (hangi öğretmen olursa olsun). Mevcut `fixedAssignments`
-- alanının anlamı DEĞİŞMEDİ: hâlâ yalnız SEÇİLEN öğretmenin kendi sabit
-- nöbetleridir. `fixedLocationAssignments` bunun YANINA eklenir, yerini almaz.
--
-- teacherName: önce güncel importtaki teachers.name (source_id eşlemesiyle);
-- öğretmen o importta bulunamazsa (silinmiş/yeniden adlandırılmış kaynak
-- satırı) fixed_duty_assignments.teacher_name_snapshot'a düşer — HİÇBİR ZAMAN
-- null dönmez.
--
-- KAPSAM: yalnız fa.campus_id = v_campus_id AND fa.academic_year_id = v_year_id
-- — başka kampüs/yıl sabit ataması asla sızmaz (FK zaten bunu garanti eder,
-- burada AYRICA açıkça filtrelenir).
--
-- DEĞİŞEN DİĞER DAVRANIŞ: selectedBlockCells artık allows_fixed_assignment
-- = true olan yerlere ait satırları GÖRÜNÜR normal seçim olarak döndürmez
-- (böyle eski/hatalı bir satır varsa fiziksel olarak SİLİNMEZ — yalnız bu
-- görünüm listesinden çıkarılır; bkz. aşağıdaki "and not dl.allows_fixed_assignment").
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

  -- Öğretmenin sabit nöbetleri (mevcut davranış aynen korunur — yalnız
  -- SEÇİLEN öğretmenin kendi atamaları).
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

  -- YENİ: bu eğitim yılı+kampüsteki TÜM sabit yer işgalleri (her öğretmen).
  -- teacherName önce güncel importtaki teachers.name'e, orada bulunamazsa
  -- teacher_name_snapshot'a düşer. Kapsam kesin: campus_id + academic_year_id
  -- ikisi de eşleşmeli — başka kampüs/yıl verisi asla sızmaz.
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
    -- Yalnız hâlâ aktif+silinmemiş, SABİT-ATAMA-YALNIZ OLMAYAN nöbet
    -- yerlerine, HÂLÂ o yer için tanımlı bloklara VE sabit nöbeti OLMAYAN
    -- günlere ait hücreler döner. Gizlenen satırlar fiziksel olarak
    -- SİLİNMEZ; koşul ortadan kalkınca geri görünür (bkz.
    -- 20260907090000/20260909090000'daki aynı desen). "and not
    -- dl.allows_fixed_assignment" YENİ: ILKOKUL1/ILKOKUL2 için eskiden
    -- yanlışlıkla oluşmuş normal tercih satırları artık normal seçim gibi
    -- GÖSTERİLMEZ (silinmez, yalnız gizlenir).
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
    'fixedLocationAssignments', v_fixed_locations,
    'updatedAt', v_setting.updated_at
  );
end;
$$;

comment on function public.get_teacher_duty_matrix(text, text, uuid) is
  'Salt okunur: blok bazlı nöbet uygunluk matrisi snapshot''ı — günler, dört blok, aktif nöbet yerleri (blockIds + allowsFixedAssignment), selectedBlockCells (allows_fixed_assignment=true yerler HARİÇ), ders çakışmaları (lessonConflicts), SEÇİLEN öğretmenin sabit nöbetleri (fixedAssignments) ve eğitim yılındaki TÜM sabit yer işgalleri (fixedLocationAssignments — teacherName güncel import snapshot''ından, bulunamazsa teacher_name_snapshot''tan). legacySelectedCells eski gün bazlı tablodan salt-okunur denetim kaydıdır. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 2. save_teacher_duty_matrix — allows_fixed_assignment yerlere yazma kesin engeli
-- ============================================================================
-- YENİ kontrollü red: invalid_cells / fixed_assignment_only_location —
-- payload'da allows_fixed_assignment = true bir yere ait HERHANGİ bir hücre
-- varsa TÜM istek atomik olarak reddedilir (mevcut desenle aynı: erken
-- exists() kontrolü, kısmi yazma yok).
--
-- YENİ DELETE davranışı: atomik replace artık allows_fixed_assignment = true
-- yerlere ait satırlara HİÇ dokunmaz (ne siler ne değiştirir) — bu yerlere
-- payload zaten asla giremediği için (yukarıdaki red), böyle bir satır ancak
-- BU MIGRATION ÖNCESİNDEN kalma tarihsel/hatalı bir kayıt olabilir; sessizce
-- silinmez, olduğu gibi korunur (get_teacher_duty_matrix zaten görünümden
-- gizler).
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

  -- (2b) YENİ — allows_fixed_assignment = true yerler (ILKOKUL1/ILKOKUL2)
  -- yalnız Sabit Nöbetler ekranından atanır: payload'da böyle bir yere ait
  -- HERHANGİ bir hücre varsa TÜM istek reddedilir, hiçbir kısmi yazma olmaz.
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
  --
  -- YENİ: "and not dl.allows_fixed_assignment" — ILKOKUL1/ILKOKUL2'ye ait
  -- tarihsel/hatalı bir satır olsa bile (bu migration'dan önce oluşmuş
  -- olabilir; adım (2b) bundan sonra böyle bir satırın YAZILMASINI zaten
  -- engeller) bu DELETE onu asla silmez — sessiz veri kaybı yerine kalıcı
  -- koruma tercih edilmiştir (get_teacher_duty_matrix zaten görünümden
  -- gizler, bkz. yukarıdaki bölüm 1).
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
  'Blok bazlı nöbet uygunluk matrisini tek transaction içinde atomik upsert+replace eder. p_cells öğeleri {duty_location_id, day_order, duty_block_id}. Yer×blok gereksinimini, ders çakışmasını (5-OO/5-IO) VE allows_fixed_assignment=true yerlere yazma YASAĞINI (invalid_cells/fixed_assignment_only_location) DB seviyesinde zorunlu kılar; sabit günlerin tüm bloklarını reddeder (fixed_day_locked). Replace (8) kapsamı, o an ders çakışması İÇİNDE OLAN VEYA allows_fixed_assignment=true yere ait mevcut satırları HARİÇ TUTAR — bunlar sessizce silinmez. create_fixed_duty_assignment ile aynı advisory lock anahtarlarını 1→5 sırada alır. YALNIZ teacher_duty_block_availabilities''e yazar; eski gün bazlı tabloya hiç dokunmaz. Yalnız service_role çağırabilir.';
