# Supabase — Nöbet2027 Ders Programı Şeması

Bu klasör, `xml/asc.xml` (aSc Timetables) formatından ayrıştırılan ders
programı verisini ileride kayıpsız biçimde saklayabilecek PostgreSQL şemasını
tanımlayan migration dosyalarını içerir.

**Bu aşamada bu şema hiçbir uzak Supabase projesine uygulanmadı.** Frontend
henüz bu tablolara bağlı değil (`npm run dev` ile açılan XML ekranı hâlâ
tamamen istemci tarafında çalışır, hiçbir ağ isteği yapmaz).

## Şemanın amacı

`src/lib/timetableXml/*` içindeki ayrıştırıcı (aSc XML → `TimetableImportResult`)
tarayıcıda çalışıyor ve sonucu yalnızca React state'inde tutuyor. Bu şema, o
sonucu ileride bir veritabanına yazmak istediğimizde ihtiyaç duyacağımız
tabloları önceden, dikkatli biçimde tasarlar — böylece gerçek entegrasyon
yapılacağı zaman şema tasarımı değil yalnızca "yazma" kodu yazılır.

## Import-snapshot yaklaşımı

Her XML yüklemesi bir `timetable_imports` satırıdır. O importa ait tüm
`teachers`, `school_classes`, `timetable_days`, `lesson_periods`, `subjects`,
`lessons`, `timetable_cards`, `timetable_assignments` satırları o importun
**anlık görüntüsüdür** (snapshot).

Bilinçli tasarım kararı: **farklı importlardaki aynı `source_id` değerleri
birleştirilmez.** İki ayrı XML yüklemesindeki `teacher id="T1"` kayıtları
veritabanında iki ayrı `teachers` satırı olarak kalır — otomatik olarak "aynı
öğretmen" sayılmaz. Bunun nedenleri:

- XML'in kaynağıyla bire bir izlenebilirlik korunur.
- Erken/hatalı bir "aynı kişi" varsayımı, ileride kişi eşleştirme (identity
  resolution) için ayrı, kasıtlı bir süreç/ekran gerektirecek — bu şemanın
  işi değil.
- Bir import'u tamamen silmek (`ON DELETE CASCADE`) güvenli ve öngörülebilir
  kalır: yalnızca o importa ait satırlar gider, başka hiçbir import etkilenmez.

Bu nedenle her çocuk tablo hem `id` hem `timetable_import_id` üzerinde bir
`UNIQUE` kısıt taşır ve tüm ilişkiler (`lesson_teachers`, `lesson_classes`,
`timetable_cards`, `timetable_assignments`) **composite foreign key**
kullanarak iki tarafın da aynı importa ait olmasını veritabanı seviyesinde
zorunlu kılar (bkz. migration içindeki `*_import_fk` kısıtları). Bu, "bir
assignment'ın teacher_id'si başka bir importtan gelmemeli" gibi kuralları
uygulama koduna değil PostgreSQL'e yaptırır — yerel olarak da doğrulandı
(bkz. aşağıdaki "Doğrulama" bölümü).

### `subjects` için neden `ON DELETE RESTRICT` (SET NULL değil)

`lessons.subject_id` ve `timetable_assignments.subject_id`, `subjects` tablosuna
composite FK ile bağlanır (`(subject_id, timetable_import_id) references
subjects (id, timetable_import_id)`). İlk taslakta bu FK'ler `ON DELETE SET
NULL` idi; bu **hatalıydı** ve yerel PostgreSQL'de fonksiyonel bir testle
doğrulanıp düzeltildi:

PostgreSQL, composite bir FK'de `ON DELETE SET NULL` dediğinizde FK'yi
oluşturan **tüm sütunları** NULL yapmaya çalışır — yalnız `subject_id`'yi
değil, `timetable_import_id`'yi de. `timetable_import_id` `NOT NULL`
olduğundan, kullanımdaki bir subject silinmeye çalışıldığında
`"null value in column timetable_import_id violates not-null constraint"`
hatasıyla işlem başarısız oluyordu.

PostgreSQL 15+'ta sütun listeli `ON DELETE SET NULL (subject_id)` (yalnız
belirtilen sütunu NULL yapan biçim) mevcuttur, ama hedef Supabase Postgres
sürümüne örtük bir bağımlılık yaratmamak için bu migration **`ON DELETE
RESTRICT`** kullanır: bir subject, herhangi bir `lessons` veya
`timetable_assignments` satırından referans alıyorsa **tek başına**
silinemez. Snapshot/import modelinde zaten bir subject'in kendi importundan
bağımsız tek başına silinmesine ihtiyaç yoktur — subject yalnızca ait olduğu
`timetable_imports` satırı `CASCADE` ile tamamen silinirken gider. Bu, hem
tekil-silme engelleme hem de tüm-import-cascade senaryoları için yerel
olarak ayrı ayrı test edildi (bkz. "Yerel doğrulama").

## Ham lesson/card ile normalize assignment ayrımı

Bu ayrım, mevcut frontend'deki "Plan Kartı" / "Atama Kaydı" ayrımının aynısıdır:

- **`timetable_cards`** = XML'deki ham `<card>` sayısı. Bir card, bir
  `lesson`'ın belirli bir gün+ders saatine yerleşimidir. Kaynak XML'de
  `<card>` için gerçek bir `id` alanı olmadığından, ayrıştırıcının ürettiği
  `card-{sıraNo}` sentetik anahtarı `source_card_key` sütununda saklanır.
- **`timetable_assignments`** = normalize edilmiş öğretmen×sınıf atama
  satırı. Bir `lesson`'ın `teacherIds`/`classIds` alanları virgülle ayrılmış
  birden çok değer içerebildiği için, tek bir `timetable_cards` satırı
  birden çok `timetable_assignments` satırına açılabilir.

**Bu iki sayı birbirine karıştırılmamalı** — `timetable_imports` tablosunda
da bilinçli olarak iki ayrı sütun var: `source_card_count` (ham) ve
`normalized_assignment_count` (normalize).

## `mapping_status` anlamları

`timetable_assignments.mapping_status`, bir atamanın `teacherIds × classIds`
kartezyen açılımından ne kadar güvenilir biçimde üretildiğini işaretler:

| Değer | Anlam |
|---|---|
| `exact` | lesson'da tek öğretmen + tek sınıf (1×1) — belirsizlik yok. |
| `expanded` | lesson'da öğretmen veya sınıftan yalnız biri çoklu (1×N ya da N×1) — ör. iki öğretmenin aynı sınıfı birlikte okutması. Kartezyen açılım makul kabul edilir. |
| `ambiguous` | lesson'da **hem** öğretmen **hem** sınıf çoklu (N×M). |

## Çoklu öğretmen × çoklu sınıf belirsizliği

Gerçek `xml/asc.xml` dosyası üzerinde yapılan incelemede (392 `<lesson>`
kaydından) **yalnızca 2 tanesi** hem çoklu öğretmen hem çoklu sınıf
içeriyordu — her ikisi de "KULÜP" tipi ortak etkinlik saatleriydi (ör. 5
sınıf × 7 öğretmen, 6 sınıf × 8 öğretmen). Bu kayıtlarda `groupids` sayısı
`classids` sayısıyla eşleşiyor ama `teacherids` ile eşleşmiyor — yani gerçek
"hangi öğretmen hangi sınıfla" eşleşmesi, XML'in düz (flat) nitelik
yapısından **kesin olarak çıkarılamıyor**. Bu durum bilinçli olarak
`ambiguous` diye işaretlenir; kartezyen çarpımın kesin doğru olduğu
iddia edilmez (bkz. `src/lib/timetableXml/ascAdapter.ts` içindeki
`AMBIGUOUS_CARTESIAN_MAPPING` uyarı kodu ve bu README'nin üstündeki not).

`lessons.source_group_ids` (`text[]`) bu ham `groupids` değerini kayıpsız
saklar — ileride bir `groups` ilişkisel modeli netleştiğinde, bu belirsizliği
gidermek için kullanılabilir.

## RLS: açık ama policy yok

Tüm uygulama tablolarında `ROW LEVEL SECURITY` **etkin**, ama bu migration
**hiçbir policy eklemiyor**. PostgreSQL'de bu durumda, tablo sahibi dışındaki
hiçbir rol (Supabase'in `anon` ve `authenticated` rolleri dahil) satır
okuyamaz/yazamaz — varsayılan "erişim yok"tur. Bu **yerel olarak test
edildi**: RLS açık bir tabloya `SELECT`/`INSERT` yetkisi GRANT edilse bile,
policy'siz bir rol `SELECT` sorgusunda 0 satır görüyor.

Politikalar eklenmedi çünkü kimlik doğrulama ve kullanıcı↔kampüs üyelik
modeli henüz tasarlanmadı. Bu model netleştiğinde, policy'ler **ayrı bir
migration** ile eklenecek.

**Service role anahtarı (RLS'yi bypass eder) hiçbir koşulda frontend kodunda
kullanılmamalıdır.** Bu migration da, proje de şu an hiçbir Supabase anahtarı
içermiyor.

## Neden henüz frontend bağlantısı yok

Bu aşamanın kapsamı yalnızca şema. Frontend hâlâ XML'i tamamen tarayıcıda
ayrıştırıp önizliyor, hiçbir ağ isteği yapmıyor. Supabase SDK'sı eklenmedi,
`.env` dosyası oluşturulmadı, hiçbir bağlantı dizesi/anahtar projeye
eklenmedi.

## Migration'ın ileride nasıl uygulanacağı

1. Bir Supabase projesi oluşturulur (bu migration'ın parçası **değildir**).
2. `supabase link --project-ref <ref>` ile proje bu klasöre bağlanır.
3. **Önce staging/test ortamında** `supabase db push` (veya CI/CD akışı)
   ile migration uygulanır ve frontend entegrasyonu orada doğrulanır.
4. Production'a uygulamadan önce mevcut veritabanının **yedeği alınır**
   (Supabase Dashboard → Database → Backups, veya `pg_dump`). Bu şema ilk
   migration olduğu için production'da henüz veri yoksa risk düşüktür, ama
   alışkanlık olarak yine de yedek alınmalıdır.
5. Policy'ler (auth/üyelik modeli netleştiğinde) ve gerçek import RPC/istemci
   kodu **ayrı migration'lar/PR'lar** olarak eklenir.

Bu migration için otomatik bir "down" (geri alma) migration'ı **yazılmadı** —
CREATE TABLE ağırlıklı bir ilk şema için elle yazılmış bir "down" script'i
yanlış bir güvenlik hissi verir (ör. veri kaybına yol açacak DROP'ları
"geri alınabilir" gibi göstermek). Geri alma gerekirse, yeni bir "forward"
migration olarak (ör. tabloları DROP eden) elle yazılmalı ve hangi verinin
kaybolacağı o migration'da açıkça belirtilmelidir.

## Gerçek veri seed edilmedi

Bu migration hiçbir gerçek okul, öğretmen, sınıf veya `xml/asc.xml`
içeriği barındırmıyor. Yalnızca şema (tablo/kısıt/index/trigger/RLS)
tanımlanıyor.

## Yerel doğrulama

Bu migration, projede zaten kurulu olan yerel PostgreSQL 17 servisine karşı
geçici bir veritabanında test edildi (`nobet2027_migration_check`). Migration
hatasız uygulandı (14 tablo, ortak `set_updated_at()` trigger fonksiyonu,
tüm index/kısıtlar), ardından en az şu 9 fonksiyonel senaryo gerçek SQL
işlemleriyle doğrulandı:

1. Kullanılmayan bir subject tek başına silinebiliyor.
2. Bir `lessons` satırınca kullanılan subject tek başına silinemiyor
   (`lessons_subject_import_fk` → `RESTRICT`, `foreign_key_violation`).
3. Bir `timetable_assignments` satırınca kullanılan subject tek başına
   silinemiyor (`timetable_assignments_subject_import_fk` → `RESTRICT`).
4. İlgili `timetable_imports` satırı silindiğinde subject/lesson/lesson
   ilişkileri (`lesson_teachers`, `lesson_classes`)/card/assignment
   kayıtlarının **tümü** yetim bırakmadan siliniyor — yani `RESTRICT`,
   aynı `DELETE` işleminin parçası olan tüm-import `CASCADE` zincirini
   bozmuyor.
5. Başka bir importtan `subject_id` bağlama (`lessons.subject_id` UPDATE)
   composite foreign key ile reddediliyor.
6. Başka bir importtan `teacher_id`/`school_class_id`/gün/ders saati/
   lesson bağlama girişimlerinin her biri (5 ayrı alt senaryo) composite
   foreign key ile reddediliyor.
7. Policy'siz RLS, tablo sahibi olmayan bir test rolüyle doğrulandı: role
   `SELECT` yetkisi GRANT edilmesine rağmen sorgu 0 satır döndürüyor.
8. Bir kampüste ikinci bir "aktif" eğitim yılı eklemek tek-aktif-yıl partial
   unique index'i ile reddediliyor.
9. Aynı import içinde yinelenen `source_id` eklemek unique kısıtla
   reddediliyor.

Test veritabanı ve test rolü doğrulama sonunda silindi; kalıcı hiçbir iz
bırakılmadı. **Hiçbir uzak Supabase projesine bağlanılmadı veya değişiklik
yapılmadı.**

## Dört bloklu nöbet modeli (20260910090000 → 20260910092000)

Nöbet planlaması "gün bazlı" modelden **gün + nöbet bloğu** modeline geçirildi.
Bu üç migration **yalnızca hazırlık** yapar: otomatik haftalık nöbet planı
üretmezler ve hiçbir nöbet ataması yazmazlar.

### Dört blok

| Sıra | Kod | Ad | Çakışan ders saati |
|---|---|---|---|
| 1 | `MORNING_BREAKS` | Sabah Teneffüs Bloğu | — |
| 2 | `LONG_BREAK_1` | Uzun Nöbet 1 | `5-OO` |
| 3 | `LONG_BREAK_2` | Uzun Nöbet 2 | `5-IO` |
| 4 | `AFTERNOON_BREAKS` | Öğleden Sonra Teneffüs Bloğu | — |

Sabah ve öğleden sonra blokları kısa teneffüsleri **topluca** temsil eder, bu
yüzden tek bir ders saatine bağlanamazlar (`conflict_period_name` NULL).
`conflict_period_name`, `lesson_periods.name` ile birebir eşleşir — gerçek
`xml/asc.xml` dosyasındaki `5-OO` (5. saat) ve `5-IO` (6. saat) adları
kararlıdır.

Bu dört satır **referans verisidir, seed/demo verisi değildir**: uygulamanın
tüm blok semantiği bunlara dayanır. Kodlar CHECK ile kapalı bir kümedir ve bir
BEFORE DELETE trigger'ı satırların silinmesini engeller (devre dışı bırakmak
için `is_active = false`).

### Nöbet yeri × blok gereksinimi

`duty_location_blocks` tablosundaki her satır "bu yer bu blokta aktiftir ve
**tam olarak 1** öğretmen ister" demektir. `duty_locations.capacity` sütunu
korunur ama blok modelinde **kullanılmaz** (bilgilendirme alanıdır).

Başlangıç eşlemesi **kararlı `short_code`** ile yapılır — değişebilen `name`
metni asla eşleştirme anahtarı olarak kullanılmaz:

| `short_code` | Bloklar | `allows_fixed_assignment` |
|---|---|---|
| `ILKOKUL1` | Sabah + Öğleden Sonra | `true` |
| `ILKOKUL2` | Sabah + Öğleden Sonra | `true` |
| `OGLEARASIILKOKUL` | Yalnız Uzun Nöbet 1 | `false` |
| diğer tüm silinmemiş yerler | dört blok | `false` |

`OGLEARASIILKOKUL`, Uzun Nöbet 1'de **tek** öğretmenle hem İLKOKUL-1 hem
İLKOKUL-2 koridorunu gözetir; sabit öğretmen başına ayrı destek görevi
oluşturulmaz.

Eşleme `is_active` durumuna bakmaz (soft-delete edilmişler hariç): blok
gereksinimi yerin **kalıcı** bir özelliğidir, o anki aktifliğinin değil — pasif
bir yer yeniden aktif edildiğinde tanımı hazır olmalıdır. Analiz zaten yalnız
aktif yerleri sayar.

Bu kurallar okulun doğrulanmış iş kurallarıdır ve **kullanıcı arayüzünden
değiştirilemez**; Nöbet Yerleri ekranında salt-okunur rozet olarak gösterilir.
Yeni oluşturulan her nöbet yeri dört bloğa bağlanır ve sabit nöbete kapalıdır
(`create_duty_location` RPC'si aynı transaction içinde halleder).

### Sabit nöbet

Sabit nöbet **yalnız** `allows_fixed_assignment = true` olan yerlere
verilebilir. Zorlama frontend filtresinde değil, `create_fixed_duty_assignment`
RPC'sindedir: filtre aşılırsa (eski sekme, doğrudan HTTP/RPC çağrısı) kontrollü
`{status:"location_not_fixed_eligible"}` döner.

Sabit öğretmen o gün **başka hiçbir** nöbet görevine aday olamaz — bu kural
blok modelinde de **gün** düzeyindedir:

| Blok | Sabit öğretmenin durumu |
|---|---|
| Sabah | Sabit koridorunda görevli |
| Uzun Nöbet 1 | Korumalı dinlenme |
| Uzun Nöbet 2 | Nöbet gerekmiyor (katta ders var) |
| Öğleden Sonra | Sabit koridorunda görevli |

Bu yüzden sabit günün **dört bloğu da** uygunluk matrisinde kilitlidir
(`fixed_day_locked`). Gün×öğretmen ve gün×yer benzersizlikleri ile mevcut
`pg_advisory_xact_lock('fixed-duty:{year}:{day}')` serileştirmesi aynen korundu
— iki gerçek eşzamanlı bağlantıyla yeniden doğrulandı (aşağıya bakın).

### Öğretmen uygunluğu: eski tablo korunur

`teacher_duty_availabilities` (gün bazlı) **hiç değiştirilmedi**: sütun
eklenmedi, satır silinmedi, satır taşınmadı. Blok bazlı uygunluk **ayrı** bir
tabloya yazılır: `teacher_duty_block_availabilities`, benzersizlik
`(teacher_duty_setting_id, duty_location_id, day_order, duty_block_id)`.

Sonuç bilinçlidir: migration uygulandıktan sonra eski tablo **artık yazılmaz**
ve donmuş bir denetim (audit) kaydı hâline gelir. `get_teacher_duty_matrix`
onu `legacySelectedCells` alanında salt-okunur döndürür — "veri kaybolmadı"
bunun üzerinden görülebilir.

`get_teacher_duty_matrix` / `save_teacher_duty_matrix` **imzaları değişmedi**
(`p_cells` zaten `jsonb`), böylece mevcut GRANT'ler geçerli kalır ve fonksiyon
overload'u oluşmaz. `p_cells` öğe biçimi artık
`{duty_location_id, day_order, duty_block_id}`.

`selectedCells` alanı `selectedBlockCells` olarak **yeniden adlandırıldı**:
eski adın blok bilgisi taşımayan veriyle dönmeye devam etmesi, çağıranın
sessizce yanlış bir matris çizmesine yol açardı.

Kaydetmenin kontrollü red gerekçeleri: `day_order_out_of_range`,
`duty_location_not_available`, `duty_block_not_available`,
`block_not_allowed_for_location` (yeni), `lesson_conflict` (yeni) ve
`fixed_day_locked`.

### Veri backfill'i AYRI ve AYRICA ONAYLANIR

Bu migration'lar **hiçbir gerçek uygunluk verisini kopyalamaz**.
`backfill_teacher_duty_block_availabilities(p_dry_run, p_apply_lesson_conflict_filter)`
yalnızca **tanımlanır**, çalıştırılmaz:

- `p_dry_run` **varsayılanı `true`** — yanlışlıkla çağrılsa bile hiçbir şey
  yazmaz, yalnız sayar. Yazmak için açıkça `p_dry_run => false` gerekir.
- Taşıma kuralı: her eski `(ayar, yer, gün)` satırı, o **yerin** tanımlı
  **her bloğuna** açılır (dört bloklu yer → 4 satır, `ILKOKUL1` → 2,
  `OGLEARASIILKOKUL` → 1).
- `p_apply_lesson_conflict_filter => true` verilirse `5-OO`/`5-IO` çakışan
  satırlar hiç üretilmez. Varsayılan `false`'tur: eski veri kullanıcının
  **beyan ettiği** tercihtir ve backfill onu daraltmamalıdır; ders çakışması
  zaten hem kaydetmede hem analizde ayrıca uygulanır.
- İdempotent (`ON CONFLICT DO NOTHING`); eski tabloya ve mevcut blok
  satırlarına dokunmaz. Hiç eşlenemeyen eski satırlar (ör. soft-delete edilmiş
  yere ait geçmiş tercihler) `legacyRowsWithoutBlockMapping` olarak raporlanır
  ve yerinde bırakılır.

### Planlanabilirlik analizi (salt okunur)

`analyze_duty_plan_feasibility(campus, year)` bir plan **üretmez** ve hiçbir
atama yazmaz. Neden basit sayı karşılaştırması yetmez:

> "Bu blokta 4 görev var, 9 aday öğretmen var → sorun yok" çıkarımı YANLIŞTIR.
> Bir öğretmen aynı gün **yalnız bir** normal blok alabilir; aynı 9 öğretmen
> dört bloğun hepsinde aday görünüyor olabilir. Dahası adaylar belirli nöbet
> yerlerine bağlıdır: 10 aday ve 10 görev varken bile, adayların 9'u aynı tek
> yere bağlıysa plan üretilemez.

Bu yüzden her gün için gerçek bir **iki parçalı (bipartite) maksimum
eşleştirme** hesaplanır (Kuhn artırıcı yol yöntemi, `duty_feasibility_augment`
saf yardımcı fonksiyonuyla). Görevler (blok sırası, `sort_order`, ad) ve
öğretmenler (ad, `source_id`) **sabit** bir sırayla numaralandırılır: eşleştirme
boyutu zaten sıradan bağımsızdır, sabit sıra ayrıca **hangi** görevlerin açıkta
kaldığının çağrılar arasında değişmemesini sağlar.

Sabit nöbete uygun yerler (`ILKOKUL1`/`ILKOKUL2`) normal eşleştirme havuzuna
**hiç girmez**: yalnız sabit atama ile karşılanırlar, eksikleri
`missingFixedAssignments` olarak raporlanır. Sabit öğretmen o gün aday
havuzundan tamamen çıkarılır.

Rapor, her blok için hem `independentShortfall` (bloğu **tek başına** ele alan
naif karşılaştırma) hem `matchingUncovered` (gerçek eşleştirme sonrası açık)
değerlerini verir; ikincisi her zaman ≥ birincisidir ve asıl bakılması gereken
değerdir. Karşılanamayan her görev `no_candidate` / `matching_conflict` /
`missing_fixed_assignment` gerekçesiyle etiketlenir.

Frontend karşılığı: **Planlanabilirlik Analizi** sayfası
(`/planlanabilirlik-analizi`, `GET /api/duty-plan/feasibility`). Sayfa
bilinçli olarak hiçbir yazma eylemi içermez.

### Yerel doğrulama

Uzak Supabase'e **hiçbir bağlantı kurulmadı**; migration push edilmedi, uzak
veri üzerinde hiçbir yazma çağrısı yapılmadı. Doğrulama, yerel PostgreSQL 17'de
iki geçici veritabanında yapıldı (`nobet2027_block_check`,
`nobet2027_block_data`) ve şunlar gerçek SQL işlemleriyle sınandı:

1. Tüm migration zinciri (15 dosya) baştan sona hatasız uygulanıyor.
2. Blok eşlemesi **mevcut** nöbet yeri satırları üzerinde doğru kuruluyor:
   `ILKOKUL1`/`ILKOKUL2` → 2 blok + sabit nöbete uygun; `OGLEARASIILKOKUL` →
   1 blok; `ON-BAH`/`YEMEK`/pasif `SPOR` → 4 blok; soft-delete edilmiş `ARSIV`
   → eşlenmiyor.
3. Sabit nöbet uygun olmayan yerlere (`ON-BAH`, `OGLEARASIILKOKUL`)
   `location_not_fixed_eligible` ile reddediliyor; `ILKOKUL1`'e kabul ediliyor.
4. `get_fixed_duty_assignments`, `dutyLocations` listesinde yalnız iki ilkokul
   koridorunu döndürüyor.
5. `lessonConflicts`, `5-OO` dersi olan öğretmen için (Pazartesi, Uzun Nöbet 1)
   çiftini döndürüyor.
6. Kaydetme redleri: `lesson_conflict`, `block_not_allowed_for_location`,
   `duty_location_not_available` (pasif yer), `fixed_day_locked` (sabit gün).
7. Optimistic concurrency korunuyor: doğru `expectedUpdatedAt` → `ok`, eski
   değer → `conflict` ve satır değişmiyor.
8. Eski `teacher_duty_availabilities` tablosu tüm bu işlemler boyunca satır
   sayısı ve içeriğiyle **değişmedi**.
9. Backfill dry-run hiçbir satır yazmıyor; aday sayısı doğru (`ON-BAH` → 4,
   `OGLEARASIILKOKUL` → 1), eşlenemeyen eski satır raporlanıyor. Ders
   çakışması filtresi açıldığında `5-OO` dersi olan öğretmenin Uzun Nöbet 1
   satırı aday kümesinden düşüyor (9 → 8).
10. Analiz, "bağımsız blok sayımı yeterli görünüyor ama gerçek eşleştirme açık
    buluyor" durumunu doğru raporluyor: tek öğretmenin `ON-BAH`'ın dört
    bloğunda da uygun olduğu senaryoda `LONG_BREAK_2` için
    `independentShortfall = 0` iken `matchingUncovered = 2`.
11. Eksik sabit atama (`ILKOKUL2`, Pazartesi) `missingFixedAssignments` ve
    `missing_fixed_assignment` gerekçesiyle raporlanıyor; sıradan öğretmenle
    doldurulabilirmiş gibi gösterilmiyor.
12. Ders çakışması nedeniyle elenen öğretmenler ve o görevin
    `candidateCount = 0` olması birlikte raporlanıyor.
13. **Eşzamanlılık:** açık bir transaction'da `create_fixed_duty_assignment`
    kilidi tutulurken, ikinci bir bağlantıdan aynı güne
    `save_teacher_duty_matrix` çağrıldı. İkinci bağlantı ~2 sn **bloklandı**,
    COMMIT'ten sonra **güncel** sabit nöbeti görüp `fixed_day_locked` döndürdü —
    kilitsiz yazma yarışı yok.

Test veritabanları doğrulama sonunda silindi; kalıcı iz bırakılmadı.
