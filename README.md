# Miro → Obsidian Canvas

Инструмент для экспорта досок Miro в формат [Obsidian Canvas](https://obsidian.md/canvas) (`.canvas`).
Состоит из двух независимых модулей с собственными GUI.

---

## Архитектура

```
Miro (REST API)
      ↓
 Miro_2_Json          ← скачивает доску + вложения → .json + _files/
      ↓
 Json_2_Canvas         ← конвертирует .json → .canvas (Obsidian)
      ↓
 Obsidian Canvas
```

---

## Miro_2_Json — Загрузчик

### Что делает
Авторизуется в Miro через OAuth, скачивает данные выбранной доски через REST API и сохраняет:
- `{team}_{board}.json` — все элементы доски
- `{team}_{board}_files/` — вложения (изображения, документы, PDF, embed-превью)

### Интерфейс

| Элемент | Описание |
|---|---|
| **Авторизоваться** | Открывает браузер для OAuth-авторизации. После успеха список досок заполняется автоматически |
| **Выбор доски** | Выпадающий список досок аккаунта. Опция «Публичная доска» — ввод ссылки вручную |
| **Папка сохранения** | Куда будут сохранены .json и _files/ |
| **Переименовать файлы** | Добавляет префикс `{team}_{board}_` к именам вложений |
| **API** | V2 Stable / V2 Experimental. Experimental быстрее, но данные могут быть частичными |
| **Скачать** | Запускает многопоточную загрузку |

### Четыре фазы загрузки

1. **Изображения** — `data.imageUrl` для type=image
2. **Документы** — PDF для type=document
3. **Doc_formats** — PDF + встроенные изображения (с заменой `<img src>` на локальные пути)
4. **Embed-превью** — `data.previewUrl` только если ответ сервера — реальное изображение (jpg/png/webp и т.д.); JSON/HTML-ответы игнорируются

### Конфликты файлов
При повторной загрузке спрашивает стратегию: **перезаписать / переименовать (stem(1), stem(2)…) / пропустить**.

---

## Json_2_Canvas — Конвертер

### Что делает
Читает `.json` из Miro_2_Json, конвертирует каждый элемент в ноды/рёбра формата [JsonCanvas](https://jsoncanvas.org/spec/1.0/) и сохраняет `.canvas` файл в папку Obsidian Vault.

### Интерфейс

| Элемент | Описание |
|---|---|
| **JSON файл** | Путь к файлу, полученному из Miro_2_Json. При выборе автоматически рассчитывается рекомендуемый Scale |
| **Папка** | Целевая папка внутри Vault. Vault-root определяется автоматически поиском `.obsidian/` вверх по дереву |
| **Scale** | Масштаб. Изменение пересчитывает Кегль max/min и Мин. объект. Ручное редактирование отключает барьер s_fit |
| **Кегль max / min** | Размер шрифта (px) для самого крупного/мелкого текста при текущем Scale. Редактирование любого поля пересчитывает Scale |
| **Мин. объект W×H** | Ширина/высота наименьшего элемента при текущем Scale. Редактирование ширины пересчитывает Scale |
| **Тема** | Тёмная/Светлая. Влияет на обработку цвета текста |
| **Удалить JSON** | Удаляет исходный .json после успешной конвертации |
| **Удалить _files** | Удаляет папку вложений после конвертации |
| **Конвертировать** | Запускает конвертацию |

---

## Расчёт Scale

Scale — единый коэффициент масштабирования, применяемый ко **всем** координатам, размерам нод и кеглю шрифтов.

```
x_canvas      = x_miro      × Scale
y_canvas      = y_miro      × Scale
width_canvas  = width_miro  × Scale
height_canvas = height_miro × Scale
font_canvas   = font_miro   × Scale
```

Расстояния между нодами тоже масштабируются — компоновка доски полностью сохраняется.

### Три барьера

Scale policy имеет три режима:

- `balanced` — режим по умолчанию: `min(max(s_node, s_font), s_fit)`;
- `overview` — всегда выбирает `s_fit`, чтобы получить обзор всей доски;
- `readable` — выбирает `max(s_node, s_font)`, даже если вся доска не помещается в экран.

В `balanced`:

- `max(s_node, s_font)` — желательный масштаб читаемости;
- `s_fit` — обязательный верхний предел, чтобы доска помещалась во FullHD при минимальном zoom Obsidian;
- если читаемость конфликтует с FullHD-fit, побеждает `s_fit`.

Если `readable` конфликтует с FullHD-fit, это не считается ошибкой режима: runner выводит `fit=no`, чтобы конфликт был виден явно.

#### s_fit — барьер видимости
Гарантирует, что вся доска видна при минимальном зуме Obsidian Canvas (≈12%).
```
s_fit = min(
    (viewport_w × fit_margin) / (bbox_w × min_zoom),
    (viewport_h × fit_margin) / (bbox_h × min_zoom)
)
```

По умолчанию `fit_margin = 0.95`, чтобы оставить запас под post-conversion рост нод и UI-рамки.

#### s_node — барьер минимальной ноды
Гарантирует, что наименьший элемент доски ≥ минимально взаимодействуемому размеру (60×40 px).
```
s_node = max(min_node_w / smallest_w, min_node_h / smallest_h)
```

#### s_font — барьер читаемости шрифта
Гарантирует, что самый мелкий шрифт ≥ 8 px.
```
s_font = min_font_px / font_min_miro
```

### Что исключается из расчёта Scale

Следующие типы **не участвуют** в bbox, min_node и font-анализе:

| Тип | Причина |
|---|---|
| `slide_container` + все потомки | Слайды не конвертируются (нет геометрии в JSON) |
| `board`, `board_member` | Мета-элементы, не контент |
| `preview`, `table_text` | Нет смысловой нагрузки в Canvas |
| `connector` | Рёбра, не ноды |
| `comment`, `emoji`, `kanban`, `mindmap`, `stroke`, `svg`, `grid`, `usm`, `webscreen`, `wireframe` | Read ❌ в Miro REST API |

---

## Что доступно через Miro REST API

### Доступно (Read ✅)

| Тип в JSON | Название | Как конвертируется |
|---|---|---|
| `text` | Текст | `type:text` нода с HTML |
| `shape` | Фигура | `type:text` нода, форма по subtype |
| `sticky_note` | Стикер | `type:text` нода с цветным фоном |
| `image` | Изображение | `type:file` нода |
| `document` | Документ | `type:file` нода (макс. 500×700 px) |
| `doc_format` | Документ (Rich) | `type:file` PDF (макс. 500×700 px) |
| `card` | Карточка | `type:text` нода: title + desc + дата + исполнитель |
| `app_card` | App-карточка | `type:text` нода: title + desc (fields[] в планах) |
| `embed` | Встроенный объект | `type:file` если есть превью-картинка; `type:link` иначе |
| `frame` | Фрейм | `type:group` контейнер |
| `diagram` | Диаграмма | `type:group` контейнер |
| `connector` | Соединитель | `type:edge` ребро |
| `tag` | Тег | `type:text` метка |

### Недоступно (Read ❌)

| Тип | Причина |
|---|---|
| `comment` | Только Enterprise Board Export API |
| `emoji` | Read ❌ |
| `kanban` | Read ❌ |
| `mindmap` | Read ❌ |
| `stroke` / `svg` | Read ❌ |
| `grid` | Read ❌ |
| `usm` | Read ❌ |
| `webscreen` / `wireframe` | Read ❌ |
| `slide_container` + содержимое | Нет геометрии/порядка слайдов в JSON |
| `flip_card`, `people`, `widgets_stack` | `isSupported: false` в API, нет геометрии |
| `code` (блок кода) | `isSupported: false`, содержимое недоступно |
| Beta widgets: Doc, Slides, Table, Timeline | Read ❌ |

### Неизвестные типы с геометрией

Элементы с неизвестным типом, у которых есть координаты на доске (geometry), конвертируются в ноду-заглушку вида:
```
[dynamic poll]
Тип не поддерживается API Miro
```

Элементы без геометрии (нет позиции на доске) молча пропускаются.

---

## Маппинг форм Miro → Obsidian Canvas

| Miro subtype | Canvas shape |
|---|---|
| `rectangle`, `round_rectangle` | `round-rectangle` |
| `circle` | `circle` |
| `triangle`, `rhombus` | `diamond` |
| `right_arrow`, `left_arrow`, `left_right_arrow` | `pill` |
| `can` | `database` |
| `flow_chart_decision`, `flow_chart_merge`, `flow_chart_or` | `diamond` |
| `flow_chart_document`, `flow_chart_multidocuments` | `document` |
| `flow_chart_database`, `flow_chart_magnetic_disk` | `database` |
| `flow_chart_terminator` | `pill` |
| `flow_chart_predefined_process*` | `predefined-process` |
| Все остальные | `round-rectangle` |

---

## Цвет текста и выделение

- **Тёмная тема**: чёрный цвет из Miro (`#1a1a1a`, `#000000`) удаляется — текст наследует цвет темы Obsidian
- **Цветное выделение** (`<span style="background-color:...>`): для каждого span без явного color автоматически подбирается контрастный цвет (#000 или #fff) по формуле W3C relative luminance

---

## Ноды-ссылки (type:link)

Следующие элементы конвертируются в нативные ссылки Obsidian Canvas (`type:link`), которые отображаются как карточки превью веб-страниц:

1. **Embed без скачанного превью** — `data.url` используется как URL
2. **Text-нода с единственной ссылкой** — HTML вида `<p><a href="...">...</a></p>` или голая URL-строка

Размер таких нод: `miro_width × Scale` по ширине, `width × 9/16` по высоте (соотношение 16:9).

---

## Известные ограничения

- **Слайды Miro** — в JSON нет ни геометрии слайдов, ни их порядка → экспорт невозможен
- **Комментарии** — доступны только через Enterprise Board Export API
- **Таблицы** — beta widget, содержимое ячеек недоступно через REST API
- **Повороты элементов** — Obsidian Canvas не поддерживает rotation
- **Непривязанные стрелки** — коннекторы без start/end item пропускаются
- **Размер шрифта в стикерах** — Miro не сохраняет fontSize стикеров в JSON; используется автоподбор по размеру стикера и объёму текста
