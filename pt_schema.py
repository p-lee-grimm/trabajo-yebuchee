"""Schema of the job-search app (Trabajo Yebuchee): every pt_* table and its migrations.

Kept apart from db.py so the app can be exported as a standalone repository with the
same schema code; db.init_db() calls it on the shared connection.
"""


def init_pt_schema(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            date TEXT NOT NULL DEFAULT (date('now')),
            company TEXT NOT NULL,
            sector TEXT DEFAULT '',
            role TEXT DEFAULT '',
            role_type TEXT DEFAULT '',
            channel TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'applied',
            contact_person TEXT DEFAULT '',
            fit_rating INTEGER,
            notes TEXT DEFAULT '',
            cv_file TEXT DEFAULT '',
            cover_letter_file TEXT DEFAULT '',
            source TEXT DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    pt_app_cols = [r[1] for r in conn.execute("PRAGMA table_info(pt_applications)").fetchall()]
    if "interview_at" not in pt_app_cols:
        conn.execute("ALTER TABLE pt_applications ADD COLUMN interview_at TEXT DEFAULT ''")
    # Докуда дошёл отклик — это не то же самое, что чем он кончился. У отказа по резюме и
    # отказа после финала один и тот же status = 'rejected', и воронку по нему не построить.
    # stage — максимальная достигнутая ступень ('' | screening | tech | final | offer); она
    # не откатывается назад, когда приходит отказ.
    if "stage" not in pt_app_cols:
        conn.execute("ALTER TABLE pt_applications ADD COLUMN stage TEXT NOT NULL DEFAULT ''")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_app_user ON pt_applications(user_id, status)")
    # Воронка спрашивает не «где отклик сейчас», а «через что он прошёл»: отказ после
    # интервью и отказ сразу — разные вещи, а в pt_applications.status видно только
    # последнее состояние. Пишем каждую смену статуса; для старых строк воронка
    # откатывается на interview_at и текущий статус.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_app_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            app_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_app_events ON pt_app_events(user_id, app_id, id)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            title TEXT DEFAULT '',
            company TEXT DEFAULT '',
            location TEXT DEFAULT '',
            remote TEXT DEFAULT '',
            salary TEXT DEFAULT '',
            deadline TEXT DEFAULT '',
            description TEXT DEFAULT '',
            portal TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'new',
            rank_score INTEGER,
            rank_verdict TEXT DEFAULT '',
            strengths TEXT DEFAULT '[]',
            gaps TEXT DEFAULT '[]',
            rank_date TEXT DEFAULT '',
            first_seen TEXT NOT NULL DEFAULT (date('now')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    pt_job_cols = [r[1] for r in conn.execute("PRAGMA table_info(pt_jobs)").fetchall()]
    if "published_at" not in pt_job_cols:
        conn.execute("ALTER TABLE pt_jobs ADD COLUMN published_at TEXT DEFAULT ''")
    # Link rot: postings disappear silently. The recheck run stamps checked_at on every
    # job it looks at and dead_at/dead_reason on the ones whose URL is gone, instead of
    # overwriting status — the rank and the shortlist flag are still worth keeping, and a
    # posting that comes back just gets dead_at cleared on the next pass.
    for col in ("checked_at", "dead_at", "dead_reason"):
        if col not in pt_job_cols:
            conn.execute(f"ALTER TABLE pt_jobs ADD COLUMN {col} TEXT DEFAULT ''")
    # Pay, filled by the ranking pass: what the posting itself states (salary_stated),
    # what to ask for (salary_ask) and what that rests on (salary_basis). salary_ask_eur
    # is the same ask normalised to EUR/month so the UI can sort and compare; it is null
    # whenever the currency or period could not be resolved, never a guess.
    for col in ("salary_stated", "salary_ask", "salary_basis"):
        if col not in pt_job_cols:
            conn.execute(f"ALTER TABLE pt_jobs ADD COLUMN {col} TEXT DEFAULT ''")
    if "salary_ask_eur" not in pt_job_cols:
        conn.execute("ALTER TABLE pt_jobs ADD COLUMN salary_ask_eur INTEGER")
    # Where to actually read the posting when `url` is a paid-click redirect (whatjobs)
    # that usually lands on a search page. `url` stays the dedupe key; this is display only.
    if "page_url" not in pt_job_cols:
        conn.execute("ALTER TABLE pt_jobs ADD COLUMN page_url TEXT DEFAULT ''")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_jobs_url ON pt_jobs(user_id, url)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_jobs_status ON pt_jobs(user_id, status, rank_score)")
    # Public share links for one artifact each. The token is the whole authorisation, so
    # nothing here is guessable from a filename: /artifact?path=cv/main_<company>.pdf is
    # predictable, /artifact/<token> is not. Revoking deletes the row, so a leaked link
    # can be killed without touching the file.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_shares (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            label TEXT DEFAULT '',
            hits INTEGER NOT NULL DEFAULT 0,
            last_hit TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_shares_user ON pt_shares(user_id, created_at)")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_shares_path ON pt_shares(user_id, path)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'running',
            params TEXT DEFAULT '{}',
            log TEXT DEFAULT '',
            result TEXT DEFAULT '',
            cost_usd REAL DEFAULT 0,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT DEFAULT ''
        )
    """)
    pt_run_cols = [r[1] for r in conn.execute("PRAGMA table_info(pt_runs)").fetchall()]
    for col in ("progress", "total"):
        if col not in pt_run_cols:
            conn.execute(f"ALTER TABLE pt_runs ADD COLUMN {col} INTEGER DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_runs_user ON pt_runs(user_id, started_at)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            name TEXT DEFAULT '',
            industry TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    pt_co_cols = [r[1] for r in conn.execute("PRAGMA table_info(pt_companies)").fetchall()]
    if "banned" not in pt_co_cols:
        conn.execute("ALTER TABLE pt_companies ADD COLUMN banned INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_companies ON pt_companies(user_id, key)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_mail (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            message_id TEXT NOT NULL,
            from_addr TEXT DEFAULT '',
            from_name TEXT DEFAULT '',
            subject TEXT DEFAULT '',
            sent_at TEXT DEFAULT '',
            snippet TEXT DEFAULT '',
            state TEXT NOT NULL DEFAULT 'new',
            signal TEXT DEFAULT '',
            company TEXT DEFAULT '',
            interview_at TEXT DEFAULT '',
            confidence TEXT DEFAULT '',
            evidence TEXT DEFAULT '',
            app_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_mail_msgid ON pt_mail(user_id, message_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_mail_state ON pt_mail(user_id, state)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            job_id INTEGER,
            title TEXT DEFAULT '',
            session_id TEXT DEFAULT '',
            cost_usd REAL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_chats_user ON pt_chats(user_id, updated_at)")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT DEFAULT '',
            state TEXT NOT NULL DEFAULT 'done',
            cost_usd REAL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_chat_msgs ON pt_chat_messages(chat_id, id)")
    # granted: standing per-chat grants, as rule strings from pt_gatekeeper.rule_for().
    # applied: the «Откликнулся» flag — the chat is done, hide it from the dock by default.
    pt_chat_cols = [r[1] for r in conn.execute("PRAGMA table_info(pt_chats)").fetchall()]
    if "granted" not in pt_chat_cols:
        conn.execute("ALTER TABLE pt_chats ADD COLUMN granted TEXT DEFAULT ''")
    if "applied" not in pt_chat_cols:
        conn.execute("ALTER TABLE pt_chats ADD COLUMN applied INTEGER NOT NULL DEFAULT 0")
        conn.execute("ALTER TABLE pt_chats ADD COLUMN applied_at TEXT DEFAULT ''")
    # One row per "the chat session wants to do X" question. The gatekeeper hook writes
    # the row and blocks polling it; the browser answers it through /access-requests.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_access_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            message_id INTEGER DEFAULT 0,
            tool_name TEXT NOT NULL,
            tool_input TEXT DEFAULT '',
            rule TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            state TEXT NOT NULL DEFAULT 'pending',
            scope TEXT DEFAULT '',
            expires_at INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            decided_at TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_access_chat "
                 "ON pt_access_requests(chat_id, state)")
    # LinkedIn connections, imported from an export. company_key is the normalised join
    # key against pt_jobs.company / pt_applications.company — see _contact_key().
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            first_name TEXT DEFAULT '',
            last_name TEXT DEFAULT '',
            company TEXT DEFAULT '',
            company_key TEXT DEFAULT '',
            position TEXT DEFAULT '',
            bucket TEXT DEFAULT '',
            tier TEXT DEFAULT '',
            last_msg TEXT DEFAULT '',
            msgs_from_them INTEGER DEFAULT 0,
            msgs_to_them INTEGER DEFAULT 0,
            endorsed_me INTEGER DEFAULT 0,
            recommended_me INTEGER DEFAULT 0,
            co_applied INTEGER DEFAULT 0,
            url TEXT DEFAULT '',
            imported_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_contacts_url "
                 "ON pt_contacts(user_id, url)")
    # One row per browser that asked for push. `endpoint` is the push service URL the
    # browser handed us and is the identity of the subscription — the same browser
    # re-subscribing returns the same endpoint, so it must be unique or every page load
    # would add a duplicate and every notification would arrive N times.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pt_push_subs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            user_agent TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_ok_at TEXT DEFAULT '',
            last_error TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_pt_push_endpoint "
                 "ON pt_push_subs(endpoint)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pt_contacts_company "
                 "ON pt_contacts(user_id, company_key)")
