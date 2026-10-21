# Инструкция по установке

[English version](SETUP.md)

От чистого Linux-сервера до работающего экземпляра: установка, ключи и секреты, первый
вход, заполнение профиля, настройка того, какие вакансии собираются и как оцениваются.

- [1. Что нужно](#1-что-нужно)
- [2. Системные пакеты](#2-системные-пакеты)
- [3. Claude Code](#3-claude-code)
- [4. Код](#4-код)
- [5. Ключи и секреты](#5-ключи-и-секреты)
- [6. Настройки поиска в config.yaml](#6-настройки-поиска-в-configyaml)
- [7. Запуск](#7-запуск)
- [8. Первый вход и профиль](#8-первый-вход-и-профиль)
- [9. Какие вакансии собираются: sources.json](#9-какие-вакансии-собираются-sourcesjson)
- [10. Как вакансии оцениваются: ranking_rules.md](#10-как-вакансии-оцениваются-ranking_rulesmd)
- [11. Каждый день](#11-каждый-день)
- [12. Переменные окружения](#12-переменные-окружения)
- [13. Бэкапы и обновления](#13-бэкапы-и-обновления)
- [14. Если что-то не работает](#14-если-что-то-не-работает)

## 1. Что нужно

| | |
|---|---|
| Сервер | Linux (дальше — Debian/Ubuntu), 2–3 ГБ RAM, ~3 ГБ диска с полным TeX |
| Домен | Домен или поддомен на этот сервер с HTTPS. Вход через Telegram и кука сессии работают только по https. |
| Python | 3.12 **с модулем `sqlite3`** (`python3.12 -c "import sqlite3"` не должен падать) |
| Claude | Подписка Claude или API-ключ Anthropic — через Claude Code CLI |
| Telegram | Аккаунт и бот (бесплатно, две минуты) — через него вход |

Один экземпляр — один соискатель. Все из `allowed_user_ids` видят общий профиль, источники
и документы.

## 2. Системные пакеты

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv git nginx \
    texlive-latex-base texlive-latex-recommended texlive-latex-extra \
    texlive-luatex texlive-xetex texlive-fonts-extra poppler-utils
```

- `texlive-*` собирает резюме (moderncv, LuaLaTeX) и письмо (XeLaTeX).
  `texlive-fonts-extra` большой (~1.7 ГБ); резюме из него нужны только пакеты
  `fontawesome5` и `academicons`, так что при нехватке места их можно поставить с CTAN в
  `/usr/local/share/texmf` (каждый пакет целиком, потом `sudo mktexlsr`).
- `poppler-utils` — `pdftotext`/`pdfinfo` для проверки готовых PDF.

Заведи отдельного пользователя для сервиса (дальше — `jobsearch`):

```bash
sudo adduser --disabled-password --gecos "" jobsearch
sudo -iu jobsearch
```

## 3. Claude Code

Под пользователем сервиса:

```bash
curl -fsSL https://claude.ai/install.sh | bash     # ставит ~/.local/bin/claude
~/.local/bin/claude                                 # затем /login и ссылка
```

Войди аккаунтом Claude (подписка Pro/Max) **или** не входи, а дай сервису API-ключ —
`ANTHROPIC_API_KEY` в юните systemd (шаг 7). Приложение вызывает `claude -p` для оценки
вакансий, разбора почты и чата с резюме; по ценам API оценка обходится примерно в $0.03 за
вакансию, один `/apply` — заметно дороже. Модель — `PT_CLAUDE_MODEL` (раздел 12).

## 4. Код

```bash
git clone https://github.com/p-lee-grimm/trabajo-yebuchee.git
cd trabajo-yebuchee
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml
chmod 600 config.yaml
```

## 5. Ключи и секреты

Всё в `config.yaml` (он в `.gitignore`, не коммить его).

### Вход через Telegram — обязательно

1. В Telegram открой **@BotFather** → `/newbot` → имя и username бота.
   В ответ придёт токен вида `123456789:AA…`.
2. Там же `/setdomain` → выбрать бота → прислать домен (`jobs.example.com`, без
   `https://`). Кнопка входа работает только на этом домене.
3. Свой числовой Telegram id подскажет **@userinfobot**.

```yaml
bot_token: "123456789:AA..."
bot_username: my_jobs_bot        # без @
allowed_user_ids:
  - 123456789                    # твой id; ещё id — для тех, кто делит экземпляр
```

### Секрет сессии — обязательно

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

```yaml
secret_key: <напечатанное значение>
cookie_secure: true              # false только для проверки по http://127.0.0.1
```

Смена `secret_key` разлогинивает всех.

### Push-уведомления — по желанию

```bash
venv/bin/python tools/gen-vapid-keys >> config.yaml
```

Допишет `vapid_public_key` / `vapid_private_key`; в `vapid_subject` — `mailto:` и твоя
почта. Генерировать один раз: новая пара отменяет все подписки. На iPhone push приходят
только приложению, добавленному на экран «Домой» («Поделиться» → «На экран „Домой“»).

### Почта — по желанию

Кнопка 📬 и ежечасная задача читают ящик по IMAP (SSL, порт 993, папка INBOX) и предлагают
сменить статус по приглашениям и отказам. Ничего не записывается без подтверждения. Ключи
названы по Zoho, но подходит любой IMAP:

```yaml
zoho_imap_host: imap.gmail.com   # Gmail: включи 2FA и создай пароль приложения
zoho_imap_user: you@gmail.com
zoho_imap_password: "пароль приложения"
```

Без пароля синхронизация выключена. Каждая проверка немного тратит Claude на разбор новых
писем.

### freehire.me — по желанию

```yaml
freehire_api_key: ""
```

Поиск freehire публичный, ключ ничего не добавляет, только представляет тебя. Неверный
ключ — фиды freehire падают с HTTP 400.

## 6. Настройки поиска в config.yaml

Раздел `puto_trabajo:` описывает *тебя*: где живёшь, куда готов переехать, минимум по
зарплате. В коде ничего о кандидате не зашито.

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

| Ключ | Что делает |
|---|---|
| `home_country` | ISO-2 код страны, где живёшь. Вакансия, привязанная к **одной другой стране**, отбрасывается до оценки. Без ключа по локации ничего не отбрасывается. |
| `home_regions` | Регулярка регионов, куда входит твоя страна. «Remote — Europe» с ней никогда не отбрасывается. |
| `unreachable_countries` | Страны, откуда ты не можешь работать, как бы ни была сформулирована вакансия. `US` и `IN` включают и признаки в тексте (401(k), W-2, «must be based in India», оплата в рупиях). |
| `relocation_countries` | Страны, куда готов переехать: их вакансии остаются и оцениваются. Норвегию пиши `"NO"` в кавычках — голое `NO` в YAML значит *false*. |
| `getmatch_regions` | Только для фида getmatch.ru: регионы, куда входит твоя страна. |
| `salary.monthly_floor` | Минимум в месяц, брутто. Оценка никогда не предложит просить меньше. Без него ориентир строится по профилю. |
| `salary.currency` | Валюта минимума и предлагаемой суммы. |
| `salary.contractor_uplift` | На сколько больше просить на фрилансе/B2B. |
| `timezone` | Проверка мёртвых ссылок идёт в 06:00 по этому поясу. |
| `share_base_url` | Оставь пустым. Нужен, только если nginx отображает короткий путь вроде `/docs/<token>` на `/api/puto-trabajo/artifact/<token>`. |
| `public_url` | Уходит во freehire в User-Agent; по желанию. |

### Направления: переключатель ролей

`tracks` добавляет переключатель (например *Analyst / Engineer / All*) над трекером, списком
вакансий и документами. Название попадает в направление, если совпало `match` любого из
правил и не совпало `unless` того же правила. Регулярки без учёта регистра, синтаксис
JavaScript. Название может попасть в несколько направлений или ни в одно (тогда видно
только в *All*). Нет направлений — нет переключателя.

```yaml
  tracks:
    - id: analyst
      label: Analyst
      hint: Аналитики данных и продукта
      rules:
        - match: 'analyst|аналитик|data\s+scien'
        - match: '\banalytics\b'             # «Head of Analytics» — аналитик…
          unless: '\b(data|analytics)\s+engineer'   # …«Data Engineer — Analytics» — нет
    - id: engineer
      label: Engineer
      hint: Data и analytics engineer
      rules:
        - match: '\b(data|analytics)\s+engineer|инженер\S*\s+данных'
```

После правки `config.yaml` перезапусти сервис.

## 7. Запуск

Для пробы, из папки репозитория:

```bash
venv/bin/uvicorn server:app --host 127.0.0.1 --port 8600
```

Постоянно — от root:

```bash
sudo cp deploy/trabajo-yebuchee.service /etc/systemd/system/
sudo nano /etc/systemd/system/trabajo-yebuchee.service   # пользователь, пути; по желанию:
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

Логи: `journalctl -u trabajo-yebuchee -f`.

При первом старте сервер создаёт базу `data/app.db` и рабочую папку `data/puto_trabajo/` из
`puto_trabajo_template/`. Всё личное живёт в `data/`.

## 8. Первый вход и профиль

1. Открой `https://jobs.example.com` и войди через Telegram.
2. **Документы → 🧭 Профиль** запускает `/setup` в чате: Claude расспросит о тебе и
   заполнит профиль, который читают все остальные шаги:
   - `CLAUDE.md` — кто ты, языки, право на работу, навыки, известные пробелы, целевые
     отрасли, стоп-факторы, минимум по зарплате;
   - `documents/experience.md`, `skills.md`, `education.md`, `projects.md`, `contact.md`;
   - `cv/main_example.tex` — мастер-резюме, с которого начинается каждое адаптированное.

   Можно заполнить эти файлы в `data/puto_trabajo/` и руками — всё, что нужно заменить,
   помечено `[PLACEHOLDER]`. Пиши точно: по дороге в резюме ничего не приукрашивается, а
   оценка вакансий читает тот же профиль.
3. Имя из `documents/contact.md` (`- Name: …`) попадает в названия скачиваемых файлов:
   `cv_<компания>_<имя>.pdf`.

## 9. Какие вакансии собираются: sources.json

`data/puto_trabajo/sources.json` решает, что скачивается и что доходит до оценки. Почти всё
редактируется в приложении: **Поиск → Источники**. Раз в 3 часа (и по кнопке
**🔍 Скрэпить источники**) приложение:

1. скачивает все включённые фиды и доски;
2. оставляет вакансию, если её **название содержит одно из `keywords`** (подстрока, без
   учёта регистра) или подходит под `title_also_match`, и её не выкидывает `title_exclude`;
3. оставляет, только если локация, поле remote или начало описания содержат одно из
   `location_terms`, либо это одна из `relocation_countries`;
4. отбрасывает вакансии, привязанные к одной чужой стране, только-США/только-Индия и
   зарубежные без релокации (по `home_country` и др., раздел 6);
5. остальное отправляет на оценку.

### Какие должности ищешь: `keywords`

```json
"keywords": ["data analyst", "product analyst", "analytics engineer", "аналитик данных"]
```

Подстроки названия в нижнем регистре — одно `"analyst"` поймает и «Business Analyst», и
«Financial Analyst». Добавь названия на языке своей страны. В приложении:
**Источники → Ключевые слова в названии вакансии**.

### Где: `location_terms`

```json
"location_terms": ["remote", "worldwide", "anywhere", "europe", "germany", "berlin", "munich"]
```

Страна и города во всех написаниях, какие встречаются в вакансиях.

### Дополнительные правила по названиям

```json
"title_exclude": [
  {"title_has_any": ["data scientist"],
   "pattern": "\\b(machine learning|ml|deep learning|computer vision|nlp)\\b"}
],
"title_also_match": [
  {"title_has_any": ["analyst", "аналитик"], "and_any": ["data", "product", "данн", "продукт"]}
],
"telegram_keywords": ["analyst", "аналитик"]
```

- `title_exclude` — выкинуть название, где есть слово из `title_has_any` **и** совпадает
  `pattern` (регулярка). Экономит оценку на том, что ты точно не возьмёшь.
- `title_also_match` — принять название без ключевого слова, если в нём есть по слову из
  обоих списков.
- `telegram_keywords` — посты Telegram проверяются по всему тексту (роли прячутся в
  дайджестах); по умолчанию — `keywords`.

### Фиды (агрегаторы)

Каждый фид — `{"id", "type", "enabled", "url"}`. Типы:

| type | Источник | Заметки |
|---|---|---|
| `freehire` | freehire.me — ~3 млн вакансий, собирает большинство remote-досок | основной источник, см. ниже |
| `remotive`, `arbeitnow`, `jobicy`, `himalayas`, `remoteok` | публичные API remote-вакансий | выключены: freehire их уже включает, вместе будут дубли |
| `rss` | любой RSS с вакансиями | например We Work Remotely |
| `telegram` | публичный канал, `https://t.me/s/<канал>` | можно свои `"keywords"` у фида |
| `getmatch` | getmatch.ru (русскоязычный IT) | использует `getmatch_regions` |

**Ссылки freehire.** В одном запросе — **одна** фраза: несколько фраз в кавычках не находят
ничего, а фраза без кавычек ловит слишком много. Поэтому — по фиду на каждую должность и
географию:

```
https://freehire.me/api/v1/agent/jobs/search?q=%22data%20analyst%22&q_fields=title&countries=de&open_within_days=30
https://freehire.me/api/v1/agent/jobs/search?q=%22data%20analyst%22&q_fields=title&regions=eu&regions=global&work_mode=remote&open_within_days=30
```

| Параметр | Значение |
|---|---|
| `q=%22…%22` | должность в кавычках, URL-кодированная (`%22` — кавычка, `%20` — пробел) |
| `q_fields=title` | искать только в названиях (`company` — по работодателю) |
| `countries=de` | вакансии в стране (ISO-2 строчными) |
| `regions=eu&regions=global` | регионы, объединяются через «или» |
| `work_mode=remote` | только удалёнка |
| `open_within_days=30` | опубликованы за N дней; для частых должностей хватит 7 |
| `source_exclude=…` | исключить источник (например, спамера перепостов) |

freehire молча игнорирует неизвестные параметры и тогда ищет по всей базе; приложение
считает это ошибкой, так что опечатка сразу видна. Дополнительные поля фида:
`"companies": ["Точное Название"]` оставляет только этих работодателей (для фидов с
`q_fields=company`), `"remote_worldwide": true` освобождает удалённые вакансии этого
работодателя от отсева по одной стране.

В шаблоне есть **выключенные** `freehire-home` и `freehire-remote`: замени `data%20analyst`
и `countries=xx`, потом поставь `"enabled": true`.

### Доски компаний (ATS)

```json
{"ats": "greenhouse", "token": "acme", "enabled": true}
```

Поддерживаются `greenhouse`, `lever` (для jobs.eu.lever.co — `"region": "eu"`), `ashby`,
`workable`, `recruitee`. В шаблоне ~450 публичных досок. В приложении можно добавить ещё:
вставить ссылку на любую вакансию компании (**Определить**), ввести названия компаний
(**Найти**), собрать доски из «Who is hiring» на Hacker News или
**🌍 Просканировать все публичные доски** (~16 000 досок, ~10 минут).

Править `sources.json` руками при работающем приложении можно. Битый файл никогда не
перезаписывается: приложение работает на значениях по умолчанию и пишет предупреждение в
лог, пока ты его не починишь.

## 10. Как вакансии оцениваются: ranking_rules.md

Каждая новая вакансия получает оценку 0–100 под твой профиль, плюсы, пробелы и ориентир по
зарплате. Общая часть запроса неизменна, **твои** правила берутся из
`data/puto_trabajo/ranking_rules.md` — дословно (без комментария `<!-- -->`), в порядке
приоритета. Пиши так, как объяснял бы знакомому рекрутеру:

```markdown
1. HARD deal-breakers force score <= 25 and must appear in "gaps": gambling and crypto
   employers; on-call rotations; a required language I don't speak (English, Russian).
2. Snowflake or dbt as a REQUIRED skill caps the score at 55 — my most frequent rejection.
3. Reward: product analytics, A/B testing ownership, SaaS, health-tech.
4. Seniority: mid and senior fine; Staff/Principal/Head reads as a reach.
```

Писать можно и по-русски, но английский надёжнее: остальной запрос на английском.
География и минимум по зарплате берутся из `config.yaml` — здесь их не повторяй. Правки
действуют со следующей оценки, без перезапуска. Из чата правка этого файла (и
`sources.json`) требует твоего подтверждения в интерфейсе.

## 11. Каждый день

- **Поиск** — собранные вакансии по убыванию оценки. **Добавить по ссылке** добавляет и
  оценивает одну вакансию (или вставь её текст, если страница не открывается).
- **✍️ Резюме** в карточке открывает чат с `/apply`: оценка соответствия, резюме и письмо
  под вакансию, сборка в PDF и проверка. Отвечай в чате, чтобы доработать; отметь
  **✅ Откликнулся**, когда отправил — вакансия переедет в трекер.
- **Трекер** — статусы (Отклик → Тестовое → Интервью → Оффер / Отказ), воронка, импорт и
  экспорт CSV.
- **Документы** — все готовые PDF; ссылка «поделиться» отдаёт рекрутеру один файл без входа.

Расписание: сбор и оценка раз в 3 часа (первый раз через 10 минут после старта), почта —
раз в час, проверка мёртвых ссылок — в 06:00. Автоматический прогон оценивает не больше
`PT_SCHED_RANK_MAX` вакансий, остальные ждут следующего цикла.

## 12. Переменные окружения

Задаются в юните systemd (`Environment=NAME=value`).

| Переменная | По умолчанию | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | API-ключ вместо входа в аккаунт Claude |
| `PT_CLAUDE_BIN` | `~/.local/bin/claude` | путь к Claude Code CLI |
| `PT_CLAUDE_MODEL` | `claude-sonnet-5` | модель для оценки, почты и чата |
| `PT_MAX_CLAUDE` | `2` | процессов Claude одновременно (каждый — несколько сотен МБ) |
| `PT_SCHED_RANK_MAX` | `40` | сколько вакансий может оценить один автопрогон |
| `PT_NOTIFY_MIN_SCORE` | `60` | оценка, от которой приходит push |
| `PT_CHAT_TIMEOUT` | `2700` | секунд на один ход чата |
| `PT_CHAT_MAX_TURNS` | `80` | шагов агента на одно сообщение |
| `PT_ASK_TIMEOUT` | `240` | сколько секунд чат ждёт твоего разрешения на действие |
| `PT_SHARE_BASE_URL` | — | перекрывает `share_base_url` |

## 13. Бэкапы и обновления

Бэкапь `data/` (база и рабочая папка с резюме и письмами) и `config.yaml`.

```bash
cd ~/trabajo-yebuchee && git pull && venv/bin/pip install -r requirements.txt
sudo systemctl restart trabajo-yebuchee
```

Обновления не трогают существующую рабочую папку: новые файлы шаблона попадают только в
свежие установки.

## 14. Если что-то не работает

| Симптом | Причина / что делать |
|---|---|
| «Bot domain invalid» вместо кнопки входа | `/setdomain` в @BotFather не совпадает с открытым доменом |
| Вошёл, но «Этот аккаунт Telegram не в списке доступа» | твоего id нет в `allowed_user_ids` (после правки — перезапуск) |
| После входа снова экран входа | `cookie_secure: true` при http, или сменился `secret_key` |
| «claude CLI not found» | поставь Claude Code пользователю сервиса или задай `PT_CLAUDE_BIN` |
| Оценка падает / «not logged in» | войди под пользователем сервиса (`sudo -iu jobsearch claude`) или задай `ANTHROPIC_API_KEY` |
| Чат не стартует из-за gatekeeper | `pt_gatekeeper.py` не прошёл самопроверку; смотри журнал |
| Ничего не собирается | пустые `keywords`, все фиды выключены или слишком узкие `location_terms` — **Источники → Проверить** у фида |
| Фид freehire падает с 400 | неверный `freehire_api_key` или опечатка в параметрах |
| Резюме не собирается | нет `fontawesome5`/`academicons` (поставь `texlive-fonts-extra`) |
