<#
.SYNOPSIS
    Скрипт автоматической сборки нативных бинарников MatIEC (iec2c.exe) и TinyCC (tcc.exe)
    под Windows (win32-x64) с использованием MSYS2 (MinGW-w64).

.DESCRIPTION
    Запускается в PowerShell на Windows. Автоматически проверяет наличие MSYS2,
    устанавливает недостающие пакеты (mingw-w64-x86_64-gcc, flex, bison, git, make)
    и собирает автономные статически слинкованные iec2c.exe и tcc.exe.

.EXAMPLE
    .\build_toolchain.ps1
#>

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $ScriptDir "bin\win32-x64"
$MatiecLibDir = Join-Path $ScriptDir "bin\matiec\lib"

# Поиск установки MSYS2
$MsysPaths = @(
    "C:\msys64\usr\bin\bash.exe",
    "C:\msys32\usr\bin\bash.exe",
    "$env:USERPROFILE\msys64\usr\bin\bash.exe"
)

$MsysBash = $MsysPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $MsysBash) {
    Write-Host "[ОШИБКА] MSYS2 не найден!" -ForegroundColor Red
    Write-Host "Для сборки C/C++ проектов под Windows установите MSYS2:"
    Write-Host "  winget install -e --id MSYS2.MSYS2" -ForegroundColor Yellow
    Write-Host "После установки запустите этот скрипт повторно."
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Сборка SoftPLC Toolchain для Windows (win32-x64)" -ForegroundColor Cyan
Write-Host " Используется MSYS2: $MsysBash"
Write-Host "============================================================" -ForegroundColor Cyan

# Преобразуем Windows-путь в POSIX-путь для MSYS2
$PosixScriptDir = & $MsysBash -lc "cygpath -u '$ScriptDir'"

# Внутренний bash-скрипт для выполнения внутри окружения MINGW64
$InnerBuildCmd = @"
set -euo pipefail
export MSYSTEM=MINGW64
export PATH="/mingw64/bin:/usr/bin:\$PATH"

echo "[1/4] Проверка и установка пакетов сборки в MSYS2..."
pacman -S --needed --noconfirm git base-devel mingw-w64-x86_64-toolchain mingw-w64-x86_64-autotools flex bison >/dev/null

WORK_DIR="$PosixScriptDir/_build_win"
OUT_DIR="$PosixScriptDir/bin/win32-x64"
LIB_DIR="$PosixScriptDir/bin/matiec"

mkdir -p "\$WORK_DIR" "\$OUT_DIR" "\$LIB_DIR"

if [ ! -d "\$WORK_DIR/matiec_src" ]; then
    echo "[2/4] Клонирование MatIEC..."
    git clone --depth 1 https://github.com/sm1820/matiec.git "\$WORK_DIR/matiec_src"
fi

if [ ! -d "\$WORK_DIR/tinycc_src" ]; then
    echo "[3/4] Клонирование TinyCC..."
    git clone --depth 1 https://repo.or.cz/tinycc.git "\$WORK_DIR/tinycc_src"
fi

rm -rf "\$LIB_DIR/lib"
cp -r "\$WORK_DIR/matiec_src/lib" "\$LIB_DIR/lib"

echo "[4/4] Компиляция iec2c.exe и tcc.exe..."

# Сборка MatIEC (статическая линковка, чтобы не требовались внешние DLL MinGW)
rm -rf "\$WORK_DIR/matiec_build"
cp -r "\$WORK_DIR/matiec_src" "\$WORK_DIR/matiec_build"
cd "\$WORK_DIR/matiec_build"
autoreconf -i >/dev/null 2>&1
./configure CXXFLAGS="-O2" LDFLAGS="-static" >/dev/null
make -j"\$(nproc)" >/dev/null
cp iec2c.exe "\$OUT_DIR/iec2c.exe"
strip "\$OUT_DIR/iec2c.exe"

# Сборка TinyCC (64-bit Windows)
rm -rf "\$WORK_DIR/tcc_build" "\$OUT_DIR/tcc_runtime"
cp -r "\$WORK_DIR/tinycc_src" "\$WORK_DIR/tcc_build"
cd "\$WORK_DIR/tcc_build"
./configure --prefix="\$OUT_DIR/tcc_runtime" --os=windows --cpu=x86_64 --extra-cflags="-O2" >/dev/null
make -j"\$(nproc)" >/dev/null
make install >/dev/null
mv "\$OUT_DIR/tcc_runtime/tcc.exe" "\$OUT_DIR/tcc.exe" 2>/dev/null || mv "\$OUT_DIR/tcc_runtime/bin/tcc.exe" "\$OUT_DIR/tcc.exe"
strip "\$OUT_DIR/tcc.exe"

echo "Сборка завершена успешно!"
"@

# Запускаем сборку в MSYS2
$InnerBuildCmd = $InnerBuildCmd -replace "`r`n", "`n"
& $MsysBash -lc $InnerBuildCmd

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host " Готово! Бинарники сохранены в: $OutDir" -ForegroundColor Green
    Get-ChildItem $OutDir | Select-Object Name, Length | Format-Table -AutoSize
    Write-Host "============================================================" -ForegroundColor Green
} else {
    Write-Host "[ОШИБКА] Сборка завершилась с кодом $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}
