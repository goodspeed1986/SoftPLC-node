#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# SoftPLC toolchain builder: MatIEC (iec2c) + TinyCC (tcc)
#
# Targets:
#   linux-x64    — x86_64 GNU/Linux
#   linux-arm64  — aarch64 GNU/Linux (Pi 4/5, Orange Pi, …)
#   linux-arm    — armv7l GNU/Linux (industrial ARMv7)
#   macos-arm64  — Apple Silicon (M1/M2/M3/M4)
#   macos-x64    — Intel macOS
#   win32-x64    — Windows x64 (MinGW-w64 cross from Linux, or native via .ps1)
#
# Usage:
#   ./build_toolchain.sh                  # all default targets for this host
#   ./build_toolchain.sh linux-x64
#   ./build_toolchain.sh linux-x64 linux-arm64
#   OUT_DIR=./bin WORK_DIR=./_build ./build_toolchain.sh linux-x64
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow CI to override work/out dirs (e.g. under repo root)
WORK_DIR="${WORK_DIR:-${SCRIPT_DIR}/_build_work}"
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/bin}"

MATIEC_REPO="${MATIEC_REPO:-https://github.com/sm1820/matiec.git}"
TINYCC_REPO="${TINYCC_REPO:-https://repo.or.cz/tinycc.git}"
# Optional pinned refs (empty = default branch / depth-1 tip)
MATIEC_REF="${MATIEC_REF:-}"
TINYCC_REF="${TINYCC_REF:-}"

HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

if [ "$#" -eq 0 ]; then
    case "${HOST_OS}" in
        Linux)
            case "${HOST_ARCH}" in
                x86_64)  TARGETS=("linux-x64") ;;
                aarch64|arm64) TARGETS=("linux-arm64") ;;
                armv7l|arm) TARGETS=("linux-arm") ;;
                *) TARGETS=("linux-x64") ;;
            esac
            ;;
        Darwin)
            case "${HOST_ARCH}" in
                arm64) TARGETS=("macos-arm64") ;;
                x86_64) TARGETS=("macos-x64") ;;
                *) TARGETS=("macos-arm64") ;;
            esac
            ;;
        MINGW*|MSYS*|CYGWIN*)
            TARGETS=("win32-x64")
            ;;
        *)
            TARGETS=("linux-x64")
            ;;
    esac
else
    TARGETS=("$@")
fi

echo "============================================================"
echo " SoftPLC toolchain (iec2c + tcc)"
echo " Host: ${HOST_OS}/${HOST_ARCH}"
echo " Targets: ${TARGETS[*]}"
echo " WORK_DIR=${WORK_DIR}"
echo " OUT_DIR=${OUT_DIR}"
echo "============================================================"

check_deps() {
    local missing=()
    for cmd in git make flex bison; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done
    # autoconf/automake needed for MatIEC
    for cmd in autoconf automake; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done
    if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
        missing+=("g++/c++")
    fi
    if ! command -v gcc >/dev/null 2>&1 && ! command -v clang >/dev/null 2>&1; then
        missing+=("gcc/clang")
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        echo "[ERROR] Missing tools: ${missing[*]}"
        if [ "${HOST_OS}" = "Darwin" ]; then
            echo "  brew install git make autoconf automake flex bison"
        else
            echo "  sudo apt install -y build-essential git autoconf automake flex bison"
            echo "  # cross: gcc-aarch64-linux-gnu g++-aarch64-linux-gnu"
            echo "  #         gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf mingw-w64"
        fi
        exit 1
    fi
}

check_deps
mkdir -p "${WORK_DIR}" "${OUT_DIR}/matiec"

clone_or_update() {
    local repo="$1"
    local dest="$2"
    local ref="$3"
    if [ ! -d "${dest}/.git" ]; then
        echo "  Cloning ${repo} → ${dest}"
        if [ -n "${ref}" ]; then
            git clone --depth 1 --branch "${ref}" "${repo}" "${dest}" 2>/dev/null \
                || git clone "${repo}" "${dest}"
            if [ -n "${ref}" ] && [ -d "${dest}/.git" ]; then
                git -C "${dest}" checkout "${ref}" 2>/dev/null || true
            fi
        else
            git clone --depth 1 "${repo}" "${dest}"
        fi
    else
        echo "  Using cached sources: ${dest}"
        if [ -n "${ref}" ]; then
            git -C "${dest}" fetch --depth 1 origin "${ref}" 2>/dev/null || git -C "${dest}" fetch origin "${ref}" 2>/dev/null || true
            git -C "${dest}" checkout "${ref}" 2>/dev/null || true
        fi
    fi
}

echo "[1/3] Sources"
clone_or_update "${MATIEC_REPO}" "${WORK_DIR}/matiec_src" "${MATIEC_REF}"
clone_or_update "${TINYCC_REPO}" "${WORK_DIR}/tinycc_src" "${TINYCC_REF}"

rm -rf "${OUT_DIR}/matiec/lib"
cp -a "${WORK_DIR}/matiec_src/lib" "${OUT_DIR}/matiec/lib"
echo "  matiec lib → ${OUT_DIR}/matiec/lib"

build_matiec() {
    local target="$1"
    local host_flag=""
    local strip_cmd="strip"
    local ext=""
    local ld_flags=""
    local cxxflags="-O2"
    local conf_env=()

    case "$target" in
        linux-x64)
            if [ "${HOST_OS}" = "Linux" ] && [ "${HOST_ARCH}" = "x86_64" ]; then
                host_flag=""
            else
                host_flag="--host=x86_64-linux-gnu"
            fi
            strip_cmd="strip"
            ld_flags="-static-libgcc -static-libstdc++"
            ;;
        linux-arm64)
            if [ "${HOST_OS}" = "Linux" ] && { [ "${HOST_ARCH}" = "aarch64" ] || [ "${HOST_ARCH}" = "arm64" ]; }; then
                host_flag=""
                strip_cmd="strip"
            else
                host_flag="--host=aarch64-linux-gnu"
                strip_cmd="aarch64-linux-gnu-strip"
            fi
            ld_flags="-static-libgcc -static-libstdc++"
            ;;
        linux-arm)
            if [ "${HOST_OS}" = "Linux" ] && { [ "${HOST_ARCH}" = "armv7l" ] || [ "${HOST_ARCH}" = "arm" ]; }; then
                host_flag=""
                strip_cmd="strip"
            else
                host_flag="--host=arm-linux-gnueabihf"
                strip_cmd="arm-linux-gnueabihf-strip"
            fi
            ld_flags="-static-libgcc -static-libstdc++"
            ;;
        macos-arm64)
            host_flag=""
            strip_cmd="strip"
            ld_flags=""
            cxxflags="-O2 -arch arm64"
            conf_env+=( "CXXFLAGS=${cxxflags}" "CFLAGS=${cxxflags}" "LDFLAGS=-arch arm64" )
            ;;
        macos-x64)
            host_flag=""
            strip_cmd="strip"
            ld_flags=""
            cxxflags="-O2 -arch x86_64"
            conf_env+=( "CXXFLAGS=${cxxflags}" "CFLAGS=${cxxflags}" "LDFLAGS=-arch x86_64" )
            ;;
        win32-x64)
            host_flag="--host=x86_64-w64-mingw32"
            strip_cmd="x86_64-w64-mingw32-strip"
            ext=".exe"
            ld_flags="-static"
            ;;
        *)
            echo "[ERROR] Unknown target: $target"
            return 1
            ;;
    esac

    echo "  -> iec2c [${target}]"
    local build_dir="${WORK_DIR}/matiec_${target}"
    rm -rf "${build_dir}"
    cp -a "${WORK_DIR}/matiec_src" "${build_dir}"

    pushd "${build_dir}" >/dev/null
    # MatIEC sometimes needs missing scripts; autoreconf is safest
    if [ -f configure.ac ] || [ -f configure.in ]; then
        autoreconf -fi >/dev/null 2>&1 || autoreconf -i >/dev/null 2>&1 || true
    fi
    if [ ! -f configure ]; then
        echo "  [ERROR] no configure script in MatIEC"
        popd >/dev/null
        return 1
    fi

    if [ ${#conf_env[@]} -gt 0 ]; then
        env "${conf_env[@]}" ./configure ${host_flag} CXXFLAGS="${cxxflags}" >/dev/null
    else
        ./configure ${host_flag} CXXFLAGS="${cxxflags}" LDFLAGS="${ld_flags}" >/dev/null
    fi
    make -j"${NPROC}" >/dev/null

    mkdir -p "${OUT_DIR}/${target}"
    if [ -f "iec2c${ext}" ]; then
        cp "iec2c${ext}" "${OUT_DIR}/${target}/iec2c${ext}"
    elif [ -f "src/iec2c${ext}" ]; then
        cp "src/iec2c${ext}" "${OUT_DIR}/${target}/iec2c${ext}"
    else
        # fallback: find binary
        local found
        found="$(find . -maxdepth 3 -type f -name "iec2c${ext}" | head -1)"
        if [ -z "${found}" ]; then
            echo "  [ERROR] iec2c binary not found after build"
            popd >/dev/null
            return 1
        fi
        cp "${found}" "${OUT_DIR}/${target}/iec2c${ext}"
    fi
    ${strip_cmd} "${OUT_DIR}/${target}/iec2c${ext}" 2>/dev/null || true
    chmod +x "${OUT_DIR}/${target}/iec2c${ext}" 2>/dev/null || true
    popd >/dev/null
}

build_tinycc() {
    local target="$1"
    local cross_prefix=""
    local os_flag=""
    local cpu_flag=""
    local strip_cmd="strip"
    local ext=""
    local extra_cfg=()

    case "$target" in
        linux-x64)
            if [ "${HOST_OS}" = "Linux" ] && [ "${HOST_ARCH}" = "x86_64" ]; then
                cross_prefix=""
            fi
            cpu_flag="--cpu=x86_64"
            strip_cmd="strip"
            ;;
        linux-arm64)
            if [ "${HOST_OS}" = "Linux" ] && { [ "${HOST_ARCH}" = "aarch64" ] || [ "${HOST_ARCH}" = "arm64" ]; }; then
                cross_prefix=""
            else
                cross_prefix="aarch64-linux-gnu-"
            fi
            cpu_flag="--cpu=aarch64"
            strip_cmd="$( [ -n "${cross_prefix}" ] && echo "${cross_prefix}strip" || echo strip )"
            ;;
        linux-arm)
            if [ "${HOST_OS}" = "Linux" ] && { [ "${HOST_ARCH}" = "armv7l" ] || [ "${HOST_ARCH}" = "arm" ]; }; then
                cross_prefix=""
            else
                cross_prefix="arm-linux-gnueabihf-"
            fi
            cpu_flag="--cpu=arm"
            strip_cmd="$( [ -n "${cross_prefix}" ] && echo "${cross_prefix}strip" || echo strip )"
            ;;
        macos-arm64)
            cross_prefix=""
            os_flag=""
            cpu_flag="--cpu=aarch64"
            strip_cmd="strip"
            extra_cfg+=( "--config-mingw32=no" )
            # TinyCC on Darwin: prefer triple if supported
            if ./configure --help 2>/dev/null | grep -q -- '--triple'; then
                extra_cfg+=( "--triple=arm64-apple-darwin" )
            fi
            ;;
        macos-x64)
            cross_prefix=""
            cpu_flag="--cpu=x86_64"
            strip_cmd="strip"
            extra_cfg+=( "--config-mingw32=no" )
            ;;
        win32-x64)
            cross_prefix="x86_64-w64-mingw32-"
            os_flag="--os=windows"
            cpu_flag="--cpu=x86_64"
            strip_cmd="x86_64-w64-mingw32-strip"
            ext=".exe"
            ;;
        *)
            echo "[ERROR] Unknown target for tcc: $target"
            return 1
            ;;
    esac

    echo "  -> tcc [${target}]"
    local build_dir="${WORK_DIR}/tcc_${target}"
    local install_dir="${OUT_DIR}/${target}/tcc_runtime"
    rm -rf "${build_dir}" "${install_dir}"
    cp -a "${WORK_DIR}/tinycc_src" "${build_dir}"

    pushd "${build_dir}" >/dev/null
    local cfg=(
        --prefix="${install_dir}"
        ${cpu_flag}
    )
    if [ -n "${cross_prefix}" ]; then
        cfg+=( --cross-prefix="${cross_prefix}" )
    fi
    if [ -n "${os_flag}" ]; then
        cfg+=( ${os_flag} )
    fi
    cfg+=( --extra-cflags="-O2" )
    cfg+=( "${extra_cfg[@]+"${extra_cfg[@]}"}" )

    # shellcheck disable=SC2086
    ./configure "${cfg[@]}" >/dev/null 2>&1 || ./configure --prefix="${install_dir}" ${cpu_flag} --extra-cflags="-O2" >/dev/null

    make -j"${NPROC}" >/dev/null
    make install >/dev/null

    mkdir -p "${OUT_DIR}/${target}"
    if [ -f "${install_dir}/bin/tcc${ext}" ]; then
        mv "${install_dir}/bin/tcc${ext}" "${OUT_DIR}/${target}/tcc${ext}"
    elif [ -f "${install_dir}/tcc${ext}" ]; then
        mv "${install_dir}/tcc${ext}" "${OUT_DIR}/${target}/tcc${ext}"
    elif [ -f "tcc${ext}" ]; then
        cp "tcc${ext}" "${OUT_DIR}/${target}/tcc${ext}"
    else
        local found
        found="$(find "${install_dir}" -type f -name "tcc${ext}" 2>/dev/null | head -1)"
        if [ -z "${found}" ]; then
            found="$(find . -maxdepth 2 -type f -name "tcc${ext}" | head -1)"
        fi
        if [ -z "${found}" ]; then
            echo "  [ERROR] tcc binary not found after build"
            popd >/dev/null
            return 1
        fi
        cp "${found}" "${OUT_DIR}/${target}/tcc${ext}"
    fi
    ${strip_cmd} "${OUT_DIR}/${target}/tcc${ext}" 2>/dev/null || true
    chmod +x "${OUT_DIR}/${target}/tcc${ext}" 2>/dev/null || true
    popd >/dev/null
}

echo "[2/3] Build"
for target in "${TARGETS[@]}"; do
    echo "------------------------------------------------------------"
    echo "Platform: ${target}"
    build_matiec "${target}"
    build_tinycc "${target}"
    echo "  OK: ${OUT_DIR}/${target}/"
    ls -la "${OUT_DIR}/${target}/" || true
done

echo "[3/3] Done"
echo "============================================================"
du -sh "${OUT_DIR}"/* 2>/dev/null || true
echo "Copy '${OUT_DIR}' into SoftPLC project root as 'bin/'."
