"""Telegram login: the widget's signed payload becomes an HMAC-signed session cookie.

Only Telegram ids listed in allowed_user_ids may use the app; anyone else who logs in
sees "not in the access list".
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

BOT_TOKEN = CONFIG["bot_token"]
BOT_USERNAME = str(CONFIG.get("bot_username") or "").lstrip("@")
SECRET_KEY = CONFIG["secret_key"]
ALLOWED_USER_IDS = set(CONFIG["allowed_user_ids"])
# false only for plain-http local testing: browsers drop a Secure cookie over http.
COOKIE_SECURE = bool(CONFIG.get("cookie_secure", True))
COOKIE_NAME = "ty_session"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30

router = APIRouter()


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


def make_session_token(user_id: int) -> str:
    payload = f"{user_id}:{int(time.time()) + COOKIE_MAX_AGE}"
    signature = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def verify_session_token(token: str) -> int | None:
    try:
        parts = token.split(":")
        if len(parts) != 3:
            return None
        user_id, expires, signature = parts
        payload = f"{user_id}:{expires}"
        expected = hmac.new(SECRET_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
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


@router.post("/api/auth/telegram")
async def auth_telegram(request: Request):
    data = dict(await request.json())
    raw_data = dict(data)
    if not verify_telegram_data(data):
        return JSONResponse({"error": "Invalid Telegram data"}, status_code=401)
    user_id = int(raw_data["id"])
    response = JSONResponse({"ok": True, "user_id": user_id,
                             "whitelisted": is_whitelisted(user_id)})
    response.set_cookie(COOKIE_NAME, make_session_token(user_id), max_age=COOKIE_MAX_AGE,
                        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    return response


@router.get("/api/auth/check")
async def auth_check(request: Request):
    user_id = get_current_user(request)
    if user_id is None:
        return JSONResponse({"authenticated": False, "bot": BOT_USERNAME}, status_code=401)
    return JSONResponse({"authenticated": True, "user_id": user_id,
                         "whitelisted": is_whitelisted(user_id), "bot": BOT_USERNAME})


@router.post("/api/auth/logout")
async def auth_logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
