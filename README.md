# pi-core

Личные расширения pi. Код сторонних инструментов копируется сюда с лицензией и
проверенным исходным коммитом; это наши версии, а не автоматически обновляемые
npm/git-зависимости. Для новых agent-features нужен **pi >= 1.3.0**.

## Новые расширения

### `extensions/background-jobs`

- `background_job`: start/status/stop фоновой команды; завершение доставляется
  событием в создавшую её активную сессию, без polling модели.
- `monitor`: stdout команды превращается в сообщения (batch 200 ms, максимум
  30 сообщений/минуту, затем остановка). Stderr остаётся в логе.
- `watch_path`: события файла/директории; для файла отслеживается родительская
  директория, чтобы переживать atomic save. По умолчанию без рекурсии;
  максимум 10 сообщений/минуту. По умолчанию watch живёт 5 минут, максимум 30.
- `/jobs`: список процессов и файловых watchers, остановка выбранного.

Фоновые shell-команды проходят **ту же session-only/global permission-политику**,
что и bash: запрос через внутренний event bus к `permission`. Если расширение
permission не активно, обычные команды разрешаются, а intrinsically dangerous
команды блокируются по AST; без permission-слоя это последняя защита.
Используется настроенный shell; `shellCommandPrefix` берётся с учётом project trust
и тоже входит в проверяемую команду. Это не OS sandbox.

Логи и JSON-записи — `0600`, директории владельцев — `0700`. Общий предел stdout
и stderr — **8 MiB на запуск**; лишний вывод продолжает вычитываться, но
отбрасывается. Старые завершённые записи удаляются через 30 дней. Вывод перед
передачей модели очищается от terminal controls, цитируется и обозначается как
недоверенные данные. Это уменьшает риск prompt injection, но не устраняет его.

Процессы принадлежат pi-процессу: `/reload` сохраняет jobs и shell-мониторы,
выход из pi останавливает их. При смене сессии shell-мониторы останавливаются,
обычные jobs продолжают работать, но не будят другую сессию. Результат
неактивной сессии остаётся в записи job. Файловые watchers останавливаются
при смене сессии, reload и выходе. Демоны, которым надо переживать pi,
запускайте через systemd/tmux. Stop не достигает процессов, покинувших свою
process group (например, через setsid). Поддержка jobs — Unix.

### `extensions/btw`

`/btw <вопрос>` отправляет **снимок последнего фактического запроса** основной
сессии плюс вопрос в конце. System prompt, tool declarations, tool choice,
модель и параметры кеша сохраняются. Результаты ещё выполняющихся инструментов
в этот снимок не входят.

- Основная история не меняется; ответ показывается временным widget.
- Инструменты side-ответа никогда не выполняются, даже если модель их запросила.
- `/btw cancel` отменяет запрос; смена сессии/ветки, compaction и shutdown тоже.
- Deadline — 90 секунд. Одновременно один side-запрос.
- Стоимость показывается отдельно в статусе `btw`; не добавляется в штатные
  session totals и не сохраняется после reload.
- Codex WebSocket использует отдельный SSE side-запрос, не меняя continuation
  основной WebSocket-сессии.

**Cache hits не гарантированы:** локальные тесты проверяют payload и отсутствие
изменений основного запроса, а не поведение реального провайдера. Измеряйте
cached input и стоимость на своей модели. Динамические `before_provider_headers`
и некоторые host attribution headers не копируются; credentials host разрешает
заново. Совместимость дополнительных provider extensions проверяется отдельно.

## Дополнительные расширения

### RTK rewrite (`rtk`)

Перед выполнением bash-команды расширение спрашивает `rtk rewrite` и, если
переписывание безопасно, подменяет команду на компактный эквивалент. Это
уменьшает токены, которые модель тратит на `git status`, `cargo test`, `rg`,
`find`, `kubectl`, `docker` и подобные команды.

- Работает только для `bash` и `!`-команд пользователя; вызовы `bash` из
  `codemode` не переписываются, чтобы скрипт получил именно тот вывод, который
  запросил.
- `rtk` должен быть в `PATH` и иметь версию >= 0.23.0; версия проверяется один
  раз за сессию. Если бинарника нет, всё работает как раньше, а `/rtk status`
  показывает причину.
- Не переписываются compound-команды (`&&`, `|`, `;`, redirects), inline-скрипты
  (`node -e`, `bash -c`, `python -c`, ...), `find` с `-exec`/`-delete`/`-print0`
  и другими несовместимыми предикатами, а также уже запущенные `rtk ...`.
- `RTK_DISABLED=1` выключает переписывание для одной команды (или на сессию),
  `RTK_DISABLE_REWRITE=1` — то же для одной команды; `/rtk on|off|status`
  управляет сессией. Статус в футере показывается только когда rewrite выключен
  или RTK недоступен.
- Это fail-open шим, а не слой прав: permission/AST по-прежнему видит уже
  переписанную команду. Сжатие произвольного вывода инструментов (output
  compaction) не включено — им занимается `bash-head-tail` и штатные лимиты pi.

### Частичный вывод (`partial-output`)

Pi уже сохраняет tail stdout/stderr bash при отмене и timeout. Расширение не
заменяет исполнителя: помечает такой результат `partial`, сохраняет текст ошибки
и возвращает структурированные данные для codemode с кодом 130/124. Это не
обещание восстановить вывод произвольного MCP-инструмента, который сам его
выбросил. Выполненные до отмены действия не откатываются.

### Начало и конец длинного вывода (`bash-head-tail`)

Когда bash-вывод обрезан до хвоста, расширение дочитывает начало полного лога
(до 80 строк/12 KiB) и добавляет его перед хвостом с маркером
`[... middle omitted; full output: …]`. Так ошибки в начале сборки и итог в конце
оба попадают к модели. Полный лог не загружается в память целиком.

### `index` — скелет файла

Инструмент `index` возвращает компактную карту файла: imports, классы, функции,
методы, типы и диапазоны строк. Сначала пробует **LSP documentSymbols** и берёт
точные диапазоны; если язык-сервер недоступен, использует **tree-sitter** для
C, C++, C#, Scala, Zig и Elixir; последний fallback — regex-парсер.
Используется **до** `read`, чтобы читать только нужные куски. LSP/regex
покрывают TS/JS, Python, Go, Rust, Java, Kotlin, Ruby, PHP, Lua, shell; для
незнакомого языка инструмент честно говорит, что символы не распознаны. В
выводе видно `lsp`, `tree-sitter` или `regex` — источник скелета.

### Телеметрия кеша (`cache-guard`)

`/cache` показывает последние 10 ходов текущей сессии: prompt, hit%, cost,
output. Холодный ход отмечается `COLD`, если prompt ≥ 4k, hit < 50% и hit упал
на ≥ 35% относительно предыдущего хода. Перед/после compaction приходят
уведомления о сбросе prompt cache. `/cache clear` очищает историю.

### Долговременная память (`memory`)

Локальные заметки между сессиями: `memory` tool и `/memory`.
Формат **как у Claude Code**: каталог проекта `~/.pi/agent/memory/projects/<slug>/`,
каждая память — Markdown с YAML-frontmatter (`name`, `description`,
`metadata.type`, `modified`), плюс `MEMORY.md` с индексом ссылок. Скоупы
`project` (slug из cwd, как Claude: `/home/me/repo` → `-home-me-repo`) и
`global`; `PI_MEMORY_DIR` переопределяет корень, права `0600`. На старте хода
релевантные заметки (до 5) попадают в отдельную секцию system prompt
как **данные, не инструкции**; нерелевантные не инжектятся.

При старте сессии и по `/memory import claude` расширение читает
`~/.claude/projects/<slug>/memory/*.md` (или `CLAUDE_CONFIG_DIR`) и импортирует
их с дедупликацией. Текущая память dotfiles уже перенесена.

**Auto-memory:** после `agent_settled` последнее пользовательское сообщение
проверяется на явные просьбы («remember…», «запомни…», «from now on…»,
«always use…») и сохраняется как feedback с дедупликацией. Это эвристика без
вызова модели; `/memory auto on|off|status`, `PI_MEMORY_AUTO=0` выключает.

**Jev recall:** если доступен classifier (`openrouter/typesafe/jev-1.13` и
родственные), перед ходом в Jev уходят только `description/type/tags`
кандидатов, без тел. Локальный кеш решений (`jev-cache.json`, TTL 1 час)
хранит выбранные id; при изменении памяти очищается. Тела выбранных top-5
попадают в system prompt. При ошибке/таймауте/открытом circuit breaker —
keyword fallback. `/memory jev on|off|status|clear-cache`, `PI_MEMORY_JEV=0`
выключает. 500 записей с summary-префильтром стоят порядка $0.1–1/мес.
Хранить секреты запрещено правилами инструмента.

### Уведомления (`notify`)

После `agent_settled` (когда pi действительно ждёт ввода, а не после каждого
низкоуровневого retry) отправляется OSC 99 в Kitty или OSC 777 в остальных
терминалах. Отдельные уведомления приходят перед `question` и перед запросом
прав (permission), через общий needs-input bus. `/notify on|off|status`;
`PI_NOTIFY=0` выключает. Это полезно, когда агент работает в соседней вкладке
tmux.

### AST permissions (`permission/shell-ast.ts`)

Каждая shell-команда разбирается Tree-sitter Bash: pipelines, условия, функции,
подстановки, heredoc и вложенные `bash -c`. Allow-паттерны применяются отдельно
к командам, а не ко всей строке с безопасным началом. Неизвестная/динамическая
конструкция, ошибки разбора и потенциально опасные wrappers требуют явного
подтверждения (в headless блокируются, кроме сознательного `bypassed`).

Уровень **`yolo`** авто-подтверждает обычные команды, записи и правки, но
оставляет prompt/block для «совсем опасных»: `sudo`, `rm -rf`, `dd`, `mkfs`,
`git push --force`, `git reset --hard`, `git clean -f`, `kubectl delete/drain`,
`helm uninstall`, `terraform destroy`, `curl … | sh`, публикации пакетов.
`bypassed` по-прежнему отключает все проверки. YOLO не отключает AST: команды
из codemode, фоновых jobs и background shell проходят тот же `tool_call` /
permission gate.

Консервативный разбор может спрашивать подтверждение чаще прежнего. Он не
доказывает безопасность запускаемых программ или скриптов и не заменяет sandbox.
WASM-грамматика лежит в `vendor/`, native build/install scripts не нужны.

### Изображения (`image-preview`)

- Миниатюры локальных PNG/JPEG/GIF/WebP в черновике, включая вставленные из clipboard.
- При вставке картинки в черновик попадает короткий маркер `🖼1`, а не длинный
  `/tmp/pi-clipboard-….png`: при отправке расширение читает файл и прикладывает
  его как image content, а маркер из текста убирает. Картинку видно в сообщении,
  путь в инпут не лезет; маркер удаляется парой backspace.
- **Alt+I** / `/images` — галерея, стрелки переключают картинки; `o` (или Enter
  без inline-режима) открывает выбранную картинку в отдельном окне Kitty,
  `d` удаляет вложение из черновика, Esc закрывает просмотр.
- Последние изображения из tool results тоже доступны в галерее.
- UI-превью не добавляет картинку в историю повторно, не меняет исходный файл
  и никогда не скачивает URLs. Обычно используются уменьшенные копии.
- До 3 превью черновика, 8 недавних tool images; файлы до 8 MiB/40 MP.
- **Внутри tmux** (Kitty, RGB, `allow-passthrough on`) картинки рисуются через
  Kitty Unicode placeholders, как в jcode: PNG передаётся виртуальным placement
  в DCS-passthrough, а в ячейки пишутся `U+10EEEE` с диакритиками строк/столбцов.
  Это обычный текст, поэтому tmux его не ломает. В `.tmux.conf` добавлено
  `set -g allow-passthrough on`.
- Без Kitty/tmux-passthrough — текстовый fallback, а `o` открывает картинку
  в отдельном окне Kitty через `kitty +kitten icat` (вне Kitty — `xdg-open`).
- Существующий чужой custom editor не заменяется: тогда доступна только галерея
  tool images. JPEG/WebP конвертирует штатный transcoder pi; placeholders
  используются только для PNG (остальное — external fallback).

### Изменение прочитанного файла (`read-watch`)

После успешного `read` сохраняется fingerprint, а директория файла отслеживается
через OS events. Изменения/удаление/atomic save помечают старое чтение устаревшим.
`edit`/`write` такого файла блокируется до повторного чтения. Собственные успешные
edit/write обновляют baseline; записи `propose_change` после accept тоже
считаются своими. На небольших файлах сравнивается SHA-256, свыше
4 MiB — stat metadata. Максимум 256 последних файлов.

Fingerprints сохраняются custom entries **вне model context** и восстанавливаются
по активной ветке. Уведомления объединяются и не запускают inference в простое.
Автор изменения неизвестен: это может быть другой агент, редактор или наш bash.
Изменения через bash не считаются автоматически «своими». Это не file lock и
не полноценный swarm; гонка между проверкой и записью полностью не устраняется.
`/read-watch`, `/read-watch off|on` управляют механизмом. Удалённые или
переименованные файлы не спамят при каждом restore: отсутствующие записи
пропускаются, а удаление в живой сессии предупреждается один раз.

### Checkpoints / rewind (`checkpoint`)

Перед `edit`/`write`/`propose_change` расширение запоминает **исходное содержимое**
файла и после успешной правки складывает его в content-addressed gzip-blob.
Один снимок на файл за ход; rejected/failed tool ничего не пишет.

- `/checkpoint list` — список снимков; `/checkpoint restore <n|id>` — откатить код;
  `/rewind` — откатить код и перейти по ветке чата через `ctx.navigateTree()`;
  `/checkpoint off|on` — выключить/включить.
- Инструмент `checkpoint` доступен и агенту: `list` и `restore`. Restore
  **всегда требует подтверждения пользователя**; агент не может молча откатить
  файлы и не должен вызывать его без явной просьбы.
- Перед restore создаётся **safety checkpoint** текущего состояния, так что
  восстановление можно отменить повторным restore.
- При обычном `/fork`/`/tree` хук `session_before_fork` предлагает восстановить
  код к точке форка.
- Хранилище: `~/.pi/agent/checkpoints/` (`PI_CHECKPOINT_DIR`), gzip level 1,
  `0600`, TTL 14 дней, общий лимит 256 МиБ, файл до 2 МиБ, без `fsync`.
  Исключены `.git`, `node_modules`, `target`, `dist`, `build`, `.venv`,
  `vendor`, `__pycache__`.
- Ограничение: снимки покрывают только инструменты `edit`/`write`/
  `propose_change`. Изменения через `bash`, MCP, внешний редактор или другую
  сессию не откатываются. Это не замена git.

### Прогрев prompt cache (`cache-warming`)

`cacheWarming: "idle"` в настройках включает поддержание кеша между ходами.
Расширение ограничивает его, чтобы не греть кеш круглосуточно:

- только пока с последней активности прошло ≤ 30 минут
  (`PI_CACHE_WARM_IDLE_MINUTES`);
- бюджет на одно idle-окно ≤ $0.05 (`PI_CACHE_WARM_IDLE_BUDGET`);
- только если ожидаемая экономия ≥ $0.005 (`PI_CACHE_WARM_MIN_SAVINGS`);
- во время активного run решение оставляется pi;
- после `agent_settled` бюджет и окно начинаются заново; после лимита warming
  останавливается до следующего реального запроса.

Плюс нужен `promptCache` для модели в `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "deepseek": {
      "modelOverrides": {
        "deepseek-flash": { "promptCache": { "short": 300 } }
      }
    }
  }
}
```

Без этого pi не считает модель eligible для warming. `/warming status|on|off`
показывает политику и потраченный бюджет.

### Диктовка (`voice`)

**Alt+M** / `/voice`: первое нажатие записывает, второе останавливает и
распознаёт; **Alt+U** / `/voice mute` — мьют; **Esc** / `/voice cancel` — отмена.
Текст вставляется в текущий черновик, не стирая набранное; Enter всегда нажимает
пользователь. Автозапуска микрофона, TTS и скачивания бинарников нет.

UI: над редактором появляется компактная панель из трёх строк — состояние и
таймер, индикатор уровня с живым частичным текстом, подсказки клавиш. В футере
остаётся только `🎙 0:12` или `🔇 muted`. Длинный живой текст переносится на несколько строк и показывает хвост, а не обрезается по краю.
При мьюте иконка меняется на 🔇,
метр гаснет, подсказка становится `unmute`, а захваченный звук **отбрасывается**,
а не буферизуется: после unmute в API не уйдёт то, что говорилось при мьюте.
Пункт меню `/voice` содержит `mute`, поэтому автокомплит подсказывает его первым.

Идея компактного индикатора и states (idle/recording/transcribing) сверена с
`oh-my-pi` (OMP): там микрофон рисуется прямо вместо курсора и переливается
цветом, серый при распознавании. В pi у расширения нет API подмены курсора,
поэтому взяли панель + футер, а не копировали код. Push-to-talk и
auto-submit-триггеры OMP пока не переносили.

Два бэкенда:

- **local** (по умолчанию) — `pw-record` + `whisper-cli` + локальная multilingual
  GGML-модель. Аудио не покидает машину.
- **nari** — потоковый STT по WebSocket, тот же протокол, что в jcode: живой
  частичный текст, commit по остановке, агрегация нескольких utterances.
  Включается только явно: `/voice api nari`. Аудио уходит на
  `api.narilabs.com`; локально не пишется, в лог не попадает. Ключ — только из
  env-переменной (`NARI_API_KEY` по умолчанию), не из файла.

```
/voice api nari        # потоковый API (audio leaves the machine)
/voice api local       # обратно на whisper.cpp
/voice status          # backend, endpoint, key set/missing, language, model
/voice language ru     # для Nari: auto опускает language в session.configure
/voice model /path/ggml-large-v3-turbo.bin
```

API-режим требует уже установленный `pw-record`; whisper.cpp и модель не нужны.
Без ключа запись не начинается. Стоимость показывается приблизительно
(~$0.12/час аудио по прайсу Nari, не биллинг). Таймаут финализации — 20 с,
запись — до 5 минут. 16 kHz mono PCM16 в памяти, без временных WAV в API-режиме.
На SSH/remote pi используется микрофон машины, где запущен процесс.

Автокомплит аргументов работает: `/voice <Tab>`, `/voice api <Tab>`,
`/voice language <Tab>`; также у `/read-watch`, `/permission`,
`/permission-mode`, `/btw cancel`, `/images`, `/jobs`.

Тесты используют имитации recorder/STT и локальный WebSocket-сервер; реальные
качество распознавания и Nari-биллинг не проверяются. Streaming transcript
появляется в строке статуса, но финальный текст вставляется после остановки.

### Список задач (`todo`)

Инструмент `todo_write` + панель над редактором, по мотивам Maki и rpiv-todo:

- модель присылает **полный список** каждый раз (replace-all), пустой список очищает;
- статусы `pending / in_progress / completed / cancelled`, для активной задачи можно
  задать `activeForm` («wiring CLI»);
- панель `Todos (done/total)` с глифами, активной задачей и обрезкой по бюджету
  строк (сначала прячутся completed, затем хвост, с подписью `+N more`);
- `ctrl+shift+t` / `/todos collapse|expand` сворачивает панель, `/todos` печатает
  список, `/todos clear` очищает;
- если после `agent_end` все задачи `completed`/`cancelled`, панель остаётся до
  следующего **пользовательского** сообщения и затем очищается сама (служебные
  `triggerTurn`-сообщения её не трогают); незавершённые задачи переживают ход;
- снимок каждого изменения пишется в custom entry (`pi-core:todo`), поэтому
  состояние переживает `/reload`, `/resume`, `/tree` и compaction; фолбэк —
  `details` последнего `todo_write`; в модель custom entries не попадают;
- состояние привязано к session id: параллельные сессии не перетирают друг друга.

Инструмент не заменяет plan mode: это видимый чеклист, а не блокирующий гейт.

### Вопросы пользователю (`question`)

Инструмент `question` — аналог Maki `question`, адаптация официального
`questionnaire.ts` из pi:

- 1–4 вопроса в одном диалоге с табами и Submit;
- варианты с описаниями, recommended первым; всегда есть «Type your own answer»;
- `multiSelect`: Space переключает/открывает свободный ответ, Enter подтверждает;
- ответы возвращаются массивами строк и лежат в `details`;
- Esc закрывает всё → модель получает `(question dismissed by user)`;
- в non-TUI режиме инструмент возвращает ошибку с просьбой спросить текстом;
- один tool-вызов блокирует ход до ответа — это осознанное прерывание, не чат.

Ограничения: до 4 вопросов и 8 вариантов, тексты санитизируются (ANSI/control
удаляются, пробелы схлопываются); ответы не пишутся отдельным custom entry,
поэтому вызов из codemode не оставит карточку в транскрипте.

### Тур по изменениям в Neovim (`nvim`)

Когда правок много, модель проходит по ним в открытом Neovim, а не вываливает
diff в чат:

```
/tour overview [paths]  # один снапшот всех изменений в Neovim
/tour start [paths]     # пройти стопы по одному
/tour next | prev | status | stop
```

Инструмент `review_tour` делает то же для модели
(`action=overview|start|next|prev|status|stop`). `overview` открывает scratch-буфер
с базой, diffstat и списком стопов — весь снапшот работы на одном экране.
`start` водит по hunk'ам.
Каждый стоп — hunk из `git diff --unified=0` с контекстом (по умолчанию 6 строк,
до 60 строк), соседние hunks сливаются, всего до 40 стопов; untracked-файлы
показываются первыми 40 строками. Neovim открывает файл и показывает изменение
**как diff**, а не серым блоком: добавленные строки подсвечиваются `DiffAdd`,
удалённые выводятся виртуальными строками `DiffDelete` (`- текст`, до 20 строк,
дальше «… N more removed»). Это только extmarks: текст буфера не меняется,
`diffthis` не включается, поэтому LSP-диагностики, signs и inlay hints остаются
на своих местах. В ответ модели уходит только текущий фрагмент и прогресс
`Tour 3/12`, а на последнем стопе — указание спросить пользователя через
инструмент `question` («всё ок / что поправить»).

Мост **один**: `extensions/nvim` (`client.lua` + `bridge.lua`) не зависит от
duet и обслуживает всё — тур, комментарии, `propose_change`, `show`,
`selection`, `nvim_context`, live-follow и `/nvim status|save`. Старое расширение
`duet/pi/editor.ts` с командой `/nvim-status` из конфига убрано. Клиент
подключается к сокету `nvim --listen`, выполняет bridge внутри Neovim и
поддерживает `status`/`show`/`snapshot`. Сокет ищется в `PI_NVIM_SOCKET`,
`DUET_NVIM_SOCKET`, затем `NVIM_LISTEN_ADDRESS`.

Если ничего не подключено и Pi запущен **внутри tmux**, тур сам открывает Neovim
в новом окне `pi-review` (`tmux new-window`) со свежим `--listen`-сокетом и
запоминает его в `PI_NVIM_SOCKET`. `PI_NVIM_AUTO_OPEN=0` это выключает; вне tmux
автооткрытие не делается — команда попросит поднять Neovim вручную.

```sh
nvim --listen /tmp/nvim.sock
export PI_NVIM_SOCKET=/tmp/nvim.sock
```

Главный сценарий — **не спрашивать про каждый hunk**, а после пласта работы открыть
`overview`, дать пользователю увидеть весь снапшот и один раз спросить через
`question` про архитектуру и выбранное направление. Именно это и прописано в
guidelines инструмента.

Навигация живёт **в Neovim**: после установки тура доступны `]t` / `[t`
(следующий/предыдущий стоп) и `<leader>pc` — комментарий к строке или выделению.
`]t`/`[t` **перетирают дефолтные tag-jumps Neovim** (иначе они не работают);
если тур не установлен, нажатие скажет об этом. `<leader>pc` ставится только если
клавиша свободна — чужой маппинг не ломается. `review_tour next|prev` сначала спрашивает
у Neovim текущую позицию, поэтому ручная навигация и команды агента не расходятся.

**Live-follow.** После успешного `edit`/`write`/`propose_change` Neovim сам
переходит к изменённому диапазону (добавленная строка подсвечена `DiffAdd`).
Работает только когда Neovim подключён и тур не запущен; быстрые правки
склеиваются. Включено по умолчанию, `/tour live off` или `PI_NVIM_LIVE=0`
выключает, `/tour live on` — обратно. Это не `:diffthis` и не меняет буфер.

**Авто-подсказка ревью.** На `agent_end`, если в рабочем дереве ≥3 файлов или
≥80 изменённых строк, pi один раз (не чаще раза в 10 минут для того же набора)
показывает уведомление и кладёт в следующую очередь сообщение: открыть
`review_tour overview` и задать один вопрос про архитектуру через `question`.
Это подсказка, а не принудительный запуск тура.

**Комментарии как в jcode, но для pi.** На каждом `session_start` расширение
поднимает локальный Unix-сокет `pi-nvim-<pid>-<session>.sock` (0600) и передаёт
его в Neovim при установке моста. `<leader>pc` спрашивает текст, ставит extmark и
отправляет `{id, file, from, to, text}` в pi; расширение проверяет, что файл
внутри проекта, и доставляет комментарий как пользовательское сообщение
(`sendMessage`, `deliverAs: "steer"`).

Треды **двусторонние**: агент отвечает инструментом `comment_reply` (id, текст,
`resolve`), ответ появляется под комментарием в Neovim вместе со статусом
`open → answered → resolved`. В Neovim: `<leader>pl` — список и переход к
комментарию, `<leader>pr` — resolved для комментария под курсором; неотвеченные
и отвеченные видны в `nvim_context`. Комментарии и ответы живут в состоянии моста
(`_G.pi_ide_bridge_state`), переживают hot-reload и повторно рисуются при
открытии буфера. Мост перезагружается по mtime, поэтому правки `bridge.lua`
подхватываются без перезапуска Neovim.

#### Diff с accept/reject (`propose_change`)

Инструмент `propose_change` открывает нативный diff: оригинал слева, предложенное
содержимое справа. Пользователь может править правую сторону, `:w` — принять,
`:q` — отклонить. Pi ждёт решения (до 10 минут), при accept пишет **принятое**
содержимое (включая правки пользователя), при reject ничего не трогает. Буферы
помечены `acwrite`/`b:pi_diff_id`, чтобы автосейв-плагины не «принимали» diff
случайно. `:w` в proposed-буфере не пишет файл сам — это делает pi после accept.

#### Dirty-буферы

Если Neovim подключён, `edit`/`write` блокируются, когда буфер файла грязный:
сообщение просит сохранить его или использовать `propose_change`. `/nvim save
[file]` сохраняет буфер; `/nvim status` показывает workspace, открытые буферы и
selection. Инструмент `nvim_context` отдаёт то же модели: cwd, editors
(`modified`), последнее выделение с флагом `stale`.

#### Discovery и токен

`nvim/pi-ide.lua` (добавь `dofile("/home/danil/w/pi-core/nvim/pi-ide.lua")` в
`init.lua`) поднимает server, пишет lock-файл с `socket`, `pid`,
`workspaceFolders`, `authToken` и обновляет его при `/cd`; lock удаляется на
выходе. Pi ищет lock в `PI_IDE_DIR`, `$XDG_RUNTIME_DIR/pi-ide`, `~/.pi/ide`,
`/tmp/pi-ide`, берёт самый свежий живой endpoint, чей workspace содержит cwd.
Приоритет: `PI_NVIM_SOCKET`/`DUET_NVIM_SOCKET`/`NVIM_LISTEN_ADDRESS`, затем lock.
Автооткрытие в tmux запускает Neovim с `pi-ide.lua`, поэтому lock появляется и
там. Токен проверяется, когда Neovim загрузил `pi-ide.lua`; для «ручного»
`--listen` без плагина токена нет и проверка пропускается (доступ к сокету уже
ограничен правами ОС).

Ограничения: нужен Neovim с сокетом; для показа диффа используются hunks
рабочего дерева относительно базы, а не side-by-side diff-режим; путь bridge
должен быть доступен процессу Neovim; binary/code-файлы больше лимитов
пропускаются; живой тест сделан на NVIM 0.11.6 (show/snapshot), но автотесты используют
поддельные RPC/tmux-бинарники; live-follow после edit/write и авто-подсказка
ревью проверяются отдельными тестами.

## Подключение для разработки

Чтобы не загружать старые копии одноимённых расширений, подключайте только нужные
локальные entry points, исключив прежний permission из другого пакета:

```json
{
  "extensions": [
    "/home/danil/w/pi-core/extensions/permission/index.ts",
    "/home/danil/w/pi-core/extensions/background-jobs/index.ts",
    "/home/danil/w/pi-core/extensions/btw/index.ts",
    "/home/danil/w/pi-core/extensions/partial-output/index.ts",
    "/home/danil/w/pi-core/extensions/read-watch/index.ts",
    "/home/danil/w/pi-core/extensions/image-preview/index.ts",
    "/home/danil/w/pi-core/extensions/voice/index.ts",
    "/home/danil/w/pi-core/extensions/todo/index.ts",
    "/home/danil/w/pi-core/extensions/question/index.ts",
    "/home/danil/w/pi-core/extensions/nvim/index.ts",
    "/home/danil/w/pi-core/extensions/index/index.ts",
    "/home/danil/w/pi-core/extensions/memory/index.ts",
    "/home/danil/w/pi-core/extensions/notify/index.ts",
    "/home/danil/w/pi-core/extensions/bash-head-tail/index.ts",
    "/home/danil/w/pi-core/extensions/checkpoint/index.ts",
    "/home/danil/w/pi-core/extensions/cache-warming/index.ts",
    "/home/danil/w/pi-core/extensions/cache-guard/index.ts",
    "/home/danil/w/pi-core/extensions/rtk/index.ts"
  ]}
```

Проверяйте runtime-зависимости через `npm ci --ignore-scripts --omit=dev
--legacy-peer-deps`; Pi SDK предоставляется host-процессом. `/reload` применяет
изменения. Не устанавливайте параллельно upstream pi-background-job или
pi-btw-cached — будут конфликтовать имена tools/commands.

## Тесты

С dev dependencies: `npm ci --ignore-scripts`, затем `npm run test:agent-features`
и `npm run typecheck:agent-features`.
Или используйте уже установленную pi без второй копии SDK:

```sh
PI_OFFLINE=1 \
PI_TEST_NODE_MODULES="$HOME/.pi/agent/install/releases/1.3.0/node_modules" \
npm run test:agent-features
```

Тесты используют временные директории, собственные subprocess groups и локальные
HTTP/WebSocket имитации API. Реальные модели, микрофон и API-ключи не используются.
Проверяются permission/session state, stop/cleanup, bounded logs, atomic saves,
отмена `/btw`, replay запросов, codemode, cache warming и Codex WebSocket;
отдельно — AST-shell, частичный вывод, read-watch, изображения, voice,
todo, question, tour (diff/dirty/context/discovery), index, memory, notify,
bash-head-tail, checkpoint/rewind, cache-warming, cache-guard, RTK rewrite,
LSP/tree-sitter index, Claude-совместимая память (импорт, Markdown/frontmatter,
auto-recall, auto-memory, Jev+локальный кеш) и needs-input уведомления.

## Что пока не перенесено

Subagents с изолированным контекстом, plan mode, откат изменений через
`bash`/MCP (checkpoints сейчас только для `edit`/`write`/`propose_change`),
полноценная межагентная координация (swarm) и hold-to-talk диктовка —
следующие задачи. `index`, память и checkpoints уже здесь; swarm пока не добавляем.

Происхождение vendored-кода и лицензии: [THIRD_PARTY.md](THIRD_PARTY.md).
