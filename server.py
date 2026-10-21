"""Trabajo Yebuchee — a self-hosted job search: tracker, scraping, ranking, /apply chat.

One process serves the web app from web/ and the API under /api/. The scheduler runs the
unattended work: scrape + rank every 3 hours, mail sync hourly, dead-link recheck at 06:00.
"""
import logging
import mimetypes
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from auth import router as auth_router
from db import init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

BASE_DIR = Path(__file__).parent
WEB_DIR = (BASE_DIR / "web").resolve()

# FileResponse takes its Content-Type from mimetypes, which doesn't know this extension.
# Served as text/plain, the manifest is ignored and the app can't be installed — which on
# iOS also means no push, since Safari only pushes to installed web apps.
mimetypes.add_type("application/manifest+json", ".webmanifest")


@asynccontextmanager
async def lifespan(app_instance):
    from apscheduler.schedulers.asyncio import AsyncIOScheduler
    from routes.puto_trabajo import (PT_TZ, reconcile_stale_runs, scheduled_mail_sync,
                                     scheduled_recheck, scheduled_scrape)

    reconcile_stale_runs()
    now = datetime.now(timezone.utc)
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(scheduled_mail_sync, "interval", hours=1, id="pt_mail_sync",
                      next_run_time=now + timedelta(minutes=2))
    # Link rot check before the working day: the morning list has no dead postings in it.
    scheduler.add_job(scheduled_recheck, "cron", hour=6, minute=0, id="pt_recheck",
                      timezone=PT_TZ)
    # Boards every 3h, then rank whatever came in. Offset from startup so a restart
    # doesn't fire a paid ranking run instantly.
    scheduler.add_job(scheduled_scrape, "interval", hours=3, id="pt_scrape",
                      next_run_time=now + timedelta(minutes=10))
    scheduler.start()
    yield
    scheduler.shutdown()


init_db()

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(auth_router)

from routes.puto_trabajo import router as pt_router  # noqa: E402  (after init_db)

app.include_router(pt_router)


# Must stay last: it catches every path the API routes above did not.
@app.get("/{path:path}")
async def web(path: str):
    target = (WEB_DIR / path).resolve() if path else WEB_DIR / "index.html"
    if target != WEB_DIR and WEB_DIR not in target.parents:
        return JSONResponse({"error": "Not found"}, status_code=404)
    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        return JSONResponse({"error": "Not found"}, status_code=404)
    # The page itself is never cached, so a deploy shows up on the next load; its
    # scripts and styles are cached for a day and versioned by ?v= in index.html.
    cache = "no-cache" if target.suffix in (".html", ".webmanifest") or target.name == "sw.js" \
        else "public, max-age=86400"
    return FileResponse(target, headers={"Cache-Control": cache})
