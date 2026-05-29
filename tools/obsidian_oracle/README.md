# Obsidian Oracle Harness

Этот harness нужен для финальной визуальной проверки результата в настоящем Obsidian.

Собственный renderer полезен для быстрой диагностики, но он не может гарантировать полное совпадение с Obsidian. Финальный oracle должен использовать сам Obsidian как renderer.

## Целевой подход

1. Создать отдельный тестовый vault.
2. Зафиксировать версию Obsidian, тему, CSS snippets, zoom, шрифт и размер окна.
3. Отключить сторонние плагины.
4. Скопировать сгенерированный `.canvas` и связанные файлы в vault.
5. Открыть canvas в Obsidian.
6. Сделать screenshot.
7. Сравнить screenshot с baseline fixture.

## Локальный oracle-профиль

Текущий тестовый vault:

```text
<local-test-data>
```

Рабочая папка внутри vault:

```text
<local-test-data>\MIRO2OBSIDIAN
```

Обязательный community plugin:

```text
advanced-canvas
```

Проверенное состояние:
- plugin folder: `<local-test-data>\.obsidian\plugins\advanced-canvas`;
- manifest id: `advanced-canvas`;
- manifest name: `Advanced Canvas`;
- manifest version: `6.0.1`;
- plugin включён в `<local-test-data>\.obsidian\community-plugins.json`.

Для oracle-проверок Advanced Canvas должен оставаться включённым. Если тест запускается на другом vault, он должен повторить это состояние или явно зафиксировать отличие.

## Команды

Проверить локальную oracle-среду:

```powershell
python tools\obsidian_oracle\check_environment.py
```

Сконвертировать fixture и положить `.canvas` в oracle-папку vault:

```powershell
python tools\obsidian_oracle\stage_fixture.py basic_text
```

Результат будет создан в:

```text
<local-test-data>\MIRO2OBSIDIAN\_oracle\<fixture>\
```

После staging нужно открыть полученный `.canvas` в Obsidian и сделать/сравнить screenshot с `expected.obsidian.png`.

## Правило при расхождении

Если диагностический web-render и Obsidian показывают разное поведение, источником истины считается Obsidian.

После этого нужно:
- либо исправить web-render harness;
- либо записать его ограничение в документацию;
- либо добавить отдельную проверку, которая ловит проблему без зависимости от собственного renderer.

## Требования к стабильности

- один viewport для всех baseline;
- один масштаб canvas;
- одна тема;
- один набор шрифтов;
- отсутствие пользовательских плагинов;
- исключение: `advanced-canvas` должен быть включён для этого проекта;
- отсутствие ручного перемещения nodes перед screenshot;
- baseline обновляется только через выбранную проблему из `tasks/problem_library.md`.
