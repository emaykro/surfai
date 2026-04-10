# Сессия 2026-04-10: Восстановление SDK-телеметрии — context / bot_signals / session events

Большая сессия-расследование. Начали с нейтрального вопроса «нам не хватает данных о пользователях — девайсы, ОС, браузер», а закончили **каскадным фиксом четырёх связанных багов**, которые в сумме три дня тихо портили production data.

## Что привело нас сюда

User спросил, что можно сделать для расширения данных о пользователях. Я начал с пункта «проверить, не собираются ли уже device/browser/OS-поля, но не используются». Оказалось — **собираются в коде**, **подключены к ML** в `ml/config.py`, но в production **реальные данные не приходят**.

Провёл аудит покрытия через postgres MCP / SSH на прод:

| Дата | Сессий | С `context` | Покрытие |
|---|---|---|---|
| 2026-04-07 | 498 | 464 | **93%** ✅ |
| 2026-04-08 | 506 | 197 | 39% ⚠️ |
| 2026-04-09 | 450 | 10 | 2% ❌ |
| 2026-04-10 (утро) | 167 | 0 | **0%** ❌ |

`bot_signals` events с момента деплоя 2026-04-08 — **ни одного**. `session` events — ~11% (редкие счастливчики).

Регресс начался 2026-04-08 в день коммита `e5cfb3c` "Add 3-layer bot detection".

## Что было найдено и починено

### Баг 1 — `requestIdleCallback` ронял контекст на bounce-сессиях

**Файлы:** `client/src/collectors/context.ts`, `client/src/collectors/bot-signals.ts`

`ContextCollector.start()` и `BotSignalCollector.start()` оба откладывали свой единственный `pushEvent` в `requestIdleCallback`. На bounce-сессиях (большинство реального трафика) браузер выгружает страницу раньше, чем idle callback успеет выстрелить — event даже не попадает в буфер, и `sendBeacon` на `pagehide` его не видит.

**Фикс:** убрали `requestIdleCallback`, эмиттим синхронно прямо в `start()`. Обёрнуто в `try/catch` ради never-throw-into-host правила.

**Коммит:** `36f7a69` — "Fix context/bot_signals: emit synchronously instead of via requestIdleCallback"

### Баг 2 — миграция 008 забыла обновить `events_type_check`

**Файлы:** `server/migrations/008_bot_detection.sql` (прошлый дефект), `server/migrations/009_bot_signals_event_type.sql` (новый фикс)

`persistBatch()` работает атомарно — `BEGIN` / `COMMIT` на всю ingest-порцию. Миграция 008 (2026-04-08) добавила колонки `bot_score`, `bot_signals`, `is_bot` в `session_features`, **но забыла обновить CHECK-constraint** `events_type_check`, в котором перечислены разрешённые значения `events.type`. Тип `bot_signals` так и не был валидным.

Каждый ingest batch, в котором присутствовал `bot_signals` event, отвергался Postgres целиком — **вместе со всеми mouse/scroll/context/etc в том же POST**. Как collateral damage.

Это маскировалось два дня только потому, что `requestIdleCallback` почти никогда не срабатывал и большинство батчей никакого `bot_signals` не несли. Наш Баг 1 фикс (синхронный emit) **обнажил** Баг 2 — теперь каждый батч нёс `bot_signals`, и каждый батч падал.

**Фикс:** новая миграция `009_bot_signals_event_type.sql` в стиле 002 / 006 — `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` с расширенным списком типов.

**Коммит:** `16527e9` — "Add migration 009: allow bot_signals in events_type_check"

### Баг 3 — nginx-кэш 24 часа на `/dist/tracker.js`

**Файл:** `/etc/nginx/sites-enabled/surfai.conf` (прод, вне git)

nginx отдавал `tracker.js` с `Cache-Control: public, max-age=86400`. Это означало, что любой фикс SDK приходил к клиентам с задержкой до 24 часов, а первые 2 дня после деплоя Баг 1 / Баг 2 фикса мы вообще не видели изменения метрик.

**Фикс:** вручную на проде в `location /dist/` добавлены `proxy_hide_header Cache-Control` + `add_header Cache-Control "public, max-age=300, must-revalidate" always`. Бекап оригинала — `/root/surfai.conf.bak.20260410-143837`. Проверено `nginx -t`, применено `systemctl reload nginx`.

**Последствие:** теперь любая будущая правка SDK раскатывается за ≤5 минут. Долгосрочно стоит сделать content-hash в имени файла (`tracker.<sha>.js`) и вернуть long cache с `immutable`, но это TODO.

### Баг 4 — `SessionCollector` не отправлял session event

Это оказался не один баг, а **каскад из трёх**:

**4a. Порядок `beforeunload` listeners.** `tracker.start()` регистрировал свой `onBeforeUnload` (который вызывает `flushBeacon`) ПЕРЕД циклом запуска коллекторов. SessionCollector затем регистрировал свой собственный `beforeunload` listener. При unload tracker первым делал flush пустого состояния, потом SessionCollector пушил `session` event в уже опустошённый буфер — который больше никогда не флашился.

**Фикс:** ввели опциональный метод `beforeFlush?()` в `Collector` interface. `tracker` вызывает `c.beforeFlush()` для всех collectors СИНХРОННО непосредственно перед `flushBeacon()` во всех трёх lifecycle handlers. SessionCollector реализует `beforeFlush()` вместо регистрации собственного listener'а. Коммит `cf358db`.

**4b. `flushBeacon` дренил только первые 100 events + `pushEvent` auto-flush race.** На busy-сессиях buffer имел >100 events к моменту unload. `flushBeacon` делал одну `splice(0, 100)` + один `sendBeacon` — хвост терялся. Плюс `pushEvent` в `beforeFlush` триггерил `this.flush()` (async fetch), который гонился с unload.

**Фикс:** добавили флаг `this.unloading` на tracker, выставляется в lifecycle handlers **до** `runBeforeFlushHooks`. `pushEvent` при `unloading=true` не триггерит async auto-flush. `flushBeacon` переписан на while-loop, дренит весь buffer через несколько `sendBeacon` вызовов подряд (cap 10 beacons), каждый с соблюдением `MAX_EVENTS_PER_FLUSH` и `MAX_PAYLOAD_BYTES`. Коммит `f821009`.

**4c. `beforeunload` / `visibilitychange` ненадёжны на мобильных.** Даже после 4a+4b в production оставался 0% покрытие по session events. Причина: основной трафик SURFAI — мобильные Yandex Browser / Safari iOS, на которых `beforeunload` часто не стреляет, а `visibilitychange→hidden` может срабатывать после того, как `sendBeacon` уже бесполезен.

**Фикс:**
- Добавили **`pagehide`** listener как третий lifecycle event (рекомендация MDN / web.dev для надёжной browser telemetry). Все три (`visibilitychange`, `pagehide`, `beforeunload`) funneлятся через shared `finalFlush()`, который идемпотентен через `this.unloading`.
- В `SessionCollector.start()` добавили **ранний snapshot через `setTimeout(3000)`**. На bounce-сессиях короче 5 сек, где никакой lifecycle не успевает — этот ранний snapshot всё равно уходит через обычный 5-секундный flushInterval (`fetch` путь).

**Коммит:** `352b7d2` — "Reliable session snapshot: pagehide listener + early 3s snapshot"

## Итоговое состояние production (2026-04-10 16:41 MSK)

Сессии, начавшиеся после последнего деплоя 16:33:32:

| Start | Duration | Events | `context` | `bot_signals` | `session` |
|---|---|---|---|---|---|
| 16:33 | 4 мин | 141 | ✅ | ✅ | **✅** |
| 16:39 | 2 мин | 145 | ✅ | ✅ | **✅** |

**2/2 = 100%** на свежем бандле. Старые сессии (до 16:33) всё ещё используют закэшированный бандл и не имеют session events — они естественно выровняются по мере истечения browser cache.

**Покрытие context / bot_signals после фикса 14:50 (migration 009):** стабильно ~95–100% на свежих сессиях.

## Инфраструктурные улучшения, которые прошли заодно

- Новый метод `Collector.beforeFlush?()` в public interface — другие коллекторы могут использовать для финальных snapshot events.
- `tracker.finalFlush()` — единый идемпотентный путь для трёх lifecycle events.
- `tracker.flushBeacon()` — теперь дренит весь buffer, а не только первый chunk.
- `tracker.unloading` флаг — блокирует async `flush()` в unload контексте.
- 3 новых vitest теста покрывают: `beforeFlush` emit, идемпотентность, multi-beacon drain с 250-event buffer.

## Зафиксированные в auto-memory уроки

Записаны в `~/.claude/projects/-Users-arturgrigoryan-Downloads-PROJECTS-SURFAI/memory/`:
- `feedback_sdk_telemetry_lessons.md` — не использовать `requestIdleCallback` для one-shot critical telemetry; новый event type ⇒ SDK + DB constraint в одном коммите; короткий SDK cache TTL.
- `feedback_no_ruflo.md` — решение не ставить ruvnet/ruflo как фреймворк; использовать идеи (Agent Booster, Token Optimizer) как референс.

## Что осталось в backlog после сессии

1. **Расширение `ContextCollector`** (то, с чего начинали) — timezone, viewport, dpr, languages[], hardware, utm, referrer. Один коммит по Meta-Sync Protocol.
2. **GeoIP-обогащение на сервере** — MaxMind GeoLite2 → country / region / ASN на `session_features`. Работает на любой вертикали, нужно для будущего multi-vertical SaaS.
3. **Дашборд-фильтры** по device / browser / OS / country — после того, как поля начнут стабильно поступать.
4. **Content-hash в имени `tracker.js`** + immutable cache + 302 redirect с `tracker.js` на актуальный hash. Долгосрочное решение проблемы кэша.
5. **Бэкфилл невозможен** для 1,834 исторических сессий без `ctx_*` — CatBoost справится с NaN, но стоит иметь в виду при следующей тренировке.
6. **Monitoring / alerting**: в идеале иметь алерт на "context coverage < 80% за последний час" чтобы такие регрессы ловить за минуты, а не за дни.

## Открытые вопросы

- Стоит ли переименовать `Vibe-Ninja` упоминания в документации (были в `worldspace.md`) на `SURFAI`? **Сделано в этой сессии** — переписал `worldspace.md` полностью.
- Ruflo / claude-flow как фреймворк для оркестрации — **решено не ставить** (см. `feedback_no_ruflo.md`).
