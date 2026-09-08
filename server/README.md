# Nöbet2027 — Yerel İçe Aktarma Backend'i

Bu klasör, doğrulanmış XML ders programı sonucunu Supabase'e **kalıcı ve
atomik** biçimde kaydeden küçük bir Node/TypeScript/Express backend'i içerir.

## ⚠️ Güvenlik sınırı — MUTLAKA OKUYUN

- **Bu sürüm yalnızca yerel, tek kullanıcılı geliştirme içindir.** Auth,
  kullanıcı/üyelik modeli ve RLS erişim politikaları henüz yoktur.
- **Yerel API internete açılmamalıdır.** Yalnızca `127.0.0.1` üzerinde
  dinler (bkz. `server/index.ts` — `app.listen(port, "127.0.0.1", ...)`).
- **Port yönlendirme veya tünel (ngrok, Cloudflare Tunnel, vb.) kullanmayın.**
  Bu backend, `sb_secret_...` anahtarıyla RLS'yi bypass eden bir RPC'yi
  çağırabilir; internete açmak veritabanının tamamını korumasız bırakır.
- **Uygulama gerçek kullanıcılara deploy edilmeden önce** Supabase Auth ve
  kullanıcı↔kampüs üyeliğine dayalı RLS policy'leri eklenmelidir (ayrı bir
  migration ile — bu backend'in kapsamı dışında).
- **`sb_secret_...` yalnızca bu backend'in çalıştığı makinedeki
  `.env.local` dosyasında kalmalıdır.** Hiçbir zaman: React koduna,
  `VITE_` önekli bir değişkene, tarayıcı bundle'ına, `localStorage`'a, bir
  API cevabına, terminal çıktısına, rapora veya Git'e eklenmez.
- **Secret sızarsa**: Supabase Dashboard → Project Settings → API
  üzerinden o `sb_secret_...` anahtarını **silin ve yeni bir tane
  oluşturun**. Legacy `anon`/`service_role` anahtarlarını **yeniden
  etkinleştirmeyin** — bu proje yalnızca yeni `sb_publishable_.../sb_secret_...`
  anahtar sistemini kullanır.

## Mimari

```
Tarayıcı (src/)  →  yerel API (server/, 127.0.0.1)  →  Supabase RPC  →  Postgres
     |                        |
     |                sb_secret_... BURADA
     |                (yalnız server env'inde)
     └── hiçbir zaman Supabase'e doğrudan yazmaz
```

- Tarayıcı yalnızca `POST http://127.0.0.1:<port>/api/timetable-imports`
  isteği yapar — Supabase URL'sini veya herhangi bir anahtarı hiç bilmez.
- Backend, isteği **yeniden doğrular** (istemciye güvenilmez — bkz.
  `server/validation/importPayload.ts`), sonra tek bir Postgres RPC'sini
  (`public.import_timetable_snapshot`, bkz. `supabase/migrations/
  ..._create_single_campus_import_rpc.sql`) çağırır. Bu RPC tüm yazma
  işlemini TEK bir transaction içinde yapar: ya tamamen başarılı olur ya
  da hiçbir satır kalmaz.
- RPC yalnızca `service_role` (yani yalnızca bu backend'in sahip olduğu
  `sb_secret_...` anahtarı) tarafından çağrılabilir — `anon` ve
  `authenticated` rollerinin bu fonksiyonu çalıştırma izni yoktur.

## Klasör yapısı

```
server/
  index.ts              — Express app kurulumu, 127.0.0.1'de dinleme
  config.ts             — env okuma/doğrulama + merkezi kampüs/yıl adı
  supabase.ts           — server-only Supabase istemcisi (secret anahtarla)
  routes/
    timetableImports.ts — POST /api/timetable-imports
  services/
    importTimetable.ts  — RPC çağrısı
    toRpcPayload.ts      — camelCase istek → snake_case RPC payload dönüşümü
  validation/
    importPayload.ts    — zod şeması + referans bütünlüğü + iş kuralları
  __tests__/             — vitest + supertest testleri
```

## Ortam değişkenleri

`.env.example` dosyasını `.env.local` olarak kopyalayın ve
`SUPABASE_SECRET_KEY` değerini **kendi bilgisayarınızda elle** doldurun
(Supabase Dashboard → Project Settings → API → yeni anahtar sistemi →
`sb_secret_...`). Bu depo hiçbir zaman gerçek bir secret içermez.

| Değişken | Açıklama |
|---|---|
| `SUPABASE_URL` | Supabase proje URL'si (gizli değil). |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` — YALNIZCA `.env.local`'de, yalnızca bu makinede. |
| `LOCAL_API_PORT` | Backend'in dinlediği port (varsayılan 3001). |
| `ALLOWED_ORIGIN` | İzin verilen tek frontend origin'i (varsayılan `http://localhost:5173`). |

Kampüs adı ve eğitim yılı (`Kaplan Okulları · Üçevler Kampüsü`, `2026-2027`)
env değişkeni DEĞİLDİR — `server/config.ts` içinde merkezi sabitler olarak
tanımlıdır (tek-kampüs aşaması gereği).

## Çalıştırma

```bash
npm run dev        # frontend (Vite) + backend'i birlikte çalıştırır
npm run dev:web     # yalnız frontend
npm run dev:api      # yalnız backend (tsx watch server/index.ts)
```

`SUPABASE_SECRET_KEY` eksikse backend, bağlantı denemeden önce açık ve
güvenli bir hatayla (`MissingEnvError`) başlamayı reddeder.

## Import endpoint'i

`POST /api/timetable-imports` — frontend'in `buildImportPayload()` ile
ürettiği, zaten istemci tarafında doğrulanmış+normalize XML sonucunu kabul
eder. Backend bu veriye **güvenmez**: zod şeması + referans bütünlüğü +
iş kuralları (yinelenen source_id, negatif sıralar, tanımsız referanslar,
sayım uyuşmazlıkları, hatalı `mapping_status`, kritik doğrulama hatası)
ile yeniden doğrular, sonra RPC'yi çağırır. RPC de kendi tarafında
(Postgres) AYRICA doğrular — iki bağımsız katman.

Kritik (severity=`error`) doğrulama sorunu içeren bir XML **hiçbir zaman**
kaydedilmez — ne Node katmanında ne RPC'de.

Aynı eğitim yılı + aynı SHA-256 kombinasyonu tekrar gönderilirse RPC yeni
kayıt açmaz; mevcut importu `alreadyImported: true` ile döner.
