-- ============================================================================
-- Nöbet2027 — ÖĞLE ARASI-1/2 BAHÇE blok gereksinimi + kalıcı iş kuralı
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- ÖĞLE ARASI-1 BAHÇE ve ÖĞLE ARASI-2 BAHÇE, ilk oluşturulduklarında "diğer
-- nöbet yerleri" genel kuralına göre (bkz. 20260910090000, bölüm 3-c) dört
-- bloğun TAMAMINA bağlanmıştı. Gerçek iş kuralı ise yalnız kendi uzun
-- teneffüslerinde görev gerektiriyor (bkz. YEMEKHANE1/2 için aynı düzeltme,
-- 20260912090000):
--   OGLEARASI1 (Uzun 1 / 5-OO) → yalnız LONG_BREAK_1
--   OGLEARASI2 (Uzun 2 / 5-IO) → yalnız LONG_BREAK_2
--
-- Uzun nöbet zaman uygunluğu (5-OO / 5-IO hedef+komşu periyot kuralı,
-- bkz. 20260913090000) blok koduna göre çalışır, yer bazlı istisnası yoktur
-- — bu migration o kurala dokunmaz, yalnız hangi yer×blok hücrelerinin
-- VAR OLDUĞUNU değiştirir.
--
-- REVİZYON (bu dosya remote'a HENÜZ uygulanmadı, önceki inceleme sonrası
-- düzeltildi):
-- (1) OGLEARASI1/OGLEARASI2 ÇALIŞMA ZAMANI VERİSİDİR — migration seed'i
--     DEĞİLDİR. İlk sürüm bu yerler yoksa RAISE EXCEPTION ile başarısız
--     oluyordu; artık yerler yoksa migration BAŞARILI bir no-op'tur (DELETE/
--     INSERT zaten satır etkilemeyen SELECT tabanlı DML'dir — WHERE zaten
--     short_code eşleşmesini arar). Yalnız duty_blocks referans kayıtları
--     (LONG_BREAK_1/2) eksikse hata verir — o gerçek bir şema bozukluğudur.
-- (2) Son doğrulama artık GLOBAL "count = 1" değil, BULUNAN HER silinmemiş
--     yerin YALNIZ doğru bloğa bağlı olduğunu tek tek denetler (çoklu kampüs
--     senaryosuna karşı da doğru: her satır kendi başına değerlendirilir).
-- (3) create_duty_location AYNI transaction içinde CREATE OR REPLACE edilir
--     (aşağıda bölüm B) — böylece bu iş kuralı yalnız VAR OLAN satırları
--     düzeltmekle kalmaz, BUNDAN SONRA oluşturulacak yerlerde de kalıcı
--     olarak uygulanır. İmza değişmedi, bu yüzden 20260906090000'daki
--     GRANT/REVOKE (yalnız service_role EXECUTE edebilir) aynen geçerli
--     kalır.
-- (4) short_code artık PATCH ile değiştirilemez (bkz. bölüm C, DB tetikleyici)
--     — backend/frontend tarafındaki karşılığı ayrı dosyalarda (bu migration
--     dışında, ayrı commit'te).
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- teacher_duty_block_availabilities tablosuna HİÇ dokunmaz (ne INSERT ne
-- UPDATE ne DELETE). Artık geçersiz eşlemeye ait tarihsel öğretmen
-- tercihleri (varsa) fiziksel olarak OLDUĞU GİBİ KALIR — get_teacher_duty_matrix
-- zaten yalnız GÜNCEL duty_location_blocks'ta tanımlı hücreleri gösterir
-- (bkz. 20260910091000 bölüm 2), save_teacher_duty_matrix'in atomik replace
-- DELETE'i de yalnız GÜNCEL tanımlı yer×blok kapsamındaki satırlara dokunur
-- (bkz. 20260913090000, "exists (select 1 from duty_location_blocks lb ...)")
-- — bu yüzden eşlemesi kaldırılan satırlar SESSİZCE SİLİNMEZ, yalnız
-- görünümden gizlenir. fixed_duty_assignments tablosuna da dokunulmaz.
--
-- İDEMPOTENT VE GÜVENLİ
-- ----------------------------------------------------------------------------
-- Yerler `short_code` ile (kararlı), bloklar `code` ile (referans tablo)
-- bulunur — görünen ad/UUID hard-code edilmez. Fazla eşlemeler yalnız
-- OGLEARASI1/OGLEARASI2 kapsamında silinir; eksik eşleme varsa eklenir
-- (ON CONFLICT DO NOTHING). Bu migration ikinci kez çalıştırılsa sonuç
-- DEĞİŞMEZ.
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

-- ============================================================================
-- A. Mevcut OGLEARASI1/OGLEARASI2 satırlarını düzelt (veri varsa)
-- ============================================================================

do $$
begin
  -- Yalnız gerçek bir şema bozukluğunda dur: duty_blocks referans kayıtları
  -- HER ZAMAN var olmalı (20260910090000'da oluşturulur). OGLEARASI1/2
  -- duty_locations satırları ise ÇALIŞMA ZAMANI verisidir — yoksa aşağıdaki
  -- DELETE/INSERT'ler zaten hiçbir satırı etkilemez (no-op), migration
  -- BAŞARILI sayılır.
  if not exists (select 1 from public.duty_blocks where code = 'LONG_BREAK_1') then
    raise exception 'LONG_BREAK_1 duty_blocks kaydı bulunamadı — migration sırası bozulmuş olabilir.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.duty_blocks where code = 'LONG_BREAK_2') then
    raise exception 'LONG_BREAK_2 duty_blocks kaydı bulunamadı — migration sırası bozulmuş olabilir.' using errcode = '22023';
  end if;
end
$$;

-- Fazla eşlemeleri kaldır — YALNIZ OGLEARASI1/OGLEARASI2 kapsamında,
-- YALNIZ istenmeyen blok kodlarında. Yer yoksa bu bir no-op'tur. Başka
-- hiçbir yerin satırına dokunmaz.
delete from public.duty_location_blocks lb
using public.duty_locations dl, public.duty_blocks b
where lb.duty_location_id = dl.id
  and lb.duty_block_id = b.id
  and dl.deleted_at is null
  and (
    (upper(dl.short_code) = 'OGLEARASI1' and b.code <> 'LONG_BREAK_1')
    or (upper(dl.short_code) = 'OGLEARASI2' and b.code <> 'LONG_BREAK_2')
  );

-- OGLEARASI1 → yalnız LONG_BREAK_1 (eksikse ekle, idempotent, yer yoksa no-op).
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where upper(dl.short_code) = 'OGLEARASI1'
    and dl.deleted_at is null
    and b.code = 'LONG_BREAK_1'
on conflict on constraint duty_location_blocks_unique_pair do nothing;

-- OGLEARASI2 → yalnız LONG_BREAK_2 (eksikse ekle, idempotent, yer yoksa no-op).
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where upper(dl.short_code) = 'OGLEARASI2'
    and dl.deleted_at is null
    and b.code = 'LONG_BREAK_2'
on conflict on constraint duty_location_blocks_unique_pair do nothing;

-- Son doğrulama: BULUNAN her silinmemiş OGLEARASI1/OGLEARASI2 satırı
-- (0, 1 veya çoklu kampüs nedeniyle birden fazla olabilir) artık TAM OLARAK
-- tek ve doğru bloğa bağlı olmalı. Hiç satır yoksa döngü hiç çalışmaz —
-- migration yine de başarılı sayılır (no-op). Beklenmeyen bir durum varsa
-- migration ham bir hata ile durur — sessizce yanlış bir duruma geçilmez.
do $$
declare
  v_loc record;
  v_expected_code text;
  v_total_count int;
  v_correct_count int;
begin
  for v_loc in
    select id, campus_id, short_code
      from public.duty_locations
      where upper(short_code) in ('OGLEARASI1', 'OGLEARASI2')
        and deleted_at is null
  loop
    v_expected_code := case upper(v_loc.short_code)
      when 'OGLEARASI1' then 'LONG_BREAK_1'
      when 'OGLEARASI2' then 'LONG_BREAK_2'
    end;

    select count(*) into v_total_count
      from public.duty_location_blocks lb
      where lb.duty_location_id = v_loc.id;

    select count(*) into v_correct_count
      from public.duty_location_blocks lb
      join public.duty_blocks b on b.id = lb.duty_block_id
      where lb.duty_location_id = v_loc.id
        and b.code = v_expected_code;

    if v_total_count <> 1 or v_correct_count <> 1 then
      raise exception 'Beklenmeyen durum: % (id=%, kampüs=%) toplam % eşleme, doğru blokta (%) % eşleme (1/1 olmalıydı).',
        v_loc.short_code, v_loc.id, v_loc.campus_id, v_total_count, v_expected_code, v_correct_count
        using errcode = '22023';
    end if;
  end loop;
end
$$;

-- ============================================================================
-- B. create_duty_location — iş kuralını KALICI hale getir
-- ============================================================================
-- İMZA DEĞİŞMEDİ (7 parametre, returns public.duty_locations) — bu yüzden
-- 20260906090000'daki GRANT/REVOKE bloğu (yalnız service_role EXECUTE
-- edebilir) aynen geçerli kalır, fonksiyon overload'u OLUŞMAZ.
--
-- Önceki davranış: HER yeni yer, kategorisi ne olursa olsun, dört bloğun
-- TAMAMINA bağlanıyordu (bkz. 20260910090000 bölüm 4). Bu, ILKOKUL1/2,
-- OGLEARASIILKOKUL, YEMEKHANE1/2, OGLEARASI1/2 gibi özel yerlerin YENİDEN
-- oluşturulması durumunda (ör. soft-delete + tekrar ekleme) yanlış varsayılan
-- blok kümesiyle başlamasına yol açardı — düzeltme yalnız MEVCUT satırlara
-- uygulanan tek seferlik bir migration'du, kalıcı değildi.
--
-- YENİ davranış: short_code'a göre (büyük/küçük harf duyarsız) doğru blok
-- kümesi AYNI transaction içinde kurulur. UUID veya görünen ad hard-code
-- edilmez — yalnız short_code ve duty_blocks.code (referans tablo)
-- kullanılır. Gerekli özel blok kaydı (LONG_BREAK_1/2, MORNING_BREAKS,
-- AFTERNOON_BREAKS) duty_blocks'ta yoksa fonksiyon RAISE EXCEPTION ile
-- durur — INSERT dahil TÜM transaction rollback olur, yer YARIM
-- yapılandırmayla oluşmaz.
create or replace function public.create_duty_location(
  p_campus_id uuid,
  p_name text,
  p_short_code text,
  p_category text,
  p_capacity integer,
  p_description text,
  p_is_active boolean
)
returns public.duty_locations
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_next_sort_order integer;
  v_row public.duty_locations;
  v_code text := upper(p_short_code);
  v_required_codes text[];
  v_inserted int;
begin
  perform pg_advisory_xact_lock(hashtext('duty_locations:' || p_campus_id::text));

  select coalesce(max(sort_order), 0) + 1
    into v_next_sort_order
    from public.duty_locations
    where campus_id = p_campus_id and deleted_at is null;

  -- allows_fixed_assignment yalnız ILKOKUL1/ILKOKUL2 için true — sabit
  -- nöbete uygunluk arayüzden verilemez, yalnız bu iki kararlı short_code
  -- ile otomatik belirlenir (bkz. 20260910090000 aynı gerekçe).
  insert into public.duty_locations (
    campus_id, name, short_code, category, capacity, description, is_active, sort_order, allows_fixed_assignment
  ) values (
    p_campus_id, p_name, p_short_code, p_category, p_capacity, p_description, p_is_active, v_next_sort_order,
    (v_code in ('ILKOKUL1', 'ILKOKUL2'))
  )
  returning * into v_row;

  v_required_codes := case v_code
    when 'ILKOKUL1' then array['MORNING_BREAKS', 'AFTERNOON_BREAKS']
    when 'ILKOKUL2' then array['MORNING_BREAKS', 'AFTERNOON_BREAKS']
    when 'OGLEARASIILKOKUL' then array['LONG_BREAK_1']
    when 'YEMEKHANE1' then array['LONG_BREAK_1']
    when 'YEMEKHANE2' then array['LONG_BREAK_2']
    when 'OGLEARASI1' then array['LONG_BREAK_1']
    when 'OGLEARASI2' then array['LONG_BREAK_2']
    else null
  end;

  if v_required_codes is not null then
    insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
      select v_row.campus_id, v_row.id, b.id
        from public.duty_blocks b
        where b.code = any(v_required_codes);
    get diagnostics v_inserted = row_count;
    if v_inserted <> array_length(v_required_codes, 1) then
      raise exception 'Nöbet yeri % (short_code=%) için gereken duty_blocks kaydı bulunamadı (% / % blok bulundu) — işlem geri alındı.',
        p_name, p_short_code, v_inserted, array_length(v_required_codes, 1)
        using errcode = '22023';
    end if;
  else
    -- Özel olmayan (diğer bütün) yerler: dört aktif bloğun tamamı,
    -- allows_fixed_assignment varsayılanı (false) korunur.
    insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
      select v_row.campus_id, v_row.id, b.id
        from public.duty_blocks b
        where b.is_active;
  end if;

  return v_row;
end;
$$;

comment on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) is
  'Yeni nöbet yeri ekler (sort_order advisory lock ile eşzamanlı-güvenli) ve yeri AYNI transaction içinde short_code''a göre doğru nöbet bloklarına bağlar: ILKOKUL1/2 → sabah+öğleden sonra (allows_fixed_assignment=true), OGLEARASIILKOKUL/YEMEKHANE1/OGLEARASI1 → yalnız LONG_BREAK_1, YEMEKHANE2/OGLEARASI2 → yalnız LONG_BREAK_2, diğerleri → dört aktif blok. Gerekli özel blok kaydı yoksa RAISE EXCEPTION ile tüm transaction rollback olur. Yalnız service_role çağırabilir.';

-- ============================================================================
-- C. short_code kararlılığını DB seviyesinde zorla
-- ============================================================================
-- short_code sistem genelinde "kararlı, kullanıcı tarafından değiştirilemez"
-- kabul edilir (bkz. 20260906090000 sütun yorumu, bu dosyanın A/B
-- bölümlerindeki eşleme mantığı tamamen short_code'a güvenir). Backend
-- doğrulaması (PATCH şeması) bunu ayrı bir değişiklikte zorunlu kılar; bu
-- tetikleyici SAVUNMA DERİNLİĞİdir — service_role ile doğrudan tablo
-- erişimi (ör. elle SQL, gelecekte yazılacak başka bir uç nokta) da
-- short_code'u değiştiremesin diye eklenir. Yalnız short_code sütununu
-- kilitler; name/category/capacity/description/is_active/sort_order gibi
-- diğer PATCH edilebilir alanlara dokunmaz.
create or replace function public.prevent_duty_location_short_code_change()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if new.short_code is distinct from old.short_code then
    raise exception 'short_code değiştirilemez (kararlı tanımlayıcıdır).' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_duty_locations_short_code_immutable on public.duty_locations;
create trigger trg_duty_locations_short_code_immutable
  before update on public.duty_locations
  for each row
  execute function public.prevent_duty_location_short_code_change();

comment on function public.prevent_duty_location_short_code_change() is
  'duty_locations.short_code UPDATE ile değiştirilemez (kararlı tanımlayıcı) — backend doğrulamasının DB seviyesindeki savunma derinliği katmanı.';
