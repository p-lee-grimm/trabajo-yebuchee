"""Login: a Telegram account or a single password, chosen by `auth:` in config.yaml.

telegram (default) — the login widget's signed payload is checked against the bot token;
    only ids in allowed_user_ids get in, anyone else sees "not in the access list".
password — one password for the whole instance, stored as a salted scrypt hash
    (tools/hash-password). Everyone who knows it acts as the same user.

Either way the result is an HMAC-signed session cookie.
"""
import hashlib
import hmac
import time
from pathlib import Path

import yaml
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

BASE_DIR = Path(__file__).parent

with open(BASE_DIR / "config.yaml") as f:
    CONFIG = yaml.safe_load(f)

AUTH_METHOD = str(CONFIG.get("auth") or "telegram").strip().lower()
if AUTH_METHOD not in ("telegram", "password"):
    raise SystemExit(f"config.yaml: auth must be 'telegram' or 'password', not {AUTH_METHOD!r}")

SECRET_KEY = CONFIG["secret_key"]
BOT_TOKEN = str(CONFIG.get("bot_token") or "")
BOT_USERNAME = str(CONFIG.get("bot_username") or "").lstrip("@")
PASSWORD_HASH = str(CONFIG.get("password_hash") or "")
if AUTH_METHOD == "telegram" and not (BOT_TOKEN and CONFIG.get("allowed_user_ids")):
    raise SystemExit("config.yaml: auth: telegram needs bot_token and allowed_user_ids")
if AUTH_METHOD == "password" and not PASSWORD_HASH.startswith("scrypt$"):
    raise SystemExit("config.yaml: auth: password needs password_hash "
                     "(venv/bin/python tools/hash-password >> config.yaml)")

# In password mode there is one person; their data lives under this id.
PASSWORD_USER_ID = 1
ALLOWED_USER_IDS = ({PASSWORD_USER_ID} if AUTH_METHOD == "password"
                    else set(CONFIG["allowed_user_ids"]))
# false only for plain-http local testing: browsers drop a Secure cookie over http.
COOKIE_SECURE = bool(CONFIG.get("cookie_secure", True))
COOKIE_NAME = "ty_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30
# The password hash is part of the signing key, so changing the password ends every
# session signed under the old one.
SIGNING_KEY = SECRET_KEY + (PASSWORD_HASH if AUTH_METHOD == "password" else "")

# Failed password attempts per client IP: after 5 in a row, a minute's pause.
MAX_FAILURES, LOCKOUT_SECONDS = 5, 60
_failures: dict = {}

router = APIRouter()


def background_user_ids() -> list:
    """Whose data the scheduled scrape/rank/mail jobs act on."""
    if AUTH_METHOD == "password":
        return [PASSWORD_USER_ID]
    try:
        with open(BASE_DIR / "config.yaml") as handle:
            return (yaml.safe_load(handle) or {}).get("allowed_user_ids") or []
    except (OSError, ValueError):
        return []


def verify_telegram_data(data: dict) -> bool:
    check_hash = data.pop("hash", None)
    if not check_hash:
        return False
    filtered = {k: str(v) for k, v in data.items() if v is not None and v != ""}
    sorted_data = "\n".join(f"{k}={v}" for k, v in sorted(filtered.items()))
    secret = hashlib.sha256(BOT_TOKEN.encode()).digest()
    computed = hmac.new(secret, sorted_data.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed, check_hash):
        return False
    # A captured payload must not be replayable forever.
    try:
        return time.time() - int(data.get("auth_date", 0)) < 86400
    except (TypeError, ValueError):
        return False


def verify_password(password: str) -> bool:
    try:
        _, n, r, p, salt, digest = PASSWORD_HASH.split("$")
        computed = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                                  n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(computed.hex(), digest)


def make_session_token(user_id: int) -> str:
    payload = f"{user_id}:{int(time.time()) + COOKIE_MAX_AGE}"
    signature = hmac.new(SIGNING_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def verify_session_token(token: str) -> int | None:
    try:
        parts = token.split(":")
        if len(parts) != 3:
            return None
        user_id, expires, signature = parts
        payload = f"{user_id}:{expires}"
        expected = hmac.new(SIGNING_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            return None
        if int(expires) < int(time.time()):
            return None
        return int(user_id)
    except (ValueError, TypeError):
        return None


def is_whitelisted(user_id: int | None) -> bool:
    return user_id is not None and user_id in ALLOWED_USER_IDS


def get_current_user(request: Request) -> int | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    return verify_session_token(token)


def _session_response(user_id: int) -> JSONResponse:
    response = JSONResponse({"ok": True, "user_id": user_id,
                             "whitelisted": is_whitelisted(user_id)})
    response.set_cookie(COOKIE_NAME, make_session_token(user_id), max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    return response


@router.post("/api/auth/telegram")
async def auth_telegram(request: Request):
    if AUTH_METHOD != "telegram":
        return JSONResponse({"error": "Вход через Telegram выключен"}, status_code=404)
    data = dict(await request.json())
    raw_data = dict(data)
    if not verify_telegram_data(data):
        return JSONResponse({"error": "Invalid Telegram data"}, status_code=401)
    return _session_response(int(raw_data["id"]))


@router.post("/api/auth/password")
async def auth_password(request: Request):
    if AUTH_METHOD != "password":
        return JSONResponse({"error": "Вход по паролю выключен"}, status_code=404)
    # Behind nginx uvicorn takes the client address from X-Forwarded-For, which it trusts
    # only from the local proxy — so attempts are counted per real client.
    client = request.client.host if request.client else "?"
    count, since = _failures.get(client, (0, 0.0))
    if count >= MAX_FAILURES and time.time() - since < LOCKOUT_SECONDS:
        return JSONResponse({"error": "Слишком много попыток — подожди минуту"},
                            status_code=429)
    body = await request.json()
    if not verify_password(str(body.get("password") or "")):
        _failures[client] = (count + 1 if count < MAX_FAILURES else 1, time.time())
        return JSONResponse({"error": "Неверный пароль"}, status_code=401)
    _failures.pop(client, None)
    return _session_response(PASSWORD_USER_ID)


@router.get("/api/auth/check")
async def auth_check(request: Request):
    user_id = get_current_user(request)
    info = {"method": AUTH_METHOD, "bot": BOT_USERNAME}
    if user_id is None:
        return JSONResponse({"authenticated": False, **info}, status_code=401)
    return JSONResponse({"authenticated": True, "user_id": user_id,
                         "whitelisted": is_whitelisted(user_id), **info})


@router.post("/api/auth/logout")
async def auth_logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
