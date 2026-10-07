# Подключение собственных досок Miro

[English](MIRO_APP_SETUP.md) | **Русский**

Здесь описано, зачем Miro to Obsidian требуется собственное Miro Developer App,
как его создать и какие части настройки пока выполняются вручную.

## Короткий ответ

- Программировать ничего не нужно.
- Если вы можете устанавливать приложения в team целевой доски, настройка обычно
  занимает 10-20 минут.
- Если требуется согласование администратора team, понадобится больше времени.
- Приложение настраивается один раз, после чего может экспортировать все доски,
  доступные одновременно авторизованному пользователю и установленному app.
- В текущем pre-release ещё нужны Python, локальный сервер и ручное скачивание
  Web SDK JSON. Будущий мастер первого запуска должен убрать эти технические
  действия.

В этом локальном сценарии используется app, настроенное вами. Репозиторий не должен
поставлять один общий client secret, который смешивает доступ разных
пользователей к их доскам.

## Какой выигрыш это даёт

| Без собственного Miro app | С собственным Miro app |
|---|---|
| Только конвертация уже имеющегося JSON | Прямая авторизация в вашем Miro account |
| Нет автоматического списка досок | Список досок, видимых пользователю и app |
| Нет свежего REST-экспорта | REST items, comments и обязательные assets |
| Нет Web SDK capture | Максимальный payload, доступный внутри открытой доски |
| Нет воспроизводимой проверки источника | Проверка доски, свежести, полноты и provenance |

Комбинация REST и Web SDK даёт максимум данных, который открывают публичные API
Miro. Она не может восстановить скрытые внутренние данные, которые Miro не
выдаёт ни через один публичный интерфейс.

## Что потребуется

- Miro account с доступом к целевой доске;
- право устанавливать app в team этой доски или помощь администратора team;
- этот репозиторий и Python 3.13 для текущего pre-release;
- Obsidian vault для итогового Canvas.

Miro Developer team подходит для безопасных тестов, но app, установленное только
в ней, не появится на доске другой team. То же app нужно установить именно в
team реальной доски.

## 1. Создайте Miro app

1. Войдите в Miro.
2. Откройте [Developer Hub → Your apps](https://developers.miro.com/page/developer-hub#your-apps)
   в браузере, где выполнен вход в Miro. Если вы начали с Profile settings →
   Your apps, нажмите **Get started** в блоке **Explore the Developer Hub**.
3. Выберите **Create new app** или **Create your first app**. Раздел
   Apps & Integrations показывает установленные приложения; это не экран создания.
4. Назовите приложение `Miro Full Exporter` и выберите Developer team. Если Miro
   требует Enterprise Developer team, её должен настроить администратор организации.
   Обычная команда с названием `Dev team` не обязательно является Developer team.
5. До нажатия **Create app** снимите **Expire user authorization token**.
   Эта версия не обновляет истекающие токены, а Miro не позволяет изменить
   настройку после создания. Если приложение уже создано с истекающим токеном,
   потребуется переподключение после истечения либо новое приложение с нужной настройкой.

Вход по почте и авторизацию проходите в одном браузере. Настройка программы
теперь находится в главном окне: **Создать приложение → Настроить приложение →
Подключить**. У адресов и имени есть кнопки **Скопировать**. Для готового
приложения можно сразу перейти к подключению. Необязательная локальная страница
в браузере использует те же три шага.

Это действие не переносит и не копирует доски. Оно создаёт credentials и
границу разрешений для локального экспорта.

## 2. Настройте URL

Введите в настройках app точные значения:

| Настройка Miro | Значение |
|---|---|
| App URL / SDK URI | `http://localhost:8766/index.html` |
| OAuth redirect URI | `http://localhost:8765/callback` |

Если у callback URI есть options, включите **Use this URI for SDK
authorization**. Сохраните настройки.

`localhost` означает, что приложение обслуживается только вашим компьютером.
Miro разрешает HTTP для локальной разработки на `localhost`; удалённый сервер
потребовал бы HTTPS.

Host является частью redirect URI. Не заменяйте `localhost` на `127.0.0.1`, если
второй URI отдельно не зарегистрирован в Miro и не настроен локально.

## 3. Выберите разрешения

Для обычного экспорта нужен минимальный набор:

| Scope | Для чего нужен |
|---|---|
| `boards:read` | Чтение items и метаданных доски |
| `team:read` | Список видимых teams и досок |
| `boards:write` | Необязательные developer probes, создающие тестовые items |

Обычному пользователю достаточно `boards:read` и `team:read`.
`boards:write` добавляйте только для явно выбранного probe, который создаёт
элементы. Для полноты read-only экспорта этот scope ничего не добавляет.

## 4. Установите app в правильную team

1. В настройках app нажмите **Install app and get OAuth token**.
2. Выберите team, которой принадлежит целевая доска.
3. Проверьте scopes и нажмите **Install & authorize**.
4. Если нужной team нет или установка запрещена, попросите её администратора
   одобрить app.

Выбор team критичен. App из Developer team не появляется автоматически на
досках личной, корпоративной или клиентской team.

## 5. Передайте credentials локально

Скопируйте **Client ID** и **Client secret** из настроек app. Не отправляйте их в
issue, chat, screenshot или tracked-файл. В GUI нажмите **Set up Miro app**,
введите оба значения и нажмите **Connect**. GUI хранит их в памяти до закрытия
программы и автоматически запускает OAuth. В режиме **Code automation**
полученный access token дополнительно сохраняется в системном хранилище;
кнопка **Forget saved token** удаляет его. См. [три режима](WORKFLOW_MODES.ru.md).

Можно использовать кнопки **Paste** рядом с полями: скопировать значение
кнопкой Miro, затем вставить прямо в GUI. В GUI значение secret скрыто.
Не включайте необратимую опцию **Expire user authorization token** при создании
app: текущий клиент ещё не обновляет OAuth token автоматически.

Если целевой доски нет в списке, нажмите **Switch Miro team** и выберите в окне
OAuth команду, которой принадлежит доска. Для автоматизации без GUI допустимы
переменные окружения текущей PowerShell-сессии:

```powershell
$env:MIRO_CLIENT_ID = "<ваш client id>"
$env:MIRO_CLIENT_SECRET = "<ваш client secret>"
$env:MIRO_REDIRECT_URI = "http://localhost:8765/callback"
```

Значения не нужно сохранять в файл проекта.

## 6. Проверьте REST-подключение

Установите runtime dependencies и запустите desktop app:

```powershell
python -m pip install .
miro2obsidian-gui
```

Если credentials уже заданы вне GUI, выберите **Miro account** и нажмите
**Authenticate / refresh**. Browser откроет
Miro OAuth и вернётся на `http://localhost:8765/callback`. После согласия GUI
покажет доски, доступные и пользователю, и app.

Теперь GUI может запустить строгий REST-путь: board items, REST comments и
обязательные скачиваемые assets.

## 7. Добавьте Web SDK для максимально полного экспорта

Во втором terminal запустите локальный Web SDK server:

```powershell
miro2obsidian websdk-serve --port 8766
```

Затем:

1. Откройте целевую доску в Miro.
2. В левом toolbar откройте **+ More apps** или **+ More tools**.
3. Выберите приложение по заданному вами имени, например `Miro Full Exporter`.
4. Нажмите **Export board**, а не **Export selection**.
5. Сохраните скачанный JSON. Он должен относиться к той же доске и быть получен
   близко по времени к REST-экспорту.
6. В GUI раскройте **Метод экспорта и состав данных**, затем укажите JSON в поле
   **JSON всей доски из Web SDK (обязательно)** через **Выбрать**. Здесь же есть пошаговая
   инструкция и кнопки копирования команды сервера и App URL. По умолчанию
   требуется REST + Web SDK; чтобы пропустить захват, явно выберите
   **Только REST (меньше данных)**.
   В CLI передайте файл через `--websdk-json`, как показано
   в [README](../README.ru.md#максимально-полный-экспорт).

Сейчас скачанный Web SDK JSON является ручным мостом. В будущем локальный
companion должен принимать его напрямую через loopback, проверять одноразовый
session nonce и автоматически объединять с REST.

## Частые проблемы

| Симптом | Вероятная причина | Что сделать |
|---|---|---|
| `ERR_CONNECTION_REFUSED` в Miro | Local server не запущен на нужном порту | Запустить `serve_no_cache.py` на `8766` |
| `404 File not found` | App URL ведёт на старый путь или другой static server | Указать `http://localhost:8766/index.html` |
| App отсутствует на доске | Оно установлено в другую team | Установить в team этой доски |
| OAuth callback не работает | Отличается host, port или path | Везде использовать `http://localhost:8765/callback` |
| Список досок пуст или неполон | Нет доступа пользователя, установки в team или `team:read` | Проверить все три условия; при необходимости обратиться к admin |
| Порт `8765` занят | Web SDK compatibility server конфликтует с OAuth callback | Web SDK держать на `8766`, OAuth на `8765` |
| `WinError 5` при записи Canvas | Открытый Obsidian удерживает создаваемый файл | Закройте Obsidian, повторите экспорт и откройте готовый Canvas после успешного завершения |
| Probe сообщает о permission | App настроено read-only | Добавить `boards:write` только для намеренного probe |

## План удобства для начинающих

Целевой сценарий: скачать программу, запустить один мастер, выбрать доску и
Obsidian vault, нажать **Export**. Начинающему не должны требоваться terminal,
Python, Node.js, environment variables, JSON paths и знания о local ports.

Мастер первого запуска должен:

1. Поставляться как подписанный Windows installer или portable package со своим
   runtime.
2. Предлагать два понятных пути: **Connect Miro** и **Convert existing JSON**.
3. Открывать правильную страницу Miro и показывать по одному действию.
4. Давать copy-кнопки для app name, URL и минимальных scopes.
5. Автоматизировать действия в Miro через открытый браузер, когда это возможно,
   и явно показывать шаги подтверждения доступа.
6. Принимать и проверять Client ID/secret и хранить их в системном credential
   store, а не в plain-text файле проекта.
7. Автоматически запускать и останавливать OAuth и Web SDK loopback services.
8. Находить конфликт портов, неверную team, отсутствующие scopes, ошибку OAuth и
   устаревший Web SDK capture и предлагать конкретное исправление.
9. Продолжать с последнего завершённого шага после закрытия Miro или browser.
10. Находить Obsidian vault и attachment settings и выбирать безопасные defaults.
11. Передавать Web SDK capture прямо локальному companion с short-lived nonce.
12. Показывать единый progress от выбора доски через REST, comments, assets,
    Web SDK merge, conversion и validation до готового Canvas.

Miro требует входа в аккаунт с правом создать и установить app и явного
согласия на запрошенные права. Действия в интерфейсе можно автоматизировать в
уже открытой пользовательской сессии, как при этом живом тесте; одобрение
администратора при ограничениях team остаётся внешним условием.

## Требования к дизайну интерфейсов

### Панель в Miro

- Одна ясная primary action для обычного экспорта всей доски.
- Отображение текущей доски, connection state, версии exporter и полноты.
- Generated probes и diagnostics только в явном advanced mode.
- Progress, success и исправимые ошибки прямо внутри панели.
- Поддержка light/dark appearance Miro, keyboard navigation, заметного focus и
  корректного toolbar icon.
- Основной путь - безопасная прямая передача локальному companion; JSON download
  остаётся advanced fallback.

### Локальное desktop-приложение

- Вместо плотной формы - пошаговый первый запуск и понятный export flow.
- Beginner defaults отдельно от advanced source/converter controls.
- Board picker и vault picker вместо ручного ввода ID и путей.
- Одна status-зона с progress, следующим действием, retry и logs по запросу.
- Ошибки на языке пользователя с точным repair action.
- Keyboard accessibility, scaling, light/dark themes и читаемая компоновка на
  типичных Windows-экранах.

## Критерий beginner-ready

Релиз готов для начинающих, когда человек на чистом Windows-компьютере может:

1. скачать и запустить программу без developer tools;
2. создать и подключить Miro app, следуя только встроенному мастеру;
3. понимать каждое ручное permission-действие до его подтверждения;
4. выбрать видимую Miro board и Obsidian vault без копирования ID и paths;
5. получить maximum export без ручной работы с JSON и local servers;
6. восстановиться после закрытого browser, неверной team, scope или занятого port;
7. найти готовый Canvas и понятный отчёт о полноте.

## Официальные материалы Miro

- [Создание Developer team](https://developers.miro.com/docs/create-a-developer-team)
- [REST API quickstart](https://developers.miro.com/docs/rest-api-build-your-first-hello-world-app)
- [Создание Web SDK app](https://developers.miro.com/docs/build-your-first-hello-world-app)
- [App manifest и scopes](https://developers.miro.com/docs/app-manifest)
- [Miro guided onboarding](https://developers.miro.com/docs/guided-onboarding)
