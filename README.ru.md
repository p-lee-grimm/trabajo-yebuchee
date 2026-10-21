# Trabajo Yebuchee

[English](README.md)

Self-hosted помощник для поиска работы: трекер откликов, сбор вакансий с досок, оценка
каждой вакансии под твой профиль и чат, который пишет резюме и сопроводительное письмо
под конкретную вакансию. Интерфейс на русском.

- **Трекер.** Отклики и статусы (отклик → тестовое → интервью → оффер), воронка по
  ступеням, импорт и экспорт CSV, разбор почты: письмо с приглашением или отказом
  предлагает сменить статус.
- **Поиск.** Раз в 3 часа собирает вакансии: freehire.me, ATS-доски компаний (Greenhouse,
  Lever, Ashby, Workable, Recruitee), публичные Telegram-каналы, getmatch.ru и др.
  Отсеивает по названию и географии, остальное Claude оценивает по шкале 0–100 с плюсами,
  пробелами и ориентиром по зарплате. Push-уведомление, если нашлось что-то сильное.
- **Резюме.** «✍️ Резюме» в карточке вакансии запускает `/apply` в чате: оценка
  соответствия, CV (LaTeX, moderncv) и письмо, сборка в PDF, проверка по чек-листу.
- **Документы.** Все готовые PDF и ссылки «поделиться» на отдельный файл.

Один экземпляр — один соискатель. Работает на небольшом Linux-сервере; нужны Python 3.12,
Claude Code CLI (подписка Claude или API-ключ), TeX и домен с HTTPS. Вход — по паролю или
через Telegram.

**→ [Инструкция по установке](docs/SETUP.ru.md)**: установка, ключи и секреты, настройка
искомых должностей и того, как оцениваются вакансии.

## Быстрый старт

```bash
git clone https://github.com/p-lee-grimm/trabajo-yebuchee.git && cd trabajo-yebuchee
python3.12 -m venv venv && venv/bin/pip install -r requirements.txt
cp config.example.yaml config.yaml        # auth (пароль или Telegram), secret_key, puto_trabajo:
venv/bin/python tools/hash-password >> config.yaml   # для auth: password
venv/bin/uvicorn server:app --port 8600
```

Дальше войди, нажми **Документы → 🧭 Профиль**, чтобы заполнить профиль, и задай искомые
должности в **Поиск → Источники**.

## Откуда

Навыки и команды в `puto_trabajo_template/.claude/` основаны на
[ai-job-search](https://github.com/ai-job-search-dev/ai-job-search) Мадса Лоренцена
(MIT, см. `puto_trabajo_template/LICENSE-ai-job-search`). Шрифты Lato и Raleway — SIL OFL.

## Лицензия

MIT — см. `LICENSE`. Навыки из ai-job-search и шрифты остаются под своими лицензиями.
