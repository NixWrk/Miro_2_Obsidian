"""Shared presentation copy. Canonical menu values and source evidence stay intact."""

import re

from miro2obsidian.ui_strings import RU

DESKTOP_RU = {
    **RU,
    "Language": "Язык", "Appearance": "Интерфейс", "light": "Светлая", "dark": "Тёмная",
    "Workflow": "Сценарий", "Source": "Источник", "Board": "Доска", "Board URL": "Ссылка на доску",
    "Miro account": "Аккаунт Miro", "Miro URL": "Ссылка Miro", "Miro URL list": "Список ссылок Miro",
    "Existing JSON": "Готовый JSON", "Manual": "Вручную", "Code automation": "Автоматизация", "Agent": "Агент",
    "Authenticate first": "Сначала подключите Miro", "No boards available": "Нет доступных досок",
    "Authenticate / refresh": "Войти / обновить", "Authenticate": "Войти",
    "Refresh boards": "Обновить доски", "Switch Miro team": "Сменить команду Miro",
    "Set up Miro app": "Настроить приложение Miro", "Set up your Miro app": "Настройка приложения Miro",
    "Forget saved token": "Забыть подключение", "Check connection": "Проверить подключение",
    "URL list": "Список ссылок", "JSON file": "Файл JSON", "Canvas folder": "Папка Canvas",
    "Vault root (auto)": "Хранилище (авто)", "Browse": "Выбрать", "Auto": "Авто", "auto": "авто",
    "Scale mode": "Вид доски", "balanced": "Сбалансированный", "overview": "Обзор", "readable": "Для чтения",
    "Text": "Стиль текста", "Theme": "Тема Canvas", "Scale": "Масштаб", "Min zoom": "Мин. масштаб",
    "Min font": "Мин. шрифт", "Format": "Формат",
    "Allow degraded export/source": "Разрешить неполный экспорт",
    "Allow missing assets (degraded)": "Разрешить отсутствие файлов",
    "Allow incomplete/unverified JSON": "Разрешить непроверенный JSON",
    "Use stable REST items": "Использовать стабильный REST",
    "Install Advanced Canvas + zoom unlock": "Установить плагины Canvas и масштаба",
    "Store identical attachments once": "Не дублировать одинаковые вложения",
    "Web SDK": "Web SDK", "Web SDK JSON": "JSON Web SDK", "Optional whole-board download": "Необязательный экспорт всей доски",
    "Whole-board Web SDK JSON (From file)": "JSON всей доски из Web SDK",
    "Automatic (open board and capture)": "Авто: открыть и получить доску", "Off (REST only)": "Выкл.: только REST",
    "From file…": "Из файла…", "Configure agent": "Настроить агента", "Run pipeline": "Экспортировать",
    "Copy instructions for my agent": "Инструкции для моего агента", "Agent command": "Команда агента",
    "Use": "Применить", "Paste": "Вставить", "Open Your apps": "Открыть Your apps",
    "Connect": "Подключить", "Back": "Назад", "Next": "Далее", "Close": "Закрыть",
    "Open in browser": "Открыть в браузере", "OK": "ОК", "Yes": "Да", "Cancel": "Отмена",
    "Miro app": "Приложение Miro", "Miro connected": "Miro подключён", "Clipboard is empty.": "Буфер обмена пуст.",
    "The clipboard is empty.": "Буфер обмена пуст.", "Enter both the Client ID and the Client secret.": "Введите Client ID и Client secret.",
    "Checking the Miro connection...": "Проверяем подключение Miro…",
    "Waiting for you to approve access in the browser window that just opened...": "Разрешите доступ в открывшемся окне браузера…",
    "Connected to Miro.": "Miro подключён.", "Pipeline complete": "Экспорт завершён",
    "Pipeline incomplete": "Экспорт неполный", "Pipeline failed": "Ошибка экспорта",
    "Written with gaps": "Сохранено с пропусками", "Miro needs your attention": "Miro требует вашего участия",
    "Miro needs attention": "Требуется ваше участие", "OAuth failed": "Ошибка авторизации",
    "Copied": "Скопировано", "Choose a file": "Выберите файл", "Choose a folder": "Выберите папку",
    "Board lists": "Списки досок", "All files": "Все файлы", "JSON files": "Файлы JSON",
    "Canvas folder is required.": "Укажите папку Canvas.", "Choose a JSON file.": "Выберите файл JSON.",
    "Choose a URL list file.": "Выберите файл со списком ссылок.", "Authenticate and choose a board.": "Подключите Miro и выберите доску.",
    "Paste a Miro board link.": "Вставьте ссылку на доску Miro.",
    "You control Miro and may supply a downloaded Web SDK JSON.": "Вы управляете Miro и можете добавить скачанный JSON Web SDK.",
    "Code exports REST, assets, and Canvas; steps appear in the log.": "Программа выгружает REST, файлы и Canvas; этапы видны в журнале.",
    "A configured agent handles browser steps; the app validates its output.": "Агент выполняет шаги в браузере; приложение проверяет результат.",
    "For the Advanced Canvas plugin: today's default, richest styling.": "Для Advanced Canvas: формат по умолчанию с расширенным оформлением.",
    "Plain Obsidian, no plugin required: Markdown text, no HTML.": "Обычный Obsidian без плагина: Markdown, без HTML.",
    "For the miro-canvas plugin: draws the Miro look from the source board.": "Для miro-canvas: оформление Miro из исходной доски.",
    "Just the Miro data: no Canvas file, only the exported JSON.": "Только данные Miro: JSON без файла Canvas.",
    "JSON argument array for any local agent adapter. Leave blank for the default.": "Команда адаптера агента как JSON-массив аргументов. Пустое поле — адаптер по умолчанию.",
    'Example: ["python", "/path/to/adapter.py"]. Never put secrets here.': 'Пример: ["python", "/path/to/adapter.py"]. Не вводите сюда ключи.',
    "These values stay in this program's memory for this session.": "Эти значения хранятся в памяти программы до конца сеанса.",
    "Ready. Default path: Miro board -> REST experimental JSON + assets -> Canvas.": "Готово. Доска Miro → JSON REST и файлы → Canvas.",
    "Agent mode: a configured local agent will handle browser-dependent steps.": "Агент выполнит действия, требующие браузера.",
    "Manual mode: choose each source and run the pipeline yourself.": "Выберите источник и запустите экспорт вручную.",
    "Code mode: REST and assets run automatically; the OS vault stores the token when available.": "REST и файлы экспортируются автоматически; токен хранится в системном хранилище, если оно доступно.",
    "Code mode: the program opens the board, captures it, exports REST and assets and writes the Canvas.": "Программа открывает доску, получает Web SDK, экспортирует REST и файлы и создаёт Canvas.",
    "Code: checking the vault and selected source.": "Проверяем хранилище и источник.",
    "Code: reading local JSON; Miro access is unnecessary.": "Читаем локальный JSON; доступ к Miro не нужен.",
    "Code: this run will use REST only; no Web SDK capture was selected.": "Используется только REST: экспорт Web SDK не выбран.",
    "Code: this run will use REST only; Web SDK is off.": "Используется только REST: Web SDK выключен.",
    "Code: the board will open in your browser so the Miro app can send its data.": "Доска откроется в браузере, чтобы приложение Miro передало данные.",
    "Code: using the Web SDK file you selected.": "Используем выбранный файл Web SDK.",
    "Code: export finished; the output passed the pipeline checks.": "Экспорт завершён; результат прошёл проверки.",
    "Agent 1/3: opening a dedicated Miro browser profile for the agent.": "Агент 1/3: открываем отдельный профиль браузера Miro.",
    "Agent browser: first sign-in or MFA may still need the account owner.": "Для первого входа или MFA потребуется владелец аккаунта.",
    "No Miro app is saved yet; opening the setup.": "Подключение Miro ещё не сохранено; открываем настройку.",
    "Miro is not connected yet; opening the setup.": "Miro ещё не подключён; открываем настройку.",
    "Choose the team that owns the target board in Miro OAuth.": "При авторизации Miro выберите команду, которой принадлежит доска.",
    "Choose the team that owns the target board in the Miro window that opens.": "В открывшемся окне Miro выберите команду, которой принадлежит доска.",
    "Miro app credentials ready for this session.": "Ключи Miro готовы для этого сеанса.",
    "Miro token ready for this GUI session.": "Подключение Miro готово для этого сеанса.",
    "OAuth token obtained for this GUI session.": "Авторизация для этого сеанса выполнена.",
    "Using the Miro token from the OS credential store.": "Используем токен Miro из системного хранилища.",
    "Miro token saved in the OS credential store for future runs.": "Токен Miro сохранён в системном хранилище.",
    "Saved Miro token removed from the OS credential store.": "Сохранённый токен Miro удалён из системного хранилища.",
    "No OS credential store is available; session token cleared.": "Системное хранилище недоступно; токен сеанса очищен.",
    "No custom Obsidian attachment folder found; attachments stay beside the Canvas.": "Отдельная папка вложений Obsidian не задана; файлы будут рядом с Canvas.",
    "MIRO_ACCESS_TOKEN is still set in the environment and will be used.": "В окружении задан MIRO_ACCESS_TOKEN; будет использован этот токен.",
    "Instructions for your agent copied. Paste them into your agent's chat.": "Инструкции скопированы. Вставьте их в чат вашего агента.",
    "The instructions are on your clipboard.\n\nPaste them into your AI agent's chat. They contain no Miro credentials.": "Инструкции в буфере обмена.\n\nВставьте их в чат вашего агента. Ключей Miro в них нет.",
    "Not connected to Miro. Click 'Set up Miro app' to connect.": "Miro не подключён. Нажмите «Настроить приложение Miro».",
    "Importing a board.": "Импортируем доску.", "Nothing was imported.": "Ничего не импортировано.",
    "Export your Miro board": "Экспорт доски Miro",
    "Capture board data, then bring it into your Obsidian vault.": "Получите данные доски и перенесите их в хранилище Obsidian.",
    "Open exporter panel": "Открыть панель экспорта",
    "This page registers the Miro toolbar icon and opens the exporter panel.": "Эта страница добавляет значок приложения в Miro и открывает панель экспорта.",
    "Waiting for Miro Web SDK...": "Ожидаем Miro Web SDK…",
    "Miro Web SDK UI API is not available. Open this page as an installed Miro app.": "Miro Web SDK недоступен. Откройте эту страницу как установленное приложение Miro.",
    "Miro Web SDK UI API is not available. Check the App URL and open this inside a Miro board.": "Miro Web SDK недоступен. Проверьте App URL и откройте приложение внутри доски Miro.",
    "Exporter panel opened.": "Панель экспорта открыта.",
    "Ready. Click the app icon on the Miro toolbar to open the exporter panel.": "Готово. Нажмите значок приложения в панели Miro, чтобы открыть экспорт.",
    "Create probe items": "Создать тестовые элементы", "Export board": "Экспортировать доску",
    "Export selection": "Экспортировать выделение", "Download JSON": "Скачать JSON", "Copy JSON": "Копировать JSON",
    "Waiting for export...": "Ожидаем экспорт…", "Exporting...": "Экспортируем…",
    "Miro Web SDK export copied": "Экспорт Miro Web SDK скопирован", "Miro Web SDK export ready": "Экспорт Miro Web SDK готов",
    "Developer tools": "Инструменты разработчика",
    "Probe items are added to the current board.": "Тестовые элементы будут добавлены на текущую доску.",
    "Exporter version: 20260727-complete-json": "Версия экспорта: 20260727-complete-json",
    "Copy manifest": "Копировать манифест",
    "First export: ": "Первый экспорт: ",
    "Miro is not connected yet. Click 'Set up Miro app' and follow the steps.": "Miro ещё не подключён. Нажмите «Настроить приложение Miro» и выполните шаги.",
    "Miro no longer accepts the saved connection (it may have been revoked). Click 'Switch Miro team' or 'Set up Miro app' to connect again.": "Miro не принимает сохранённое подключение: возможно, доступ отозван. Нажмите «Сменить команду Miro» или «Настроить приложение Miro».",
    "Not connected to Miro, and this computer has no credential store to keep a connection. Install a keyring backend, or set MIRO_ACCESS_TOKEN for this run.": "Miro не подключён, системное хранилище недоступно. Установите хранилище keyring или задайте MIRO_ACCESS_TOKEN для этого запуска.",
    "Connected with the MIRO_ACCESS_TOKEN environment variable (this run only; not saved).": "Подключено через MIRO_ACCESS_TOKEN из окружения: только на этот запуск, без сохранения.",
    "Connected with an older saved token (team unknown). It cannot renew itself: use 'Set up Miro app' to connect again.": "Подключено через старый токен; команда неизвестна. Обновление невозможно: повторите настройку приложения Miro.",
    "The Web SDK data is missing, so items and details that exist only inside the board (some shapes, styling and positions) are not in this result.": "Данные Web SDK отсутствуют: часть фигур, оформления и позиций, доступных только внутри доски, не вошла в результат.",
    "Miro asks for a sign-in in the agent's browser.": "Нужен вход в Miro в браузере агента.",
    "Sign in to Miro in the dedicated browser window, then run Agent mode again.": "Войдите в Miro в выделенном окне браузера и повторите запуск агента.",
    "Miro asks for a second sign-in step (MFA).": "Miro требует подтверждения входа (MFA).",
    "Finish the sign-in in the dedicated browser window, then run Agent mode again.": "Завершите вход в выделенном окне браузера и повторите запуск агента.",
    "The Miro team needs an administrator to approve the app.": "Администратор команды Miro должен одобрить приложение.",
    "Ask the team administrator to approve the app, then run Agent mode again.": "Попросите администратора одобрить приложение и повторите запуск агента.",
    "This agent session cannot control a signed-in browser.": "Агент не может управлять браузером с выполненным входом.",
    "Use Code automation (it needs no agent), or configure an agent adapter with browser access.": "Используйте автоматизацию без агента или настройте адаптер с доступом к браузеру.",
    "The agent cannot reach its service from this environment.": "Сервис агента недоступен из этого окружения.",
    "Check the agent's network access and run Agent mode again.": "Проверьте доступ агента к сети и повторите запуск.",
    "Miro is not connected.": "Miro не подключён.",
    "Click 'Set up Miro app' to connect, then run Agent mode again.": "Настройте подключение Miro и повторите запуск агента.",
    "The Miro app did not send the board data in time.": "Приложение Miro не передало данные доски вовремя.",
    "On the open board click the Miro to Obsidian app icon in the left toolbar (More apps, then the app), then run it again.": "На открытой доске нажмите значок Miro to Obsidian слева (More apps → приложение), затем повторите запуск.",
    "A Web SDK file belongs to one board. Choose a single board, or switch Web SDK to Automatic or Off.": "Файл Web SDK относится к одной доске. Выберите одну доску или переключите Web SDK в авто / выкл.",
    "Choose the whole-board Web SDK JSON file, or switch Web SDK to Automatic or Off.": "Выберите JSON всей доски или переключите Web SDK в авто / выкл.",
    "Choose an existing whole-board Web SDK JSON file.": "Выберите существующий JSON всей доски.",
    "Send to miro2obsidian": "Отправить в miro2obsidian",
    "miro2obsidian server not detected. Use Download JSON or Copy JSON.": "Сервер miro2obsidian не найден. Скачайте или скопируйте JSON.",
    "miro2obsidian server not detected. Start it with: miro2obsidian websdk-serve": "Сервер не найден. Запустите: miro2obsidian websdk-serve",
    "Sending to miro2obsidian…": "Отправляем в miro2obsidian…",
    "miro2obsidian is waiting for this board. Exporting…": "miro2obsidian ожидает эту доску. Экспортируем…",
    "The export is already running in the background; this panel will not repeat it.": "Экспорт уже выполняется в фоне; повторный запуск не нужен.",
    "Export for miro2obsidian is already running.": "Экспорт для miro2obsidian уже выполняется.",
    "Connect to Miro and choose a board.": "Подключите Miro и выберите доску.",
    "This source does not read boards from Miro.": "Этот источник не получает доски из Miro.",
    "Agent mode currently needs one Miro board or board URL.": "Для агента выберите одну доску Miro или ссылку на неё.",
    "Choose or paste a Miro board before starting Agent mode.": "Выберите доску или вставьте ссылку перед запуском агента.",
    "Complete": "Готово", "Needs you": "Требуется ваше участие", "Failed": "Ошибка",
    "Connect first": "Сначала подключитесь",
    "You choose each source. Web SDK: let the app capture it, skip it, or give a downloaded file.": "Выберите источник. Web SDK: получите данные автоматически, пропустите этот шаг или укажите скачанный файл.",
    "Code opens the board, captures it, exports REST and assets, and writes the Canvas; steps appear in the log.": "Программа открывает доску, получает Web SDK, REST и файлы и создаёт Canvas. Этапы видны в журнале.",
}

PATTERNS = [
    (r"Connected to team (.+)\. The connection renews itself\.", r"Подключено к команде \1. Подключение обновляется автоматически."),
    (r"Connected to team (.+) until (.+)\. It cannot renew itself: reconnect before then\.", r"Подключено к команде \1 до \2. Повторите подключение до этого срока: токен не обновляется."),
    (r"Step (\d+) of (\d+)", r"Шаг \1 из \2"),
    (r"(\d+) lines", r"\1 строк"),
    (r"Copy (.+)", r"Копировать: \1"),
    (r"Copied: (.+)\. Paste it where Miro asks for it\.", r"Скопировано: \1. Вставьте в нужное поле Miro."),
    (r"Connected to team (.+)\.", r"Подключено к команде \1."),
    (r"Loaded boards: (\d+) across (\d+) team\(s\) visible to this Miro app/user\.", r"Загружено досок: \1. Доступных команд: \2."),
    (r"No Miro board links found in (.+)", r"Ссылки на доски Miro не найдены в \1"),
    (r"Completed with incomplete source data: (\d+) board\(s\)\.", r"Неполные исходные данные: \1 досок."),
]
PREFIXES = {
    "OAuth failed: ": "Ошибка авторизации: ", "Pipeline failed: ": "Ошибка экспорта: ",
    "Could not connect: ": "Не удалось подключиться: ", "Done: ": "Готово: ",
    "Warning: ": "Предупреждение: ", "Result: ": "Результат: ", "What to do: ": "Что делать: ",
    "Diagnostics log: ": "Журнал диагностики: ", "Needs you: ": "Требуется ваше участие: ",
    "Attachments follow Obsidian setting: ": "Папка вложений Obsidian: ",
    "Vault autodetect failed: ": "Не удалось определить хранилище: ",
    "Token available for this session only: ": "Токен доступен только для этого сеанса: ",
    "First export: ": "Первый экспорт: ",
    "Missing source data or assets:\n": "Отсутствуют исходные данные или файлы:\n",
}


def translate(value, language="en"):
    if language != "ru" or not isinstance(value, str):
        return value
    if value in DESKTOP_RU:
        return DESKTOP_RU[value]
    status = re.fullmatch(r"\[(Complete|Written with gaps|Needs you|Failed)\] (.*)", value)
    if status:
        return f"[{DESKTOP_RU[status[1]]}] {status[2]}"
    if value.startswith("  "):
        return "  " + translate(value[2:], language)
    for pattern, replacement in PATTERNS:
        if re.fullmatch(pattern, value):
            return re.sub(pattern, replacement, value)
    for prefix, replacement in PREFIXES.items():
        if value.startswith(prefix):
            return replacement + translate(value[len(prefix):], language)
    if "\n" in value:
        return "\n".join(translate(line, language) for line in value.split("\n"))
    return value


DESKTOP_RU.update({
    "Open Miro Settings > Your apps": "Откройте Miro: Settings → Your apps",
    "Open this link in your normal browser and sign in to Miro. Miro may redirect to a company-specific Profile settings URL; choose the Your apps tab. If the link does not open it, use your Miro avatar, Settings, then Your apps. The Explore the Developer Hub / Get started banner is optional. Finish email sign-in and setup in the same browser: sessions do not transfer between browsers. Miro renames screens now and then, so the labels on your screen may differ slightly from the ones quoted here; look for the same purpose.": "Откройте ссылку в обычном браузере и войдите в Miro. Возможен переход в настройки компании: выберите Your apps. Если ссылка не работает, нажмите аватар → Settings → Your apps. Баннер Developer Hub / Get started можно пропустить. Вход по письму и настройку завершайте в одном браузере: сеансы входа между браузерами не переносятся. Названия настроек Miro могут немного отличаться; ориентируйтесь на их назначение.",
    "Create your own Miro app in a Developer team": "Создайте приложение в Developer team",
    "In Your apps click Create new app below the Developer Hub banner. Pick the organization and a Developer team (create one and accept the developer terms if none exists), then create a new app. Give it a recognizable name. Creating the app does not move or copy any board; it only creates the credentials and permissions this program uses. This local-first program uses an app you configure rather than shipping shared credentials.": "В Your apps нажмите Create new app под баннером Developer Hub. Выберите организацию и команду разработчика; если её нет, создайте и примите условия. Дайте приложению понятное имя. Создание приложения не переносит доски: оно задаёт ключи и права для программы. Мы используем ваше приложение без встроенных общих ключей.",
    "Set the app URL, redirect URI and permissions": "Задайте адреса приложения и права",
    "Option A: if your app settings page offers editing the app manifest, paste the manifest below and save. Option B: set the fields by hand. Set the App URL (also called SDK URI) to http://localhost:8766/index.html. Add the redirect URI http://localhost:8765/callback and, in that URI's options, select 'Use this URI for SDK authorization'. Select the permissions (scopes) boards:read and team:read, and nothing else. Save. You may switch on 'Expire user authorization token': Miro to Obsidian supports it either way and renews such tokens by itself. Use the host name localhost exactly as written, not 127.0.0.1. Miro renames screens now and then, so the labels on your screen may differ slightly from the ones quoted here; look for the same purpose.": "Если доступно редактирование манифеста, вставьте YAML ниже и сохраните. Иначе заполните поля вручную: App URL / SDK URI — http://localhost:8766/index.html; Redirect URI — http://localhost:8765/callback. Включите Use this URI for SDK authorization. Выберите только boards:read и team:read. Можно включить Expire user authorization token: программа поддерживает обновление токенов. Используйте именно localhost, как указано, вместо 127.0.0.1. Названия настроек Miro могут немного отличаться.",
    "Install the app into the team that owns your boards": "Установите приложение в команду владельца досок",
    "In the app settings choose 'Install app and get OAuth token' (or the equivalent button), select the team that owns the boards you want to export, review the permissions and confirm. An app installed only in your Developer team will not see boards of another team, so install it in the board owner's team. If the team is missing or installing apps is restricted, ask that team's administrator to approve the app. You do not need to copy the access token Miro may show you here.": "В настройках приложения нажмите Install app and get OAuth token или аналогичную кнопку, выберите команду, которой принадлежат доски, проверьте права и подтвердите. Установка только в Developer team не даёт доступа к доскам других команд. Если команда отсутствует или установка ограничена, обратитесь к её администратору. Копировать показанный токен доступа не нужно.",
    "Connect the program to your app": "Подключите программу к приложению",
    "Run the command below. It opens a local form in your browser: paste the app's Client ID and Client secret (from the app settings, under its credentials) into that form only, never into a chat or file, then approve access in Miro. The connection is saved in your operating system credential store and renews itself afterwards.": "Откройте Settings → Your apps в Miro, выберите настроенное приложение и найдите его ключи. Вставьте Client ID и Client secret в поля ниже и нажмите «Подключить». Секрет скрыт. В браузере разрешите доступ для команды владельца досок. Подключение сохраняется в системном хранилище и обновляется автоматически.",
    "First export only: start the app on the board if Miro does not": "Первый экспорт: запустите приложение на доске",
    "When an export opens a board, the Miro to Obsidian app should start by itself and send the board data to the program. If nothing happens within about 20 seconds, click the app's icon in the board's left toolbar (or More apps, then the app). If the icon is missing, the app is not installed in this board's team: repeat the install step for that team.": "При экспорте приложение Miro должно запуститься на доске и передать данные автоматически. Если за 20 секунд ничего не происходит, нажмите значок приложения слева или More apps. Если значка нет, повторите установку в команду владельца этой доски.",
    "Open Miro Settings > Your apps, select your configured app and find its credentials. Copy the Client ID and the Client secret into the two boxes below (the secret stays hidden), then click Connect. Your browser opens so you can approve access for the team that owns your boards. The connection is saved in your computer's credential store and renews itself, so you only do this once.": "Откройте Settings → Your apps в Miro, выберите настроенное приложение и найдите его ключи. Вставьте Client ID и Client secret в поля ниже и нажмите «Подключить». Секрет скрыт. В браузере разрешите доступ для команды владельца досок. Подключение сохраняется в системном хранилище и обновляется автоматически.",
    "First export: ": "Первый экспорт: ",
    "No app yet? Open Miro Settings > Your apps and click Create new app below the Developer Hub banner. Choose a Developer team, then set App URL to http://localhost:8766/index.html and OAuth redirect URI to http://localhost:8765/callback. Select boards:read and team:read, then install the app in the board's team. Leave 'Expire user authorization token' unchecked for unattended Code mode. Finish email sign-in and OAuth in the same browser. Enter Client ID and Client secret only after configuring the app.": "Нет приложения? Откройте Settings → Your apps в Miro, нажмите Create new app под баннером Developer Hub. Выберите Developer team. App URL: http://localhost:8766/index.html; OAuth redirect URI: http://localhost:8765/callback. Права: boards:read и team:read. Установите приложение в команду владельца доски. В этой версии оставьте Expire user authorization token выключенным. Вход по письму и OAuth завершите в одном браузере. Затем введите Client ID и Client secret."
})

DESKTOP_RU.update({'01   Choose a workflow': '01   Сценарий работы', '02   Choose a source': '02   Источник', '03   Save to Obsidian': '03   Сохранение', '04   Export progress': '04   Экспорт', 'Continue': 'Продолжить', 'Choose the board or file to import.': 'Выберите доску или файл для импорта.', 'Choose a folder inside your Obsidian vault.': 'Выберите папку в вашем хранилище Obsidian.', 'Export progress': 'Ход экспорта', 'Advanced settings': 'Дополнительные настройки', 'Connection options': 'Параметры подключения', 'Connect to Miro and choose a board first.': 'Сначала подключите Miro и выберите доску.', 'Paste your Miro board URL first.': 'Сначала вставьте ссылку на доску Miro.', 'Choose an existing source file first.': 'Сначала выберите существующий файл источника.', 'Choose an export folder first.': 'Сначала выберите папку для экспорта.'})

DESKTOP_RU["Additional board data"] = "Дополнительные данные доски"

DESKTOP_RU["Return to the app to choose your board."] = "Вернитесь в приложение и выберите доску."

DESKTOP_RU["Restart setup from the app."] = "Запустите настройку заново из приложения."
