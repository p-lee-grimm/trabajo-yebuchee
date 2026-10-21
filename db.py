import sqlite3
from pathlib import Path

from pt_schema import init_pt_schema

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "data" / "app.db"


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    init_pt_schema(conn)
    conn.commit()
    conn.close()


def get_db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn
