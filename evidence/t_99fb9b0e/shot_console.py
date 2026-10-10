"""Screenshot the LIVE facilitator console sign-in screen (t_99fb9b0e evidence)."""
import sys
from playwright.sync_api import sync_playwright

URL = "https://cvm-pwa.orangesync.tech/console/"
OUT = sys.argv[1]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/home/c03rad0r/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome")
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=2)
    resp = page.goto(URL, wait_until="networkidle", timeout=45000)
    print(f"status={resp.status} url={page.url}")
    page.wait_for_timeout(1200)
    page.screenshot(path=OUT, full_page=True)
    print("title:", page.title())
    print("--- visible text ---")
    print(page.inner_text("body")[:1200])
    browser.close()
print(OUT)
