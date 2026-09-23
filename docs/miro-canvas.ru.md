# miro-canvas

[English](miro-canvas.md) | **Русский**

`miro-canvas` - полностью локальный Obsidian-плагин в активной разработке;
он предназначен для расширения любого Obsidian Canvas. На обычной
доске планируются удобное редактирование, комментарии, защита, темы, цвета,
формы и продвинутые стрелки. Если локальный файл содержит `miroSource`, плагин
сможет точнее отображать ранее экспортированный Miro snapshot без связи с Miro,
OAuth или интернетом.

Это спецификация продукта и исполняемый backlog. Экспорт Miro, canonical union
и конвертер остаются отдельными слоями; `miro-canvas` отвечает за отображение и
локальную работу внутри Obsidian.

## Текущий статус реализации

Repository-level фундамент M0 реализован в `plugins/miro-canvas/`. Он включает
plugin shell, версионированную проверку `miroCanvas` schema и in-memory
migrations, read-only native/Advanced Canvas adapters, explicit metadata writer
с защищённым atomic compare-and-swap (CAS) bridge, а также детерминированную
матрицу из четырёх профилей и project-local test-vault harness.

M0 пока не production-ready. Real-Obsidian gate остаётся открытым: поведение
native Ctrl+Z/redo для metadata actions и реальная визуальная/интерактивная
проверка ещё не заявляются.

Нативный Canvas при каждом сохранении пересобирает документ из собственной
модели и сохраняет только известные ему корневые ключи, поэтому `miroCanvas` и
`miroSource` стирались бы любой обычной нативной правкой. Сессия ставит один
хук на `getData` в пределах экземпляра: он переносит все корневые ключи, которые
остались в живом документе, но пропали после пересборки, включая данные другого
плагина — потерять их так же разрушительно, как свои. `nodes` и `edges` всегда
остаются за хостом, значение, созданное самим хостом, никогда не
перезаписывается, а при dispose хук снимается.

Документ, созданный хостом, читается в своей JSON-форме: значения, которые
теряет сериализация, например отсутствующее необязательное поле со значением
`undefined`, нормализуются, а не считаются признаком испорченного документа. Всё,
что плагин ставит новым корнем, по-прежнему проходит строгий plain-JSON клон. Требовать от хоста побайтово тот же документ нельзя,
поэтому принятая транзакция проверяется по тому, чем владеет плагин: его
корневые ключи должны совпасть точно, а наборы id узлов и рёбер — остаться
прежними. Всё, что хост изменил сверх этого, отклоняется с откатом, а отказ
теперь называет условие, на котором он произошёл.

Текущий этап включает интерфейс M1: навигацию, кликабельную minimap,
типографику, темы доски, цвета, блокировки/review mode и видимость названий
вложений. Native zoom безопасно ограничен диапазоном 6,25%–200%; снятие этого
ограничения не реализовано. DOM smoke в Chromium проверяет интерфейс M1 с
синтетическим native host, а не настоящий runtime Obsidian.

Контекстная панель форматирования появляется над выделением, когда native DOM
поддаётся измерению, и исчезает сразу после снятия выделения. По образцу Miro
это один компактный ряд иконок: фигура, шрифт, размер со степпером, жирность,
выравнивание, по кнопке на каждый цветовой слот, переключатель блокировки и меню
переполнения. Длинные списки в самом ряду не появляются. Кнопка фигуры открывает
частые типы, а **More shapes** раскрывает все поддерживаемые типы Miro; в меню
переполнения лежат остальные начертания, межстрочный интервал, стиль и толщина
обводки и полный набор настроек коннектора: маршрут, стиль линии, оба
наконечника и толщина. Неприменимые к выделению элементы управления убираются из
ряда, а не показываются неактивными; одновременно открыт только один popover.

Типографика и цвета по-прежнему идут через appearance pipeline, а фигура,
обводка и коннектор — через защищённую authoring-транзакцию. В review mode и на
заблокированном элементе панель остаётся видимой, но неактивной, с явным
указанием причины; исключение — переключатель блокировки, который остаётся
рабочим, чтобы случайную блокировку можно было снять. Боковая панель пока
сохраняет те же группы типографики и цветов; это дублирование убирается после
проверки панели в настоящем runtime Obsidian.

Зум, вписывание и переключатель миникарты находятся в навигационном доке внизу
холста, рядом с картой, которой они управляют; при скрытой карте док продолжает
нести зум. Панорамирование, зум, миникарта, review mode и блокировка
зарегистрированы как команды, поэтому им можно назначить клавиши в штатном
редакторе горячих клавиш Obsidian; плагин не занимает ни одной клавиши по
умолчанию. Вкладка настроек задаёт шаг и диапазон зума, следование зума за
курсором, модификатор колеса, шаг клавиатурного панорамирования и его множитель
с Shift, а также видимость поверхностей. Сохранённые настройки нормализуются при
загрузке: неизвестные ключи отбрасываются, числа вне диапазона зажимаются, так
что неверная настройка не может помешать открыть доску.

При выделении одного элемента появляются ручки, которых нет у нативного
Canvas: ручка поворота под выделением и три ручки связи на каждой стороне.
При наведении ручка становится стрелкой наружу: клик добавляет связанную ноду,
а перетаскивание проецирует оба конца на настоящий контур фигур по направлению
указателя вместо фиксации в серединах сторон. Поворот показывается на месте и
записывается один раз при отпускании, поэтому жест даёт одну запись в нативной истории, а не десятки;
Shift привязывает угол к 15 градусам. Связь, отпущенная над другой нодой,
становится нативным ребром, а стрелка создаёт ноду рядом с выделением и
соединяет её. Всё это идёт через защищённую authoring-транзакцию, поэтому review
mode, заблокированная цель и устаревший документ отклоняют жест так же, как
отклонили бы действие из меню.

Инструменты M2 доступны через команду **Local shapes, comments, anchors and
documents**: поддерживаемый набор фигур Miro с редактируемым native text
fallback. Каждый локальный комментарий получает постоянный Canvas anchor и
собственную метку; открытие метки фокусирует ветку, где у каждого сообщения
показаны автор и время создания. Импортированные комментарии доступны только
для чтения. Локальные ветки можно редактировать, дополнять ответами, переводить
в resolved/reopen и удалять прямо из панели или карточки marker. Marker можно
перетащить на другой элемент или в свободную точку Canvas, не изменяя исходный
объект импортированного Miro comment. Имя локального автора берётся из настройки,
затем из имени Obsidian account, а цвет marker/avatar настраивается отдельно для
каждого автора.
Выберите цель и относительные координаты node/image anchor, T для edge anchor
или X/Y свободной точки, затем сохраните anchor или измените конец стрелки.
Для node/image меняется и native endpoint. Free/edge anchors сохраняют валидный
native fallback с диагностикой приближённого отображения без плагина.
Изменения графа учитывают readonly/review/locks, сохраняют `miroSource` и
неизвестные поля и записывают одну транзакцию native history. Точные anchors
коннектора хранятся рядом с ближайшим native side fallback, поэтому файл
остаётся пригодным без плагина.

Перед открытием инструментов выберите файл для навигации штатным viewer.
PDF-навигация учитывает введённую страницу, Markdown сохраняет subpath.
Неподдерживаемый PDF fit API даёт диагностику; активный импортированный HTML
не выполняется внутри плагина. Unit и Chromium integration тесты проверяют UI
M2 и синтетическую native history. Работа и горячие клавиши в настоящем
Obsidian остаются отдельной неподтверждённой проверкой.
M3 проецирует canonical `miroSource.items`/`connectors` через явные bindings.
Source/local rotation применяется вокруг центра native node и учитывается в
anchors; z-order берётся из метаданных или source rank. Обратимый renderer
добавляет inert-оформление существующим native DOM-элементам для фигур, текста,
sticky notes, connectors, frames и media, не заменяя редактируемое содержимое и
не выполняя source HTML/URL. Ограничения раздельных native node/edge layers и
недостающих source-полей выдаются как диагностика.
Первый срез M4 распознаёт подтверждённый payload Miro code, проецирует только
ограниченные по размеру title/language/line-number/code поля и добавляет
обратимое оформление code card вокруг редактируемого Canvas text. Raw HTML,
URL и неизвестные source-поля остаются неактивными внутри `miroSource`.
Следующий срез распознаёт подтверждённые `app_card.fields[]` и card theme.
Плагин добавляет обратимое оформление и ограниченное состояние card, а title,
description и fields остаются редактируемым native Canvas text конвертера.
Preview metadata теперь показывается inert overlay поверх native clickable
link. Обычные cards связывают ограниченный список tag IDs с definitions и
показывают безопасные chips; сами tag definitions не становятся board nodes.
Подтверждённые `mindmap_node` сохраняют native text и hierarchy edges,
созданные конвертером. Renderer различает root/branch, применяет безопасные
source colors/shapes и отдельно маркирует generated hierarchy edges. Legacy
`mindmap` остаётся явно source-limited.
Через Commands и command palette открывается read-only source/provenance
inspector. Он показывает bounded counts по типам, completeness, provenance,
diagnostics, selection и paths/types неизвестных полей. Raw values остаются
только в Canvas-файле, а доска не получает служебных nodes.

Текущие проверки плагина из корня репозитория:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
```

Собрать и развернуть локальный runtime в защищённый M0 test vault можно из
корня репозитория:

```powershell
cd plugins\miro-canvas
npm ci
npm run typecheck
npm test
npm run build
cd ..\..
python tools\obsidian_oracle\setup_m0_vault.py
python tools\obsidian_oracle\check_environment.py
```

`setup_m0_vault.py` создаёт `_obsidian_oracle_vault`, раскладывает все четыре
committed fixtures в `MIRO2OBSIDIAN\_oracle\m0-compatibility` и атомарно
копирует только собранные `manifest.json`, `main.js` и `styles.css` для
`miro-canvas`. Цель защищена: произвольный vault или путь через link/reparse
point отклоняется. Для Advanced Canvas сначала будет создан placeholder
manifest; настоящий runtime нужно отдельно скопировать или установить, поэтому
успешная offline matrix check не является real-Obsidian visual pass.

Setup также создаёт `m1-daily.canvas`: локальное вложение, заблокированный
элемент, настройки текста и удалённый элемент для проверки minimap. Повторный
setup сохраняет ручные изменения этой доски. Команда
`python -m tools.obsidian_oracle.smoke_plugin_ui` проверяет настоящий интерфейс
плагина в DOM Chromium с синтетическим Canvas host; это browser integration
check, а не проверка совместимости в самом Obsidian. Если Playwright Chromium
не установлен, добавьте `--browser edge`, чтобы использовать Microsoft Edge.

### Активация и проверка M0-профилей

Каждая активация раскладывает выбранный Canvas fixture и атомарно обновляет
контролируемые записи `.obsidian\community-plugins.json`. Ниже приведены
ровно четыре пары команд; запускать их нужно из корня репозитория:

```powershell
python tools\obsidian_oracle\activate_profile.py native-only
python tools\obsidian_oracle\check_environment.py --profile native-only

python tools\obsidian_oracle\activate_profile.py miro-canvas-only
python tools\obsidian_oracle\check_environment.py --profile miro-canvas-only

python tools\obsidian_oracle\activate_profile.py advanced-only
python tools\obsidian_oracle\check_environment.py --profile advanced-only

python tools\obsidian_oracle\activate_profile.py both
python tools\obsidian_oracle\check_environment.py --profile both
```

Профили означают соответственно native Canvas без optional plugins, native
Canvas с `miro-canvas`, native Canvas с Advanced Canvas и оба плагина. Checker
проверяет enabled-plugin state, metadata fixture и committed matrix. Отсутствие
бинарников плагинов является warning, если не указан `--strict-runtime`.
Для реального Advanced Canvas сначала установите pinned hash-verified runtime
командой `python -m tools.obsidian_oracle.install_plugin_runtime advanced-canvas`
или скопируйте его из существующего vault; затем повторите проверку нужного
профиля с `--strict-runtime`.

Скрипты только готовят файлы и не регистрируют/не открывают project-local vault
в окне пользователя. Перед real-app check добавьте `_obsidian_oracle_vault`
через vault switcher Obsidian (или другим штатным способом), затем откройте
Canvas из `MIRO2OBSIDIAN\_oracle\m0-compatibility`. Выполненный offline
checker сам по себе не означает real-Obsidian visual pass.

При ошибке **vault not found** выберите **Открыть другое хранилище → Открыть
папку как хранилище** и укажите абсолютный путь из setup. URI `open` не
регистрирует новую папку. Команда
`python -m tools.obsidian_oracle.open_local_vault` проверяет регистрацию без
изменения глобальных настроек Obsidian и печатает нужный путь. После
регистрации используйте `--profile both --open`. Опция
`check_environment --require-registered` делает отсутствие или неопределённость
регистрации явной ошибкой. Если папки не видно, вставьте полный путь в адресную
строку выбора папки; диск J: должен быть доступен самому процессу Obsidian.

### Явные metadata actions

Команды command palette регистрируются только на активном native Canvas, если
известная persistence boundary совместима:

| Команда | Действие |
|---|---|
| `Miro Canvas: Initialize board metadata` | Явно создаёт `miroCanvas` schema v1; при уже существующем default metadata это no-op. |
| Native Canvas `Ctrl/Cmd+Z` | Использует native undo history Obsidian после explicit metadata transaction. |
| Native Canvas `Ctrl/Cmd+Y` (или штатное действие redo) | Использует native redo history Obsidian после explicit metadata transaction. |
| `Miro Canvas: Show plugin status` | Показывает adapter, metadata, persistence и optional Advanced Canvas state. |

Открытие или inspection Canvas ничего не записывает. Каждая metadata mutation
проходит explicit writer (внутренний API `MetadataWriter.write(action, mutate)`):
detached JSON-safe copy, schema validation, проверка неизменности `miroSource`
и одна complete-document transaction в host. Native bridge записывает такую
транзакцию через `requestSave(true)`, поэтому native Ctrl/Cmd+Z и Ctrl/Cmd+Y —
предполагаемый путь undo/redo; отдельного user-facing history stack у плагина
нет. Public command M0 — `Initialize board metadata`; будущие controls будут
использовать ту же writer boundary. Проверка native hotkeys остаётся real-app gate.

### Atomic CAS bridge и fail-closed

`src/obsidian-metadata-store.ts` — единственный native root-data bridge. Он
поддерживает известную форму (`Canvas.data` как writable data property и
синхронный `requestSave(true)` native history/save boundary), отдаёт detached
snapshots и
передаёт `commitDocument(next, expected)` в `MetadataWriter`. Bridge не угадывает
`getData`, `setData`, `importData`, vault writes или text-view serialization.

Bridge сравнивает live root с `expected`, заменяет его detached clone, вызывает
`requestSave(true)`, проверяет результат и восстанавливает предыдущий root, если host
отклонил транзакцию, выбросил ошибку, вернул async thenable или записал другой
document. Writer дополнительно отклоняет malformed/unsupported metadata,
invalid candidate, cyclic/non-JSON document, stale CAS/history и любое изменение
immutable `miroSource`. Bridge намеренно не принимает и не записывает неудачные
транзакции; поведение при внутреннем сбое private Obsidian runtime остаётся
частью проверки в реальном приложении.

Это доказывает atomic in-memory root replacement и создание native undo snapshot;
Obsidian всё ещё планирует обычное debounced сохранение файла, поэтому durable
disk flush синхронно не доказан и это не filesystem transaction.

Если private runtime shape отсутствует, read-only, accessor-backed, malformed или
несовместим, bridge сообщает `unavailable`/`incompatible` и не выдаёт writable
store. Плагин остаётся загружен, native Canvas продолжает работать, а только
metadata persistence commands выключаются с diagnostic status. Поведение
покрыто offline unit tests; реальный Obsidian session пока не проверен.

## Пользовательское ядро

| Возможность | Что должно быть в первой рабочей версии |
|---|---|
| Шрифты и текст | Выбор font family и размера, форматирование и alignment через UI, без ручного HTML |
| Комментарии | Отображение, создание, редактирование, ответы, resolve и anchors к элементу или точке |
| Zoom | Большой диапазон zoom, быстрый fit и сохранение привычного pan/pinch/wheel |
| Миникарта | Весь холст в углу, точная рамка текущего viewport, click/drag navigation без смены zoom |
| Тема отображения | Мгновенное переключение system/light/dark командой, кнопкой и hotkey |
| Цвета | Расширенная палитра, recent colors и простой picker для text/fill/border/edge |
| Nodes и формы | Создание и редактирование расширенных node types и всех поддерживаемых Miro shapes |
| Документы | Аккуратный preview, page/fit controls и нормальное открытие исходного файла |
| Защита | Lock отдельных элементов и review mode всей доски без случайного редактирования |
| Стрелки | Разные caps, anchors внутри элементов, на изображении, на другой стрелке и в свободной координате |
| Названия вложений | Глобальный default и отдельный toggle для каждой file/document node |
| Obsidian | Сохраняются hotkeys, Markdown, wikilinks, обычные ссылки, embeds, drag/drop, undo/redo и context menu |
| Offline | Вся работа, comments, settings и assets остаются в vault; сеть не нужна |
| Рисование | Пока используется Excalidraw; встроенное свободное рисование остаётся в roadmap |

## Главные правила

- Общие функции плагина работают на любой Canvas-доске; Miro renderer включается
  только при наличии `miroSource`.
- Canonical JSON всегда остаётся максимально полным и не упрощается ради Canvas.
- `.canvas` остаётся валидным и открывается без `miro-canvas`; без плагина виден
  стандартный Canvas fallback.
- Плагин не форкает Obsidian и Advanced Canvas и не изменяет их файлы.
- Нативные возможности Canvas и Obsidian переиспользуются и не подменяются.
- Content хранится в стандартных Canvas fields, когда они подходят. Шрифты,
  locks, comments и свободные anchors хранятся в namespaced `miroCanvas` metadata.
- Пользователь локально редактирует Canvas, а immutable `miroSource` остаётся
  историческим snapshot. Отправка данных обратно в Miro не входит в этот проект.
- Плагин не выдумывает отсутствующие данные. Source-limited элементы получают
  явную диагностику, а не правдоподобную подделку.
- Открытие Canvas ничего не записывает; файл меняется только после явного
  пользовательского действия.
- `canvas-zoom-unlock` поглощается `miro-canvas` после достижения полной
  функциональной эквивалентности; два постоянных плагина для одной доски не нужны.

## Архитектурное решение

Пишем `miro-canvas` с нуля как отдельный Obsidian plugin, но не создаём новый
Canvas engine. Базой всегда остаётся нативный Obsidian Canvas. Поэтому
`самостоятельно` здесь означает: все обязательные функции работают без Advanced
Canvas и других community plugins; сам core Canvas Obsidian остаётся необходим.

Advanced Canvas поддерживается как необязательный сосед. Если он установлен,
`miro-canvas` использует совместимые metadata/events и не дублирует уже активные
controls. Если его нет или его API изменился, отключается только integration
layer, а доска и собственные функции `miro-canvas` продолжают работать.

- [ ] `ARCH-001` `P0 P` Использовать нативный Canvas view как единственный
  обязательный runtime и не заменять его отдельным редактором.
- [x] `ARCH-002` `P0 P` Не зависеть при загрузке или сохранении от Advanced
  Canvas, Canvas Minimap, Excalidraw или другого community plugin.
- [x] `ARCH-003` `P0 P` Подключать Advanced Canvas только через optional adapter
  с runtime detection, проверкой capabilities и graceful disable.
- [x] `ARCH-004` `P0 P` Не форкать и не копировать код Advanced Canvas;
  совместимость строить на данных, событиях и минимальном feature detection.
- [ ] `ARCH-005` `P0 P` Один и тот же `.canvas` без потери данных открывается в
  режимах: native only, `miro-canvas`, Advanced Canvas и оба plugins вместе.
- [ ] `ARCH-006` `P0 P` При совместной работе убирать дублирующиеся кнопки и
  patches, сохраняя один понятный control для каждой функции.
- [ ] `ARCH-007` `P0 P` Изолировать private Canvas internals в одном тонком
  `CanvasAdapter`; Advanced Canvas integration не должна растекаться по features.
- [ ] `ARCH-008` `P1 P` Читать Advanced JSON Canvas metadata, когда она есть, но
  реализовать необходимое отображение этого metadata и без Advanced Canvas.
- [x] `ARCH-009` `P0 P` Размещать исходники в `plugins/miro-canvas/` этого repo,
  собирать TypeScript через esbuild и не добавлять UI framework/runtime dependency.
- [ ] `ARCH-010` `P1 P` Выносить plugin в отдельный repository только перед
  независимыми releases/community publication, когда граница кода стабилизируется.
- [ ] `ARCH-011` `P0 P` Несовместимость optional integration не должна блокировать
  startup, чтение, редактирование или сохранение обычной Canvas-доски.

## Офлайн-граница

- [ ] `OFFLINE-001` `P0 P` Не включать Miro API client, OAuth, access tokens,
  upload, polling или synchronization code.
- [ ] `OFFLINE-002` `P0 P` Не выполнять фоновые network requests, telemetry,
  remote fonts, remote previews или update checks из board renderer.
- [ ] `OFFLINE-003` `P0 P` Хранить comments, overrides, anchors, settings и
  обязательные assets локально в vault или plugin data.
- [ ] `OFFLINE-004` `P0 P` Открывать внешний URL только после явного клика через
  штатное действие Obsidian; отсутствие сети не ломает доску.
- [ ] `OFFLINE-005` `P0 P` Считать `miroSource` immutable historical snapshot, а
  не remote state, который требуется обновлять.
- [ ] `OFFLINE-006` `P0 P` Все create/edit/delete/comment workflows должны
  полностью работать при физически отключённой сети.
- [ ] `OFFLINE-007` `P1 P` Собрать все внешние file/link references в diagnostics,
  не загружая их автоматически.
- [ ] `OFFLINE-008` `P0 P` Перед release запускать network-denied integration test
  и подтверждать отсутствие обязательных remote dependencies.

## Что означают метки

| Метка | Где нужна работа |
|---|---|
| `P` | Только `miro-canvas` |
| `B` | Небольшой metadata bridge в конвертере и renderer в плагине |
| `S` | Сначала нужен новый источник Miro; плагину пока нечего рисовать |
| `X` | В текущем публичном export этого нет; только диагностика |

Приоритеты: `P0` - обязательно для production или защиты данных, `P1` - полный
основной workflow, `P2` - улучшение удобства, `P3` - будущая или source-зависимая
работа. Фактический порядок реализации задают этапы `M0`-`M5` ниже.

## Проверенная исходная точка

Production-прогон `TEST_BOARD` от 2026-08-16:

| Артефакт | Факт |
|---|---:|
| Canonical Miro items | 479 |
| REST comments | 1 |
| Web SDK items | 477 |
| Обязательные assets | 78 images, 1 document, 2 `doc_format` |
| Canvas | 445 nodes, 30 edges |
| Битые file refs / дубли ID / оборванные edges | 0 / 0 / 0 |
| Полнота capture | `complete=true`, `capture_complete=true` |
| Полнота всей внутренней модели Miro | `board_complete=false` |

`board_complete=false` означает ограничение публичных Miro API, а не дефект
pipeline. Подробный снимок расхождений находится в
[`MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md`](MIRO_VS_CANVAS_DISPLAY_GAPS.ru.md).

## Контракт данных

Canonical источник уже целиком встроен в `.canvas` как `miroSource`. Поэтому
плагин не должен дублировать каждый Miro object в каждой Canvas node. При
открытии он один раз строит индекс `items`, `comments`, `assets` и tag definitions
по ID.

Дополнительное корневое поле `miroCanvas` хранит две вещи: вычисленные данные
renderer и локальные пользовательские расширения, которых нет в JSON Canvas.
Оно допустимо и на обычной доске без `miroSource`:

```json
{
  "miroCanvas": {
    "schemaVersion": 1,
    "transform": {
      "scale": 1.0,
      "offsetX": 0.0,
      "offsetY": 0.0
    },
    "bindings": {
      "generated-canvas-id": {
        "sourceId": "miro-item-id",
        "role": "item"
      }
    },
    "zOrder": ["miro-item-id"],
    "decks": [],
    "localOverrides": {
      "node-id": {
        "typography": {"fontFamily": "Inter", "fontSize": 18},
        "locked": false,
        "showAttachmentName": true
      }
    },
    "localComments": [],
    "freeAnchors": {}
  }
}
```

`bindings` содержит только несовпадающие или синтетические ID. Обычная Canvas
node с тем же ID, что и Miro item, связывается без записи в `bindings`.

### Data bridge

- [x] `DATA-001` `P0 B` Добавить версионированный `miroCanvas.schemaVersion`.
- [ ] `DATA-002` `P0 B` Сохранить точный scale и итоговый translation конвертера.
- [ ] `DATA-003` `P0 B` Сохранить binding только для comments, diagnostics,
  document slots, slide sequence edges и других синтетических объектов.
- [ ] `DATA-004` `P0 B` Сохранить исходный порядок элементов как `zOrder`, если
  Miro не отдаёт отдельный `zIndex`.
- [ ] `DATA-005` `P1 B` Сохранить вычисленную структуру deck -> slides и признак
  синтетической раскладки slide thumbnails.
- [ ] `DATA-006` `P1 P` Индексировать `miroSource` один раз, без копирования
  полного payload в DOM attributes.
- [x] `DATA-007` `P0 P` Валидировать версии и обязательные поля; при ошибке
  отключать только Miro-слой, сохраняя нативный Canvas.
- [x] `DATA-008` `P1 P` Поддержать миграции metadata между версиями без
  переписывания файла при открытии.
- [x] `DATA-009` `P0 P` Никогда не изменять или сокращать `miroSource`.
- [x] `DATA-010` `P1 P` Показывать provenance REST/Web SDK и completeness в
  inspector, а не отдельными шумными узлами по умолчанию.
- [ ] `DATA-011` `P0 P` Хранить local typography, lock и attachment-title settings
  как overrides по стабильному Canvas/source ID.
- [ ] `DATA-012` `P0 P` Хранить local comments и free anchors отдельно от
  immutable `miroSource`.
- [x] `DATA-013` `P0 P` Записывать metadata только после явного действия и одной
  транзакцией, совместимой с undo/redo.
- [ ] `DATA-014` `P1 B` При повторном импорте переносить overrides, comments и
  anchors по source ID, не затирая ручную работу.
- [ ] `DATA-015` `P0 P` UI typography не должен добавлять inline HTML styles в
  текст node.

## Общая геометрия и слои

- [ ] `GEO-001` `P0 P` Сохранять точные `x`, `y`, `width`, `height` результата
  конвертера без дополнительного auto-layout со стороны renderer.
- [ ] `GEO-002` `P0 P` Рисовать source rotation вокруг центра Miro item.
- [ ] `GEO-003` `P0 P` Поворачивать вместе с объектом фон, border, текст,
  изображение, hitbox, selection outline и resize handles.
- [ ] `GEO-004` `P0 P` Подключать edges к фактическому контуру повёрнутой фигуры.
- [ ] `GEO-005` `P0 B` Воспроизводить source order / `zIndex`, включая перекрытия
  text, shapes, images, frames и connectors.
- [ ] `GEO-006` `P1 P` Учитывать parent-relative coordinates и вложенные
  transforms для frames, groups, mind maps и slides.
- [ ] `GEO-007` `P1 P` Сохранять отрицательные координаты и очень большие доски.
- [ ] `GEO-008` `P1 P` Не менять aspect ratio fixed-ratio объектов при загрузке.
- [ ] `GEO-009` `P1 P` Поддержать clipping только там, где оно есть в Miro;
  group membership сам по себе не должен обрезать дочерние элементы.
- [ ] `GEO-010` `P1 P` Не создавать layout shift после загрузки fonts, images и
  link previews.
- [ ] `GEO-011` `P2 P` Дать переключатель overlay: native Canvas / Miro render /
  сравнение границ.

## Камера, zoom и навигация

- [ ] `VIEW-001` `P0 P` Включить диапазон zoom не хуже текущего
  `canvas-zoom-unlock`, включая `2^-12` для больших досок.
- [ ] `VIEW-002` `P0 P` Сохранить wheel, trackpad, pinch, pan и fit-to-content.
- [ ] `VIEW-003` `P1 B` Восстанавливать Miro viewport/zoom, когда источник их
  действительно содержит.
- [ ] `VIEW-004` `P1 P` Если Miro viewport недоступен, уважать сохранённую камеру
  Obsidian и не выдавать синтетический viewport за исходный.
- [ ] `VIEW-005` `P1 P` Добавить команды fit board, fit selection и jump to
  source item ID.
- [ ] `VIEW-006` `P0 P` Встроить minimap для больших досок без отдельного layout
  engine и без обязательного стороннего plugin.
- [ ] `VIEW-007` `P2 P` Сохранять текущую selection и camera при временном
  переключении Miro renderer.

## Миникарта

Миникарта - собственный лёгкий navigation layer на нативном HTML Canvas 2D. Она
не является вторым renderer: рисует упрощённую геометрию, цвета, groups и edges,
поэтому не дублирует DOM всей доски и не пытается сделать мелкий текст читаемым.

- [ ] `MAP-001` `P0 P` Показывать полные content bounds, включая отрицательные
  coordinates, удалённые nodes, groups, frames и edges.
- [ ] `MAP-002` `P0 P` Показывать контрастную точную рамку текущего viewport:
  положение экрана и долю всей доски, которую он занимает.
- [ ] `MAP-003` `P0 P` Обновлять viewport frame при pan, zoom, resize окна,
  открытии sidebar и переключении renderer без заметной задержки.
- [ ] `MAP-004` `P0 P` Клик по точке миникарты центрирует там текущий viewport,
  не меняя zoom.
- [ ] `MAP-005` `P0 P` Drag рамки viewport плавно перемещает камеру; pointer не
  должен проскальзывать в редактирование элементов под миникартой.
- [ ] `MAP-006` `P0 P` Обновлять overview после create, move, resize, restyle,
  reconnect и delete, не перечитывая весь DOM на каждый pointer event.
- [ ] `MAP-007` `P0 P` Одинаково работать на обычной Canvas и рядом с Advanced
  Canvas, используя общий `CanvasAdapter` и не требуя Canvas Minimap plugins.
- [ ] `MAP-008` `P1 P` Дать выбор угла, размера и opacity, а также компактные
  show/hide и collapse controls; default - правый нижний угол.
- [ ] `MAP-009` `P0 P` Уважать system/light/dark theme, сохранять видимость
  viewport frame и не закрывать штатные Canvas controls.
- [ ] `MAP-010` `P1 P` Поддержать mouse, touch и keyboard focus с доступным
  названием control; drag имеет click fallback.
- [ ] `MAP-011` `P0 P` Рисовать через один `<canvas>` и `requestAnimationFrame`,
  кешировать scene geometry и не подключать D3 или отдельный layout engine.
- [ ] `MAP-012` `P0 P` При изменении private Canvas API отключать только minimap
  с понятной диагностикой, не ломая сам Canvas.

Существующие [Canvas minimap](https://github.com/ifree/Obsidian-canvas-minimap)
и [HY Canvas Minimap](https://github.com/lugglory/hy-canvas-minimap) используются
как UX/reference и источник compatibility fixtures, но не как runtime dependency.

## Темы и цвета

- [ ] `THEME-001` `P0 P` Добавить быстрый switch `system` / `light` / `dark` в
  toolbar, command palette и настраиваемый hotkey.
- [ ] `THEME-002` `P0 P` Переключать тему без reload, потери selection, camera и
  несохранённых правок.
- [ ] `THEME-003` `P1 P` Отделить тему UI/Canvas от source colors Miro: исходные
  цвета не перекрашиваются молча.
- [ ] `THEME-004` `P1 P` Сохранять выбор глобально или для конкретной доски по
  решению пользователя.
- [ ] `COLOR-001` `P0 P` Дать swatches Miro и Obsidian, recent colors, custom
  color picker и ввод HEX.
- [ ] `COLOR-002` `P0 P` Независимо выбирать text, fill, border и edge color.
- [ ] `COLOR-003` `P0 P` Поддержать opacity и clear/transparent без ручного JSON.
- [ ] `COLOR-004` `P1 P` Применять цвет к multi-selection одной операцией с
  undo/redo.
- [ ] `COLOR-005` `P1 P` Добавить reset к source/native color и не терять custom
  colors при смене темы.
- [ ] `COLOR-006` `P2 P` Использовать системный eyedropper, когда он доступен,
  без отдельной тяжёлой dependency.

## Текст

- [ ] `TEXT-001` `P0 P` Рендерить source HTML безопасно, сохраняя paragraphs,
  line breaks, bold, italic, underline, strike, links и lists.
- [ ] `TEXT-002` `P0 P` Сохранять font family, font size, weight, style,
  decoration и text color.
- [ ] `TEXT-003` `P0 P` Сохранять line height, horizontal alignment и vertical
  alignment.
- [ ] `TEXT-004` `P0 P` Повторять Miro padding и wrapping внутри source bbox.
- [ ] `TEXT-005` `P0 P` Убрать браузерные paragraph margins и native Canvas
  scrollbars, которых нет в Miro.
- [ ] `TEXT-006` `P0 P` Поддержать Miro overflow/autofit без увеличения node поверх
  соседних элементов.
- [ ] `TEXT-007` `P1 P` Добавить deterministic font fallback map и диагностику
  отсутствующих fonts.
- [ ] `TEXT-008` `P1 P` Сохранять whitespace, non-breaking spaces, Unicode и emoji
  внутри обычного текста.
- [ ] `TEXT-009` `P1 P` Сохранять кликабельность ссылок, не ломая selection и
  text editing Canvas.
- [ ] `TEXT-010` `P1 P` В режиме редактирования уступать нативному editor; custom
  renderer остаётся presentation layer и не пишет изменения в Miro source.
- [ ] `TEXT-011` `P1 P` Не менять исходный цвет текста при смене темы; theme
  применяется только к UI плагина.
- [ ] `TEXT-012` `P2 P` Добавить сравнение фактических text bounds с source bbox в
  диагностическом режиме.
- [ ] `TEXT-013` `P0 P` Редактировать font size через input/stepper и presets,
  сохраняя число в metadata, а не в HTML.
- [ ] `TEXT-014` `P0 P` Выбирать font family из доступных fonts с понятным fallback.
- [ ] `TEXT-015` `P0 P` Показывать текущий размер и font для single и
  multi-selection.
- [ ] `TEXT-016` `P1 P` Дать UI controls для bold, italic, underline, strike,
  alignment и line height; Markdown используется там, где он нативен.
- [ ] `TEXT-017` `P1 P` Применять typography к нескольким nodes одной undoable
  операцией.
- [ ] `TEXT-018` `P1 P` Добавить reset typography к Miro source или native Canvas
  defaults.
- [ ] `TEXT-019` `P0 P` Не ломать Markdown, wikilinks, embeds и обычные URL при
  изменении размера или font family.
- [ ] `TEXT-020` `P1 P` Для импортированной node хранить локальный style override,
  сохраняя исходный text/style внутри `miroSource`.

## Фигуры

- [ ] `SHAPE-001` `P0 P` Рисовать собственный vector path вместо схлопывания 45
  Miro subtypes в 8 Advanced Canvas shapes.
- [ ] `SHAPE-002` `P0 P` Масштабировать path без искажения, с корректным
  preserve-aspect поведением конкретной фигуры.
- [ ] `SHAPE-003` `P0 P` Сохранять fill color и fill opacity независимо от border.
- [ ] `SHAPE-004` `P0 P` Сохранять border color, opacity, width и
  solid/dashed/dotted style.
- [ ] `SHAPE-005` `P0 P` Рисовать прозрачные фигуры без ложного фона, сохраняя
  hit testing по контуру.
- [ ] `SHAPE-006` `P0 P` Согласовать padding и clipping текста с каждым path.
- [ ] `SHAPE-007` `P1 P` Учитывать rotation, z-order и connector anchors для всех
  фигур.
- [ ] `SHAPE-008` `P1 P` Не заменять пустые arrows/braces текстовыми символами.

Полный обязательный набор renderer paths:

| Семейство | Miro subtypes |
|---|---|
| Basic | `rectangle`, `round_rectangle`, `circle`, `triangle`, `rhombus`, `parallelogram`, `trapezoid`, `pentagon`, `hexagon`, `octagon`, `wedge_round_rectangle_callout`, `star`, `cloud`, `cross`, `can`, `right_arrow`, `left_arrow`, `left_right_arrow`, `left_brace`, `right_brace` |
| Flowchart | `flow_chart_predefined_process`, `flow_chart_connector`, `flow_chart_magnetic_disk`, `flow_chart_input_output`, `flow_chart_decision`, `flow_chart_delay`, `flow_chart_display`, `flow_chart_document`, `flow_chart_magnetic_drum`, `flow_chart_internal_storage`, `flow_chart_manual_input`, `flow_chart_manual_operation`, `flow_chart_merge`, `flow_chart_multidocuments`, `flow_chart_note_curly_left`, `flow_chart_note_curly_right`, `flow_chart_note_square`, `flow_chart_offpage_connector`, `flow_chart_or`, `flow_chart_predefined_process_2`, `flow_chart_preparation`, `flow_chart_process`, `flow_chart_online_storage`, `flow_chart_summing_junction`, `flow_chart_terminator` |

Новые source subtypes не должны молча становиться `round-rectangle`: renderer
показывает native fallback и записывает subtype в diagnostics.

## Создание nodes и форм

- [ ] `NODE-001` `P0 P` Сделать расширенные nodes доступными на любой Canvas,
  даже без Miro import.
- [ ] `NODE-002` `P0 P` Добавить компактный node picker: text, shape, sticky,
  file/document, link/card, code, frame/group, comment и anchor point.
- [ ] `NODE-003` `P0 P` Позволить создавать все 45 shape subtypes из searchable
  palette с визуальными icons.
- [ ] `NODE-004` `P1 P` Менять форму выбранной node без потери text, geometry,
  links, colors и attached edges.
- [ ] `NODE-005` `P0 P` Сохранить native create, duplicate, copy/paste, delete и
  undo/redo для расширенных nodes.
- [ ] `NODE-006` `P0 P` Использовать стандартный JSON Canvas node type и fields,
  когда они способны хранить результат.
- [ ] `NODE-007` `P1 P` При отключённом плагине custom node остаётся читаемым
  стандартным fallback, а не исчезает.

## Sticky notes

- [ ] `STICKY-001` `P1 P` Отдельно рендерить `square` и `rectangle` sticky notes.
- [ ] `STICKY-002` `P1 P` Сохранять 16 именованных цветов и точный custom color,
  если он присутствует.
- [ ] `STICKY-003` `P1 P` Повторять padding, alignment, autosize и text fit Miro.
- [ ] `STICKY-004` `P1 P` Сохранять rotation и source aspect ratio.
- [ ] `STICKY-005` `P1 P` Не показывать native text-node chrome и scrollbar.
- [ ] `STICKY-006` `P2 P` Воспроизводить визуальные эффекты sticky только после
  подтверждения fixture; декоративные догадки не добавлять.

## Connectors и edges

- [ ] `EDGE-001` `P0 P` Рендерить `straight`, `elbowed` и `curved` по source
  shape и anchors, а не только по ближайшему pathfinding mode.
- [ ] `EDGE-002` `P3 S` Найти source, который отдаёт точные bends/control
  points. После этого добавить их в bridge и применять без реконструкции.
- [ ] `EDGE-003` `P0 P` Сохранять start/end anchor position, side и процентную
  позицию на контуре.
- [ ] `EDGE-004` `P0 P` Сохранять stroke color, opacity, width и
  normal/dashed/dotted style.
- [ ] `EDGE-005` `P0 P` Поддержать все 16 caps: `none`, `stealth`,
  `rounded_stealth`, `arrow`, `filled_triangle`, `triangle`, `filled_diamond`,
  `diamond`, `filled_oval`, `oval`, `erd_one`, `erd_many`, `erd_one_or_many`,
  `erd_only_one`, `erd_zero_or_many`, `erd_zero_or_one`.
- [ ] `EDGE-006` `P0 P` Поддержать несколько captions, их position и vertical
  alignment; сейчас сохраняется не вся модель.
- [ ] `EDGE-007` `P1 P` Правильно рисовать self-loop, edge между вложенными
  элементами и edge через границы frames/slides.
- [ ] `EDGE-008` `P1 P` Рисовать dangling connector, если источник даёт хотя бы
  абсолютную координату свободного конца; иначе показывать diagnostics.
- [ ] `EDGE-009` `P1 P` Не путать обычные source connectors, mind-map hierarchy
  edges и невидимые slide-sequence edges.
- [ ] `EDGE-010` `P1 P` Обновлять path при move/resize/rotation Canvas node, не
  меняя сохранённый Miro object.
- [ ] `EDGE-011` `P2 P` Дать diagnostics для потерянных endpoints и unsupported
  caps/path data.
- [ ] `EDGE-012` `P0 P` Разрешить вести edge от любого Canvas element: text,
  shape, image, file, link, document, frame/group и custom node.
- [ ] `EDGE-013` `P0 P` Поддержать interior anchor как нормализованную точку
  `(u, v)` внутри элемента, включая любую точку изображения.
- [ ] `EDGE-014` `P0 P` Поддержать свободный endpoint в абсолютной Canvas
  coordinate без обязательной видимой node.
- [ ] `EDGE-015` `P1 P` Поддержать endpoint на другой edge и на отдельной anchor
  point node.
- [ ] `EDGE-016` `P0 P` Показывать draggable anchor handles в edit mode и точно
  сохранять выбранную точку.
- [ ] `EDGE-017` `P0 P` Для plugin-off fallback представлять свободную координату
  маленькой служебной point node, сохраняя валидный Canvas edge.
- [ ] `EDGE-018` `P0 P` Редактировать caps, stroke, labels и anchors через UI без
  ручного JSON или HTML.
- [ ] `EDGE-019` `P1 P` При move/resize изображения или node сохранять interior
  anchor в той же относительной точке.
- [ ] `EDGE-020` `P1 P` Добавить draggable bend points и ручное редактирование
  маршрута для локально созданных straight/elbowed/curved edges.
- [ ] `EDGE-021` `P0 P` Считать свободную линию и привязанный к элементам
  connector двумя состояниями одной модели: attachment/detachment endpoint
  преобразует их друг в друга без потери route, caps, color, width и labels.
- [ ] `EDGE-022` `P1 P` Соединять конец одной линии с концом другой как topology
  link, не принуждая сегменты принимать единый style; разъединение восстанавливает
  два независимых endpoint.

## Groups, frames и diagrams

- [ ] `FRAME-001` `P1 P` Различать `group`, `frame`, `diagram` и
  `slide_container`, хотя базовый Canvas видит их как groups.
- [ ] `FRAME-002` `P1 P` Рендерить frame background, border, title, title
  placement и chrome Miro.
- [ ] `FRAME-003` `P1 P` Сохранять точный membership по source parent/group IDs.
- [ ] `FRAME-004` `P1 P` Поддержать вложенные containers и корректный z-order
  parent/children.
- [ ] `FRAME-005` `P1 P` Не исключать дочерний элемент только потому, что его
  center выходит за bbox frame.
- [ ] `FRAME-006` `P1 P` Перемещать container вместе с descendants, сохраняя
  внутреннюю геометрию и connectors.
- [ ] `FRAME-007` `P2 P` Поддержать lock/collapse/visibility только при наличии
  соответствующего source field.
- [ ] `FRAME-008` `P2 P` Дать команду focus/present frame без изменения данных.

## Slides и presentation

- [ ] `SLIDE-001` `P1 B` Сохранить deck ownership, source order и первый slide
  каждой deck.
- [ ] `SLIDE-002` `P1 P` Скрывать служебные slide-sequence edges во всех режимах,
  кроме diagnostics.
- [ ] `SLIDE-003` `P1 P` Рендерить slide frame с исходным ratio, title и content.
- [ ] `SLIDE-004` `P1 P` Добавить presentation mode с next/previous, deck picker,
  fit slide, fullscreen и escape.
- [ ] `SLIDE-005` `P1 P` Начинать presentation с `metadata.startNode` или первого
  slide выбранной deck.
- [ ] `SLIDE-006` `P1 P` Сохранять обычные connectors между slide children.
- [ ] `SLIDE-007` `P1 P` Не смешивать slides разных decks.
- [ ] `SLIDE-008` `P2 P` Показывать thumbnails и текущий slide без изменения
  Canvas geometry.
- [ ] `SLIDE-009` `P2 B` Явно маркировать synthetic deck layout, когда Miro не
  отдал координаты thumbnails.
- [ ] `SLIDE-010` `P3 S` Перейти от synthetic layout к точному только после
  появления source thumbnail positions.

## Images, files и documents

- [ ] `MEDIA-001` `P1 P` Рендерить local image без filename/header chrome
  Obsidian.
- [ ] `MEDIA-002` `P1 P` Сохранять crop rectangle, object position, mask,
  rotation, opacity и aspect ratio, если эти поля есть в source.
- [ ] `MEDIA-003` `P1 P` Сохранять border и corner treatment изображения, если
  они есть в source.
- [ ] `MEDIA-004` `P1 P` Не дублировать внутренние image slots `doc_format` рядом
  с родительским document renderer.
- [ ] `MEDIA-005` `P1 P` Поддержать PNG, JPEG, GIF, WebP и SVG как локальные
  assets, когда они реально скачаны.
- [ ] `MEDIA-006` `P1 P` Показывать явный missing-asset state на исходном bbox, не
  скрывая потерю.
- [ ] `MEDIA-007` `P1 P` Рендерить PDF/document/doc_format внутри исходного bbox с
  локальным fallback на открытие файла.
- [ ] `MEDIA-008` `P2 P` Поддержать page navigation для многостраничного PDF без
  изменения source data.
- [ ] `MEDIA-009` `P2 P` Показывать source filename/title только когда он видим в
  Miro или пользователь открыл inspector.
- [ ] `MEDIA-010` `P2 P` Не загружать внешние assets, если complete local asset уже
  есть.
- [ ] `MEDIA-011` `P0 P` Добавить global default `show attachment names` и
  per-node override.
- [ ] `MEDIA-012` `P0 P` Переключать filename/title без изменения file path,
  geometry и link semantics.
- [ ] `MEDIA-013` `P0 P` Сохранить native open, reveal, rename и link-update
  actions Obsidian для file/document node.
- [ ] `MEDIA-014` `P1 P` Для документов дать fit page/width, page navigation,
  scroll и кнопку открытия оригинала.
- [ ] `MEDIA-015` `P1 P` Если формат нельзя встроить корректно, показывать
  аккуратную file card и открывать оригинал, не имитируя несуществующий preview.

## Links, previews и embeds

- [ ] `LINK-001` `P1 P` Рендерить Miro preview card из сохранённых title,
  description, provider, thumbnail и URL.
- [ ] `LINK-002` `P1 P` Не зависеть от Obsidian metadata cache или сети для уже
  экспортированной preview information.
- [ ] `LINK-003` `P1 P` Сохранять source bbox/aspect ratio link/embed card.
- [ ] `LINK-004` `P1 P` Делать URL кликабельным и безопасно поддерживать обычное
  Canvas selection/drag.
- [ ] `LINK-005` `P1 P` Использовать локальный preview asset, когда он есть.
- [ ] `LINK-006` `P2 P` Встраивать iframe/media только после явного разрешения;
  scripts и опасные URL schemes не исполнять.
- [ ] `LINK-007` `P2 P` Показывать offline/provider state без изменения размеров.
- [ ] `LINK-008` `P2 P` Для unrecoverable URL показывать raw metadata в inspector,
  а не выдуманную ссылку.

## Cards, app cards и tags

- [x] `CARD-001` `P1 P` Рендерить card title, description, URL, due date,
  assignee, color и доступные metadata fields.
- [x] `CARD-002` `P1 P` Рендерить все meaningful `app_card.fields[]`, сохраняя
  label, display value и порядок.
- [ ] `CARD-003` `P1 P` Сохранять card padding, wrapping и отсутствие внутренних
  scrollbars.
- [x] `CARD-004` `P1 P` Связывать item tag IDs с tag definitions и показывать
  title/color как chips внутри соответствующего item.
- [x] `CARD-005` `P1 P` Не рисовать tag definitions отдельными board nodes без
  source geometry.
- [ ] `CARD-006` `P2 P` Показывать неизвестные app-card fields в inspector, даже
  если для них нет специализированного UI.
- [ ] `CARD-007` `P2 P` Не имитировать live state внешней интеграции; export
  остаётся snapshot.

## Code blocks

- [x] `CODE-001` `P1 P` Сохранять code text и whitespace без HTML-потерь.
- [x] `CODE-002` `P1 P` Показывать title, language и line-number visibility.
- [x] `CODE-003` `P1 P` Использовать monospace и доступную встроенную подсветку
  Obsidian без новой тяжёлой dependency.
- [x] `CODE-004` `P1 P` Исключить двойные scrollbars и сохранить source bbox.
- [x] `CODE-005` `P2 P` Не выполнять код и не доверять HTML из code payload.

## Mind maps

- [x] `MIND-001` `P1 P` Рендерить `mindmap_node` content из фактического source
  payload.
- [x] `MIND-002` `P1 P` Сохранять hierarchy, parent-relative coordinates и
  отдельный стиль hierarchy edges.
- [x] `MIND-003` `P1 P` Сохранять node shape, branch/fill color, typography и
  root/child distinction, когда данные доступны.
- [x] `MIND-004` `P1 P` Не смешивать generated hierarchy edges с Miro connectors.
- [ ] `MIND-005` `P2 P` Поддержать collapsed state только при наличии source data.
- [x] `MIND-006` `P3 S` Legacy `mindmap` без recoverable nodes остаётся
  source-limited.
- [ ] `MIND-007` `P1 P` Для child/sibling insert, drag reparent, collapse/expand,
  keyboard navigation и переключения mind map / Markdown сначала оценить
  открытый MIT-проект
  [`obsidian-enhancing-mindmap`](https://github.com/MarkMindCkm/obsidian-enhancing-mindmap),
  а не писать новый layout вслепую.
- [ ] `MIND-008` `P0 P` Текущий
  [`obsidian-markmind`](https://github.com/MarkMindCkm/obsidian-markmind)
  использовать только как UX-reference: его README прямо говорит, что проект
  не open source, поэтому код и внутреннюю реализацию из него не копировать.
- [ ] `MIND-009` `P1 P` При переносе MIT-кода сохранить copyright и текст
  лицензии в third-party notices; не подключать весь plugin как runtime
  dependency без доказанной необходимости.
- [x] `MIND-010` `P0 P` Оставить native Canvas JSON источником истины, чтобы
  mind-map editing не создавал закрытый формат и не ломал обычный Canvas.

## Защита от редактирования

- [ ] `LOCK-001` `P0 P` Добавить lock/unlock для node, edge, group и
  multi-selection.
- [ ] `LOCK-002` `P0 P` Добавить review mode для всей доски.
- [ ] `LOCK-003` `P0 P` В review mode разрешать pan, zoom, navigation, links,
  document viewing и comments, блокируя изменения content/layout/style.
- [ ] `LOCK-004` `P0 P` Lock должен блокировать drag, resize, delete, text edit,
  restyle и reconnect как мышью, так и hotkeys.
- [ ] `LOCK-005` `P0 P` Показывать ненавязчивый lock indicator и давать явную
  command/context action для unlock.
- [ ] `LOCK-006` `P1 P` Сохранять lock по стабильному ID и переносить его при
  повторном Miro import.
- [ ] `LOCK-007` `P1 P` Lock group по выбору защищает descendants, но не меняет
  их собственные lock states.
- [ ] `LOCK-008` `P2 P` Добавить отдельные режимы `position only` и `fully locked`,
  если простой lock окажется недостаточен.
- [ ] `LOCK-009` `P0 P` Ясно обозначить, что lock защищает от случайных правок,
  но не является шифрованием или контролем доступа к vault.

## Comments

- [ ] `COMMENT-001` `P0 P` Показывать Miro comments и local comments единым
  списком с компактными markers на Canvas.
- [ ] `COMMENT-002` `P0 P` Показывать messages, replies, authors, timestamps,
  mentions, reactions и resolved state, когда эти данные есть.
- [ ] `COMMENT-003` `P0 P` Создавать comment на свободной Canvas coordinate,
  node, edge, frame или относительной точке изображения.
- [ ] `COMMENT-004` `P0 P` Редактировать и удалять local comments, отвечать,
  resolve, reopen и фильтровать threads.
- [ ] `COMMENT-005` `P0 P` Подсвечивать target выбранного comment и переходить к
  нему без потери текущего zoom history.
- [ ] `COMMENT-006` `P0 P` Поддержать comment editor с plain text, Markdown,
  wikilinks и обычными links без ручного HTML.
- [ ] `COMMENT-007` `P0 P` Разрешить comments в review mode, не снимая защиту с
  доски или target element.
- [ ] `COMMENT-008` `P1 P` Импортированный Miro thread остаётся immutable source;
  local edit/reply хранится как явно помеченный local override.
- [ ] `COMMENT-009` `P1 P` Показывать origin `imported` / `local`, не создавая
  впечатления, что local comment куда-либо синхронизируется.
- [ ] `COMMENT-010` `P1 P` Показывать raw comment JSON и provenance в inspector.
- [ ] `COMMENT-011` `P1 P` Добавить команды и настраиваемые hotkeys: add comment,
  next/previous comment, resolve/reopen.
- [ ] `COMMENT-012` `P0 P` Не включать Miro write API, auth или sync в comments;
  потенциальная онлайн-интеграция может быть только отдельным будущим продуктом.

## Tables

Текущие REST и Web SDK snapshots отдают table geometry и cell-like items, но не
отдают содержимое ячеек. Поэтому renderer таблиц сейчас не может восстановить
таблицу, которую видит пользователь Miro.

- [ ] `TABLE-001` `P3 S` Найти источник rows, columns, cells и cell content.
- [ ] `TABLE-002` `P2 P` До появления источника убрать ложную псевдотаблицу:
  оставить bbox badge и полные raw records в diagnostics.
- [ ] `TABLE-003` `P3 P` После появления данных рендерить grid, row heights,
  column widths и outer/inner borders.
- [ ] `TABLE-004` `P3 P` Поддержать merged cells, rich text, alignment, padding,
  fill и per-cell styles.
- [ ] `TABLE-005` `P3 P` Сохранять table rotation, z-order и container membership.
- [ ] `TABLE-006` `P3 P` Проверять, что `table_text` не дублируется поверх
  родительской таблицы.

## Рисование: будущий план

- [ ] `DRAW-001` `P0 P` В V1 сохранить полноценную работу с Excalidraw file node:
  create/open/edit/reveal через установленный Excalidraw plugin.
- [ ] `DRAW-002` `P0 P` Не создавать собственный drawing engine, пока Excalidraw
  закрывает задачу лучше и уже хранит рисунок как Obsidian file.
- [ ] `DRAW-003` `P3 P` В будущем оценить встроенные pencil, highlighter, eraser и
  pressure-sensitive strokes прямо на Canvas.
- [ ] `DRAW-004` `P3 P` Будущий stroke format должен иметь plugin-off fallback и
  экспорт в PNG/SVG или Excalidraw.
- [ ] `DRAW-005` `P3 S` Импортировать Miro freehand strokes только после появления
  source geometry, а не по приблизительному bbox.

## Будущие задачи продукта (заданы 2026-09-23)

- [ ] `FUT-001` `P1 P` Автоматически выбирать язык настроек и интерфейса по
  языку Obsidian, с английским по умолчанию; первыми — английский и русский.
- [ ] `FUT-002` `P1 P` Вынести плагин в отдельный репозиторий, сохранив связь с
  miro2obsidian через общий версионированный контракт данных: схему
  `miroSource`/`miroCanvas` и эталонные файлы ведёт miro2obsidian, плагин
  закрепляет версию схемы и прогоняет эти файлы в своём CI.
- [ ] `FUT-003` `P1 P` Пользователю одного плагина код экспорта из Miro не нужен.
  При первой настройке спрашивать, нужен ли импорт из Miro; если да — экспортёр
  скачивается по требованию, разворачивается автоматически, ведёт пользователя
  по понятной пошаговой инструкции с картинками и по желанию удаляется после
  импорта. Кнопка повтора остаётся в настройках плагина. Открытый вопрос:
  правила каталога Obsidian запрещают плагинам «устанавливать или обновлять
  себя или свои зависимости», поэтому способ доставки нужно выбрать так, чтобы
  плагин остался в каталоге (отдельный плагин-импортёр, который ставит сам
  Obsidian; приложение-компаньон с подтверждением пользователя; или
  распространение вне каталога).
- [ ] `FUT-004` `P1 P` Пройти полный путь пользователя на чистой машине:
  установка, первая настройка, приложение Miro, экспорт, конвертация, открытие и
  правка доски — и исправить всё найденное.
- [ ] `FUT-005` `P1 S` miro2obsidian не обязывает пользоваться плагином: его
  собственный простой GUI экспортирует в сырой JSON, обычный Canvas, Advanced
  Canvas и miro-canvas.
- [ ] `FUT-006` `P1 S` Дедупликация вложений в miro2obsidian по хэшу
  содержимого (SHA-256): одинаковые картинки и файлы хранятся один раз, все ноды
  ссылаются на одно вложение, а манифест хэшей позволяет следующим импортам
  переиспользовать то, что уже есть в хранилище.
- [ ] `FUT-007` `P2 P` Скилл или MCP-сервер, чтобы агенты работали с форматом
  плагина так же естественно, как с обычным Canvas: читать, проверять и менять
  доски (ноды, линии, комментарии, overrides) через те же транзакции, что и
  плагин.
- [ ] `FUT-008` `P1 P` Доделать экспорт в PDF/PPTX (черновик в ветке
  `wip/board-export`): слайды — колодой, отмеченные области доски — страницами.
- [ ] `FUT-009` `P2 P` Импорт из форматов других плагинов (см. раздел ниже).
- [ ] `FUT-010` `P2 P` Настройки и раскладки под другие ОС, смартфоны и
  планшеты, с проверкой по матрице устройств.
- [ ] `FUT-011` `P1 P` Ознакомительная доска, которую пользователь получает по
  желанию при первой настройке или из настроек.
- [ ] `FUT-012` `P1 P` Нормальное визуализированное описание функций плагина и
  порядка его настройки, со снимками экрана.

## Миграция из форматов других плагинов: будущий план

- [ ] `MIGRATE-001` `P1 P` Добавить явный недеструктивный импорт Excalidraw,
  common mind-map plugins и других распространённых локальных форматов в native
  Canvas + versioned `miroCanvas`, сохраняя исходный файл без изменений.
- [ ] `MIGRATE-002` `P1 P` Для каждого импортёра хранить provenance, список
  преобразованных сущностей и unsupported fields; не обещать эквивалентность,
  когда исходный plugin format не раскрывает нужные данные.
- [ ] `MIGRATE-003` `P1 P` Делать format adapters независимыми и optional: другой
  plugin не становится runtime dependency, а migration запускается только явным
  действием пользователя с preview результата.

## Source-limited и unsupported families

Для этих семейств нельзя обещать визуальную эквивалентность, пока новый export
не принесёт content и geometry:

| Семейство | Что известно сейчас | Поведение `miro-canvas` |
|---|---|---|
| `table`, `table_text`, `data_table_format` | Нет cell payload | Badge + inspector; renderer после нового source |
| `dynamic_poll` | Geometry без poll/options | Diagnostics |
| `prototyping_screen` | Geometry/title без screen content | Diagnostics |
| `flip_card`, `people`, `widgets_stack` | Position без полезного content/size | Diagnostics |
| `emoji`, `kanban`, `mockup`, `stroke`, `usm` | Публичный source недостаточен | Diagnostics до fixture |
| `wireframe`, `webscreen`, `svg`, `grid` | Нужна отдельная source verification | Diagnostics до fixture |
| legacy `mindmap` | Нет доказанного recoverable tree | Diagnostics; `mindmap_node` поддерживается отдельно |
| exact slide thumbnail placement | Deck membership есть, координат нет | Явно помеченная synthetic layout |
| exact connector bends/control points | Есть shape и anchors, но нет списка точек | Semantic route с меткой approximated до нового source |
| Miro initial viewport | Не гарантирован текущим export | Камера Obsidian без притворной точности |
| live cursors, presence, timers, voting, permissions, history | Не являются snapshot board item data | Не воспроизводятся |
| `board`, `board_member` | Metadata, не визуальные items | Только inspector |

- [ ] `LIMIT-001` `P0 P` Ни один unknown type не должен исчезать молча.
- [ ] `LIMIT-002` `P0 P` Diagnostics различает `unsupported`, `source-limited`,
  `missing asset`, `invalid source` и `plugin unsupported`.
- [x] `LIMIT-003` `P1 P` Default view не засоряется большими placeholders;
  используются маленькие badges и отдельная panel.
- [ ] `LIMIT-004` `P1 P` Inspector всегда показывает полный raw object без
  сокращения ключей.
- [ ] `LIMIT-005` `P2 P` Экспортируемый diagnostics report содержит counts, IDs,
  types, причины и provenance.

## Пользовательское поведение

- [ ] `UX-001` `P0 P` Общие authoring/review tools доступны на любой Canvas;
  Miro-specific renderer автоматически включается только при `miroSource`.
- [ ] `UX-002` `P0 P` Custom layers не ломают select, multi-select, drag, resize,
  pan, zoom, context menu, undo/redo и edge editing.
- [ ] `UX-003` `P1 P` Добавить локальные context actions: inspect source, copy
  source ID, reveal local asset и copy original URL без автоматического открытия.
- [ ] `UX-004` `P1 P` Дать независимые toggles для shapes, text, connectors,
  comments, diagnostics и presentation.
- [ ] `UX-005` `P1 P` Сохранять настройки как plugin settings, не в canonical
  source.
- [ ] `UX-006` `P1 P` Поддерживать light/dark UI chrome, не перекрашивая board
  content.
- [ ] `UX-007` `P1 P` Добавить keyboard navigation, focus states, ARIA labels и
  reduced-motion behavior.
- [ ] `UX-008` `P2 P` Показывать краткий status: exact, approximated,
  source-limited для выбранного элемента.
- [ ] `UX-009` `P1 P` Рассматривать lasso как настраиваемый selection gesture,
  разрешить назначать select/pan/lasso/line/connector на mouse buttons и
  modifiers и независимо скрывать их toolbar buttons, не забирая global hotkeys.

## Совместимость с Obsidian

- [ ] `NATIVE-001` `P0 P` Расширять существующий Canvas view, не заменяя его
  отдельным редактором.
- [ ] `NATIVE-002` `P0 P` Не перехватывать глобальные hotkeys; команды плагина
  работают только в активном Canvas и полностью переназначаются.
- [ ] `NATIVE-003` `P0 P` Сохранять Markdown, wikilinks, block links, embeds,
  external URLs и click behavior Obsidian.
- [ ] `NATIVE-004` `P0 P` Сохранять drag/drop файлов, paste, attachment paths и
  native file rename/link updates.
- [ ] `NATIVE-005` `P0 P` Сохранять selection, multi-selection, context menu,
  copy/paste, duplicate, delete и undo/redo.
- [ ] `NATIVE-006` `P0 P` Сохранять open link, open file, open in new pane и
  reveal-in-navigation actions.
- [ ] `NATIVE-007` `P1 P` Не ломать backlinks/search для native notes и files;
  custom decoration не должна скрывать их реальные links.
- [ ] `NATIVE-008` `P1 P` Уважать Obsidian themes и CSS snippets для UI chrome,
  сохраняя явные board colors.
- [ ] `NATIVE-009` `P0 P` Совместимость с Advanced Canvas и Excalidraw проверять
  как обязательную; Advanced Canvas остаётся optional, с остальными plugins -
  через graceful fallback.
- [ ] `NATIVE-010` `P2 P` Проверить desktop и mobile/touch отдельно; отсутствие
  mobile patch не должно ломать стандартный mobile Canvas.
- [ ] `NATIVE-011` `P1 P` Прогнать документированную матрицу Windows/macOS/Linux
  (или репрезентативных VM), разных размеров окна и device-pixel-ratio, а также
  Obsidian desktop/mobile на mouse, trackpad, pen tablet/stylus и touch screen.

## Надёжность, производительность и безопасность

- [ ] `QUAL-001` `P0 P` Не использовать `eval`, inline scripts или непроверенные
  URL schemes из Miro payload.
- [ ] `QUAL-002` `P0 P` Санитизировать source HTML и создавать SVG/DOM через
  безопасные APIs.
- [ ] `QUAL-003` `P0 P` Не обращаться к сети автоматически ни при открытии, ни
  при редактировании, preview, comments или diagnostics.
- [ ] `QUAL-004` `P0 P` Namespace CSS и DOM markers, чтобы не менять обычные
  Canvas files.
- [ ] `QUAL-005` `P0 P` Изолировать обращения к private Obsidian Canvas API в
  одном adapter; Advanced Canvas получает отдельный optional integration layer.
- [ ] `QUAL-006` `P0 P` При несовместимой версии отключать patch и показывать
  понятную ошибку, не ломая Canvas.
- [ ] `QUAL-007` `P1 P` Строить source indexes за `O(n)` и не сканировать весь DOM
  на каждое изменение.
- [ ] `QUAL-008` `P1 P` Debounce наблюдение за Canvas и перерисовывать только
  изменившиеся items.
- [ ] `QUAL-009` `P1 P` Освобождать observers, event handlers, object URLs и caches
  при закрытии view.
- [ ] `QUAL-010` `P1 P` Не добавлять runtime dependency, пока platform/Obsidian API
  решает задачу приемлемо.
- [ ] `QUAL-011` `P1 P` Не хранить tokens, OAuth credentials или remote session в
  plugin settings.
- [ ] `QUAL-012` `P2 P` Показывать понятный compatibility report для версий
  Obsidian, Advanced Canvas и schema.
- [ ] `QUAL-013` `P0 P` Проверять release bundle на remote URLs, telemetry SDK и
  случайные network-capable dependencies.

## Тестирование и критерии готовности

- [ ] `TEST-001` Для каждого поддерживаемого Miro type создать минимальный
  fixture с одним ожидаемым расхождением.
- [ ] `TEST-002` Для всех 45 shape subtypes сделать renderer snapshot и проверку
  path/bbox/rotation.
- [ ] `TEST-003` Для 3 connector shapes и 16 caps проверить path, anchors,
  captions, style и hitbox.
- [ ] `TEST-004` Проверять light/dark, plugin enabled/disabled и минимум два zoom
  уровня в настоящем Obsidian.
- [ ] `TEST-005` Использовать существующий `tools/obsidian_oracle`; diagnostic
  web-renderer не является финальным визуальным oracle.
- [ ] `TEST-006` На `TEST_BOARD` учесть каждый из 479 items и 1 comment как
  rendered, structural, metadata-only или source-limited; неизвестных причин 0.
- [ ] `TEST-007` На `TEST_BOARD` точно отобразить 45 shape subtypes, 3 rotated
  items, 29 source connectors и все обязательные local assets.
- [ ] `TEST-008` Сохранить 0 broken file refs, 0 duplicate IDs и 0 dangling
  Canvas edges.
- [ ] `TEST-009` Выполнить fresh production conversion и visual run по всем
  доступным тестовым доскам из явно выбранного локального списка.
- [ ] `TEST-010` Unknown/new item type не вызывает crash и попадает в diagnostics
  с полным raw payload.
- [ ] `TEST-011` Открытие, pan, zoom, selection и закрытие `TEST_BOARD` не дают
  заметных stalls или накопления listeners/memory между повторными открытиями.
- [ ] `TEST-012` Plugin-off screenshot подтверждает сохранение обычного JSON
  Canvas fallback.
- [ ] `TEST-013` Plugin-on screenshot сравнивается с реальным Miro по bbox,
  rotation, z-order, shape path, text metrics, connector path и visible assets.
- [ ] `TEST-014` Source-limited элементы не считаются renderer defect, если их
  raw records доступны и причина явно показана.
- [ ] `TEST-015` Полный Python test suite, lint, compile, JS smoke и Obsidian
  visual oracle проходят перед каждым release.
- [ ] `TEST-016` Обычная Canvas-доска без `miroSource` проходит native feature
  regression с включённым и выключенным плагином.
- [ ] `TEST-017` Font family/size меняются через UI, переживают reload и не
  добавляют inline HTML styles.
- [ ] `TEST-018` Local comment проходит create/edit/reply/resolve/delete для
  point, node, edge и image-relative anchors.
- [ ] `TEST-019` Lock блокирует все изменения, сохраняя zoom, links, navigation и
  comments в review mode.
- [ ] `TEST-020` Free и image-relative edge anchors переживают move, resize,
  reload и plugin-off fallback.
- [ ] `TEST-021` Theme switch, colors и attachment-title toggle не меняют
  geometry, links или selection.
- [ ] `TEST-022` Hotkeys, Markdown, wikilinks, embeds, file actions и undo/redo
  проходят real-Obsidian smoke test.
- [ ] `TEST-023` Прогнать compatibility matrix: native only, `miro-canvas` only,
  Advanced Canvas only и оба plugins; сравнить данные, UI controls и console errors.
- [ ] `TEST-024` Minimap показывает все content bounds и точный viewport на
  отрицательных coordinates, большой доске и после resize sidebar/window.
- [ ] `TEST-025` Click и drag minimap перемещают камеру в ожидаемую coordinate,
  сохраняют zoom и не изменяют selection или content.
- [ ] `TEST-026` При simulated adapter incompatibility Canvas открывается и
  сохраняется, а отключаются только minimap/Advanced integration capabilities.
- [ ] `TEST-027` На нескольких viewport sizes/DPI проверить dock, toolbar,
  minimap, comment cards, selection handles и чёткость текста повёрнутых nodes
  при focus/blur окна.
- [ ] `TEST-028` На tablet/stylus/touch проверить pressure, palm rejection,
  lasso, pan, straight-line Shift equivalent и отмену pointer gesture.

## Порядок реализации

| Этап | Содержание | Результат |
|---|---|---|
| M0 | Plugin shell в `plugins/miro-canvas`, schema, Canvas adapter, optional Advanced adapter, compatibility matrix | Плагин самостоятельно работает поверх native Canvas и ничего не ломает |
| M1 | Minimap, font/size UI без HTML, zoom, theme switch, colors, locks, attachment-title toggle | Ежедневная работа с обычным Canvas уже заметно удобнее |
| M2 | Local comments, advanced arrows/anchors, node/shape authoring, documents | Закрыто пользовательское ядро первой версии |
| M3 | Rotation, z-order, Miro shapes/text/connectors, sticky, frames, slides, media/cards | Импортированные доски отображаются существенно ближе к Miro |
| M4 | Tables и unsupported widgets | Только после появления доказанного source payload |
| M5 | Встроенное свободное рисование | Только если Excalidraw-интеграции реально недостаточно |
| M6 | Импорт форматов других plugins и platform/device matrix | Недеструктивная миграция с provenance и проверенная работа на разных OS, экранах и input devices |

Самый короткий полезный release - обычный Canvas с typography controls, zoom,
темами, цветами, lock, attachment-title toggle и сохранением всех нативных
возможностей Obsidian. Затем добавляются comments, свободные anchors и формы.
Miro sync не входит в проект; собственный drawing engine не блокирует V1.

## Definition of done

### Текущая доработка соединителей

Новые линии и стрелки хранятся в `miroCanvas.connectors`, без скрытых
нод-контейнеров. Это один тип элемента с двумя привязками, маршрутом и стилем;
наконечник не меняет тип. Концы привязываются к холсту, ноде/изображению или
участку другого соединителя. Стили соединённых стрелок остаются независимыми.
Нативные и импортированные рёбра поддерживаются общей геометрией привязок.

Инструмент Lines and arrows остаётся активным до переключения. Его нижняя
панель с маршрутом, цветом и толщиной не закрывается после рисования.
Выделенный соединитель можно переместить, потянуть за концы, изменить на линию
или стрелку, скопировать, вырезать и удалить. Копирование, вырезание и вставка
идут через события буфера, которые поднимает сам Obsidian (см. заметки о буфере
от 2026-09-23 ниже).
Файловые ноды сохраняют ссылку на исходный файл.
Escape на холсте сбрасывает инструменты и выделение. У команды
`Miro Canvas: Reset tools and selection` нет горячей клавиши по умолчанию, поэтому
Escape в тексте карточки, подписи или поле остаётся за ними; назначить клавишу
можно в Settings → Hotkeys Obsidian.

Для старых нод-линий есть явная команда
`Miro Canvas: Convert legacy line nodes to connectors`. Преобразование
отменяется одним Undo, повторный запуск не создаёт копий. Исходные данные Miro
сохраняются, прежние нода и override архивируются в `connectorMigrationArchive`.
Для прямых линий поворот теперь переносится в координаты точек. Повёрнутые
кривые/угловые линии и ноды-линии с привязками нативных либо независимых
соединителей сохраняются в старом виде с диагностикой: связи не теряются.
При открытии карты преобразование не запускается.

Ограничения: без плагина независимые соединители не отображаются, поскольку
Obsidian не поддерживает свободные концы без нод-контейнеров. Сам файл Canvas
остаётся валидным, другие ноды и нативные рёбра доступны. Shift+клик и лассо
поддерживают смешанное выделение нод и соединителей. Копирование, вставка,
вырезание, удаление выделения и групповое перемещение отменяются одним Undo.
При копировании внутренние привязки переназначаются, внешние становятся
свободными точками. Прямоугольное выделение захватывает только концы
соединителей, находящиеся внутри рамки. Линия, которая лишь пересекает её,
не выделяется; при групповом перемещении дальний конец остаётся на месте.
Любое выделение нескольких элементов рамкой или лассо сохраняет общую
рамку после перемещения; за всю её внутреннюю область можно потянуть группу
повторно. Удаление проверяет блокировки всех
зависимых соединителей до изменения графа. Ошибка сохранения или устаревший
снимок группового перетаскивания не должны приводить к частичной записи.
Проверка мышью в настоящем Obsidian остаётся открытой: захват окна возвращает
`SetIsBorderRequired / 0x80004002`, кликам через дерево доступности не хватает
геометрии. Фокусный браузерный тест проверяет клавиши буфера, сохранение,
undo/redo, копирование соединителей, следование отображаемой камере и сброс.
Инструмент соединителей использует одну постоянную нижнюю панель без второго
всплывающего меню. Привязанные маршруты и рамки выделения следуют за текущей
геометрией при перетаскивании по кадрам анимации. При групповом перемещении
нативные и оформленные плагином рёбра берут координаты из того же предпросмотра,
что независимые соединители. Цвет комментария записывается один раз после
выбора, а не на каждое движение мыши в палитре. Тест проверяет геометрию с отключённым
периодическим обновлением.
Фокусный и полный браузерные UI-smoke проходят на синтетическом хосте;
это не заменяет проверку взаимодействий в настоящем Obsidian.

### Повторная проверка (2026-09-22)

Сборка установлена в тестовый vault, после команды перезагрузки наблюдался
статус `ready/valid/ready/ready`. Проходят 646 тестов плагина, три браузерных
прогона, TypeScript, Ruff, 501 Python-тест и 157 подтестов, структурная и
визуальная регрессия (у семи сценариев ещё нет эталонных изображений).
Проверка мышью заблокирована указанными выше ошибками инструмента, поэтому
плавность и системный буфер в реальном Obsidian пока требуют проверки пользователем.

Выделенные независимые соединители используют общую панель с иконками
наконечников, маршрута, толщины, цвета, блокировки и удаления вместо отдельного
текстового меню. Нижняя панель оформлена как рисование: палитра, образец толщины,
ползунок и числовое поле. Стрелки сгруппированы слева, линии — справа.
Значок комментария захватывает первое нажатие и сохраняет перетаскивание при
обновлении интерфейса. Отдельная проверка:
`python -m tools.obsidian_oracle.smoke_plugin_ui --controls`;
`--screenshots <каталог>` сохраняет снимок панелей.

В настройках соединителей по умолчанию разрешена **только привязка к нодам**.
Свободные концы и привязка к другим линиям/стрелкам включаются отдельными
переключателями. Отключение типа цели не переписывает существующие связи,
но ограничивает создание и перемещение концов. Недопустимая новая связь не сохраняется.
В нижней панели — все семь типов в один ряд (стрелки слева, линии справа),
палитра и толщина. Строки рисования и соединителей имеют общую ширину 600px,
ограниченную размером узкого экрана. Переключение инструмента закрывает прежнее
всплывающее меню; открытие форм выключает инструмент соединителей.
Независимые соединители используют только собственные SVG-ручки;
перетаскивание конца при активном инструменте стрелок не создаёт новый соединитель.
Фокусный браузерный тест дополнительно проверяет правое лассо при конкурирующем
обработчике панорамирования mousedown, ограничения привязки, ширину панели и
видимость удаления при пустом нативном меню. Проверка мышью в настоящем Obsidian
остаётся неподтверждённой: повторный захват окна снова завершился `0x80004002`.

#### Дополнительная критическая ревизия

Блочные стрелки теперь учитывают выбранную толщину и меняют направление головы.
Создание блочной стрелки начинается с толщины 16, отдельно от обычных линий (2).
Обе толщины запоминаются при переключении типов в текущей сессии; предпросмотр
использует ту же толщину, что сохранённый соединитель. Снимок группового переноса
проходит ту же JSON-нормализацию, что нативная транзакция: необязательные поля
Canvas со значением `undefined` больше не вызывают ложный отказ и возврат назад.
Браузерный сценарий с мышью проверяет два выделенных соединителя, обновление
во время перетаскивания, одно сохранение, undo и redo.
Удаление головы или выбор несовместимого маршрута/наконечника преобразует вид
в обычный соединитель, сохраняя привязки. Старые неявные головы интерпретируются
без автоматической миграции документа.
Перетаскивание одиночного соединителя не перезаписывает более новую правку того
же элемента; отпускание над запрещённой целью отменяет перенос, а не сохраняет
последнюю допустимую точку наведения. Слой соединителей не перехватывает буфер
текстового редактора. Описания настроек поясняют Escape и отключение всех целей.

Оставшиеся замечания ревизии — не заявления о готовности:

Следующая доработка возвращает ручки изгиба независимых прямых, кривых и
ортогональных соединителей. Перетаскивание тела привязанного соединителя меняет
маршрут, сохраняя концы; свободный соединитель перемещается целиком.
При копировании сохраняется центр выделения: вставка размещает группу центром
у последнего положения указателя на холсте, а если оно неизвестно — в центре
видимой области. Клик инструментом протягивания линии/стрелки больше не создаёт
соединитель стандартной длины. Многоточечные линии по-прежнему задаются точками.
У рисования появился выбор произвольного цвета, как у соединителей.
Скрытые действия карточки комментария больше не видны одновременно: удаление
локального комментария и скрытие импортированного не показывают две корзины.

Карточка комментария позволяет указать имя автора при создании и изменить
отображаемое имя позже, удалить отдельный локальный ответ, выбрать цвет и
заблокировать комментарий. Имя по умолчанию берётся из настройки плагина;
изменение автора импортированного сообщения — локальный псевдоним отображения,
а не правка метаданных Miro. Блокировка отмечается на значке и карточке,
запрещает ответы, изменение имени и цвета, решение и удаление этой ветки в
карточке и панели комментариев. Снятие блокировки возвращает эти действия.
Новые отдельные комментарии в других местах холста блокировкой одной ветки не
запрещаются. Стрелки привязываются к значкам комментариев и
следуют за ними. Размер наконечника настраивается независимо от толщины линии.
Рамка смешанного выделения охватывает нативные элементы, независимые
соединители и значки комментариев; перетаскивание её внутренней области
перемещает всю группу одной транзакцией.
Это проверено модульными и браузерными тестами, но не живым Obsidian.
При выделении левой кнопкой плагин рисует одну лёгкую рамку. После отпускания
выбираются нативные ноды и рёбра, независимые соединители и комментарии;
при движении мыши обновляется только рамка, без второй рамки Obsidian и
полной перерисовки доски.
Проверяются экранные центры нод и значков комментариев и видимые положения
концов нативных и независимых соединителей. Группу/фрейм нужно охватить
целиком, чтобы маленькая рамка внутри большого фрейма не выбирала его.
Если выбран один конец соединителя, вокруг него появляется маленькая рамка:
при переносе второй конец остаётся на месте. Если внутри оба конца и весь
маршрут, вместе с ними сдвигаются изгибы линии.
Для выделения только нод видимой остаётся рамка Obsidian, а область захвата
плагина прозрачна. Для смешанного выделения с независимыми соединителями видна
общая рамка плагина: нативная не может охватить эти элементы и комментарии. У одной
неповёрнутой ноды остаются нативный контур и ручки плагина без второго контура.
Кнопки создания соседней ноды со стрелкой остаются в прозрачном слое ручек,
привязанном к нативному контуру; отдельная видимая рамка для них не нужна.
Во время протягивания рамки её геометрия повторно не рассчитывается.
Палитра заливки стикера содержит 17 именованных цветов Miro в сетке по восемь,
затем до 12 недавно использованных цветов и отдельный выбор произвольного
цвета. Недавние цвета могут повторять готовые — это не новые цвета Miro.
При повороте ноды за ней следуют только привязанные концы соединителей;
свободные концы и изгибы остаются на своих местах. Браузерный тест также
проходит цепочку «лассо → общая рамка → перетаскивание».
Цвет комментария предварительно показывается при движении в палитре и
сохраняется один раз после выбора, даже если карточка
обновилась до закрытия выбора цвета. При перетаскивании значка привязанная
стрелка следует за ним без промежуточных записей; отмена возвращает маршрут.
Панели рисования и создания соединителей имеют одинаковую ширину 600 px и
один ряд; на узком экране они прокручиваются горизонтально, а не переносятся.
Подпись независимого соединителя можно добавить кнопкой «Add or edit line label»
в меню выделения, клавишей Enter или двойным щелчком по линии.
Подпись перемещается вдоль маршрута; по умолчанию
она посередине, а начальная позиция настраивается в параметрах плагина.
Если у нативного ребра изменён маршрут средствами плагина, его подпись
показывается на видимом маршруте вместо старой середины Obsidian. Её тоже
можно редактировать двойным щелчком и двигать вдоль линии. Подпись следует
за телом стрелки с первого перетаскивания и при перемещении группы. При обычном
перемещении холста SVG независимых соединителей сдвигается целиком без
перестройки всех линий на каждом кадре.

- Копирование только нативного ребра без его конечных нод пока не поддержано
  общим путём вставки. Независимые соединители поддержаны.
- Форматирование смешанного выделения нативных/независимых элементов использует
  отдельные транзакции; единый шаг undo, как для перемещения группы, не гарантирован.
- Замеры больших досок приведены ниже; за их пределами ничего не обещается.
- Мышь/буфер в настоящем Obsidian, другие ОС, touch/stylus и повёрнутый текст
  при высоком DPI остаются отдельными проверками, не заменяемыми браузерным стендом.

#### Стандартные рёбра, один редактор подписей, большие доски (2026-09-23)

Линия или стрелка, оба конца которой держатся за карточки (привязки к нодам или
изображениям двух разных карточек), теперь — нативное ребро Canvas, как ребро,
проведённое между карточками в самом Obsidian: оно открывается и работает без
плагина. Маршрут, наконечники, штрих, толщина, цвет и точные привязки хранятся
в `localOverrides`. Линия со свободным концом, концом на другой линии или на
комментарии остаётся записью `miroCanvas.connectors`. Перенос конца превращает
одно в другое с тем же id, сохраняя вид и подпись; каждое превращение — один шаг
undo. Импортированное ребро остаётся нативным ребром, к которому привязан
соединитель Miro: перенесённый конец держится привязкой плагина, как раньше.
Инструмент Lines and arrows от карточки к карточке сразу создаёт нативное ребро.

Собственные соединители доски рисуются в движущемся слое Canvas рядом с его
рёбрами и под карточками, с классами нативных рёбер: наведение, подсветка
выделения, ручки концов и изгибов и панель — те же, что у нативных рёбер, а
перемещение и масштаб холста им ничего не стоят. Перерисовывается только
соединитель, у которого изменились маршрут, стиль или выделение.

Подписи нативных рёбер и собственных соединителей — один и тот же элемент:
стиль подписи Canvas, место на маршруте, который рисует плагин, в единицах доски.
Клик выделяет линию, перетаскивание двигает подпись вдоль маршрута, двойной
клик, Enter или кнопка панели открывают правку на месте (Enter сохраняет,
Shift+Enter переносит строку, Escape отменяет). Скрытый редактор Obsidian по
Enter и двойному клику больше не открывается.

Исправление undo: запись метаданных плагина в транзакции графа меняла документ,
который Canvas одновременно хранит как последний шаг истории, и Undo мог вернуть
новые метаданные со старым графом (например, нативное ребро рядом с уже
превращённым соединителем). Теперь документ заменяется копией.

Большие доски: на синтетической доске из 2000 карточек, 980 нативных рёбер
(подписано каждое пятое) и 520 собственных соединителей одно обновление плагина
ускорилось примерно со 130 до 4 мс, работа плагина на кадр перемещения холста —
примерно с 10 до 2 мс. Перетаскиваемая карточка раньше двигалась примерно с
7 кадрами в секунду; теперь работа плагина на кадр перетаскивания — около 35 мс.
Доска перечитывается только после сохранения Canvas (или пока нажата кнопка),
метаданные разбираются один раз на объект, нативные элементы охраняются один
раз, содержимое миникарты проецируется один раз на сцену, маршруты, не
держащиеся за сдвинутые карточки, при перетаскивании не пересчитываются, а цикл
кадров работает только во время жестов и анимаций. Это замеры основного потока
в изолированном стенде, а не гарантия частоты кадров.

Все три синтетических браузерных прогона проходят (основной, `--interactions`,
`--controls`). У синтетического хоста теперь есть движущийся слой Canvas и
живые координаты карточек; основной прогон падал на шаге поворота в панели
локальных инструментов, потому что нажатие на неё снимало выделение.

Буфер обмена (2026-09-23): Ctrl+C, Ctrl+X и Ctrl+V больше не перехватываются.
Они приходят на холст событиями буфера, которые Obsidian поднимает в любой
раскладке, как и пункты «Вырезать», «Копировать», «Вставить» в меню выделения
Canvas и в меню плагина для собственных линий доски. Копия записывает
`obsidian/canvas` (граф, который Canvas сам вставляет на любую доску, вместе с
собственными линиями), `obsidian/miro-canvas` (запись плагина о каждом
элементе) и `text/plain` (тексты карточек, файлы как `[[ссылки]]`, страницы как
адреса) — вставка в заметку или другую программу даёт читаемый текст, а не JSON.
Вставка графа ложится центром под указатель одним шагом undo; файлы, картинки,
текст и ссылки вставляет сам Canvas. Замена контекстного меню плагином убрана:
остаются меню Canvas. Сочетания распознаются по нажатой клавише (Ctrl+С в русской
раскладке — это Ctrl+C, буквы инструментов работают в любой раскладке), а клавиша
без выделения больше не отклоняется как правка текста — из-за этого не работали
буквы инструментов и вставка при пустом выделении.

| Запрос | Подтверждение / ограничение |
| --- | --- |
| Перемещение/удаление комментариев, имя и цвет автора | Проходят тесты маркеров, карточки, локальных комментариев и настроек. Импортированные комментарии скрываются локально, исходные данные не удаляются. |
| Магниты 45° и кнопки 90° | Покрыты тестами ручек выделения; кнопки четверти оборота сохранены. |
| Жесты лассо/перемещения/линий и видимость кнопок | Проходят тесты настроек и привязок, смешанное лассо — браузерный сценарий. Доступны поддержанные наборы комбинаций. |
| Маркер текста, спокойные цвета frames, цвета типов на миникарте | Проходят профильные тесты и полный браузерный прогон. |

`miro-canvas` считается готовым для первой production-версии, когда:

1. Обычный Canvas без `miroSource` сохраняет hotkeys, Markdown, wikilinks,
   embeds, links, file actions, drag/drop, context menu и undo/redo.
2. Без плагина любой созданный `.canvas` по-прежнему открывается штатно.
3. Плагин полностью загружается и работает без Advanced Canvas; при совместной
   работе нет двойных controls, конфликтующих patches или потери metadata.
4. Миникарта показывает весь холст и точный viewport; click/drag перемещают
   камеру без изменения zoom, selection или content.
5. Font family, font size, colors, theme, zoom, lock и attachment names меняются
   через понятный UI без ручного HTML или JSON.
6. Local comments можно создавать, редактировать, удалять, обсуждать и привязывать
   к node, edge, изображению или свободной coordinate.
7. Edges поддерживают все caps, любой element endpoint, interior/image anchors и
   свободные coordinates с валидным plugin-off fallback.
8. Расширенные nodes и 45 shapes можно не только импортировать, но и создавать и
   редактировать в Obsidian.
9. Документы отображаются аккуратно, открываются нативно, а filename можно
   показать или скрыть глобально и для отдельной node.
10. Каждый доступный Miro source object либо отображён, либо имеет явную и
    проверяемую причину ограничения; canonical JSON и provenance не теряются.
11. `TEST_BOARD`, все доступные web boards и обычная Canvas fixture проходят
    structural и real-Obsidian visual/interaction проверки.
12. Tables, exact connector bends и закрытые Miro internals честно остаются
    source-limited до появления нового локального export source.
13. Все основные workflows проходят с отключённой сетью; bundle не содержит
    Miro auth/sync, telemetry или обязательных remote dependencies.
