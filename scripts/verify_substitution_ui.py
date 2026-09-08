import json
from playwright.sync_api import sync_playwright

def fulfill(route, payload):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def api(route):
        url = route.request.url
        if "/api/substitutions/preparation" in url:
            lessons = []
            if "teacherSourceId=" in url:
                lessons = [{"key":"2026-09-07:11111111-1111-4111-8111-111111111111","assignmentDate":"2026-09-07","timetableCardId":"11111111-1111-4111-8111-111111111111","periodOrder":1,"periodName":"1. Saat","startsAt":"08:30","endsAt":"09:10","subjectName":"Matematik","classNames":"7/A"}]
            return fulfill(route,{"hasImport":True,"dailySoftLimit":5,"teachers":[{"sourceId":"T1","name":"Ayşe Öğretmen","branch":"Matematik"}],"lessons":lessons})
        if "/api/substitutions/lists" in url:
            return fulfill(route,{"items":[]})
        if "/api/substitutions/compensation-types" in url:
            return fulfill(route,{"items":[{"id":"22222222-2222-4222-8222-222222222222","name":"Sabah Nöbeti","systemCode":None,"entryMode":"manual","isActive":True,"rates":[{"id":"33333333-3333-4333-8333-333333333333","effectiveFrom":"2026-09-01","unitRate":100}]}]})
        if "/api/substitutions/payroll" in url:
            return fulfill(route,{"periodStart":"2026-08-31","periodEnd":"2026-09-27","status":"open","periodId":None,"totals":[{"teacher_source_id":"T1","teacher_name_snapshot":"Ayşe Öğretmen","total_quantity":1,"total_amount":100,"breakdown":[{"type":"Sabah Nöbeti","quantity":1,"amount":100}]}],"lines":[{"source_id":"44444444-4444-4444-8444-444444444444","source_kind":"manual","teacher_name_snapshot":"Ayşe Öğretmen","duty_date":"2026-09-07","compensation_type_name_snapshot":"Sabah Nöbeti","quantity":1,"unit_rate_snapshot":100,"amount_snapshot":100,"detail_snapshot":"Sabah görevi","rate_missing":False}]})
        return fulfill(route,{})

    page.route("**/api/substitutions/**", api)
    page.goto("http://127.0.0.1:5173/ders-yerine-gorevlendirme")
    page.wait_for_load_state("networkidle")
    assert page.get_by_role("heading", name="Ders Yerine Görevlendirme").is_visible()
    page.get_by_label("Öğretmen").select_option("T1")
    page.get_by_role("button", name="Dersleri Getir").click()
    page.get_by_text("Tüm gün kapsanacak dersler").wait_for()
    assert page.get_by_role("checkbox").is_disabled()

    page.goto("http://127.0.0.1:5173/puantaj")
    page.wait_for_load_state("networkidle")
    assert page.get_by_text("Açık · geçici toplamlar").is_visible()
    assert page.locator("table").count() == 2
    assert not errors, errors
    print("UI_OK")
    browser.close()
