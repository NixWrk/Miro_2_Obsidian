# Отличия отображения Miro и Obsidian Canvas

Этот документ фиксирует не общие догадки, а результат production-прогона
`TEST_BOARD` от 2026-08-16. Источник собран как строгий union REST + Web SDK:

- canonical JSON: 479 элементов и 1 комментарий;
- Web SDK: 477 элементов;
- обязательные ассеты: 78 изображений, 1 документ и 2 `doc_format`;
- Canvas: 445 узлов и 30 рёбер;
- отсутствующие файлы, дубли ID и оборванные рёбра: 0.

`completeness.complete` и `capture_complete` равны `true`. При этом
`board_complete` намеренно равен `false`: публичные Miro API не обещают доступ
к скрытым внутренним данным неподдерживаемых виджетов. Это ограничение источника,
а не ошибка pipeline.

## Фактическое преобразование TEST_BOARD

| Miro | Количество | Canvas | Результат |
|---|---:|---|---|
| `shape` | 233 | 233 text nodes | Текст, цвет и базовая форма сохранены через Advanced Canvas attributes |
| `sticky_note` | 29 | 29 text nodes | Содержимое и основные цвета сохранены |
| `text` | 75 | 75 text nodes | Rich text передан как HTML внутри Canvas text node |
| `image` | 78 | 73 file nodes | 5 внутренних слотов документа скрыты, потому что их отображает родительский `doc_format` |
| `document` + `doc_format` | 3 | 3 file nodes | Локальные файлы сохранены и проверены |
| `frame` + `group` + `diagram` + `slide_container` | 10 | 10 group nodes | Геометрия, подписи и membership сохранены в доступной модели Canvas |
| `connector` | 29 | 29 edges | Концы и 2 подписи сохранены; добавлено 1 невидимое ребро порядка слайдов |
| `preview` | 1 | 1 link node | Целевой URL стал нативной Canvas link card |
| `table` + `table_text` | 19 | 19 text nodes | API не отдали содержимое ячеек, поэтому сохранены диагностические данные и ссылки |
| REST comment | 1 | 1 text node | Текст и метаданные видимы, но это не интерактивный Miro thread |
| `board` + `board_member` | 2 | 0 visible nodes | Служебные записи остаются в `miroSource`, но не рисуются на поле |
| completeness diagnostic | 0 source items | 1 text node | Явно показывает известные ограничения публичного API |

## Оставшиеся различия

Приоритеты ниже одновременно учитывают заметность на доске и возможность
исправления.

| Приоритет | Область | Miro | Canvas сейчас | Причина | Где исправлять |
|---|---|---|---|---|---|
| P0 | Таблицы | Полноценная сетка и содержимое ячеек | Технические placeholders для 3 таблиц и 16 ячеек | REST и Web SDK не вернули содержимое | Сначала нужен новый источник данных; Canvas plugin сам данные не восстановит |
| P0 | Фигуры | 45 фактических подтипов | 8 форм Advanced Canvas | Целевая модель беднее Miro | Плагин с собственным renderer фигур или расширение Advanced Canvas |
| P0 | Rotation | 3 повёрнутых элемента | В output нет поля rotation | JSON Canvas не имеет универсальной нативной модели поворота | Canvas plugin и отдельное metadata-поле |
| P0 | Коннекторы | Точная трасса, изгибы, caps, width, dash, orientation | Узлы соединены, 2 подписи сохранены, но точная трасса не гарантируется | Canvas edge model хранит меньше геометрии | Плагин renderer рёбер плюс сохранение Miro control points |
| P1 | Текст | Точные шрифты, метрики, line wrap и vertical alignment | HTML сохраняет контент, но Obsidian пересчитывает строки и размеры | Другой HTML/CSS renderer и набор шрифтов | Плагин typography layer и font fallback map |
| P1 | Цвета и границы | Отдельные fill/border opacity, border width/style | Сохраняется поддерживаемая часть; визуальная альфа и толщина могут отличаться | Ограничения Advanced Canvas attributes | Расширить style metadata и renderer |
| P1 | Frames | Frame chrome, background, title placement и порядок | 5 frames стали group nodes | Canvas group семантически проще Miro frame | Расширение group renderer |
| P1 | Slides | Deck, порядок, presentation UI | `startNode` и невидимое sequence edge | В Canvas нет Miro presentation mode | Плагин slide navigator/presentation mode |
| P1 | Sticky notes | Нативный sticky layout, autosize, padding и эффекты | Text nodes с формой и цветом | Нет отдельного sticky node type | Специализированный note renderer |
| P1 | Documents | Редактируемый Miro doc с inline slots | Локальный PDF/HTML file preview | Canvas показывает файл, а не Miro document model | Плагин document viewer; редактирование потребует отдельной модели |
| P1 | Comments | Thread, anchor, replies, reactions и статус | Отдельный текстовый узел | Canvas не имеет comment thread API | Плагин comments panel и anchor metadata |
| P2 | Images | Crop, mask, exact rotation and image chrome | Локальные file nodes | Obsidian отвечает за file preview | Image renderer без filename chrome, с crop metadata |
| P2 | Link previews | Miro preview card | Нативная Obsidian link card | Вид зависит от сети и metadata cache Obsidian | Кэшировать title/thumbnail или добавить собственную карточку |
| P2 | Z-order | Явный порядок слоёв Miro | Явного `zIndex` в output нет | Canvas использует порядок nodes и собственные правила | Сохранять Miro order в metadata и применять в plugin |
| P2 | Viewport | Miro start viewport и zoom | Доска центрируется и масштабируется до `1.133212` | Canvas и Miro используют разные камеры | Сохранять viewport metadata и восстанавливать через plugin |

## Схлопывание фигур на TEST_BOARD

На доске встретились 45 Miro subtype, но целевой renderer использует только:

- `round-rectangle`;
- `pill`;
- `circle`;
- `diamond`;
- `parallelogram`;
- `predefined-process`;
- `database`;
- `document`.

Поэтому `star`, `cloud`, `cross`, `pentagon`, `hexagon`, `octagon`, callout,
braces и часть flowchart symbols выглядят приблизительно. Их текст и положение
сохраняются, но силуэт не совпадает с Miro.

## Что уже исправлено этим прогоном

1. Полный Web SDK JSON больше не считается неполным из-за корректно
   сериализованных маркеров `undefined` и non-finite values.
2. Строковая форма `data.shape` больше не ломает конвертацию.
3. Повторный production run безопасно обновляет изменившиеся вложения и
   восстанавливает предыдущую папку при сбое.
4. Внутренние image slots `doc_format` больше не появляются повторно как
   технические текстовые узлы.
5. `preview` с целевым URL отображается как нативная link card, а не как
   крупная строка URL.

## Рекомендуемый backlog плагина

1. Добавить metadata-поля `miroSubtype`, `miroRotation`, `miroZIndex` и точную
   геометрию connector path без изменения стандартных Canvas-полей.
2. Реализовать renderer для 45 Miro shapes и rotation.
3. Реализовать connector renderer с Miro caps, dash, width и control points.
4. Добавить frame/slide presentation layer.
5. Добавить typography layer для font family, vertical alignment и line wrap.
6. Добавить comments panel и скрываемый provenance/diagnostic inspector.
7. Исследовать отдельный источник table data. До этого table renderer не решит
   главную проблему, потому что рисовать ему нечего.

## Проверка будущего плагина

Для каждой категории нужен один маленький fixture и один снимок из настоящего
Obsidian. Критерии сравнения:

1. одинаковое число пользовательских элементов;
2. совпадающие bounding boxes с заданным допуском;
3. совпадающие subtype, rotation, fill, border и text metrics;
4. совпадающие connector endpoints и path;
5. отсутствие технических placeholders там, где данные можно отрисовать;
6. явный diagnostic node там, где данные не отдал Miro.

Главное архитектурное правило: canonical JSON остаётся максимально полным и
не подстраивается под ограничения Canvas. Потери отображения исправляются на
слое конвертации или плагина, а исходные REST/Web SDK объекты и provenance
сохраняются без удаления.
