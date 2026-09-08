-- ============================================================================
-- Nöbet2027 — YEMEKHANE-1/2 blok gereksinimini düzelt
-- ============================================================================
-- KONTROLLÜ TARİHSEL ONARIM (remote'ta ZATEN uygulanmış bu dosyada)
-- ----------------------------------------------------------------------------
-- Bu dosya remote'ta daha önce başarıyla uygulandı ve remote'ta YENİDEN
-- ÇALIŞTIRILMAYACAK — bu yüzden dosyanın VERSİYONU/adı DEĞİŞMEDİ, remote
-- migration geçmişiyle çakışma oluşmaz. Ancak dosyanın orijinal hali
-- YEMEKHANE1/YEMEKHANE2 duty_locations satırlarının migration ANINDA VAR
-- OLDUĞUNU varsayıyordu (RAISE EXCEPTION ile zorluyordu). Bu satırlar
-- ÇALIŞMA ZAMANI verisidir, migration seed'i DEĞİLDİR (bkz.
-- 20260914090000'daki aynı düzeltme, OGLEARASI1/2 için). Sonuç: TAMAMEN
-- TEMİZ bir `supabase db reset` (duty_locations=0) bu migration'da
-- durur — zincir kesilir, SONRAKİ hiçbir migration (20260913, 20260914 dahil)
-- hiç ÇALIŞMAZ. Bu yalnız yerel/CI temiz kurulumları etkiler; remote zaten
-- YEMEKHANE1/2 satırlarıyla geçmişte başarıyla uygulanmıştı, bu onarım
-- remote'taki DURUMU değiştirmez.
--
-- BURADA DEĞİŞEN: yalnız "yer(ler) yoksa RAISE EXCEPTION" davranışı
-- "yer(ler) yoksa başarılı no-op" olarak değiştirildi (20260914090000'daki
-- OGLEARASI1/2 düzeltmesiyle BİREBİR aynı desen) ve son doğrulama global
-- "count = 1" yerine BULUNAN HER silinmemiş YEMEKHANE1/YEMEKHANE2 satırını
-- ayrı ayrı denetler. duty_blocks (LONG_BREAK_1/2) referans kaydı hâlâ
-- HER ZAMAN zorunludur (gerçek şema bozukluğu göstergesi). Yerler mevcutsa
-- DELETE/INSERT mantığı, hedef bloklar (YEMEKHANE1→LONG_BREAK_1,
-- YEMEKHANE2→LONG_BREAK_2) ve idempotentlik AYNEN korunur — hiçbir başka
-- SQL/eşleme/güvenlik davranışı değişmedi.
-- ============================================================================
-- KÖK NEDEN
-- ----------------------------------------------------------------------------
-- YEMEKHANE-1 ve YEMEKHANE-2, ilk oluşturulduklarında "diğer nöbet yerleri"
-- genel kuralına göre (bkz. 20260910090000, bölüm 3-c) dört bloğun TAMAMINA
-- bağlanmıştı. Gerçek iş kuralı ise yalnız uzun yemek teneffüslerinde
-- görev gerektiriyor:
--   YEMEKHANE-1 → yalnız LONG_BREAK_1 (5-OO)
--   YEMEKHANE-2 → yalnız LONG_BREAK_2 (5-IO)
-- Sabah ve Öğleden Sonra bloklarında, ayrıca YEMEKHANE-1'de LONG_BREAK_2'de,
-- YEMEKHANE-2'de LONG_BREAK_1'de hiç görev yoktur.
--
-- BU MIGRATION NE YAPMAZ
-- ----------------------------------------------------------------------------
-- Yeni tablo yaratmaz, backfill çalıştırmaz, teacher_duty_block_availabilities
-- tablosuna HİÇ dokunmaz (ne INSERT ne UPDATE ne DELETE). Artık geçersiz
-- eşlemeye ait tarihsel öğretmen tercihleri (varsa) fiziksel olarak
-- OLDUĞU GİBİ KALIR — get_teacher_duty_matrix zaten yalnız GÜNCEL
-- duty_location_blocks'ta tanımlı hücreleri gösterir (bkz. 20260910091000
-- bölüm 2, "and exists (select 1 from duty_location_blocks ...)"),
-- save_teacher_duty_matrix'in atomik replace DELETE'i de yalnız GÜNCEL
-- tanımlı yer×blok kapsamındaki satırlara dokunur (bkz. aynı migration
-- bölüm 8, "and exists (select 1 from duty_location_blocks lb ...)") — bu
-- yüzden eşlemesi kaldırılan satırlar replace sırasında da SESSİZCE
-- SİLİNMEZ, yalnız görünümden gizlenir. duty_blocks, duty_locations,
-- fixed_duty_assignments tablolarına da dokunulmaz.
--
-- İDEMPOTENT VE GÜVENLİ
-- ----------------------------------------------------------------------------
-- Yerler `short_code` ile (kararlı, kullanıcı tarafından değiştirilemez),
-- bloklar `code` ile (referans tablo, bkz. duty_blocks) bulunur — görünen ad
-- kullanılmaz. Fazla eşlemeler yalnız YEMEKHANE1/YEMEKHANE2 kapsamında
-- silinir; eksik eşleme varsa eklenir (ON CONFLICT DO NOTHING). Bu migration
-- ikinci kez çalıştırılsa sonuç DEĞİŞMEZ (DELETE'in silecek satırı kalmaz,
-- INSERT zaten var olan satırı sessizce atlar).
--
-- HİÇBİR ÖNCEKİ MİGRATION DOSYASI DEĞİŞTİRİLMEDİ.
-- ============================================================================

do $$
begin
  -- (1) Gerekli duty_blocks kayıtlarının var olduğunu doğrula.
  if not exists (select 1 from public.duty_blocks where code = 'LONG_BREAK_1') then
    raise exception 'LONG_BREAK_1 duty_blocks kaydı bulunamadı — migration sırası bozulmuş olabilir.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.duty_blocks where code = 'LONG_BREAK_2') then
    raise exception 'LONG_BREAK_2 duty_blocks kaydı bulunamadı — migration sırası bozulmuş olabilir.' using errcode = '22023';
  end if;

  -- (2) YEMEKHANE1/YEMEKHANE2 duty_locations satırları ÇALIŞMA ZAMANI
  -- verisidir — yoksa aşağıdaki DELETE/INSERT'ler zaten hiçbir satırı
  -- etkilemez (SELECT tabanlı DML, WHERE zaten short_code arar), migration
  -- BAŞARILI bir no-op sayılır (bkz. dosya başındaki KONTROLLÜ TARİHSEL
  -- ONARIM notu).
end
$$;

-- (5) Fazla eşlemeleri kaldır — YALNIZ YEMEKHANE1/YEMEKHANE2 kapsamında,
-- YALNIZ istenmeyen blok kodlarında. Başka hiçbir yerin satırına dokunmaz.
delete from public.duty_location_blocks lb
using public.duty_locations dl, public.duty_blocks b
where lb.duty_location_id = dl.id
  and lb.duty_block_id = b.id
  and dl.deleted_at is null
  and (
    (upper(dl.short_code) = 'YEMEKHANE1' and b.code <> 'LONG_BREAK_1')
    or (upper(dl.short_code) = 'YEMEKHANE2' and b.code <> 'LONG_BREAK_2')
  );

-- (3) YEMEKHANE1 → yalnız LONG_BREAK_1 (eksikse ekle, idempotent).
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where upper(dl.short_code) = 'YEMEKHANE1'
    and dl.deleted_at is null
    and b.code = 'LONG_BREAK_1'
on conflict on constraint duty_location_blocks_unique_pair do nothing;

-- (4) YEMEKHANE2 → yalnız LONG_BREAK_2 (eksikse ekle, idempotent).
insert into public.duty_location_blocks (campus_id, duty_location_id, duty_block_id)
select dl.campus_id, dl.id, b.id
  from public.duty_locations dl
  cross join public.duty_blocks b
  where upper(dl.short_code) = 'YEMEKHANE2'
    and dl.deleted_at is null
    and b.code = 'LONG_BREAK_2'
on conflict on constraint duty_location_blocks_unique_pair do nothing;

-- Son doğrulama: BULUNAN her silinmemiş YEMEKHANE1/YEMEKHANE2 satırı
-- (0, 1 veya çoklu kampüs nedeniyle birden fazla olabilir) artık TAM OLARAK
-- tek ve doğru bloğa bağlı olmalı. Hiç satır yoksa döngü hiç çalışmaz —
-- migration yine de başarılı sayılır (no-op). Beklenmeyen bir durum varsa
-- (ör. bir yerin birden fazla veya yanlış bloğa bağlı olması) migration ham
-- bir hata ile durur — sessizce yanlış bir duruma geçilmez.
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
      where upper(short_code) in ('YEMEKHANE1', 'YEMEKHANE2')
        and deleted_at is null
  loop
    v_expected_code := case upper(v_loc.short_code)
      when 'YEMEKHANE1' then 'LONG_BREAK_1'
      when 'YEMEKHANE2' then 'LONG_BREAK_2'
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
