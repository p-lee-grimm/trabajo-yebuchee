# Setup guide

[Русская версия](SETUP.ru.md)

This guide takes a fresh Linux server to a working instance: install, keys and secrets,
first login, filling in your profile, and tuning which jobs get collected and how they are
scored. The web interface itself is in Russian.

- [1. What you need](#1-what-you-need)
- [2. Install system packages](#2-install-system-packages)
- [3. Install Claude Code](#3-install-claude-code)
- [4. Get the code](#4-get-the-code)
- [5. Keys and secrets](#5-keys-and-secrets)
- [6. Search settings in config.yaml](#6-search-settings-in-configyaml)
- [7. Run it](#7-run-it)
- [8. First login and your profile](#8-first-login-and-your-profile)
- [9. Which jobs get collected: sources.json](#9-which-jobs-get-collected-sourcesjson)
- [10. How jobs are scored: ranking_rules.md](#10-how-jobs-are-scored-ranking_rulesmd)
- [11. Daily use](#11-daily-use)
- [12. Environment variables](#12-environment-variables)
- [13. Backups and updates](#13-backups-and-updates)
- [14. Troubleshooting](#14-troubleshooting)

## 1. What you need

| | |
|---|---|
| Server | Linux (Debian/Ubuntu assumed below), 2–3 GB RAM, ~3 GB disk with full TeX |
| Domain | A domain or subdomain pointing at the server, with HTTPS. The session cookie (and the Telegram login widget) only work over https. |
| Python | 3.12 **with the `sqlite3` module** (`python3.12 -c "import sqlite3"` must not fail) |
| Claude | A Claude subscription or an Anthropic API key, used through the Claude Code CLI |
| Login | Either a Telegram bot (free, two minutes) or just a password |

One instance serves one job seeker. Everyone listed in `allowed_user_ids` sees the same
profile, sources and documents.

## 2. Install system packages

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv git nginx \
    texlive-latex-base texlive-latex-recommended texlive-latex-extra \
    texlive-luatex texlive-xetex texlive-fonts-extra poppler-utils
```

- `texlive-*` builds the CV (moderncv, LuaLaTeX) and the cover letter (XeLaTeX).
  `texlive-fonts-extra` is large (~1.7 GB); the CV only needs the `fontawesome5` and
  `academicons` packages from it, so if disk is tight you can install those two from CTAN
  into `/usr/local/share/texmf` instead (copy each package whole, then `sudo mktexlsr`).
- `poppler-utils` gives `pdftotext`/`pdfinfo`, used to check the generated PDFs.

Create a dedicated user to run the service (the rest of this guide assumes `jobsearch`):

```bash
sudo adduser --disabled-password --gecos "" jobsearch
sudo -iu jobsearch
```

## 3. Install Claude Code

As the service user:

```bash
curl -fsSL https://claude.ai/install.sh | bash     # installs ~/.local/bin/claude
~/.local/bin/claude                                 # then /login, follow the link
```

Log in with your Claude account (Pro/Max subscription) **or** skip the login and give the
service an API key instead — `ANTHROPIC_API_KEY` in the systemd unit (see step 7). The app
runs `claude -p` for ranking, mail parsing and the CV chat; at API prices ranking costs
roughly $0.03 per posting and one `/apply` run noticeably more. The model is
`PT_CLAUDE_MODEL` (section 12).

## 4. Get the code

```bash
git clone https://github.com/p-lee-grimm/trabajo-yebuchee.git
cd trabajo-yebuchee
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml
chmod 600 config.yaml
```

## 5. Keys and secrets

All of these go into `config.yaml` (gitignored, never commit it).

### Login — pick one

```yaml
auth: telegram      # or: password
```

**Password** — the simplest: one password for the whole instance.

```bash
venv/bin/python tools/hash-password >> config.yaml   # asks twice, appends password_hash
```

Then set `auth: password`; `bot_token`, `bot_username` and `allowed_user_ids` can be deleted.
Only a salted scrypt hash is stored. Five wrong attempts in a row from one address lock the
form for a minute. To change the password, run the tool again, replace the old
`password_hash` line and restart — every open session is logged out.

**Telegram** — each person logs in with their own account; useful when several people
share the instance, and there is no password to leak.

1. In Telegram open **@BotFather** → `/newbot` → pick a name and a username.
   It replies with a token like `123456789:AA…`.
2. Still in @BotFather: `/setdomain` → choose the bot → send your domain
   (e.g. `jobs.example.com`, no `https://`). The login widget only works on this domain.
3. Find your numeric Telegram id: write to **@userinfobot**.
4. Set `auth: telegram`.

```yaml
bot_token: "123456789:AA..."
bot_username: my_jobs_bot        # without @
allowed_user_ids:
  - 123456789                    # your id; add more ids for people who share the instance
```

### Session secret — required

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

```yaml
secret_key: <the printed value>
cookie_secure: true              # false only for testing over plain http://127.0.0.1
```

Changing `secret_key` logs everyone out.

### Push notifications — optional

```bash
venv/bin/python tools/gen-vapid-keys >> config.yaml
```

This appends `vapid_public_key` / `vapid_private_key`; set `vapid_subject` to
`mailto:` + your email. Generate once — a new pair invalidates every subscription. On an
iPhone, push only reaches the app installed to the home screen (Share → Add to Home Screen).

### Mail — optional

The 📬 button and an hourly job read your inbox over IMAP (SSL, port 993, folder INBOX) and
suggest status changes from interview invitations and rejections. Nothing is written until
you confirm. The keys are named after Zoho but any IMAP server works:

```yaml
zoho_imap_host: imap.gmail.com   # Gmail: turn on 2FA and create an app password
zoho_imap_user: you@gmail.com
zoho_imap_password: "app password"
```

Without a password, mail sync is off. Each sync spends a little Claude usage on
classifying new messages.

### freehire.me — optional

```yaml
freehire_api_key: ""
```

freehire search is public; a key adds nothing but identifies you. A wrong key makes the
freehire feeds fail with HTTP 400.

## 6. Search settings in config.yaml

The `puto_trabajo:` section describes *you*: where you live, where you would move, your
salary floor. Nothing about the candidate is hard-coded.

```yaml
puto_trabajo:
  public_url: https://jobs.example.com/
  share_base_url: ""
  timezone: Europe/Berlin
  home_country: DE
  home_regions: 'europe|\beu\b|emea|\bcet\b|\bdach\b'
  unreachable_countries: [US, CA, IN]
  relocation_countries: [NL, AT, CH]
  getmatch_regions: [_cu-world, _cu-europe, _cu-european-union, _cu-emea]
  salary:
    currency: EUR
    monthly_floor: 4000
    contractor_uplift: 20-30%
  tracks: [...]
```

| Key | What it does |
|---|---|
| `home_country` | ISO-2 code of the country you live in. A posting confined to **one other country** is dropped before ranking. Without it nothing is dropped on location. |
| `home_regions` | Regex of region words that include your country. "Remote — Europe" matching it is never dropped. |
| `unreachable_countries` | Countries you can't work from however the posting is worded. `US` and `IN` also enable text tells (401(k), W-2, "must be based in India", rupee pay). |
| `relocation_countries` | Countries you would move to: their single-country postings are kept and ranked. Write Norway as `"NO"` in quotes — bare `NO` is YAML for *false*. |
| `getmatch_regions` | Only for the getmatch.ru feed: region slugs that include your country. |
| `salary.monthly_floor` | Gross monthly minimum. The ranker never suggests asking below it. Omit to let it work from your profile. |
| `salary.currency` | Currency of the floor and of the suggested ask. |
| `salary.contractor_uplift` | How much more to ask on freelance/B2B contracts. |
| `timezone` | The dead-link recheck runs at 06:00 in this zone. |
| `share_base_url` | Leave empty. Set it only if nginx maps a short path such as `/docs/<token>` to `/api/puto-trabajo/artifact/<token>`. |
| `public_url` | Sent in the User-Agent to freehire; optional. |

### Tracks: the role switch

`tracks` adds a switch (e.g. *Analyst / Engineer / All*) above the tracker, the job list and
the documents. A title belongs to a track when any of its rules `match` and that rule's
`unless` does not. Regexes are case-insensitive, JavaScript syntax. A title can be in
several tracks or in none (then it is only visible under *All*). No tracks — no switch.

```yaml
  tracks:
    - id: analyst
      label: Analyst
      hint: Data and product analysts
      rules:
        - match: 'analyst|data\s+scien'
        - match: '\banalytics\b'             # "Head of Analytics" is an analyst role…
          unless: '\b(data|analytics)\s+engineer'   # …"Data Engineer — Analytics" is not
    - id: engineer
      label: Engineer
      hint: Data and analytics engineers
      rules:
        - match: '\b(data|analytics)\s+engineer'
```

Restart the service after editing `config.yaml`.

## 7. Run it

Quick test, from the repo directory:

```bash
venv/bin/uvicorn server:app --host 127.0.0.1 --port 8600
```

For real use, as root:

```bash
sudo cp deploy/trabajo-yebuchee.service /etc/systemd/system/
sudo nano /etc/systemd/system/trabajo-yebuchee.service   # user, paths; optional:
#   Environment=ANTHROPIC_API_KEY=sk-ant-...
#   Environment=PT_CLAUDE_MODEL=...
sudo systemctl daemon-reload
sudo systemctl enable --now trabajo-yebuchee

sudo cp deploy/nginx.conf /etc/nginx/sites-available/trabajo-yebuchee
sudo nano /etc/nginx/sites-available/trabajo-yebuchee    # server_name
sudo ln -s /etc/nginx/sites-available/trabajo-yebuchee /etc/nginx/sites-enabled/
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d jobs.example.com
sudo systemctl reload nginx
```

Logs: `journalctl -u trabajo-yebuchee -f`.

On first start the server creates `data/app.db` and the workspace `data/puto_trabajo/`
from `puto_trabajo_template/`. Everything personal lives in `data/`.

## 8. First login and your profile

1. Open `https://jobs.example.com` and log in (password or Telegram).
2. **Документы → 🧭 Профиль** starts `/setup` in a chat: Claude asks about you and fills
   in the profile every other step reads:
   - `CLAUDE.md` — identity, languages, work authorisation, skills, known gaps,
     target sectors, deal-breakers, salary floor;
   - `documents/experience.md`, `skills.md`, `education.md`, `projects.md`, `contact.md`;
   - `cv/main_example.tex` — the master CV every tailored CV starts from.

   You can also edit these files by hand in `data/puto_trabajo/` — every field to fill in
   is marked `[PLACEHOLDER]`. Be accurate: nothing is embellished on the way into a CV, and
   the ranking reads this profile too.
3. The name in `documents/contact.md` (`- Name: …`) names downloaded files:
   `cv_<company>_<your_name>.pdf`.

## 9. Which jobs get collected: sources.json

`data/puto_trabajo/sources.json` decides what is fetched and what passes to ranking. Most of
it is editable in the app: **Поиск → Источники**. Every 3 hours (and on
**🔍 Скрэпить источники**) the app:

1. fetches every enabled feed and board;
2. keeps a posting when its **title contains one of `keywords`** (case-insensitive
   substring) — or matches a `title_also_match` rule — and no `title_exclude` rule drops it;
3. keeps it only if its location, remote field or description start contains one of
   `location_terms`, or it is in one of your `relocation_countries`;
4. drops postings confined to another single country, US-only/India-only ones, and foreign
   ones that rule out relocation (driven by `home_country` etc., section 6);
5. sends the rest to ranking.

### Job titles you search for: `keywords`

```json
"keywords": ["data analyst", "product analyst", "analytics engineer", "analista de datos"]
```

Plain lowercase substrings of the title — `"analyst"` alone would also match "Business
Analyst" and "Financial Analyst". Add the local-language titles of your country. In the
app: **Источники → Ключевые слова в названии вакансии**.

### Where: `location_terms`

```json
"location_terms": ["remote", "worldwide", "anywhere", "europe", "germany", "berlin", "munich"]
```

Include your country and cities in every spelling postings use.

### Optional title rules

```json
"title_exclude": [
  {"title_has_any": ["data scientist"],
   "pattern": "\\b(machine learning|ml|deep learning|computer vision|nlp)\\b"}
],
"title_also_match": [
  {"title_has_any": ["analyst", "analista"], "and_any": ["data", "product", "growth", "bi"]}
],
"telegram_keywords": ["analyst", "аналитик"]
```

- `title_exclude` — drop a title that contains one of `title_has_any` **and** matches
  `pattern` (regex). Saves ranking money on postings you would never take.
- `title_also_match` — accept a title no keyword covers when it has one word from each list.
- `telegram_keywords` — Telegram posts are matched on their whole text (roles hide inside
  digests); defaults to `keywords`.

### Feeds (aggregators)

Each feed is `{"id", "type", "enabled", "url"}`. Supported types:

| type | Source | Notes |
|---|---|---|
| `freehire` | freehire.me — ~3M postings, aggregates most remote boards | the main source; see below |
| `remotive`, `arbeitnow`, `jobicy`, `himalayas`, `remoteok` | public remote-job APIs | shipped disabled: freehire already includes them, enabling both gives duplicates |
| `rss` | any RSS job feed | e.g. We Work Remotely |
| `telegram` | public Telegram channel, `https://t.me/s/<channel>` | optional `"keywords"` per feed |
| `getmatch` | getmatch.ru (Russian-speaking IT) | uses `getmatch_regions` |

**freehire URLs.** One query holds **one** phrase — several quoted phrases in `q` find
nothing, and an unquoted multi-word phrase matches far too loosely — so make one feed per
title and geography:

```
https://freehire.me/api/v1/agent/jobs/search?q=%22data%20analyst%22&q_fields=title&countries=de&open_within_days=30
https://freehire.me/api/v1/agent/jobs/search?q=%22data%20analyst%22&q_fields=title&regions=eu&regions=global&work_mode=remote&open_within_days=30
```

| Parameter | Meaning |
|---|---|
| `q=%22…%22` | the title phrase, quoted and URL-encoded (`%22` = `"`, `%20` = space) |
| `q_fields=title` | search titles only (`company` searches employer names) |
| `countries=de` | jobs in a country (lowercase ISO-2) |
| `regions=eu&regions=global` | regions; several are OR-ed |
| `work_mode=remote` | remote only |
| `open_within_days=30` | posted in the last N days; 7 is enough for busy titles |
| `source_exclude=…` | skip one source (e.g. a repost spammer) |

freehire silently ignores unknown parameters and would then search everything; the app
treats that as an error, so a typo fails loudly. Optional per-feed fields:
`"companies": ["Exact Name"]` keeps only those employers (for `q_fields=company` feeds), and
`"remote_worldwide": true` exempts that employer's remote jobs from the one-country drop.

The template ships `freehire-home` and `freehire-remote` **disabled**: replace
`data%20analyst` and `countries=xx`, then set `"enabled": true`.

### Company boards (ATS)

```json
{"ats": "greenhouse", "token": "acme", "enabled": true}
```

Supported: `greenhouse`, `lever` (add `"region": "eu"` for jobs.eu.lever.co), `ashby`,
`workable`, `recruitee`. The template includes ~450 public boards. In the app you can add
more: paste any job link of a company (**Определить**), type company names (**Найти**),
pull boards from Hacker News "Who is hiring", or **🌍 Просканировать все публичные доски**
(~16 000 boards, ~10 minutes).

Hand-editing `sources.json` while the app runs is fine. An invalid file is never
overwritten — the app falls back to defaults and logs a warning until you fix it.

## 10. How jobs are scored: ranking_rules.md

Every new posting is scored 0–100 against your profile, with strengths, gaps and a salary
suggestion. The fixed parts of the prompt are generic; **your** rules come from
`data/puto_trabajo/ranking_rules.md`, pasted in verbatim (minus the `<!-- -->` comment), in
priority order. Write them as you would brief a recruiter friend:

```markdown
1. HARD deal-breakers force score <= 25 and must appear in "gaps": gambling and crypto
   employers; on-call rotations; a required language I don't speak (I speak English and German).
2. Snowflake or dbt as a REQUIRED skill caps the score at 55 — my most frequent rejection.
3. Reward: product analytics, A/B testing ownership, SaaS, health-tech.
4. Seniority: mid and senior fine; Staff/Principal/Head reads as a reach.
```

Geography and the salary floor come from `config.yaml` — don't repeat them here. Changes
apply to the next ranking run, no restart. From the chat, edits to this file (and to
`sources.json`) need your confirmation in the UI.

## 11. Daily use

- **Поиск** — collected jobs sorted by score. **Добавить по ссылке** adds and scores one
  posting (or paste its text if the page can't be fetched).
- **✍️ Резюме** on a job opens a chat running `/apply`: fit assessment, tailored CV and
  cover letter, compiled to PDF and checked. Reply in the chat to iterate; mark
  **✅ Откликнулся** when you've applied — the job moves to the tracker.
- **Трекер** — statuses (Отклик → Тестовое → Интервью → Оффер / Отказ), funnel, CSV
  import/export.
- **Документы** — all generated PDFs; a share link gives a recruiter one file without login.

Schedule: scrape + rank every 3 hours (first run 10 minutes after start), mail hourly,
dead-link check at 06:00. An unattended run scores at most `PT_SCHED_RANK_MAX` postings; the
rest wait for the next cycle.

## 12. Environment variables

Set in the systemd unit (`Environment=NAME=value`).

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | use an API key instead of a logged-in Claude account |
| `PT_CLAUDE_BIN` | `~/.local/bin/claude` | path to the Claude Code CLI |
| `PT_CLAUDE_MODEL` | `claude-sonnet-5` | model for ranking, mail and chat |
| `PT_MAX_CLAUDE` | `2` | Claude processes at once (each takes a few hundred MB) |
| `PT_SCHED_RANK_MAX` | `40` | max postings one unattended run may score |
| `PT_NOTIFY_MIN_SCORE` | `60` | score that triggers a push |
| `PT_CHAT_TIMEOUT` | `2700` | seconds per chat turn |
| `PT_CHAT_MAX_TURNS` | `80` | agent turns per chat message |
| `PT_ASK_TIMEOUT` | `240` | seconds a chat waits for you to allow an action |
| `PT_SHARE_BASE_URL` | — | overrides `share_base_url` |

## 13. Backups and updates

Back up `data/` (database + workspace with your CVs and letters) and `config.yaml`.

```bash
cd ~/trabajo-yebuchee && git pull && venv/bin/pip install -r requirements.txt
sudo systemctl restart trabajo-yebuchee
```

Updates never touch an existing workspace: new template files only reach fresh installs.

## 14. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Bot domain invalid" instead of the login button | `/setdomain` in @BotFather doesn't match the domain you opened |
| Logged in, but "Этот аккаунт Telegram не в списке доступа" | your id is not in `allowed_user_ids` (restart after editing) |
| Login loops back to the gate | `cookie_secure: true` over plain http, or `secret_key` changed |
| "Слишком много попыток" | five wrong passwords in a row — wait a minute |
| Service won't start: `config.yaml: auth: …` | the chosen `auth` mode lacks its keys (`password_hash`, or `bot_token` + `allowed_user_ids`) |
| "claude CLI not found" | install Claude Code for the service user or set `PT_CLAUDE_BIN` |
| Ranking errors / "not logged in" | log in as the service user (`sudo -iu jobsearch claude`) or set `ANTHROPIC_API_KEY` |
| Chat refuses to start: gatekeeper | `pt_gatekeeper.py` failed its self-test; check the journal |
| Nothing collected | empty `keywords`, all feeds disabled, or `location_terms` too narrow — use **Источники → Проверить** on a feed |
| freehire feed fails with 400 | wrong `freehire_api_key`, or a parameter typo |
| CV fails to compile | missing `fontawesome5`/`academicons` (install `texlive-fonts-extra`) |
