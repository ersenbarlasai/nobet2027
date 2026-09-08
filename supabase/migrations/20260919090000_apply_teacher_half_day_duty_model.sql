-- ============================================================================
-- Nöbet2027 — Öğretmen bazlı YARIM GÜN kuralı + blok düzeyinde sabitlik
-- ============================================================================
-- Bu migration nöbet modelini üç noktada değiştirir:
--
--   1. teacher_duty_settings.half_day_rule_enabled — öğretmen bazlı "aynı gün
--      yalnız bir normal nöbet bloğu" kuralı (varsayılan AÇIK).
--
--   2. duty_location_blocks.assignment_mode — sabitlik artık YER düzeyinde
--      değil BLOK düzeyinde tanımlanır. Eski duty_locations.allows_fixed_
--      assignment bütün yeri normal atamaya kapatıyordu; oysa İLKOKUL-1/2'de
--      Sabah/Öğleden Sonra sabit, Öğle Arası-1 normaldir. Sütun geriye
--      uyumluluk için BIRAKILIR, ancak authoritative kural artık burasıdır.
--
--   3. Hedef 11 aktif nöbet yeri × blok eşlemesi (38 hücre/gün) ve tek-blok
--      normal paket modelini DB seviyesinde zorlayan kurallar.
--
-- GÜVENLİK VE GERİYE UYUMLULUK
--   * Eski migration dosyaları DEĞİŞTİRİLMEZ; bu yalnız ileri yönlü bir adım.
--   * Yayımlanmış/arşivlenmiş planların satırlarına ve tarihsel snapshot
--     alanlarına DOKUNULMAZ. Eski FULL_DAY/SHORT_BREAKS paketleri okunabilir
--     kalır.
--   * Emekliye ayrılan nöbet yerleri SOFT-DELETE edilir; eski tercih
--     (teacher_duty_block_availabilities) satırları FİZİKSEL OLARAK SİLİNMEZ.
--   * Temiz/boş bir veritabanı zincirinde (duty_locations boş) bütün veri
--     bölümleri no-op'tur ve migration hata vermez.
--   * UUID hard-code EDİLMEZ; eşleme yalnız kararlı short_code ve
--     duty_blocks.code üzerinden kurulur.
-- ============================================================================

-- ============================================================================
-- 0. Şema ön koşulu — YALNIZ zorunlu duty_blocks kayıtları için fail-fast
-- ============================================================================
-- Dört blok referans tablosu 20260910090000 ile gelir. Yoksa bu migration'ın
-- geri kalanı sessizce yanlış bir duruma geçerdi; bu yüzden burada durulur.
-- (Bu bir VERİ kontrolü değil ŞEMA kontrolüdür — boş db reset'inde de geçerli.)
do $$
declare
  v_missing text[];
begin
  select array_agg(c)
    into v_missing
    from unnest(array['MORNING_BREAKS', 'LONG_BREAK_1', 'LONG_BREAK_2', 'AFTERNOON_BREAKS']) as c
    where not exists (select 1 from public.duty_blocks b where b.code = c);

  if v_missing is not null then
    raise exception 'Zorunlu duty_blocks kayıtları eksik: % — yarım gün nöbet modeli uygulanamaz.', v_missing
      using errcode = '22023';
  end if;
end
$$;

-- ============================================================================
-- 1. teacher_duty_settings.half_day_rule_enabled
-- ============================================================================
-- Kalıcı kimlik MEVCUT modelle aynıdır: (academic_year_id, teacher_source_id)
-- benzersizdir, bu yüzden yeni bir XML importundan sonra ayar KORUNUR —
-- import teacher_source_id'yi değiştirmediği sürece satır aynı satırdır.
alter table public.teacher_duty_settings
  add column if not exists half_day_rule_enabled boolean not null default true;

comment on column public.teacher_duty_settings.half_day_rule_enabled is
  'AÇIK (varsayılan) ⇔ bu öğretmene aynı gün YALNIZ BİR normal nöbet bloğu atanabilir (bloklar/yerler farklı olsa bile). KAPALI ⇔ aynı gün farklı bloklarda birden fazla normal görev alabilir, ama her blokta en fazla bir görev (teorik üst sınır dört blok). Sabit nöbet günü bu ayardan BAĞIMSIZ olarak her zaman normal göreve kapalıdır. Tercih GİRİŞİNİ kısıtlamaz — yalnız atamada kaç tercihin kullanılabileceğini belirler.';

-- ============================================================================
-- 2. duty_location_blocks.assignment_mode
-- ============================================================================
--   normal      → normal tercih/otomatik/manuel atamaya AÇIK
--   fixed_only  → yalnız fixed_duty_assignments üzerinden karşılanabilir
--   (eşleme yok) → o yer/blok için nöbetçi GEREKMİYOR
alter table public.duty_location_blocks
  add column if not exists assignment_mode text not null default 'normal';

do $$
begin
  if not exists (
    select 1 from pg_constraint
      where conrelid = 'public.duty_location_blocks'::regclass
        and conname = 'duty_location_blocks_assignment_mode_check'
  ) then
    alter table public.duty_location_blocks
      add constraint duty_location_blocks_assignment_mode_check
      check (assignment_mode in ('normal', 'fixed_only'));
  end if;
end
$$;

comment on column public.duty_location_blocks.assignment_mode is
  'Bu yer×blok hücresinin AUTHORITATIVE atama politikası. normal ⇔ normal tercih/otomatik/manuel atamaya açık; fixed_only ⇔ yalnız fixed_duty_assignments üzerinden karşılanır. Eşleme satırı hiç yoksa o blokta nöbetçi gerekmez. duty_locations.allows_fixed_assignment ARTIK AUTHORITATIVE DEĞİLDİR (geriye uyumluluk için bırakıldı) — bütün yeri normal atamaya kapatması İLKOKUL-1/2 × Öğle Arası-1 için yanlıştır.';

create index if not exists duty_location_blocks_mode_idx
  on public.duty_location_blocks (duty_location_id, assignment_mode);

-- ============================================================================
-- 3. Hedef nöbet yeri × blok eşlemesi (VERİ — boş db'de tamamen no-op)
-- ============================================================================
-- Hedef tablo (11 aktif yer, 38 hücre/gün):
--
--   Yer            | Sabah      | Öğleden Sonra | Öğle Arası-1 | Öğle Arası-2
--   ---------------+------------+---------------+--------------+-------------
--   ALT BAHÇE      | normal     | normal        | (kapalı)     | normal
--   BALKON         | normal     | normal        | normal       | normal
--   ÜST BAHÇE      | normal     | normal        | (kapalı)     | normal
--   LOBİ           | normal     | normal        | normal       | normal
--   İLKOKUL-1      | fixed_only | fixed_only    | normal       | (kapalı)
--   İLKOKUL-2      | fixed_only | fixed_only    | normal       | (kapalı)
--   ORTAOKUL-1/2   | normal     | normal        | normal       | normal
--   LİSE-1/2       | normal     | normal        | normal       | normal
--   YEMEKHANE      | (kapalı)   | (kapalı)      | normal       | normal
--
-- ÖNEMLİ: ORTAOKUL/LİSE/LOBİ/BALKON short_code'ları bu depoda fixture veya
-- kod olarak BULUNMADIĞI için HARD-CODE EDİLMEZ. Bunun yerine "emekli
-- olmayan ve özel olmayan her aktif yer dört normal bloğa bağlanır" kuralı
-- uygulanır — hedef tablodaki dört-normal satırların tamamı bu kuralla
-- kendiliğinden doğru sonucu verir.
-- ----------------------------------------------------------------------------

-- 3a. Emekliye ayrılan özel öğle yerleri: SOFT-DELETE (fiziksel silme YOK).
--     Bu yerlere ait teacher_duty_block_availabilities satırları KORUNUR;
--     eski plan assignment/package satırlarına DOKUNULMAZ.
update public.duty_locations
   set is_active = false,
       deleted_at = coalesce(deleted_at, timezone('utc', now()))
 where upper(short_code) in ('OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL')
   and deleted_at is null;

-- 3b. YEMEKHANE birleştirmesi.
--     YEMEKHANE1 CANONICAL kayıttır: görünen adı "YEMEKHANE" yapılır,
--     immutable short_code DEĞİŞTİRİLMEZ (trg_duty_locations_short_code_
--     immutable bunu zaten reddederdi), iki öğle arası bloğuna bağlanır.
--     Aynı kampüste "YEMEKHANE" adını KULLANAN BAŞKA bir silinmemiş kayıt
--     varsa bu BELİRSİZ bir veri durumudur: hangi kaydın canonical olduğu
--     migration tarafından güvenle seçilemez. Sessizce atlamak yerine (eski
--     davranış) transaction AÇIK bir hatayla durdurulur — otomatik birleştirme
--     veya silme YAPILMAZ, çözümü operatör verir. UUID hard-code EDİLMEZ;
--     hata mesajı çakışan kaydın short_code'unu bildirir.
do $$
declare
  v_conflict record;
begin
  for v_conflict in
    select canon.campus_id,
           canon.short_code as canonical_short_code,
           other.short_code as conflicting_short_code,
           other.name as conflicting_name
      from public.duty_locations canon
      join public.duty_locations other
        on other.campus_id = canon.campus_id
       and other.id <> canon.id
       and other.deleted_at is null
       and lower(btrim(other.name)) = 'yemekhane'
     where upper(canon.short_code) = 'YEMEKHANE1'
       and canon.deleted_at is null
       and lower(btrim(canon.name)) is distinct from 'yemekhane'
  loop
    raise exception 'Kampüs %: canonical yemekhane kaydı (short_code=%) "YEMEKHANE" adına taşınamıyor — aynı adı kullanan başka bir aktif kayıt var (short_code=%, ad=%). Belirsiz birleştirme/silme YAPILMADI; önce bu çakışmayı elle çözün.',
      v_conflict.campus_id, v_conflict.canonical_short_code, v_conflict.conflicting_short_code, v_conflict.conflicting_name
      using errcode = '23505';
  end loop;
end
$$;

update public.duty_locations dl
   set name = 'YEMEKHANE'
 where upper(dl.short_code) = 'YEMEKHANE1'
   and dl.deleted_at is null
   and dl.name is distinct from 'YEMEKHANE';

-- YEMEKHANE2'nin LONG_BREAK_2 tercihleri canonical kayda KOPYALANIR.
-- INSERT ... SELECT + conflict-safe: ikinci çalıştırmada duplicate ÜRETMEZ.
-- Kaynak satırlar SİLİNMEZ (tarihsel denetim kaydı olarak kalır).
do $$
declare
  v_conflict_target text;
begin
  -- Tercih tablosunun benzersizlik kısıtının adı sürümler arasında
  -- değişebileceği için sütun listesiyle ON CONFLICT kullanılır.
  if to_regclass('public.teacher_duty_block_availabilities') is null then
    return;
  end if;

  insert into public.teacher_duty_block_availabilities (
    campus_id, teacher_duty_setting_id, day_order, duty_location_id, duty_block_id
  )
  select src.campus_id, src.teacher_duty_setting_id, src.day_order, canon.id, src.duty_block_id
    from public.teacher_duty_block_availabilities src
    join public.duty_locations y2
      on y2.id = src.duty_location_id
     and upper(y2.short_code) = 'YEMEKHANE2'
    join public.duty_blocks b
      on b.id = src.duty_block_id
     and b.code = 'LONG_BREAK_2'
    join public.duty_locations canon
      on canon.campus_id = y2.campus_id
     and upper(canon.short_code) = 'YEMEKHANE1'
     and canon.deleted_at is null
  on conflict do nothing;

  raise notice 'YEMEKHANE2 → YEMEKHANE (canonical) LONG_BREAK_2 tercihleri kopyalandı.';
end
$$;

-- YEMEKHANE2 emekliye ayrılır (soft-delete), tercihleri KORUNUR.
update public.duty_locations
   set is_active = false,
       deleted_at = coalesce(deleted_at, timezone('utc', now()))
 where upper(short_code) = 'YEMEKHANE2'
   and deleted_at is null;

-- 3c. Hedef eşlemeyi kur. Tek bir bildirimsel kaynak: (short_code, block, mode).
--     Emekli yerler ve silinmiş kayıtlar KAPSAM DIŞIDIR.
do $$
declare
  v_retired text[] := array['OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL', 'YEMEKHANE2'];
  v_loc record;
  v_desired record;
  v_deleted int;
begin
  -- Yer başına İSTENEN (blok kodu, mod) kümesini tutan geçici tablo.
  create temporary table tmp_desired_blocks (
    block_code text primary key,
    assignment_mode text not null
  ) on commit drop;

  for v_loc in
    select id, campus_id, short_code
      from public.duty_locations
      where deleted_at is null
        and upper(short_code) <> all(v_retired)
      order by short_code
  loop
    delete from tmp_desired_blocks;

    if upper(v_loc.short_code) in ('ILKOKUL1', 'ILKOKUL2') then
      insert into tmp_desired_blocks values
        ('MORNING_BREAKS', 'fixed_only'),
        ('AFTERNOON_BREAKS', 'fixed_only'),
        ('LONG_BREAK_1', 'normal');
    elsif upper(v_loc.short_code) = 'YEMEKHANE1' then
      insert into tmp_desired_blocks values
        ('LONG_BREAK_1', 'normal'),
        ('LONG_BREAK_2', 'normal');
    elsif upper(v_loc.short_code) in ('ALTBAHCE', 'USTBAHCE') then
      insert into tmp_desired_blocks values
        ('MORNING_BREAKS', 'normal'),
        ('AFTERNOON_BREAKS', 'normal'),
        ('LONG_BREAK_2', 'normal');
    else
      -- Diğer bütün aktif yerler: dört blok, tamamı normal.
      insert into tmp_desired_blocks values
        ('MORNING_BREAKS', 'normal'),
        ('LONG_BREAK_1', 'normal'),
        ('LONG_BREAK_2', 'normal'),
        ('AFTERNOON_BREAKS', 'normal');
    end if;

    -- Eksik eşlemeleri ekle.
    insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
      select v_loc.campus_id, v_loc.id, b.id, d.assignment_mode
        from tmp_desired_blocks d
        join public.duty_blocks b on b.code = d.block_code
    on conflict on constraint duty_location_blocks_unique_pair do nothing;

    -- Modu hedefe hizala (idempotent: ikinci çalıştırmada 0 satır etkiler).
    update public.duty_location_blocks lb
       set assignment_mode = d.assignment_mode
      from tmp_desired_blocks d
      join public.duty_blocks b on b.code = d.block_code
     where lb.duty_location_id = v_loc.id
       and lb.duty_block_id = b.id
       and lb.assignment_mode is distinct from d.assignment_mode;

    -- Hedefte OLMAYAN eşlemeleri kaldır (ör. ALT/ÜST BAHÇE × Öğle Arası-1,
    -- İLKOKUL × Öğle Arası-2). duty_location_blocks yalnız KONFİGÜRASYONdur;
    -- geçmiş plan satırları duty_plan_assignments'ta durur ve ETKİLENMEZ.
    delete from public.duty_location_blocks lb
     where lb.duty_location_id = v_loc.id
       and not exists (
         select 1
           from tmp_desired_blocks d
           join public.duty_blocks b on b.code = d.block_code
          where b.id = lb.duty_block_id
       );
    get diagnostics v_deleted = row_count;
    if v_deleted > 0 then
      raise notice 'Nöbet yeri % — hedef dışı % blok eşlemesi kaldırıldı.', v_loc.short_code, v_deleted;
    end if;
  end loop;
end
$$;

-- 3d. Emekli yerlerin blok eşlemeleri kaldırılır (görev evreninden çıkarlar).
--     Tercihler ve geçmiş planlar korunur; yalnız KONFİGÜRASYON temizlenir.
delete from public.duty_location_blocks lb
 using public.duty_locations dl
 where dl.id = lb.duty_location_id
   and upper(dl.short_code) in ('OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL', 'YEMEKHANE2');

-- ============================================================================
-- 4. Doğrulama
-- ============================================================================
-- İKİ KATMANLI:
--
--   4a. HER BULUNAN kayıt tek tek doğrulanır — kampüsteki aktif yer sayısından
--       BAĞIMSIZ. Kısmi veya boş bir veritabanında da hatalı bir özel kayıt
--       sessizce geçemez. Boş DB'de hiç kayıt olmadığı için hiçbir şey
--       doğrulanmaz ve migration BAŞARILI olur (no-op).
--
--   4b. 38 / 34 / 4 toplamları YALNIZ beklenen 11 aktif short_code kümesinin
--       TAMAMI mevcutsa zorlanır — bu ölçek kontrolü, tekil kayıt
--       doğrulamasının YERİNE değil ÜSTÜNE gelir.
do $$
declare
  v_row record;
  v_expected text;
  v_actual text;
begin
  -- 4a-i. Özel yerlerin blok×mod imzası birebir doğru olmalı.
  for v_row in
    select dl.campus_id,
           dl.short_code,
           upper(dl.short_code) as code,
           coalesce(
             string_agg(b.code || ':' || lb.assignment_mode, ',' order by b.code),
             '(eşleme yok)'
           ) as signature
      from public.duty_locations dl
      left join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      left join public.duty_blocks b on b.id = lb.duty_block_id
     where dl.deleted_at is null
       and dl.is_active
       and upper(dl.short_code) in ('ILKOKUL1', 'ILKOKUL2', 'YEMEKHANE1', 'ALTBAHCE', 'USTBAHCE')
     group by dl.campus_id, dl.short_code
  loop
    v_expected := case v_row.code
      -- Sabah + Öğleden Sonra fixed_only, Öğle Arası-1 normal, Öğle Arası-2 KAPALI.
      when 'ILKOKUL1' then 'AFTERNOON_BREAKS:fixed_only,LONG_BREAK_1:normal,MORNING_BREAKS:fixed_only'
      when 'ILKOKUL2' then 'AFTERNOON_BREAKS:fixed_only,LONG_BREAK_1:normal,MORNING_BREAKS:fixed_only'
      -- Yalnız iki öğle arası normal; kısa bloklar KAPALI.
      when 'YEMEKHANE1' then 'LONG_BREAK_1:normal,LONG_BREAK_2:normal'
      -- Sabah, Öğleden Sonra, Öğle Arası-2 normal; Öğle Arası-1 KAPALI.
      when 'ALTBAHCE' then 'AFTERNOON_BREAKS:normal,LONG_BREAK_2:normal,MORNING_BREAKS:normal'
      when 'USTBAHCE' then 'AFTERNOON_BREAKS:normal,LONG_BREAK_2:normal,MORNING_BREAKS:normal'
    end;

    if v_row.signature is distinct from v_expected then
      raise exception 'Kampüs % — % blok eşlemesi hatalı. Beklenen: [%]. Bulunan: [%].',
        v_row.campus_id, v_row.short_code, v_expected, v_row.signature
        using errcode = '22023';
    end if;
  end loop;

  -- 4a-ii. Emekli yerler aktif OLMAMALI ve aktif blok eşlemesi TAŞIMAMALI.
  for v_row in
    select dl.campus_id, dl.short_code, dl.is_active, count(lb.id) as block_count
      from public.duty_locations dl
      left join public.duty_location_blocks lb on lb.duty_location_id = dl.id
     where upper(dl.short_code) in ('OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL', 'YEMEKHANE2')
     group by dl.campus_id, dl.short_code, dl.is_active, dl.deleted_at
    having dl.deleted_at is null or count(lb.id) > 0
  loop
    raise exception 'Kampüs % — emekli nöbet yeri % hâlâ etkin (is_active=%, % blok eşlemesi). Emekli yerler soft-delete edilmeli ve blok eşlemesi taşımamalıdır.',
      v_row.campus_id, v_row.short_code, v_row.is_active, v_row.block_count
      using errcode = '22023';
  end loop;

  -- 4a-iii. Diğer bütün aktif yerler DÖRT normal blok taşımalı.
  for v_row in
    select dl.campus_id,
           dl.short_code,
           coalesce(string_agg(b.code || ':' || lb.assignment_mode, ',' order by b.code), '(eşleme yok)') as signature
      from public.duty_locations dl
      left join public.duty_location_blocks lb on lb.duty_location_id = dl.id
      left join public.duty_blocks b on b.id = lb.duty_block_id
     where dl.deleted_at is null
       and dl.is_active
       and upper(dl.short_code) not in (
         'ILKOKUL1', 'ILKOKUL2', 'YEMEKHANE1', 'ALTBAHCE', 'USTBAHCE',
         'OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL', 'YEMEKHANE2'
       )
     group by dl.campus_id, dl.short_code
  loop
    v_expected := 'AFTERNOON_BREAKS:normal,LONG_BREAK_1:normal,LONG_BREAK_2:normal,MORNING_BREAKS:normal';
    if v_row.signature is distinct from v_expected then
      raise exception 'Kampüs % — % dört normal blok taşımalı. Beklenen: [%]. Bulunan: [%].',
        v_row.campus_id, v_row.short_code, v_expected, v_row.signature
        using errcode = '22023';
    end if;
  end loop;
end
$$;

-- 4b. Ölçek doğrulaması — YALNIZ beklenen 11 aktif short_code'un TAMAMI varsa.
do $$
declare
  v_campus record;
  v_expected_codes text[] := array[
    'ALTBAHCE', 'USTBAHCE', 'BALKON', 'LOBI',
    'ILKOKUL1', 'ILKOKUL2', 'ORTAOKUL1', 'ORTAOKUL2',
    'LISE1', 'LISE2', 'YEMEKHANE1'
  ];
  v_present int;
  v_total int;
  v_fixed int;
  v_normal int;
begin
  for v_campus in
    select distinct campus_id from public.duty_locations where deleted_at is null
  loop
    select count(*)
      into v_present
      from public.duty_locations dl
     where dl.campus_id = v_campus.campus_id
       and dl.deleted_at is null
       and dl.is_active
       and upper(dl.short_code) = any(v_expected_codes);

    -- Beklenen küme eksikse ölçek kontrolü ANLAMSIZDIR (kısmi ortam, test
    -- fixture'ı). Tekil kayıt doğrulaması 4a'da ZATEN yapıldı.
    if v_present < array_length(v_expected_codes, 1) then
      continue;
    end if;

    select count(*),
           count(*) filter (where lb.assignment_mode = 'fixed_only'),
           count(*) filter (where lb.assignment_mode = 'normal')
      into v_total, v_fixed, v_normal
      from public.duty_location_blocks lb
      join public.duty_locations dl on dl.id = lb.duty_location_id
     where dl.campus_id = v_campus.campus_id
       and dl.deleted_at is null
       and dl.is_active;

    if v_total <> 38 or v_fixed <> 4 or v_normal <> 34 then
      raise exception 'Kampüs % hedef ölçeği tutturamadı: toplam=% (38 olmalı), fixed_only=% (4), normal=% (34).',
        v_campus.campus_id, v_total, v_fixed, v_normal
        using errcode = '22023';
    end if;

    raise notice 'Kampüs % — hedef eşleme doğrulandı: 38 hücre/gün (4 sabit + 34 normal).', v_campus.campus_id;
  end loop;
end
$$;

-- ============================================================================
-- 5. create_duty_location — yeni modele göre
-- ============================================================================
-- İMZA DEĞİŞMEDİ (7 parametre, returns public.duty_locations) — 20260906090000
-- GRANT/REVOKE bloğu aynen geçerli kalır, overload OLUŞMAZ.
--
-- Değişiklikler:
--   * Blok eşlemesi artık assignment_mode ile birlikte kurulur.
--   * İLKOKUL1/2 → Sabah+Öğleden Sonra fixed_only, Öğle Arası-1 normal.
--   * YEMEKHANE1 → iki öğle arası normal.
--   * ALTBAHCE/USTBAHCE → Sabah/Öğleden Sonra/Öğle Arası-2 normal.
--   * Emekli short_code'lar (OGLEARASI1/2, OGLEARASIILKOKUL, YEMEKHANE2)
--     yeniden OLUŞTURULAMAZ — yanlış konfigürasyonla geri gelmelerini önlemek
--     için açık bir hata ile reddedilir (tüm transaction rollback).
--   * Gerekli duty_blocks kaydı eksikse RAISE EXCEPTION → INSERT dahil her şey
--     geri alınır, yer YARIM yapılandırmayla oluşmaz.
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
  v_pairs text[][];
  v_pair text[];
  v_inserted int;
  v_expected int;
begin
  if v_code in ('OGLEARASI1', 'OGLEARASI2', 'OGLEARASIILKOKUL', 'YEMEKHANE2') then
    raise exception 'Nöbet yeri kodu % emekliye ayrılmıştır (yarım gün nöbet modeli) — yeniden oluşturulamaz. Öğle arası nöbetleri için YEMEKHANE ve İLKOKUL-1/2 × Öğle Arası-1 kullanılır.', v_code
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('duty_locations:' || p_campus_id::text));

  select coalesce(max(sort_order), 0) + 1
    into v_next_sort_order
    from public.duty_locations
    where campus_id = p_campus_id and deleted_at is null;

  -- allows_fixed_assignment ARTIK AUTHORITATIVE DEĞİLDİR (bkz. bölüm 2), ama
  -- geriye uyumluluk için eski anlamıyla (ILKOKUL1/2) doldurulmaya devam eder.
  insert into public.duty_locations (
    campus_id, name, short_code, category, capacity, description, is_active, sort_order, allows_fixed_assignment
  ) values (
    p_campus_id, p_name, p_short_code, p_category, p_capacity, p_description, p_is_active, v_next_sort_order,
    (v_code in ('ILKOKUL1', 'ILKOKUL2'))
  )
  returning * into v_row;

  v_pairs := case v_code
    when 'ILKOKUL1' then array[['MORNING_BREAKS', 'fixed_only'], ['AFTERNOON_BREAKS', 'fixed_only'], ['LONG_BREAK_1', 'normal']]
    when 'ILKOKUL2' then array[['MORNING_BREAKS', 'fixed_only'], ['AFTERNOON_BREAKS', 'fixed_only'], ['LONG_BREAK_1', 'normal']]
    when 'YEMEKHANE1' then array[['LONG_BREAK_1', 'normal'], ['LONG_BREAK_2', 'normal']]
    when 'ALTBAHCE' then array[['MORNING_BREAKS', 'normal'], ['AFTERNOON_BREAKS', 'normal'], ['LONG_BREAK_2', 'normal']]
    when 'USTBAHCE' then array[['MORNING_BREAKS', 'normal'], ['AFTERNOON_BREAKS', 'normal'], ['LONG_BREAK_2', 'normal']]
    else array[['MORNING_BREAKS', 'normal'], ['LONG_BREAK_1', 'normal'], ['LONG_BREAK_2', 'normal'], ['AFTERNOON_BREAKS', 'normal']]
  end;

  v_expected := array_length(v_pairs, 1);
  v_inserted := 0;

  for i in 1 .. v_expected loop
    v_pair := array[v_pairs[i][1], v_pairs[i][2]];
    insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id, assignment_mode)
      select v_row.campus_id, v_row.id, b.id, v_pair[2]
        from public.duty_blocks b
        where b.code = v_pair[1] and b.is_active;
    v_inserted := v_inserted + case when found then 1 else 0 end;
  end loop;

  if v_inserted <> v_expected then
    raise exception 'Nöbet yeri % (short_code=%) için gereken duty_blocks kaydı bulunamadı (% / % blok) — işlem geri alındı.',
      p_name, p_short_code, v_inserted, v_expected
      using errcode = '22023';
  end if;

  return v_row;
end;
$$;

comment on function public.create_duty_location(uuid, text, text, text, integer, text, boolean) is
  'Yeni nöbet yeri ekler (sort_order advisory lock ile eşzamanlı-güvenli) ve AYNI transaction içinde short_code''a göre doğru blok×assignment_mode kümesini kurar: ILKOKUL1/2 → Sabah+Öğleden Sonra fixed_only + Öğle Arası-1 normal, YEMEKHANE1 → iki öğle arası normal, ALTBAHCE/USTBAHCE → Sabah/Öğleden Sonra/Öğle Arası-2 normal, diğerleri → dört blok normal. Emekli kodlar (OGLEARASI1/2, OGLEARASIILKOKUL, YEMEKHANE2) reddedilir. Eksik blok kaydında RAISE EXCEPTION ile tüm transaction rollback olur. Yalnız service_role çağırabilir.';

-- ============================================================================
-- 6. Paket/atama modeli — DB seviyesinde yeni kurallar
-- ============================================================================

-- 6a. Eski (plan, gün, öğretmen) TEKİL kuralı yeni modele UYMAZ: yarım gün
--     kuralı kapalı bir öğretmen aynı gün farklı bloklarda birden fazla
--     SINGLE_BLOCK paketi alabilir — bu paketler AYNI nöbet yerinde de
--     olabilir (ör. LOBİ × Sabah + LOBİ × Öğleden Sonra). Kontrollü kaldırılır.
alter table public.duty_plan_assignment_packages
  drop constraint if exists duty_plan_assignment_packages_teacher_day_uq;

-- Paket tablosuna YENİ BİR TEKİLLİK EKLENMEZ. teacher+day+location tekilliği
-- de iş kuralına AYKIRIDIR: aynı yerde aynı gün iki farklı blok paketi
-- meşrudur. Tek gerçek tekillik kuralı (aynı gün + aynı blok) 6b'de,
-- duty_plan_assignments üzerinde ifade edilir — paket tablosu üzerinden
-- gereksiz ikinci bir kısıt üretmeye gerek yoktur.

-- 6b. Aynı öğretmen + gün + BLOK için ikinci atama DB seviyesinde imkânsız.
--     Bu, "aynı gün aynı blokta iki farklı YERDE bulunamaz" kuralının
--     AUTHORITATIVE ifadesidir. Eski FULL_DAY (4 ayrı blok) ve SHORT_BREAKS
--     (2 ayrı blok) planları bu kuralı zaten sağlar — geçmiş veriyi BOZMAZ.
create unique index if not exists duty_plan_assignments_teacher_day_block_uq
  on public.duty_plan_assignments (plan_id, day_order, teacher_source_id, duty_block_id)
  where teacher_source_id is not null;

comment on index public.duty_plan_assignments_teacher_day_block_uq is
  'Bir öğretmen aynı planda aynı gün aynı blokta EN FAZLA bir görev alır (yarım gün kuralı kapalı olsa bile aynı blokta iki farklı yere atanamaz). Aynı gün FARKLI bloklar — aynı nöbet yerinde olsalar bile — serbesttir.';

-- 6c. Cross-table kurallar (yarım gün + sabit gün) tek bir index ile ifade
--     edilemez. Çok adımlı paket yazımlarının GEÇİCİ ara durumlarında yanlış
--     hata üretmemesi için DEFERRABLE INITIALLY DEFERRED constraint trigger
--     kullanılır — doğrulama transaction'ın SONUNDA çalışır.
create or replace function public.enforce_duty_plan_teacher_day_rules()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_plan record;
  v_teacher text := coalesce(new.teacher_source_id, old.teacher_source_id);
  v_day smallint := coalesce(new.day_order, old.day_order);
  v_normal_count int;
  v_has_fixed boolean;
  v_half_day boolean;
begin
  if v_teacher is null then
    return null;
  end if;

  select p.id, p.status, p.academic_year_id
    into v_plan
    from public.duty_plans p
    where p.id = coalesce(new.plan_id, old.plan_id);

  -- Plan silinmişse (CASCADE) doğrulanacak bir şey kalmamıştır.
  if not found then
    return null;
  end if;

  -- Yayımlanmış/arşivlenmiş planlar zaten immutable'dır; bu kurallar YALNIZ
  -- taslak yazımlarında uygulanır ki eski planlar geriye dönük olarak
  -- geçersiz sayılmasın.
  if v_plan.status <> 'draft' then
    return null;
  end if;

  -- Bu öğretmenin bu gündeki NORMAL (fixed olmayan) görev sayısı.
  select count(*)
    into v_normal_count
    from public.duty_plan_assignments a
    where a.plan_id = v_plan.id
      and a.day_order = v_day
      and a.teacher_source_id = v_teacher
      and a.assignment_kind in ('generated', 'manual');

  if v_normal_count = 0 then
    return null;
  end if;

  -- Sabit nöbet günü: HİÇBİR normal görev alamaz (half_day ayarından bağımsız).
  select exists (
    select 1
      from public.fixed_duty_assignments f
      where f.academic_year_id = v_plan.academic_year_id
        and f.teacher_source_id = v_teacher
        and f.day_order = v_day
  ) into v_has_fixed;

  if v_has_fixed then
    raise exception 'Öğretmen % gün %: sabit nöbet günüdür, normal görev alamaz.', v_teacher, v_day
      using errcode = '23514', constraint = 'duty_plan_teacher_has_fixed_duty';
  end if;

  -- Yarım gün kuralı AÇIK ise aynı gün en fazla BİR normal görev.
  select coalesce(s.half_day_rule_enabled, true)
    into v_half_day
    from public.teacher_duty_settings s
    where s.academic_year_id = v_plan.academic_year_id
      and s.teacher_source_id = v_teacher;

  if coalesce(v_half_day, true) and v_normal_count > 1 then
    raise exception 'Öğretmen % gün %: yarım gün kuralı açık, aynı gün yalnız bir normal görev alabilir (% bulundu).', v_teacher, v_day, v_normal_count
      using errcode = '23514', constraint = 'duty_plan_teacher_half_day_rule';
  end if;

  -- Yarım gün kuralı kapalı olsa da günlük teorik üst sınır dört bloktur.
  if v_normal_count > 4 then
    raise exception 'Öğretmen % gün %: günlük normal görev sayısı dört bloğu aşamaz (% bulundu).', v_teacher, v_day, v_normal_count
      using errcode = '23514', constraint = 'duty_plan_teacher_day_block_limit';
  end if;

  return null;
end;
$$;

comment on function public.enforce_duty_plan_teacher_day_rules() is
  'Öğretmen×gün kuralları (DEFERRED): sabit nöbet gününde normal görev yok; half_day_rule_enabled açıkken günde en fazla bir normal görev; kapalıyken en fazla dört. Transaction SONUNDA çalışır — çok adımlı paket yazımlarının ara durumlarında yanlış hata üretmez. YALNIZ taslak planlara uygulanır; yayımlanmış/arşivlenmiş planlar geriye dönük geçersiz sayılmaz.';

drop trigger if exists trg_duty_plan_assignments_teacher_day_rules on public.duty_plan_assignments;
create constraint trigger trg_duty_plan_assignments_teacher_day_rules
  after insert or update or delete on public.duty_plan_assignments
  deferrable initially deferred
  for each row
  execute function public.enforce_duty_plan_teacher_day_rules();

-- 6d. Yeni planlarda normal paketler YALNIZ SINGLE_BLOCK olabilir.
--     Eski planlardaki FULL_DAY/SHORT_BREAKS kayıtları KORUNUR — kural
--     yalnız algoritma sürümü yeni olan planlara uygulanır, böylece tarihsel
--     veri okunabilir kalır.
create or replace function public.enforce_single_block_normal_packages()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_algorithm text;
begin
  if new.assignment_kind = 'fixed' then
    return new;
  end if;

  select p.algorithm_version into v_algorithm
    from public.duty_plans p where p.id = new.plan_id;

  if v_algorithm is null or v_algorithm not like 'duty-plan-solver-v3%' then
    return new;
  end if;

  if new.coverage_mode <> 'SINGLE_BLOCK' then
    raise exception 'Yeni nöbet modelinde normal paketler yalnız SINGLE_BLOCK olabilir (% verildi).', new.coverage_mode
      using errcode = '23514', constraint = 'duty_plan_package_single_block_only';
  end if;

  return new;
end;
$$;

comment on function public.enforce_single_block_normal_packages() is
  'duty-plan-solver-v3* planlarında normal (fixed olmayan) paketlerin tamamı SINGLE_BLOCK olmalıdır. FULL_DAY/SHORT_BREAKS eski algoritma sürümlü planlarda tarihsel olarak korunur.';

drop trigger if exists trg_duty_plan_packages_single_block_only on public.duty_plan_assignment_packages;
create trigger trg_duty_plan_packages_single_block_only
  before insert or update on public.duty_plan_assignment_packages
  for each row
  execute function public.enforce_single_block_normal_packages();
