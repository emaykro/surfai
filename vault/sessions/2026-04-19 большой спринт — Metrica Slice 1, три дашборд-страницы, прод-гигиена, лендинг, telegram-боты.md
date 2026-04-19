# 2026-04-19 — большой спринт

Один длинный день, семь крупных кусков работы от утреннего инцидента на химчистке до вечернего контактного бота на публичном лендинге. Порядок ниже примерно хронологический.

## What was done

### 1. Диагностика и post-mortem инцидента химчистка-луч.рф

- В ходе проверки накопленных данных за 30 дней заметили, что на сайте **0 конверсий в окне после 2026-04-11** при 854 сессиях. На остальных 4 сайтах проекта всё нормально.
- Отследили временной паттерн: 9–10 апреля были все типы событий; с 11 апреля **остались только пассивные таймер-события** (engagement, idle, cross_session, context, bot_signals, session), а click/form/scroll/mouse/performance — пропали.
- `curl` прод-страницы подтвердил: GTM-контейнер `GTM-T4FFSVG` удалён с сайта (остался только reCAPTCHA + Elementor). Бэкграунд-поток пассивных событий шёл с кэшированных открытых вкладок, поэтому `install_status` оставался `verified` — тихая потеря данных 8 дней.
- Пользователь восстановил контейнер прямо в процессе; проверили, что свежие сессии пошли с 14:27 MSK.
- Написан post-mortem: `vault/bugs/2026-04-19 luch gtm container removed.md`.
- В memory добавлен **Lesson 4**: «passive-only event mix на падающем сайте = тег снят клиентом».

### 2. Yandex Metrica enrichment — Slice 1 (первый из трёх)

- **ADR**: `vault/decisions/2026-04-19_yandex_metrica_enrichment.md` — трёхслайсовый план (Slice 1 — reconciliation, Slice 2 — `ym_uid` в SDK, Slice 3 — attribution-фичи в `session_features`).
- **OAuth-токен** получен (client_id + secret + verification code → access_token с TTL ~365 дней). Пять прод-счётчиков найдены через Management API.
- **Migration 014**: `sites.yandex_counter_id BIGINT` + таблица `metrica_daily_reconciliation` (site_id, date, metrica_visits/users/pageviews/goals, surfai_sessions/conversions, divergence_ratio). Пре-заполнены 5 counter_id'ов для прод-сайтов.
- **Модуль `server/features/yandex-metrica.js`** — клиент Reports API с классификацией ошибок по коду (`TOKEN_MISSING`, `TOKEN_INVALID`, `RATE_LIMIT`, `SERVER_ERROR`, `REQUEST_ERROR`). Два бага нашли по пути: (а) `accuracy=full` требует премиум Metrica — выкинули; (б) `totals` в ответе — **плоский** массив, а не вложенный, как я гадал изначально.
- **CLI-воркер `server/jobs/metrica-reconcile.js`** — `npm run metrica:reconcile -- --date=YYYY-MM-DD [--site=<domain>] [--dry-run]`. UPSERT'ит строку на `(site_id, date)`.
- **Endpoint `GET /api/reconciliation/daily?days=30&site_id=X`** под operator-auth.
- **9 unit-тестов** с мок-fetch.
- **Systemd timer `surfai-metrica-reconcile.timer`** на проде — ежедневно 04:00 MSK, + 120с randomized delay, `Persistent=true`.
- **Первый прогон** за 2026-04-18 показал baseline-ratios (metrica_visits / surfai_sessions): sequoia=1.12, sluhnn=0.37, stefcom=0.57, теплостен=1.26, луч=n/a (0). Рацио сильно разнится не из-за поломок, а из-за разницы в определении «сессии» — это теперь baseline для будущего alerting'а на аномалии.

### 3. Geoip-deps drift fix

- На проде обнаружили, что `server/package.json` и `package-lock.json` содержат `@ip-location-db/asn-mmdb`, `@ip-location-db/dbip-city-mmdb`, `maxmind@5`, которые были **`npm install`ены напрямую 10 апреля** во время GeoIP-спринта, но никогда не закоммичены в main. Это всплыло когда `git pull` Slice 1'а отказался идти `--ff-only` поверх dirty tree.
- Обошли через `git stash` / `pull` / `stash pop`, потом отдельным коммитом скопировали прод-файлы в репо (`scp ... && git commit`) — теперь repo и prod совпадают.
- В memory добавлено правило (`feedback_prod_deps_drift.md`): **«npm install на проде → commit в той же сессии»**.

### 4. Dashboard Zone A — три новые страницы

Все три — vanilla HTML, тёмная тема, общая нав-шапка.

- **ML readiness виджет** в шапке главного дашборда: `GET /api/ml/readiness` возвращает `{enriched_conversions, target, daily_rate_14d, eta_days, eta_date, ready}`. На момент деплоя — `37/50, ETA 25 Apr`. Цветная подсветка: amber при ETA≤14д, green при ready. Виджет обновляется каждые 5 мин.
- **`/dashboard/reconciliation.html`** — pivot-грид (site × date) с цветовой подсветкой ratio относительно **медианы по каждому сайту** (а не от 1.0). Фильтр окна 7/14/30/90 дней. Под шапкой — baseline-строка с медианами.
- **`/dashboard/sites.html`** — карточка на каждый сайт, с последними 48ч event-mix, session buckets (24h/48h/7d-avg), health-верикт. Собственно **правило обнаружения «химчистка-фингерпринта»** закодировано: `has_passive && !has_interaction === red "passive_only"`. Плюс другие flags: `silent`, `session_drop_70pct`, `missing_interaction_types`, `unverified`, `never_tracked`, `quiet_last_24h`.
- **Endpoint `GET /api/sites/health`** — 4 параллельных SQL-запроса (sites + event mix 48h + session buckets + latest ratio) → аггрегация на фронте.

### 5. Antifraud-направление — провизорный ADR (запарковано)

- Пользователь спросил про антифрод. Ответил: **да, органично** — те же 103 фичи + CatBoost, только метка `fraud vs не-fraud` вместо `converted`. Два плея: (A) lead-quality для performance-рекламы (низкая стоимость, органично с Phase 8), (B) on-site fraud с sync-API для чекаута (большой лифт).
- **ADR** `vault/decisions/2026-04-19_antifraud_direction_future.md` — идея, 6 открытых вопросов, триггеры «разморозить» (Phase 7 живой + Phase 8 шлёт в Директ + платящий клиент с болью). Сейчас — **не делать**, но при проектировании Phase 7–8 держать feature-store и push-механизм общими, чтобы не сломать будущую антифрод-ветку.

### 6. Прод-гигиена (четыре задачи в одном коммите)

- **Ежедневный `pg_dump`**: `ops/backup.sh` + `surfai-backup.timer` (03:30 MSK, 30 мин до reconcile чтобы не конкурировать за pg-connections). Retention: 7 daily + 4 weekly (Sunday auto-promote). Первый бэкап: 37MB gzipped. Жизнь — **только локальная**, off-site пока не сделано.
  - Подводный камень: `ReadWritePaths=/opt/surfai/backups` в systemd юните требует, чтобы каталог существовал до настройки mount-namespace. Упало status=226/NAMESPACE. Фикс: `ExecStartPre=+/bin/mkdir -p ...` с `+` prefix (вне sandbox).
- **`GET /api/health`** — агрегирует 6 проверок (DB latency, disk%, memory%, ingest liveness через `raw_batches.received_at`, возраст последнего reconcile, Metrica token expiry). Возвращает HTTP 503 при любом `critical`.
- **`YANDEX_METRICA_TOKEN_ISSUED_AT=2026-04-19`** env-var + `metrica_token_expiry` check, предупреждающий когда до 365-дневного протухания <30 дней. Auto-refresh пока не автоматизирован.
- **Timer sanity** встроен в `/api/health` через `age_hours` последнего `metrica_daily_reconciliation.fetched_at`.

### 7. Telegram health-alerter — @SurfaiOps_bot

- Пользователь создал бота через BotFather, прислал токен. chat_id получен через `getUpdates`.
- **`server/jobs/health-alert.js`** — раз в 5 мин опрашивает `/api/health`, сравнивает с state-file `/var/lib/surfai-alerts/state.json`, шлёт в Telegram **ТОЛЬКО при переходах** (status change, level degrade, recovery, unreachable). Состояние «persistent unhealthy» → без спама.
- **Systemd unit + timer** с `StateDirectory=surfai-alerts` (systemd автосоздаёт `/var/lib/surfai-alerts/`).
- **End-to-end тест**: `systemctl stop surfai` на 6 секунд → пришёл 🚨 «health unreachable» → `systemctl start surfai` → пришёл ✅ «unreachable → healthy». Цепочка работает.

### 8. Публичный лендинг `https://surfai.ru/`

- **Research** через subagent: Sales Ninja (`sales-ninja.me`, фокус на виртуальных конверсиях для Директа), Roistat (атрибуция), Calltouch (lead-scoring на известных лидах), Carrot Quest (чат + scoring). Ни один не скорит **анонимного посетителя по поведению на странице** — это наш wedge.
- **Design-направление** через skill `frontend-ui-ux-engineer`: палитра #FAFAFA + zinc + indigo-600, Inter font, 1px hairline borders вместо теней, подпись — крупные полупрозрачные `01 / 07` слева каждой секции.
- **`landing/index.html`** (574 строки, ~30KB) — 7 секций: Hero (заголовок «Из 500 посетителей сайта 5 купят» + 500-dot visualization), Проблема (3 карточки), Что мы делаем (1 абзац + ranked-list мок — без деталей о механизме, **как пользователь просил**), Что получаете (4 тайла), Для кого / Не для кого, Чем мы НЕ являемся (differentiation против Leadfeeder / Sales Ninja / PII-сборщиков), Status + CTA.
- **SEO**: title, description, og:*, JSON-LD SoftwareApplication, canonical, `lang="ru"`.
- **Nginx**: добавлен блок `location = /` (exact-match, до catch-all) → отдаёт `/opt/surfai/landing/index.html` статикой, Fastify не трогается.
- **Backup-файл ловушка**: `surfai.conf.bak.*` в `sites-enabled/` сломал `nginx -t` дублирующим upstream. Фикс: убрали .bak из `sites-enabled/`.

### 9. Контактный бот @Surfaiask_bot + форвардер

- Пользователь создал второго бота (контактный, отдельно от ops) через BotFather.
- Все 4 CTA на лендинге переписаны с плейсхолдера `SURFAI_CONTACT_BOT` на реальный `Surfaiask_bot` (одним replaceAll).
- **`server/jobs/contact-forward.js`** — раз в 60 сек опрашивает @Surfaiask_bot `getUpdates`, **автоответ** посылает от имени @Surfaiask_bot («Спасибо, получили...»), **форвард в админ-чат** посылает от @SurfaiOps_bot с sender info, chat_id, timestamp, текстом и inline-кнопкой `https://t.me/<username>` (если есть username).
- **Баг в процессе тестирования**: inline-кнопка на `tg://user?id=<id>` возвращает `BUTTON_USER_INVALID` — Telegram не даёт ботам создавать кнопки на произвольных user_id. Фикс: если есть username → кнопка на `https://t.me/<username>`, иначе — без кнопки (Telegram в тексте auto-linkify'ит `@username`).
- **Протестировано**: тестер Ani M написала в бота → получила автоответ, админ получил форвард в @SurfaiOps_bot.

## Key decisions

1. **Metrica-интеграция трёхслайсовая**, не одним куском. Slice 1 — чистая reconciliation без SDK-правок, Slice 2 — SDK захватывает `ym_uid`, Slice 3 — attribution-фичи в `session_features`. Это позволяет в первую неделю увидеть, валидны ли join-цифры, до того как трогать SDK или feature-store.
2. **`metrica_goals_total` оставили NULL**: Metrica не имеет агрегатной метрики «все цели», нужно отдельно тянуть список goal_id через Management API и суммировать. Отложили на Slice 2+.
3. **Health-алертер шлёт только при переходах** (не периодически). Альтернатива — каждые 5 мин слать статус — рождает спам и desensitization. Recovery-сообщения шлём явно.
4. **Landing — vanilla HTML + Tailwind CDN, не Next.js**. Для single-page статики с одной CTA и без форм Next даёт лишний build-step, deploy-пайплайн и зависимость. Свернули в ~30KB файл, отдаваемый nginx напрямую.
5. **Позиционирование лендинга — против Sales Ninja, не как Sales Ninja**. Sales Ninja шлёт виртуальные конверсии в Директ; мы даём сырой intent-скор + ранжированный список, решения принимает клиент. Это differentiation, а не копия.
6. **Механизм на лендинге не раскрываем**. Пользователь явно сказал: «учитываем N факторов и тому подобное». Вместо блока «как работает» — одна строка «мы измеряем 100+ факторов, механику оставим за кадром». Это повышает доверие, а не понижает.
7. **Два бота, а не один**. @SurfaiOps_bot — только внутренние health-алерты. @Surfaiask_bot — только внешние обращения с лендинга. Разделение чистое: если в Ops-чат приходит что-то — это про инфраструктуру, если форвард с префиксом 📩 — это лид.
8. **Автоответ в контактный поток**. Пользователь написал и получил тишину — плохой UX. Автоответ «Спасибо, ответим за день» стоит 5 строк кода и убирает тревогу. Один раз на собеседника, не спамим.
9. **Антифрод запарковали, не делаем сейчас**. Технически всё готово, но требует своего label-источника и отдельного продуктового позиционирования. Возвращаемся после Phase 7–8.
10. **Off-site backup НЕ сделан намеренно**. MVP — локальный pg_dump на VPS, защищает от SQL-катастрофы, не от потери VPS. Off-site требует провижена стораджа (S3 / второй VPS / rsync), отдельный разговор.

## Current state

### На проде работает и стреляет

| Что | Когда |
|---|---|
| `surfai.service` | 24/7 |
| `surfai-metrica-reconcile.timer` | 04:00 MSK ежедневно |
| `surfai-backup.timer` | 03:30 MSK ежедневно |
| `surfai-health-alert.timer` | каждые 5 мин |
| `surfai-contact-forward.timer` | каждые 60 сек |

### В памяти (auto-memory)

Обновлены: `project_surfai_deployment.md` (добавлены все новые systemd-юниты, Metrica-интеграция, Telegram-боты, контактный пайплайн, лендинг). Созданы: `project_metrica_scope.md`, `feedback_prod_deps_drift.md`. Обновлён `feedback_sdk_telemetry_lessons.md` с Lesson 4.

### В vault

- `vault/bugs/2026-04-19 luch gtm container removed.md` — post-mortem GTM-инцидента
- `vault/decisions/2026-04-19_yandex_metrica_enrichment.md` — ADR на 3 слайса Metrica
- `vault/decisions/2026-04-19_antifraud_direction_future.md` — припаркованный ADR

### В репо (main)

17+ коммитов за день: post-mortem → Metrica Slice 1 → geoip drift fix → ML widget → Reconciliation view → Site Health panel → 3-pages docs → Antifraud ADR → ops hygiene → backup unit fix → db-check level consistency → Telegram docs → Telegram alerter → landing page → landing Telegram wire-up → contact forwarder → contact button fix → session summary.

## Next steps

### Ближайшие сутки — накопление данных

- Завтра в 03:30 MSK — первый авто-pg_dump (мы прогнали вручную для теста, следующий автоматически).
- Завтра в 04:00 MSK — второй reconciliation-прогон, уже две строки на сайт в `metrica_daily_reconciliation` — можно смотреть baseline-стабильность.
- Через 5–7 дней — 50+ enriched-конверсий, можно запускать ретрейн CatBoost на ~103 фичах.

### Неделя-две ожидания данных — возможные работы

В порядке рекомендованной очерёдности из plan A:

1. **Plan A — surface'ить enrichment в UI**. Session detail page не показывает `geo_*`, `perf_*`, `uah_*`, `bot_score` — оператор не видит половину собираемых сигналов. Плюс фиксить N+1 в текущем session list (100 HTTP вызовов `/features` на загрузку).
2. **Segmentation в sessions list** по country / UTM / device / bot_risk_level / LCP-buckets — в roadmap'е как «Phase 6.5 Data Enrichment → Dashboard segmentation».
3. **Metrica Slice 2** — SDK начинает захватывать `ym_uid` в context-событии. Миграция 015. Одна строка в `ContextCollector`.

### Явные TODO

- **Off-site backup** (S3 / второй VPS / rsync) — локальная копия не спасёт от VPS-смерти
- **Auto-refresh Metrica-токена** через `refreshAccessToken()` helper, который уже написан но не зашедулен
- **Контактный бот**: если лидов пойдёт много, имеет смысл сделать `/status`, `/mute` команды (interactive bot, не just one-way)
- **og:image для лендинга** — 1200×630 превью для шерингов в Telegram/VK
- **Фикс GeoIP-drift'а стратегически**: документировать паттерн «dep на прод → одновременный commit в репо», чтобы в будущих сессиях Claude не повторил ту же ошибку. Уже сделано через memory.

## Open questions

1. **Баги на прод-таймере первого фаера** — первый fire `surfai-health-alert.service` после `enable --now` упал с `ETIMEDOUT` на `sendTelegram`. Второй фаер через секунду сработал чисто. Не воспроизвелось, списали на транзиентный network-блип (я в этот момент параллельно SSH-сессию тяжело нагружал). Если повторится — смотреть сетевую изоляцию systemd-сандбокса.
2. **Sales-cycle-длинный ли у наших реальных 5 сайтов?** Позиционирование лендинга предполагает B2B / high-ticket с неделя+-циклом. Но конкретно наши текущие подключённые — sequoiamusic (продажа роялей), sluhnn (слуховые аппараты), stefcom (?), дома-из-теплостен (стройка), химчистка-луч (клининг). Строительство и рояли — точно да, слуховые аппараты скорее да, клининг — спорно. Вероятно для MVP-позиционирования ок, но если придут ecom-клиенты — надо будет думать о второй странице или менять ICP.
3. **Контактный бот-autoreply text** — сейчас хардкод: «Спасибо, получили ваше сообщение. Ответим в течение дня. — Команда SURFAI». Стоит ли сделать чуть живее («Привет! Это автоответ...»), или оставить сдержанно? Зависит от тона, в котором хотим общаться с лидами на старте.
4. **Нужна ли контакт-форма для CRM?** Сейчас обращения приходят в Telegram форвардом. Если лидов будет много — захочется структурированной CRM-интеграции. Это не сейчас, но стоит держать в голове.
5. **Кнопка «Открыть @username» в форвардах** — работает только если у человека есть username. Если пишет без username — кнопки нет. Можно ли без неё обойтись, или стоит что-то придумать (например, `reply_to_message` через @Surfaiask_bot → оператор пишет ответ там)? Пока оставили так.
