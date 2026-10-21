# Trabajo Yebuchee

[Русский](README.ru.md)

A self-hosted job-search assistant: application tracker, job scraping from boards, every
posting scored against your profile, and a chat that writes a CV and cover letter for a
specific posting. The web interface is in Russian.

- **Tracker.** Applications and statuses (applied → test task → interview → offer), a
  funnel by stage, CSV import/export, and mail parsing: an invitation or a rejection in your
  inbox proposes the status change.
- **Search.** Every 3 hours it collects postings from freehire.me, company ATS boards
  (Greenhouse, Lever, Ashby, Workable, Recruitee), public Telegram channels, getmatch.ru and
  more; filters them by title and geography; Claude scores the rest 0–100 with strengths,
  gaps and a salary ask. A push notification when something strong turns up.
- **CVs.** «✍️ Резюме» on a posting runs `/apply` in a chat: fit assessment, CV (LaTeX,
  moderncv) and cover letter, compiled to PDF and checked against a checklist.
- **Documents.** Every generated PDF, with per-file share links.

One instance per job seeker. Runs on a small Linux server; needs Python 3.12, the Claude
Code CLI (Claude subscription or API key), TeX and a domain with HTTPS. Login is a password
or a Telegram account.

**→ [Setup guide](docs/SETUP.md)**: install, keys and secrets, configuring which job titles
are searched and how postings are scored.

## Quick start

```bash
git clone https://github.com/p-lee-grimm/trabajo-yebuchee.git && cd trabajo-yebuchee
python3.12 -m venv venv && venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml        # auth (password or Telegram), secret_key, puto_trabajo:
venv/bin/python tools/hash-password >> config.yaml   # for auth: password
venv/bin/uvicorn server:app --port 8600
```

Then log in, press **Документы → 🧭 Профиль** to fill in your profile, and set the job
titles you want under **Поиск → Источники**.

## Credits

The skills and commands in `puto_trabajo_template/.claude/` are based on
[ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) by Mads Lorentzen
(MIT, see `puto_trabajo_template/LICENSE-ai-job-search`). Lato and Raleway fonts: SIL OFL.

## License

MIT — see `LICENSE`. The ai-job-search skills and the fonts keep their own licenses.
