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

По умолчанию smoke-test использует Playwright Chromium. Для проверки системного Edge:

```powershell
python tools\canvas_render\smoke_test.py --browser edge
```

Снять screenshots для всех fixtures и обновить baselines:

```powershell
python tools\canvas_render\capture_fixture.py --all --update-baseline
```

Сравнить текущий renderer с baselines:

```powershell
python tools\canvas_render\capture_fixture.py --all
```

Actual screenshots пишутся в `tools/canvas_render/.out/`.

`capture_fixture.py` keeps full-stage screenshots for stable fixture baselines. Local work samples use Scale_engine auto-fit plus fitted viewport screenshots through `scripts\run_local_samples.py`, so large boards are inspectable without changing committed `expected.render.png` baselines.

Текущая реализация является diagnostic harness: она рисует nodes/groups/edges, показывает базовую статистику и поддерживает screenshot/baseline сравнение для fixtures.

Renderer не обязан полностью повторять Obsidian. Его задача — ловить регрессии конвертера: пустой canvas, неверные координаты, схлопнутые nodes, пропавший текст, ошибки размеров и связей.

Финальная проверка визуального совпадения выполняется через `tools/obsidian_oracle/`.
