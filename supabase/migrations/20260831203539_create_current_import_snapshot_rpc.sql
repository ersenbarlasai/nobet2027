-- ============================================================================
-- Nöbet2027 — mevcut (en güncel başarılı) XML importunun read-only snapshot'ı
-- ============================================================================
-- "Veri ve XML" ekranındaki yeni durum kartı, veritabanındaki mevcut başarılı
-- importu göstermek için bu RPC'yi çağırır (bkz. server/routes/currentImport.ts).
--
-- Neden tek bir RPC ve birden çok bağımsız REST sayımı değil: kampüs bulma,
-- eğitim yılı bulma, en güncel 'imported' kaydı seçme ve 6 ayrı çocuk
-- tablodan sayım almak — bunlar ayrı ayrı REST çağrılarıyla yapılırsa,
-- çağrılar arasında ARADA yeni bir import tamamlanırsa (ör. kullanıcı aynı
-- anda başka bir sekmede yeni dosya yüklerse) sayımlar farklı importlardan
-- karışabilir. Tek bir PL/pgSQL fonksiyonu, tek bir sorgu anındaki (statement
-- düzeyinde MVCC snapshot) tutarlı bir görüntü garanti eder.
--
-- Bu fonksiyon SALT OKUNUR'dur (yalnız SELECT), hiçbir veri değiştirmez,
-- STABLE olarak işaretlenmiştir. SECURITY INVOKER (definer değil) — aynı
-- gerekçeyle: yalnızca service_role çağırır, service_role zaten RLS'yi
-- bypass eder ve SELECT hakkına sahiptir; ek yetkiye gerek yok.
--
-- Dinamik SQL YOKTUR. search_path sabittir.
-- ============================================================================

create or replace function public.get_current_timetable_import_snapshot(
  p_campus_name text,
  p_academic_year_name text
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
  v_teacher_count integer;
  v_class_count integer;
  v_day_count integer;
  v_period_count integer;
  v_card_count integer;
  v_assignment_count integer;
begin
  if coalesce(btrim(p_campus_name), '') = '' or coalesce(btrim(p_academic_year_name), '') = '' then
    raise exception 'campus_name ve academic_year_name zorunludur.' using errcode = '22023';
  end if;

  -- Kampüs henüz oluşturulmamışsa bu HATA değil, "kayıt yok" durumudur.
  select id into v_campus_id from public.campuses where name = p_campus_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'import', null);
  end if;

  -- Eğitim yılı henüz oluşturulmamışsa da aynı şekilde "kayıt yok".
  select id into v_year_id
    from public.academic_years
    where campus_id = v_campus_id and name = p_academic_year_name;
  if not found then
    return jsonb_build_object('hasImport', false, 'import', null);
  end if;

  -- Yalnız status='imported'; pending/failed/superseded hiçbir zaman
  -- "mevcut aktif yükleme" olarak seçilmez. Birden fazla 'imported' kaydı
  -- teorik olarak mümkün değildir (RPC her yeni başarılı importta öncekini
  -- superseded yapar) ama savunma amaçlı en güncel olan seçilir:
  -- imported_at DESC, eşitlikte created_at DESC.
  select * into v_import
    from public.timetable_imports
    where campus_id = v_campus_id
      and academic_year_id = v_year_id
      and status = 'imported'
    order by imported_at desc nulls last, created_at desc
    limit 1;

  if not found then
    return jsonb_build_object('hasImport', false, 'import', null);
  end if;

  -- Gerçek çocuk tablo sayıları AUTHORITATIVE kabul edilir; timetable_imports
  -- üzerindeki önceden saklanmış source_card_count/normalized_assignment_count
  -- ile karşılaştırılıp uyuşmazlık varsa hasCountMismatch=true ile işaretlenir
  -- (asla sessizce yanlış/eski sayı gösterilmez).
  select count(*) into v_teacher_count from public.teachers where timetable_import_id = v_import.id;
  select count(*) into v_class_count from public.school_classes where timetable_import_id = v_import.id;
  select count(*) into v_day_count from public.timetable_days where timetable_import_id = v_import.id;
  select count(*) into v_period_count from public.lesson_periods where timetable_import_id = v_import.id;
  select count(*) into v_card_count from public.timetable_cards where timetable_import_id = v_import.id;
  select count(*) into v_assignment_count from public.timetable_assignments where timetable_import_id = v_import.id;

  return jsonb_build_object(
    'hasImport', true,
    'import', jsonb_build_object(
      'sourceFilename', v_import.source_filename,
      'status', v_import.status,
      'campusName', p_campus_name,
      'academicYearName', p_academic_year_name,
      'importedAt', v_import.imported_at,
      'teacherCount', v_teacher_count,
      'classCount', v_class_count,
      'dayCount', v_day_count,
      'periodCount', v_period_count,
      'sourceCardCount', v_card_count,
      'normalizedAssignmentCount', v_assignment_count,
      'hasCountMismatch', (
        v_card_count <> v_import.source_card_count
        or v_assignment_count <> v_import.normalized_assignment_count
      )
    )
  );
end;
$$;

comment on function public.get_current_timetable_import_snapshot(text, text) is
  'Salt okunur: verilen kampüs+eğitim yılı için en güncel başarılı (status=imported) XML importunun özetini döner. Veri değiştirmez. Yalnız service_role çağırabilir.';

revoke all on function public.get_current_timetable_import_snapshot(text, text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.get_current_timetable_import_snapshot(text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.get_current_timetable_import_snapshot(text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.get_current_timetable_import_snapshot(text, text) to service_role;
  end if;
end
$$;

-- Bu migration hiçbir RLS policy eklemez ve mevcut policy'siz durumu değiştirmez.
