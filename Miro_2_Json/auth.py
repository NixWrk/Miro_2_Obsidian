# auth.py
import threading
import time
import os
import subprocess
import webbrowser
from flask import Flask, request, jsonify
import requests
from urllib.parse import quote_plus

# ====== Miro OAuth ======
CLIENT_ID = os.environ.get("MIRO_CLIENT_ID", "<redacted-long-id>")
CLIENT_SECRET = os.environ.get("MIRO_CLIENT_SECRET", "<redacted-miro-client-secret>")
REDIRECT_URI = os.environ.get("MIRO_REDIRECT_URI", "http://localhost:8000/callback")
SCOPES = os.environ.get("MIRO_SCOPES", "boards:read team:read")

AUTH_URL = (
    "https://miro.com/oauth/authorize"
    f"?response_type=code&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&scope={quote_plus(SCOPES)}"
)

app = Flask(__name__)
auth_code = None
_flask_started = False


def _yandex_browser_candidates():
    return [
        os.environ.get("YANDEX_BROWSER_PATH", ""),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Yandex", "YandexBrowser", "Application", "browser.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Yandex", "YandexBrowser", "Application", "browser.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Yandex", "YandexBrowser", "Application", "browser.exe"),
    ]


def open_in_yandex(url: str) -> bool:
    for candidate in _yandex_browser_candidates():
        if candidate and os.path.isfile(candidate):
            subprocess.Popen([candidate, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
    return False


def open_authentication_page() -> bool:
    """Open the real Miro OAuth page directly.

    The old /popup route is kept for compatibility, but opening a browser page
    that calls window.open() is fragile: popup blockers can prevent the auth tab
    from appearing. A direct OAuth URL behaves like an ordinary browser open.
    """
    if open_in_yandex(AUTH_URL):
        return True
    return bool(webbrowser.open(AUTH_URL))

@app.route("/popup")
def popup():
    # Минимальная страница — сразу открывает Miro и закрывается
    return f"""
    <html>
        <body>
            <script>
                var win = window.open("{AUTH_URL}", "MiroAuth", "width=600,height=800");
                window.close();
            </script>
        </body>
    </html>
    """


@app.route("/callback")
def callback():
    global auth_code
    auth_code = request.args.get("code")
    return """
        <html>
            <body>
                <script>
                    window.close();
                </script>
                <p>Авторизация завершена. Это окно можно закрыть.</p>
            </body>
        </html>
    """


def get_access_token(code: str) -> str:
    token_url = "https://api.miro.com/v1/oauth/token"
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    r = requests.post(token_url, data=payload, timeout=30)
    r.raise_for_status()
    return r.json()["access_token"]


def authorize_and_get_token() -> str:
    """Авторизация в Miro через popup, без лишних страниц ожидания.
    Flask-сервер запускается только один раз за жизнь процесса —
    повторные вызовы переиспользуют уже работающий сервер на порту 8000.
    """
    global auth_code, _flask_started
    auth_code = None

    if not _flask_started:
        def run_flask():
            app.run(port=8000, debug=False, use_reloader=False)

        th = threading.Thread(target=run_flask, daemon=True)
        th.start()
        _flask_started = True
        time.sleep(0.5)  # даём серверу подняться перед открытием браузера

    print("🔐 Запускаю авторизацию в Miro…")
    if not open_authentication_page():
        raise RuntimeError(
            "Не удалось открыть браузер автоматически. "
            f"Откройте ссылку вручную: {AUTH_URL}"
        )

    for _ in range(300):  # ждём до 5 минут
        if auth_code:
            break
        time.sleep(1)

    if not auth_code:
        raise RuntimeError("Не получили код авторизации.")

    print("🔑 Обмениваю code на access_token…")
    return get_access_token(auth_code)
