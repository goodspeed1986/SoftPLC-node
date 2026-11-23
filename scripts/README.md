# Скрипты кросс-компиляции тулчейна SoftPLC (`iec2c` + `tcc`)

Этот комплект автоматически скачивает исходные коды транслятора **MatIEC (`iec2c`)** и компилятора **TinyCC (`tcc`)** и собирает автономные статически слинкованные бинарники под все целевые платформы проекта:

* `linux-x64` — промышленные ПК и серверы x86_64
* `linux-arm64` — одноплатные компьютеры ARM64 (Raspberry Pi 4/5, Orange Pi, Repka Pi)
* `linux-arm` — контроллеры на базе ARMv7 (32-bit)
* `win32-x64` — промышленные станции под управлением Windows x64

---

## Вариант 1: Сборка в Docker (Рекомендуемый — 1 команда под все ОС)

Не требует установки кросс-компиляторов в основную систему. Соберет бинарники сразу для **Linux (x64, ARM64, ARMv7) и Windows (x64)**:

```bash
docker build -t softplc-builder .
mkdir -p bin
docker run --rm -v "$(pwd)/bin:/out" softplc-builder
```

---

## Вариант 2: Нативная сборка на Linux (Ubuntu / Debian)

1. Установите системные кросс-компиляторы:
   ```bash
   sudo apt update && sudo apt install -y build-essential git autoconf automake flex bison \
     gcc-aarch64-linux-gnu g++-aarch64-linux-gnu \
     gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf \
     mingw-w64
   ```
2. Запустите скрипт сборки (можно указать конкретные платформы или собрать все сразу):
   ```bash
   chmod +x build_toolchain.sh
   ./build_toolchain.sh
   # Или выборочно:
   # ./build_toolchain.sh linux-x64 linux-arm64
   ```

---

## Вариант 3: Нативная сборка на Windows (PowerShell + MSYS2)

1. Установите [MSYS2](https://www.msys2.org/) (или через `winget install -e --id MSYS2.MSYS2`).
2. Запустите скрипт в PowerShell:
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\build_toolchain.ps1
   ```
   Скрипт сам установит пакеты `mingw-w64-x86_64-toolchain`, `flex`, `bison` внутри MSYS2 и соберет `bin\win32-x64\iec2c.exe` и `tcc.exe`.

---

## Итоговая структура папки `bin/`

После выполнения любого из вариантов вы получите готовую директорию `bin/`, которую нужно скопировать в корень вашего Node.js проекта (`softplc-node-runtime`):

```text
bin/
├── matiec/
│   └── lib/             # Общие заголовочные файлы стандарта МЭК (iec_std_lib.h и др.)
├── linux-x64/
│   ├── iec2c
│   ├── tcc
│   └── tcc_runtime/     # Системные заголовки и crt-объекты TinyCC
├── linux-arm64/
│   ├── iec2c
│   ├── tcc
│   └── tcc_runtime/
├── linux-arm/
│   ├── iec2c
│   ├── tcc
│   └── tcc_runtime/
└── win32-x64/
    ├── iec2c.exe
    ├── tcc.exe
    └── tcc_runtime/
```

> **Примечание:** В `index.js` вашего Node.js приложения при вызове `tcc` передавайте флаг `-B ./bin/<platform>-<arch>/tcc_runtime/lib/tcc` (или `-I` / `-L` на папку `tcc_runtime`), чтобы `tcc` всегда находил свои встроенные заголовки (`stddef.h`, `stdarg.h`, `libtcc1.a`) независимо от того, в какую папку на контроллере развернуто приложение.

## CI (GitHub Actions)

Сборка всех платформ и публикация релизов — workflow в репозитории:

`.github/workflows/build-toolchain.yml`

- Кеш исходников MatIEC / TinyCC
- Артефакты: `softplc-toolchain-<platform>.zip` + `softplc-toolchain-all.zip`
- Release по тегу `v*` или `workflow_dispatch` с полем `release_tag`

Платформы: `linux-x64`, `linux-arm64`, `linux-arm`, `macos-arm64`, `win32-x64`.

