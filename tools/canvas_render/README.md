# Canvas Render Harness

Назначение этого инструмента — рендерить `.canvas` в обычной web-странице для быстрой автоматизированной и визуальной диагностики результата конвертации.

Obsidian Canvas основан на web-технологиях, поэтому отдельный renderer позволяет быстро проверять результат без ручного запуска Obsidian. Но этот renderer не является финальным источником истины для полного визуального совпадения.

Минимальные задачи harness:
- загрузить `.canvas`;
- нарисовать text, file, link, group nodes;
- нарисовать edges через SVG;
- показать bbox и debug overlay;
- сделать screenshot через Playwright или другой headless browser;
- сравнить screenshot с baseline для fixture.

## Использование

Откройте `index.html` в браузере и выберите `.canvas` файл через кнопку `Open .canvas`.

Также можно передать файл через query string:

```text
index.html?canvas=/path/to/file.canvas
```

Headless smoke-test:

```powershell
python tools\canvas_render\smoke_test.py
```

Текущая реализация является diagnostic harness: она рисует nodes/groups/edges и показывает базовую статистику. Автоматическое снятие screenshot и сравнение с baseline добавляются отдельным слоем поверх этого renderer.

Renderer не обязан полностью повторять Obsidian. Его задача — ловить регрессии конвертера: пустой canvas, неверные координаты, схлопнутые nodes, пропавший текст, ошибки размеров и связей.

Финальная проверка визуального совпадения выполняется через `tools/obsidian_oracle/`.
