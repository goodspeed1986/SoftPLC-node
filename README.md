# SoftPLC Runtime v1.7 — IEC 61131-3 Soft PLC

Программный ПЛК на Node.js с Web-IDE, **Online Change** (правка логики без остановки процесса), Live-отладкой и Modbus TCP.

## Возможности

| Функция | Описание |
|---------|----------|
| **Языки МЭК 61131-3** | ST, SFC, FBD, IL, LD |
| **POU** | PROGRAM, FUNCTION_BLOCK, FUNCTION |
| **Online Change** | Hot-swap при неизменной раскладке памяти или миграция состояния |
| **Live Debugger** | Force/Unforce переменных, телеметрия цикла, overrun |
| **RETAIN** | Автосохранение энергонезависимых переменных на диск |
| **Modbus TCP** | Порт 5020 + встроенный симулятор объекта |
| **Multi-project** | Несколько проектов, ZIP import/export |
| **Web-IDE** | Редактор, дерево POU, привязка TASK↔PROGRAM |

## Быстрый старт

### 1. Установка Node-зависимостей

```bash
cd SoftPLC
npm install
```

### 2. Сборка тулчейна (iec2c + tcc)

Нужны бинарники MatIEC и TinyCC. Три варианта:

**A. Docker (рекомендуется — все платформы):**
```bash
npm run build:toolchain:docker
# или вручную:
docker build -t softplc-builder -f scripts/Dockerfile scripts
mkdir -p bin
docker run --rm -v "$(pwd)/bin:/out" softplc-builder
```

**B. Нативно на Linux (только текущая платформа):**
```bash
sudo apt update && sudo apt install -y build-essential git autoconf automake flex bison
# для кросс-сборки ARM/Windows дополнительно:
#   gcc-aarch64-linux-gnu g++-aarch64-linux-gnu
#   gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf mingw-w64
npm run build:toolchain:linux-x64   # или: bash scripts/build_toolchain.sh
```

**C. Windows (PowerShell + MSYS2):**
```powershell
.\scripts\build_toolchain.ps1
```

Итоговая структура:
```
bin/
├── matiec/lib/          # заголовки МЭК
├── linux-x64/
│   ├── iec2c
│   ├── tcc
│   └── tcc_runtime/
├── linux-arm64/ ...
├── linux-arm/ ...
└── win32-x64/ ...
```

### 3. Запуск

```bash
npm start
# Web-IDE:  http://localhost:3000
# Modbus:   TCP :5020
```

Порт можно задать: `PORT=8080 npm start`


## GitHub Actions / Releases

Workflow [`.github/workflows/build-toolchain.yml`](.github/workflows/build-toolchain.yml) builds **iec2c** + **tcc** for:

| Artifact | Runner |
|----------|--------|
| `softplc-toolchain-linux-x64.zip` | `ubuntu-24.04` |
| `softplc-toolchain-linux-arm64.zip` | `ubuntu-24.04-arm` |
| `softplc-toolchain-linux-arm.zip` | cross from `ubuntu-24.04` |
| `softplc-toolchain-macos-arm64.zip` | `macos-14` |
| `softplc-toolchain-win32-x64.zip` | `windows-2022` + MSYS2 |
| `softplc-toolchain-all.zip` | combined |

**Caching:** MatIEC and TinyCC git sources are cached (`actions/cache`) across runs (`CACHE_VERSION` in the workflow).

**Release:**
```bash
git tag v1.7.1
git push origin v1.7.1
```
Or **Actions → Build Toolchain → Run workflow** and set `release_tag` (e.g. `v1.7.1`).

Download the matching zip from the [Releases](../../releases) page and extract into the project root so that `bin/<platform>/` and `bin/matiec/lib/` appear.

## Online Change (правка без остановки)

1. Откройте Web-IDE → выберите файл программы
2. Измените логику (ST / JSON-модель SFC/FBD)
3. Нажмите **▶ Compile & Online Change**

Сервер вызывает `engine.onlineUpdate()`:

- **hot_swap_zero_downtime** — раскладка памяти не изменилась: pause → unload old lib → load new → resume с тем же tick
- **state_migrated** — изменились переменные: перенос значений outputs → новый SharedArrayBuffer
- **cold_start** — ПЛК ещё не был запущен

Процесс Node.js и цикл ПЛК **не останавливаются**. RETAIN-переменные сохраняются.

## Web-IDE

- Дерево POU (PROGRAM / FB / FUNCTION / CONFIG)
- Создание POU, привязка к TASK (только PROGRAM)
- Live-таблица переменных + FORCE
- Телеметрия: cycle time, max scan, overrun, jitter
- Симулятор стенда (уровень, температура, кнопки Start/Stop/Fault)
- Multi-project + ZIP

## API (кратко)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/projects` | Список проектов |
| POST | `/api/projects/create` | Создать проект |
| POST | `/api/projects/select` | Переключить проект |
| GET/POST/DELETE | `/api/files` | Файлы исходников |
| POST | `/api/compile` | **Compile & Online Change** |
| POST | `/api/force` | Force/Unforce переменной |
| POST | `/api/plant` | Управление симулятором |
| WS | `/` | Live telemetry (~20 Гц) |

## Демо-проекты

- **pump_station** — насосная с гистерезисом, SFC-циклом, FBD, RETAIN-счётчиками
- **conveyor_demo** — простой конвейер Start/Stop/Fault

## Архитектура

```
Web-IDE ──HTTP/WS──► server.js ──► SoftPlcEngine
                                      │
                   ST/SFC/FBD/IL/LD ──┤
                                      ▼
                                   bundler.js  → bundle.st
                                      ▼
                                   iec2c (MatIEC) → Config0.c, Res0.c, VARIABLES.csv
                                      ▼
                                   codegen.js → plc_runtime.c (SharedArrayBuffer bridge)
                                      ▼
                                   tcc → plc_logic_vN.so / .dll
                                      ▼
                                   koffi load → C realtime thread
                                      │
                                      ▼
                              Modbus TCP :5020 + plant simulator
```

## Требования

- Node.js ≥ 18
- Тулчейн (см. выше)
- Linux / Windows x64 (ARM64 / ARMv7 — после кросс-сборки)

## Лицензия

MIT
