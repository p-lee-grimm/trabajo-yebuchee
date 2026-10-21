# Trabajo Yebuchee

Self-hosted помощник для поиска работы: трекер откликов, сбор вакансий с досок, оценка
каждой вакансии под твой профиль и чат, который пишет резюме и сопроводительное письмо
под конкретную вакансию. Интерфейс на русском.

- **Трекер.** Отклики, статусы (отклик → тестовое → интервью → оффер), воронка по ступеням,
  импорт и экспорт CSV, разбор почты: письмо с приглашением или отказом предлагает сменить
  статус.
- **Поиск.** Каждые 3 часа собирает вакансии: freehire.me, ATS-доски компаний (Greenhouse,
  Lever, Ashby, Workable, Recruitee), публичные Telegram-каналы, getmatch.ru и др. Отсеивает
  по названию и географии, остальное оценивает Claude по шкале 0–100 с плюсами, пробелами и
  ориентиром по зарплате. Push-уведомление, если нашлось что-то сильное.
- **Резюме.** Кнопка «✍️ Резюме» в карточке вакансии запускает `/apply` в чате: оценка
  соответствия, CV (LaTeX, moderncv) и письмо, сборка в PDF, проверка по чек-листу.
- **Документы.** Все сгенерированные PDF, ссылки «поделиться» на отдельный файл.

Один экземпляр — один человек: профиль, источники и папка с документами у всех пользователей
экземпляра общие.

## Что нужно

- Linux-сервер с ~2–3 ГБ RAM, домен и HTTPS (Telegram-вход работает только по https).
- Python 3.12 с модулем `sqlite3`.
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code), залогиненный под
  пользователем, от которого работает сервис (`claude` → `/login`). По ценам API оценка
  вакансии обходится примерно в $0.03, `/apply` — заметно дороже; модель задаётся
  переменной `PT_CLAUDE_MODEL`.
- TeX: `texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-luatex
  texlive-xetex` (~270 МБ) плюс пакеты `fontawesome5` и `academicons` с CTAN
  (или целиком `texlive-fonts-extra`, но это 1.7 ГБ). И `poppler-utils` для `pdftotext`.
- Telegram-бот для входа.

## Установка

```bash
git clone https://github.com/<you>/trabajo-yebuchee.git
cd trabajo-yebuchee
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml
venv/bin/python tools/gen-vapid-keys >> config.yaml   # ключи для push, необязательно
```

1. **Бот.** В @BotFather: `/newbot`, затем `/setdomain` → твой домен. Токен и имя бота —
   в `bot_token` и `bot_username`, свой Telegram id (спроси у @userinfobot) — в
   `allowed_user_ids`, случайная строка — в `secret_key`.
2. **Поиск.** В разделе `puto_trabajo:` укажи страну проживания, страны, куда готов
   переехать, порог зарплаты, часовой пояс и направления поиска. Всё описано в комментариях
   `config.example.yaml`.
3. **Запуск.** Для пробы: `venv/bin/uvicorn server:app --port 8600`. Для постоянной
   работы — `deploy/trabajo-yebuchee.service` (systemd) и `deploy/nginx.conf`.

При первом старте сервер создаёт рабочую папку `data/puto_trabajo/` из
`puto_trabajo_template/`. В `data/` живёт всё личное: база, профиль, резюме, письма.
Она в `.gitignore`, бэкапь её отдельно.

## Первые шаги в приложении

1. **Документы → «🧭 Профиль».** Claude расспросит о тебе и заполнит `CLAUDE.md`,
   `documents/*.md` и мастер-резюме `cv/main_example.tex`. Можно вместо этого заполнить
   эти файлы руками: везде стоят `[PLACEHOLDER]`.
2. **`data/puto_trabajo/ranking_rules.md`.** Правила оценки: что для тебя стоп-фактор,
   каких навыков не хватает, что ценить. Подставляется в каждый запрос на оценку.
3. **`data/puto_trabajo/sources.json`** (или вкладка «Поиск» → источники): `keywords` —
   названия должностей, которые ищешь; `location_terms` — слова в локации, которые
   подходят; включи нужные фиды (`enabled: true`). Для freehire замени в URL
   `q=` и `countries=`. Необязательные правила: `title_exclude`, `title_also_match`,
   `telegram_keywords`.
4. Через 10 минут после старта пройдёт первый сбор, дальше — каждые 3 часа.

## Безопасность

- Чат запускает Claude Code в режиме `bypassPermissions`, а все действия проходят через
  хук `pt_gatekeeper.py`: шелл ограничен LaTeX-инструментами, запись — рабочей папкой,
  секреты (`config.yaml`, база, `~/.ssh`) недоступны, правка настроек и правил поиска —
  только по подтверждению в интерфейсе. Если хук сломан, чат не стартует.
- Текст вакансий и писем — недоверенные данные; промпты прямо запрещают модели выполнять
  инструкции из них. Всё равно не давай доступ к экземпляру тем, кому не доверяешь.

## Откуда

Навыки и команды в `puto_trabajo_template/.claude/` основаны на
[ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) Мадса Лоренцена
(MIT, см. `puto_trabajo_template/LICENSE-ai-job-search`). Шрифты Lato и Raleway — SIL OFL.
