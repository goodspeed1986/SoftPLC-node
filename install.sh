#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> npm install"
npm install

PLATFORM="linux-x64"
case "$(uname -m)" in
  aarch64|arm64) PLATFORM="linux-arm64" ;;
  armv7l|arm)    PLATFORM="linux-arm" ;;
  x86_64|amd64)  PLATFORM="linux-x64" ;;
esac

if [ ! -f "bin/${PLATFORM}/iec2c" ] || [ ! -f "bin/${PLATFORM}/tcc" ]; then
  echo ""
  echo "Тулчейн для ${PLATFORM} не найден."
  if command -v docker >/dev/null 2>&1; then
    echo "Собираю через Docker..."
    docker build -t softplc-builder -f scripts/Dockerfile scripts
    mkdir -p bin
    docker run --rm -v "$(pwd)/bin:/out" softplc-builder
  else
    echo "Docker не найден. Соберите вручную:"
    echo "  sudo apt install -y build-essential git autoconf automake flex bison"
    echo "  bash scripts/build_toolchain.sh ${PLATFORM}"
    echo "Или: npm run build:toolchain:docker"
  fi
else
  echo "Тулчейн ${PLATFORM} уже на месте."
fi

echo ""
echo "Готово. Запуск: npm start"
echo "Web-IDE: http://localhost:3000"
