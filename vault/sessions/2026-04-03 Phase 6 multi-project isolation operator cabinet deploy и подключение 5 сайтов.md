# Сессия 2026-04-03: Phase 6, деплой, подключение сайтов

## Что сделано

### CatBoost ML Pipeline (`ml/`)
- Полный training pipeline на Python: config, data loader (PostgreSQL), preprocessing (JSONB expansion), synthetic generator, CatBoost trainer, evaluation (AUC-PR/ROC, feature importance), CLI
- Smoke test на синтетических данных пройден (AUC 0.61)
- `python3 -m ml train --synthetic` / `python3 -m ml train`

### Phase 6: Multi-Project Data Model
- **Migration 007**: таблицы `projects`, `sites`, `site_key` генерация (pgcrypto), `project_id`/`site_id` на все существующие таблицы, backfill в default проект
- **SDK**: `TrackerOptions.siteKey`, IIFE bundle через esbuild (GTM совместимость), `window.SurfaiTracker` global
- **Server**: siteKey resolution с in-memory cache (60s TTL), origin validation, project/site на всех записях
- **Dynamic CORS**: автоматически из таблицы `sites` + punycode для IDN (.рф) доменов. Больше не нужно править `.env`
- **Project/Site API**: 7 endpoints — CRUD проектов, управление сайтами, snippet generation (GTM + direct с auto-pageGoals и metrikaCapture), install verification
- **Operator Cabinet**: vanilla JS SPA на `/cabinet/` — project list, site setup, snippet copy, goals management (toggle primary, delete)
- **Metrika capture**: SDK перехватывает `ym(id, 'reachGoal', goalName)` → auto-register goals с префиксом `ym_`
- **Primary goals**: `is_primary` toggle в кабинете, `primary_goal_converted` flag на session_features для ML

### Security
- HTTP Basic Auth через nginx на `/dashboard/`, `/cabinet/` (admin / surfai2026)
- Bearer token auth (`OPERATOR_API_TOKEN`) на management API (surfai-op-2026-secret)
- Login screen в кабинете
- Публичные без auth: `/api/events` (ingest), `/api/conversions`, `/dist/` (SDK)

### Deploy
- GitHub repo: github.com/emaykro/surfai (public)
- Server: 72.56.68.138, systemd service `surfai`, port 3100
- Nginx reverse proxy, TLS через certbot (surfai.ru, app/api/cdn.surfai.ru)
- `deploy/update.sh` для быстрого редеплоя

## Подключенные сайты (проект "Luch", services)

| Сайт | Статус | Конверсия |
|------|--------|-----------|
| sequoiamusic.ru | verified, 17 sessions | page_rule: /thx |
| sluhnn.ru | verified, 5 sessions | page_rule: ?thankyou (PRIMARY) |
| stefcom.ru | verified, 1 session | metrika reachGoal (нет thank-you page) |
| дома-из-теплостен.рф | verified, 1 session | page_rule: /thank-you |
| химчистка-луч.рф | pending | page_rule: /thank-you |

## Текущее состояние

- 24 сессии с фичами, 13 440 events, 0 конверсий
- 4 page_rule goals + ожидаем auto-captured ym_ goals
- Сниппеты нужно обновить в GTM (metrikaCapture: true + pageGoals)
- химчистка-луч.рф — проверить GTM

## Следующие шаги

1. **Обновить сниппеты в GTM** на всех 5 сайтах (из кабинета — уже включают pageGoals и metrikaCapture)
2. **Проверить GTM** на химчистка-луч.рф
3. **Пометить primary goals** на всех сайтах в кабинете
4. **Ждать данных**: 200+ сессий, 50+ конверсий → запуск обучения
5. Когда данные набраны: `python3 -m ml train --target primary_goal_converted`
6. Анализ feature importance → понять bottleneck
7. Phase 7: hierarchical ML (global → vertical → project models)
8. Phase 8: predictive export в GA4/Метрику

## Ключевые решения

- **IIFE bundle**: ES module export не работает в GTM Custom HTML → esbuild IIFE с `window.SurfaiTracker`
- **Dynamic CORS**: автоматически из DB, не из ENV → не нужно рестартить при добавлении сайтов
- **Punycode CORS**: IDN домены (.рф) отправляют Origin в punycode → `new URL().origin` конвертирует
- **Metrika capture**: monkey-patch `ym()` с retry 10s (Метрика может загрузиться позже SDK)
- **Primary goals**: разделение "любая конверсия" vs "конечная конверсия" для ML

## Credentials (оператор)

- nginx basic auth: admin / surfai2026
- operator API token: surfai-op-2026-secret
- SSH: root@72.56.68.138 (пароль в чате)
- DB: postgresql://surfai_user:...@localhost:5432/surfai (пароль в /opt/surfai/.env)
