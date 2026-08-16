# miro-canvas

`miro-canvas` - полностью локальный плагин, расширяющий любой Obsidian Canvas.
На обычной доске он добавляет удобное редактирование, комментарии, защиту, темы,
цвета, формы и продвинутые стрелки. Если локальный файл содержит `miroSource`,
включается точное отображение ранее экспортированного Miro snapshot без связи с
Miro, OAuth или интернетом.

Это спецификация продукта и исполняемый backlog. Экспорт Miro, canonical union
и конвертер остаются отдельными слоями; `miro-canvas` отвечает за отображение и
локальную работу внутри Obsidian.

## Пользовательское ядро

| Возможность | Что должно быть в первой рабочей версии |
|---|---|
| Шрифты и текст | Выбор font family и размера, форматирование и alignment через UI, без ручного HTML |
| Комментарии | Отображение, создание, редактирование, ответы, resolve и anchors к элементу или точке |
| Zoom | Большой диапазон zoom, быстрый fit и сохранение привычного pan/pinch/wheel |
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
[`MIRO_VS_CANVAS_DISPLAY_GAPS.md`](MIRO_VS_CANVAS_DISPLAY_GAPS.md).

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

- [ ] `DATA-001` `P0 B` Добавить версионированный `miroCanvas.schemaVersion`.
- [ ] `DATA-002` `P0 B` Сохранить точный scale и итоговый translation конвертера.
- [ ] `DATA-003` `P0 B` Сохранить binding только для comments, diagnostics,
  document slots, slide sequence edges и других синтетических объектов.
- [ ] `DATA-004` `P0 B` Сохранить исходный порядок элементов как `zOrder`, если
  Miro не отдаёт отдельный `zIndex`.
- [ ] `DATA-005` `P1 B` Сохранить вычисленную структуру deck -> slides и признак
  синтетической раскладки slide thumbnails.
- [ ] `DATA-006` `P1 P` Индексировать `miroSource` один раз, без копирования
  полного payload в DOM attributes.
- [ ] `DATA-007` `P0 P` Валидировать версии и обязательные поля; при ошибке
  отключать только Miro-слой, сохраняя нативный Canvas.
- [ ] `DATA-008` `P1 P` Поддержать миграции metadata между версиями без
  переписывания файла при открытии.
- [ ] `DATA-009` `P0 P` Никогда не изменять или сокращать `miroSource`.
- [ ] `DATA-010` `P1 P` Показывать provenance REST/Web SDK и completeness в
  inspector, а не отдельными шумными узлами по умолчанию.
- [ ] `DATA-011` `P0 P` Хранить local typography, lock и attachment-title settings
  как overrides по стабильному Canvas/source ID.
- [ ] `DATA-012` `P0 P` Хранить local comments и free anchors отдельно от
  immutable `miroSource`.
- [ ] `DATA-013` `P0 P` Записывать metadata только после явного действия и одной
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
- [ ] `VIEW-006` `P2 P` Добавить minimap для больших досок без отдельного layout
  engine.
- [ ] `VIEW-007` `P2 P` Сохранять текущую selection и camera при временном
  переключении Miro renderer.

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

- [ ] `CARD-001` `P1 P` Рендерить card title, description, URL, due date,
  assignee, color и доступные metadata fields.
- [ ] `CARD-002` `P1 P` Рендерить все meaningful `app_card.fields[]`, сохраняя
  label, display value и порядок.
- [ ] `CARD-003` `P1 P` Сохранять card padding, wrapping и отсутствие внутренних
  scrollbars.
- [ ] `CARD-004` `P1 P` Связывать item tag IDs с tag definitions и показывать
  title/color как chips внутри соответствующего item.
- [ ] `CARD-005` `P1 P` Не рисовать tag definitions отдельными board nodes без
  source geometry.
- [ ] `CARD-006` `P2 P` Показывать неизвестные app-card fields в inspector, даже
  если для них нет специализированного UI.
- [ ] `CARD-007` `P2 P` Не имитировать live state внешней интеграции; export
  остаётся snapshot.

## Code blocks

- [ ] `CODE-001` `P1 P` Сохранять code text и whitespace без HTML-потерь.
- [ ] `CODE-002` `P1 P` Показывать title, language и line-number visibility.
- [ ] `CODE-003` `P1 P` Использовать monospace и доступную встроенную подсветку
  Obsidian без новой тяжёлой dependency.
- [ ] `CODE-004` `P1 P` Исключить двойные scrollbars и сохранить source bbox.
- [ ] `CODE-005` `P2 P` Не выполнять код и не доверять HTML из code payload.

## Mind maps

- [ ] `MIND-001` `P1 P` Рендерить `mindmap_node` content из фактического source
  payload.
- [ ] `MIND-002` `P1 P` Сохранять hierarchy, parent-relative coordinates и
  отдельный стиль hierarchy edges.
- [ ] `MIND-003` `P1 P` Сохранять node shape, branch/fill color, typography и
  root/child distinction, когда данные доступны.
- [ ] `MIND-004` `P1 P` Не смешивать generated hierarchy edges с Miro connectors.
- [ ] `MIND-005` `P2 P` Поддержать collapsed state только при наличии source data.
- [ ] `MIND-006` `P3 S` Legacy `mindmap` без recoverable nodes остаётся
  source-limited.

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
- [ ] `LIMIT-003` `P1 P` Default view не засоряется большими placeholders;
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
- [ ] `NATIVE-009` `P1 P` Совместимость с Advanced Canvas и Excalidraw проверять
  как обязательную, с остальными plugins - через graceful fallback.
- [ ] `NATIVE-010` `P2 P` Проверить desktop и mobile/touch отдельно; отсутствие
  mobile patch не должно ломать стандартный mobile Canvas.

## Надёжность, производительность и безопасность

- [ ] `QUAL-001` `P0 P` Не использовать `eval`, inline scripts или непроверенные
  URL schemes из Miro payload.
- [ ] `QUAL-002` `P0 P` Санитизировать source HTML и создавать SVG/DOM через
  безопасные APIs.
- [ ] `QUAL-003` `P0 P` Не обращаться к сети автоматически ни при открытии, ни
  при редактировании, preview, comments или diagnostics.
- [ ] `QUAL-004` `P0 P` Namespace CSS и DOM markers, чтобы не менять обычные
  Canvas files.
- [ ] `QUAL-005` `P0 P` Изолировать обращения к private Obsidian/Advanced Canvas
  APIs в одном adapter с feature detection.
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
  доступным web boards из `work/MIRO2OBSIDIAN/Obs_Miro/Концепт/Web_boards.md`.
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

## Порядок реализации

| Этап | Содержание | Результат |
|---|---|---|
| M0 | Schema, Canvas adapter, native compatibility, safe fallback, tests | Плагин ничего не ломает и готов хранить local extensions |
| M1 | Font/size UI без HTML, zoom, theme switch, colors, locks, attachment-title toggle | Ежедневная работа с обычным Canvas уже заметно удобнее |
| M2 | Local comments, advanced arrows/anchors, node/shape authoring, documents | Закрыто пользовательское ядро первой версии |
| M3 | Rotation, z-order, Miro shapes/text/connectors, sticky, frames, slides, media/cards | Импортированные доски отображаются существенно ближе к Miro |
| M4 | Tables и unsupported widgets | Только после появления доказанного source payload |
| M5 | Встроенное свободное рисование | Только если Excalidraw-интеграции реально недостаточно |

Самый короткий полезный release - обычный Canvas с typography controls, zoom,
темами, цветами, lock, attachment-title toggle и сохранением всех нативных
возможностей Obsidian. Затем добавляются comments, свободные anchors и формы.
Miro sync не входит в проект; собственный drawing engine не блокирует V1.

## Definition of done

`miro-canvas` считается готовым для первой production-версии, когда:

1. Обычный Canvas без `miroSource` сохраняет hotkeys, Markdown, wikilinks,
   embeds, links, file actions, drag/drop, context menu и undo/redo.
2. Без плагина любой созданный `.canvas` по-прежнему открывается штатно.
3. Font family, font size, colors, theme, zoom, lock и attachment names меняются
   через понятный UI без ручного HTML или JSON.
4. Local comments можно создавать, редактировать, удалять, обсуждать и привязывать
   к node, edge, изображению или свободной coordinate.
5. Edges поддерживают все caps, любой element endpoint, interior/image anchors и
   свободные coordinates с валидным plugin-off fallback.
6. Расширенные nodes и 45 shapes можно не только импортировать, но и создавать и
   редактировать в Obsidian.
7. Документы отображаются аккуратно, открываются нативно, а filename можно
   показать или скрыть глобально и для отдельной node.
8. Каждый доступный Miro source object либо отображён, либо имеет явную и
   проверяемую причину ограничения; canonical JSON и provenance не теряются.
9. `TEST_BOARD`, все доступные web boards и обычная Canvas fixture проходят
   structural и real-Obsidian visual/interaction проверки.
10. Tables, exact connector bends и закрытые Miro internals честно остаются
    source-limited до появления нового локального export source.
11. Все основные workflows проходят с отключённой сетью; bundle не содержит
    Miro auth/sync, telemetry или обязательных remote dependencies.
