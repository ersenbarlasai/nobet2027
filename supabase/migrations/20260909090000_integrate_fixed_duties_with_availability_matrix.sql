-- ============================================================================
-- Nöbet2027 — Sabit Nöbetler ↔ Nöbet Uygunluk Matrisi entegrasyonu
-- ============================================================================
-- KÖK NEDEN: get_teacher_duty_matrix ve save_teacher_duty_matrix (bkz.
-- 20260907090000_create_teacher_duty_availability.sql), fixed_duty_assignments
-- tablosunun (bkz. 20260908090000_create_fixed_duty_assignments.sql) VARLIĞINDAN
-- TAMAMEN HABERSİZDİ — iki özellik ayrı günlerde, birbirinden bağımsız
-- migration'larla eklendi ve hiç entegre edilmedi. Sonuç: bir öğretmenin
-- Sabit Nöbetler ekranından atanmış sabit nöbeti olsa bile, uygunluk matrisi
-- o günü sıradan boş hücre olarak gösteriyor ve kullanıcı aynı günde başka
-- bir yeri "uygun" işaretleyebiliyor — hem görsel hem veri bütünlüğü hatası.
--
-- Bu migration İKİ mevcut fonksiyonu CREATE OR REPLACE ile günceller. Tablo/
-- RLS/diğer RPC'lerde hiçbir değişiklik yoktur. Önceki migration dosyaları
-- DEĞİŞTİRİLMEDİ.
--
-- SEMANTİK AYRIM (bkz. görev tanımı):
--   available            — kullanıcının normal uygunluk olarak seçtiği hücre
--   unavailable          — normal, seçilmemiş hücre
--   fixed                — sabit nöbet ataması (gerçek atama, TERCİH DEĞİL)
--   locked_by_fixed_duty — sabit günün DİĞER hücreleri (o gün başka yerde
--                          sabiti olan öğretmen, aynı gün farklı bir yerde de
--                          "uygun" işaretlenemez)
-- Bu tipler frontend'de src/lib/teacherDutyAvailability/types.ts içinde
-- DutyCellStatus olarak birebir karşılığını bulur — kavram başka hiçbir
-- dosyada çelişkili biçimde yeniden tanımlanmaz.
--
-- ÖĞRETMEN KİMLİĞİ: mevcut tasarımla birebir aynı — import-snapshot
-- teachers.id DEĞİL, (academic_year_id, teacher_source_id) çifti (bkz.
-- fixed_duty_assignments'ın kendi tasarımı, aynı gerekçe).
-- ============================================================================

-- ============================================================================
-- 1. get_teacher_duty_matrix — fixedAssignments eklendi, selectedCells sabit
--    günleri artık gizliyor (fiziksel silme YOK — yalnız görünürlükte gizleme)
-- ============================================================================
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
  v_locations jsonb;
  v_cells jsonb;
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
      'id', dl.id, 'name', dl.name, 'shortCode', dl.short_code,
      'category', dl.category, 'capacity', dl.capacity, 'sortOrder', dl.sort_order
      ) order by dl.sort_order, dl.name), '[]'::jsonb)
    into v_locations
    from public.duty_locations dl
    where dl.campus_id = v_campus_id and dl.is_active and dl.deleted_at is null;

  -- Öğretmenin bu eğitim yılındaki sabit nöbetleri. INNER JOIN güvenlidir:
  -- fixed_duty_assignments_location_campus_fk ON DELETE RESTRICT olduğundan
  -- referans alınan duty_locations satırı asla fiziksel olarak yok olmaz —
  -- yalnız soft-delete/pasif olabilir; bu durumda da isim/kısa kod burada
  -- AYNEN döner (dutyLocationIsActive=false ile işaretlenerek), böylece
  -- matris "Pasif sabit nöbet yeri" salt-okunur satırını gösterebilir.
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

  select id, is_included, updated_at into v_setting
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id;

  if v_setting.id is null then
    v_cells := '[]'::jsonb;
  else
    -- Yalnız hâlâ aktif+silinmemiş nöbet yerlerine VE sabit nöbeti OLMAYAN
    -- günlere ait hücreler döner. Sabit günün eski tercihi fiziksel olarak
    -- SİLİNMEZ (bkz. tablo yorumu) — burada yalnız görünürlükte gizlenir;
    -- sabit nöbet kaldırılırsa (fixed_duty_assignments satırı gidince) bu
    -- WHERE koşulu artık onu engellemeyeceği için tercih otomatik geri gelir.
    select coalesce(jsonb_agg(jsonb_build_object('dutyLocationId', av.duty_location_id, 'dayOrder', av.day_order)), '[]'::jsonb)
      into v_cells
      from public.teacher_duty_availabilities av
      join public.duty_locations dl on dl.id = av.duty_location_id
      where av.teacher_duty_setting_id = v_setting.id
        and dl.is_active and dl.deleted_at is null
        and not exists (
          select 1 from public.fixed_duty_assignments fa
          where fa.academic_year_id = v_year_id
            and fa.teacher_source_id = v_teacher.source_id
            and fa.day_order = av.day_order
        );
  end if;

  return jsonb_build_object(
    'hasImport', true,
    'teacherFound', true,
    'teacher', jsonb_build_object('id', v_teacher.id, 'sourceId', v_teacher.source_id, 'name', v_teacher.name),
    'isIncluded', coalesce(v_setting.is_included, true),
    'days', v_days,
    'dutyLocations', v_locations,
    'selectedCells', v_cells,
    'fixedAssignments', v_fixed,
    'updatedAt', v_setting.updated_at
  );
end;
$$;

comment on function public.get_teacher_duty_matrix(text, text, uuid) is
  'Salt okunur: nöbet uygunluk matrisi snapshot''ı (günler, aktif nöbet yerleri, seçili hücreler, isIncluded, updatedAt) + öğretmenin sabit nöbetleri (fixedAssignments). selectedCells sabit günün eski tercihini fiziksel olarak SİLMEZ, yalnız gizler (sabit kaldırılınca geri görünür). Yalnız service_role çağırabilir.';

-- ============================================================================
-- 2. save_teacher_duty_matrix — sabit günlere uygunluk yazımını REDDEDER
-- ============================================================================
-- Bu, görevin en kritik noktasıdır: koruma yalnız frontend'de DEĞİL, burada
-- (RPC/DB seviyesinde) uygulanır. Eski bir tarayıcı sekmesi veya doğrudan
-- API/RPC çağrısı, sabit bir güne asla availability yazamaz — istek
-- TAMAMEN reddedilir (kısmi kayıt yok), {status:"fixed_day_locked",
-- lockedDayOrders:[...]} döner.
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
  v_invalid_day boolean;
  v_invalid_location boolean;
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

  -- day_order aralığı: DB CHECK'i tekrarlamak yerine, hatayı kontrollü
  -- biçimde önceden yakalıyoruz.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int)
    where x.day_order is null or x.day_order < 1 or x.day_order > 5
  ) into v_invalid_day;
  if v_invalid_day then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'day_order_out_of_range');
  end if;

  -- Gönderilen nöbet yerleri: aynı kampüse ait, aktif ve silinmemiş olmalı.
  select exists (
    select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int)
    where x.duty_location_id is null or x.duty_location_id not in (
      select id from public.duty_locations
      where campus_id = v_campus_id and is_active and deleted_at is null
    )
  ) into v_invalid_location;
  if v_invalid_location then
    return jsonb_build_object('status', 'invalid_cells', 'reason', 'duty_location_not_available');
  end if;

  -- KRİTİK EŞZAMANLILIK KORUMASI: create_fixed_duty_assignment (bkz.
  -- 20260908090000_create_fixed_duty_assignments.sql) her gün için
  -- 'fixed-duty:{academic_year_id}:{day_order}' anahtarıyla bir
  -- pg_advisory_xact_lock alır. Bu fonksiyon o ana kadar HİÇBİR ortak kilit
  -- almıyordu — yani bir sabit nöbet ataması ile bu kaydetme işlemi arasında
  -- GERÇEK bir serileşme YOKTU: aşağıdaki fixed_day_orders SELECT'i salt bir
  -- okumaydı, kilitsiz. İki gerçek eşzamanlı bağlantıyla (pg_sleep TAHMİNİ
  -- OLMADAN, yalnızca kilit sırasıyla) doğrulandı: create_fixed_duty_assignment
  -- kendi kilidini alıp henüz COMMIT etmeden, bu fonksiyon aynı gün için
  -- fixed_duty_assignments'ı okuyup boş bulabiliyor ve o güne normal
  -- availability yazabiliyordu — sabit nöbet commit olunca matris bu satırı
  -- gizliyordu (görsel hata yoktu) ama veritabanında GERÇEKTEN yarışan,
  -- kilitsiz bir yazma vardı (görev tanımının 4. maddesi: "sabit güne yeni
  -- availability yazılmış olmamalı" — bu ihlal ediliyordu).
  --
  -- DÜZELTME: bu fonksiyon da replace'in etkileyebileceği Pazartesi–Cuma
  -- (1–5) günlerinin TAMAMI için, create_fixed_duty_assignment ile BİREBİR
  -- AYNI anahtar formatını, 1→5 ARTAN sırayla kilitler. Artan sıra hem bu
  -- fonksiyonun kendi eşzamanlı çağrıları arasında hem de
  -- create_fixed_duty_assignment (her zaman TEK bir gün kilitler, bu yüzden
  -- sıralamaya kendi başına katkısı yoktur ama tutarlılık için aynı anahtar
  -- kullanılır) ile aralarında deadlock oluşmasını engeller. Kilitler bu
  -- transaction COMMIT/ROLLBACK olana kadar tutulur (pg_advisory_XACT_lock).
  for v_lock_day in 1..5 loop
    perform pg_advisory_xact_lock(hashtext('fixed-duty:' || v_year_id::text || ':' || v_lock_day::text));
  end loop;

  -- Öğretmenin bu eğitim yılındaki GÜNCEL sabit nöbet günleri. Yukarıdaki
  -- kilitler ALINDIKTAN SONRA okunur — bu andan itibaren hiçbir
  -- create_fixed_duty_assignment çağrısı (aynı yıl, herhangi bir gün için)
  -- bu transaction COMMIT/ROLLBACK olana kadar ARAYA GİREMEZ (kendi kilidini
  -- bekler). Böylece "başka sekmede sabit nöbet atandı, bu sekme eski
  -- snapshot ile kaydetti" yarışı da (bkz. görev tanımındaki RACE CONDITION
  -- senaryosu) artık yalnızca "sonradan okuma" ile değil, GERÇEK karşılıklı
  -- dışlamayla (mutual exclusion) kapatılır.
  select coalesce(array_agg(distinct fa.day_order), array[]::smallint[])
    into v_fixed_day_orders
    from public.fixed_duty_assignments fa
    where fa.academic_year_id = v_year_id and fa.teacher_source_id = v_teacher.source_id;

  if array_length(v_fixed_day_orders, 1) > 0 then
    select exists (
      select 1 from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int)
      where x.day_order::smallint = any (v_fixed_day_orders)
    ) into v_locked_submitted;
    if v_locked_submitted then
      return jsonb_build_object('status', 'fixed_day_locked', 'lockedDayOrders', to_jsonb(v_fixed_day_orders));
    end if;
  end if;

  -- Mevcut ayar satırını kilitle (varsa) — eşzamanlı iki kaydetme isteğini
  -- serileştirir; ikinci istek birincinin COMMIT'ini bekler, ardından
  -- expectedUpdatedAt karşılaştırmasını GÜNCEL değerle yapar.
  select id, updated_at into v_setting_id, v_current_updated_at
    from public.teacher_duty_settings
    where academic_year_id = v_year_id and teacher_source_id = v_teacher.source_id
    for update;
  v_found := found;

  if v_found then
    -- expected_updated_at NULL olsa BİLE, satır zaten VARSA bu bir
    -- çatışmadır (bkz. teacher_duty_availability migration'ındaki "BULGU B
    -- DÜZELTMESİ" — bu davranış burada AYNEN korunur, bozulmadı).
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

  -- Atomik tam değiştirme (replace): yalnız o an aynı kampüste aktif+
  -- silinmemiş VE SABİT NÖBETİ OLMAYAN günlere ait satırlar hedeflenir
  -- (bkz. teacher_duty_availability migration'ındaki "BULGU A DÜZELTMESİ" —
  -- pasif/silinmiş yer koruması AYNEN korunur; buna ek olarak artık sabit
  -- günün eski tercihi de bu DELETE'in kapsamı DIŞINDA kalır — zaten
  -- yukarıdaki kontrol nedeniyle v_cells'te hiçbir sabit-gün hücresi
  -- olamaz, ama savunma derinliği için WHERE koşuluna da eklenir).
  delete from public.teacher_duty_availabilities a
    using public.duty_locations dl
    where a.teacher_duty_setting_id = v_setting_id
      and a.duty_location_id = dl.id
      and dl.campus_id = v_campus_id
      and dl.is_active
      and dl.deleted_at is null
      and not (a.day_order = any (v_fixed_day_orders));

  insert into public.teacher_duty_availabilities (campus_id, teacher_duty_setting_id, duty_location_id, day_order)
    select distinct v_campus_id, v_setting_id, x.duty_location_id, x.day_order::smallint
    from jsonb_to_recordset(v_cells) as x(duty_location_id uuid, day_order int);

  select updated_at into v_final_updated_at from public.teacher_duty_settings where id = v_setting_id;

  return jsonb_build_object('status', 'ok', 'updatedAt', v_final_updated_at);
end;
$$;

comment on function public.save_teacher_duty_matrix(text, text, uuid, boolean, jsonb, timestamptz) is
  'Nöbet uygunluk matrisini tek transaction içinde atomik olarak upsert+replace eder. 1-5 günleri için create_fixed_duty_assignment ile AYNI pg_advisory_xact_lock anahtarlarını (fixed-duty:{academic_year_id}:{day_order}) artan sırada alarak sabit nöbet atamasıyla GERÇEKTEN serileşir — kilitler alındıktan SONRA sabit günler yeniden okunur. Sabit nöbeti olan bir güne AİT herhangi bir hücre gönderilirse istek TAMAMEN reddedilir: {status:"fixed_day_locked", lockedDayOrders:[...]} (kısmi kayıt yok). Optimistic concurrency: expected_updated_at uyuşmazsa {status:"conflict"}. Diğer iş-kuralı ihlalleri {status:"invalid_cells"}, bilinmeyen/stale öğretmen veya import {status:"not_found"}. Raw Postgres hatası sızdırmaz. Yalnız service_role çağırabilir.';

-- Yetkilendirme (GRANT/REVOKE) önceki migration'dan zaten mevcut ve bu
-- CREATE OR REPLACE ile değişmez — fonksiyon imzaları (parametre listesi,
-- dönüş tipi) aynı kaldığı için yeniden tanımlamaya gerek yoktur.

-- ============================================================================
-- Yerel doğrulama (bkz. bu migration'ın PR raporu) — nobet2027_migration_check
-- geçici veritabanında, uzak Supabase'e HİÇBİR bağlantı kurulmadan test
-- edildi. Migration hiçbir gerçek veri barındırmaz, seed etmez.
-- ============================================================================
