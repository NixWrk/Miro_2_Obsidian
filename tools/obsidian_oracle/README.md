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
_obsidian_oracle_vault
```

Рабочая папка внутри vault:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN
```

Обязательный community plugin:

```text
advanced-canvas
```

Проверенное состояние:
- plugin folder: `_obsidian_oracle_vault\.obsidian\plugins\advanced-canvas`;
- manifest id: `advanced-canvas`;
- manifest name: `Advanced Canvas`;
- manifest version: `6.0.1`;
- plugin включён в `_obsidian_oracle_vault\.obsidian\community-plugins.json`.

Для быстрых local checks достаточно project-local vault. Для финальных Obsidian screenshots Advanced Canvas должен быть установлен настоящими plugin-файлами (`main.js`, `styles.css`), а не только включён в manifest/community plugins.

## Команды

Проверить локальную oracle-среду:

```powershell
python tools\obsidian_oracle\init_local_vault.py
python tools\obsidian_oracle\check_environment.py
```

Проверить, что установлен настоящий runtime плагина:

```powershell
python tools\obsidian_oracle\check_environment.py --strict-runtime
```

Если есть существующий vault с установленным Advanced Canvas, можно скопировать runtime:

```powershell
python tools\obsidian_oracle\init_local_vault.py --plugin-source "<local-test-data>\.obsidian\plugins"
```

Если существующего vault нет, runtime можно скачать из GitHub release:

```powershell
python tools\obsidian_oracle\install_plugin_runtime.py advanced-canvas
python tools\obsidian_oracle\check_environment.py --strict-runtime
```

Сконвертировать fixture и положить `.canvas` в oracle-папку vault:

```powershell
python tools\obsidian_oracle\stage_fixture.py basic_text
```

Результат будет создан в:

```text
_obsidian_oracle_vault\MIRO2OBSIDIAN\_oracle\<fixture>\
```

После staging нужно открыть полученный `.canvas` в Obsidian и сделать/сравнить screenshot с `expected.obsidian.png`.

Принять уже снятый скриншот как baseline:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --actual path\to\screenshot.png --update-baseline
```

Сравнить уже снятый скриншот с baseline:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --actual path\to\screenshot.png
```

В интерактивной desktop-сессии можно staged fixture и снять весь экран:

```powershell
python tools\obsidian_oracle\snapshot_fixture.py app_card_fields --capture-screen --update-baseline
```

Actual screenshots пишутся в `tools/obsidian_oracle/.out/`.

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
