from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "artifacts" / "substitution-flow.png"
OUTPUT.parent.mkdir(exist_ok=True)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.goto("http://localhost:5173/ders-yerine-gorevlendirme")
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name="Ders Yerine Görevlendirme").wait_for()
    assert page.get_by_role("navigation", name="Görevlendirme aşamaları").is_visible()
    assert page.get_by_role("button", name="Dersleri getir ve devam et").is_visible()
    page.locator(".sub-header-actions button").nth(1).click()
    page.get_by_role("heading", name="Günlük görevlendirme listeleri").wait_for()
    page.get_by_role("button", name="Yeni yokluk").click()
    page.get_by_role("heading", name="Yokluğu tanımlayın").wait_for()
    assert page.evaluate("document.body.scrollWidth <= window.innerWidth")
    page.screenshot(path=str(OUTPUT), full_page=True)
    assert not console_errors, console_errors
    browser.close()

print(f"UI_OK {OUTPUT}")
