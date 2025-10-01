# auth.py
import threading
import time
import webbrowser
from flask import Flask, request, jsonify
import requests
from urllib.parse import quote_plus

# ====== Ваши ключи Miro OAuth ======
CLIENT_ID = "<redacted-long-id>"
CLIENT_SECRET = "<redacted-miro-client-secret>"
REDIRECT_URI = "http://localhost:8000/callback"
SCOPES = "boards:read team:read"

AUTH_URL = (
    "https://miro.com/oauth/authorize"
    f"?response_type=code&client_id={CLIENT_ID}"
    f"&redirect_uri={REDIRECT_URI}"
    f"&scope={quote_plus(SCOPES)}"
)

app = Flask(__name__)
auth_code = None

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
    """Авторизация в Miro через popup, без лишних страниц ожидания"""
    global auth_code
    auth_code = None

    def run_flask():
        app.run(port=8000, debug=False, use_reloader=False)

    th = threading.Thread(target=run_flask, daemon=True)
    th.start()

    print("🔐 Запускаю авторизацию в Miro…")
    webbrowser.open("http://localhost:8000/popup")

    for _ in range(300):  # ждём до 5 минут
        if auth_code:
            break
        time.sleep(1)

    if not auth_code:
        raise RuntimeError("Не получили код авторизации.")

    print("🔑 Обмениваю code на access_token…")
    return get_access_token(auth_code)
