const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const koffi = require('koffi');
const { bundleStProject, formatCompilerErrors } = require('./bundler');
const { parseVariablesCsv, generateCRuntime, createMemoryBridge } = require('./codegen');
const { RetainManager } = require('./retain');

/**
 * Определяет платформенный ключ тулчейна:
 *   linux-x64 | linux-arm64 | linux-arm | win32-x64
 */
function detectPlatformKey() {
    const arch = process.arch; // x64 | arm64 | arm
    if (process.platform === 'win32') return 'win32-x64';
    if (process.platform === 'darwin') {
        if (arch === 'arm64') return 'macos-arm64';
        return 'macos-x64';
    }
    // Linux and others
    if (arch === 'x64' || arch === 'x86_64') return 'linux-x64';
    if (arch === 'arm64' || arch === 'aarch64') return 'linux-arm64';
    if (arch === 'arm') return 'linux-arm';
    return `linux-${arch}`;
}

/**
 * Ищет бинарники iec2c / tcc в раскладке тулчейна:
 *   bin/<platform>/iec2c[.exe]
 *   bin/<platform>/tcc[.exe]
 *   bin/matiec/lib  или  matiec/lib
 * Также поддерживает плоскую раскладку bin/iec2c + bin/tcc (legacy).
 */
function resolveToolchain(rootDir) {
    const platform = detectPlatformKey();
    const isWin = process.platform === 'win32';
    const iecName = isWin ? 'iec2c.exe' : 'iec2c';
    const tccName = isWin ? 'tcc.exe' : 'tcc';

    const candidates = [
        {
            iec2c: path.join(rootDir, 'bin', platform, iecName),
            tcc: path.join(rootDir, 'bin', platform, tccName),
            tccRuntime: path.join(rootDir, 'bin', platform, 'tcc_runtime'),
            matiecLib: path.join(rootDir, 'bin', 'matiec', 'lib'),
        },
        {
            iec2c: path.join(rootDir, 'bin', platform, iecName),
            tcc: path.join(rootDir, 'bin', platform, tccName),
            tccRuntime: path.join(rootDir, 'bin', platform, 'tcc_runtime'),
            matiecLib: path.join(rootDir, 'matiec', 'lib'),
        },
        {
            iec2c: path.join(rootDir, 'bin', iecName),
            tcc: path.join(rootDir, 'bin', tccName),
            tccRuntime: path.join(rootDir, 'bin', 'tcc_runtime'),
            matiecLib: path.join(rootDir, 'matiec', 'lib'),
        },
        {
            iec2c: path.join(rootDir, 'bin', iecName),
            tcc: path.join(rootDir, 'bin', tccName),
            tccRuntime: path.join(rootDir, 'bin', 'tcc_runtime'),
            matiecLib: path.join(rootDir, 'bin', 'matiec', 'lib'),
        },
    ];

    for (const c of candidates) {
        if (fs.existsSync(c.iec2c) && fs.existsSync(c.tcc) && fs.existsSync(c.matiecLib)) {
            return { ...c, platform, found: true };
        }
    }

    return {
        iec2c: candidates[0].iec2c,
        tcc: candidates[0].tcc,
        tccRuntime: candidates[0].tccRuntime,
        matiecLib: candidates[0].matiecLib,
        platform,
        found: false,
    };
}

class SoftPlcEngine {
    constructor(options = {}) {
        this.workDir = options.workDir || path.join(__dirname, 'build');
        this.rootDir = options.rootDir || __dirname;

        const tc = resolveToolchain(this.rootDir);
        this.iec2cBin = options.iec2cBin || tc.iec2c;
        this.tccBin = options.tccBin || tc.tcc;
        this.matiecLib = options.matiecLib || tc.matiecLib;
        this.tccRuntime = options.tccRuntime || tc.tccRuntime;
        this.platformKey = tc.platform;

        if (!tc.found) {
            console.warn(
                `[SoftPLC] Тулчейн не найден для платформы ${tc.platform}.\n` +
                `  Ожидается: bin/${tc.platform}/iec2c, bin/${tc.platform}/tcc, bin/matiec/lib\n` +
                `  Соберите:  cd scripts && ./build_toolchain.sh ${tc.platform}`
            );
        } else {
            console.log(`[SoftPLC] Тулчейн: ${tc.platform} → ${path.dirname(this.iec2cBin)}`);
        }

        this.retainManager = new RetainManager(
            options.retainFile || path.join(this.workDir, 'plc_retain.ret'),
            { autosaveIntervalMs: options.retainAutosaveMs || 5000 }
        );

        this.lib = null;
        this.fns = null;
        this.meta = null;
        this.bridge = null;
        this.isRunning = false;
        this.onCycleCallback = null;
        this.onOverrunCallback = null;
        this._buildVersion = 0;

        fs.mkdirSync(this.workDir, { recursive: true });
    }

    /**
     * Компиляция IEC → C (MatIEC) → shared library (TinyCC).
     * Каждый вызов увеличивает _buildVersion, чтобы online-change
     * мог загрузить новую .so/.dll, не конфликтуя с предыдущей.
     */
    compileProject(projectDir) {
        this._buildVersion++;
        const bundlePath = path.join(this.workDir, 'bundle.st');
        const cRuntimePath = path.join(this.workDir, 'plc_runtime.c');
        const ext = process.platform === 'win32' ? 'dll' : 'so';
        const outLibPath = path.join(this.workDir, `plc_logic_v${this._buildVersion}.${ext}`);

        if (!fs.existsSync(this.iec2cBin)) {
            throw new Error(
                `Не найден iec2c: ${this.iec2cBin}\n` +
                `Соберите тулчейн: cd scripts && ./build_toolchain.sh ${this.platformKey}`
            );
        }
        if (!fs.existsSync(this.tccBin)) {
            throw new Error(
                `Не найден tcc: ${this.tccBin}\n` +
                `Соберите тулчейн: cd scripts && ./build_toolchain.sh ${this.platformKey}`
            );
        }

        const bundleInfo = bundleStProject(projectDir, bundlePath);

        try {
            execFileSync(this.iec2cBin, ['-I', this.matiecLib, bundlePath], {
                cwd: this.workDir,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            const rawStderr = err.stderr ? err.stderr.toString('utf-8') : err.message;
            throw new Error(`Ошибка компиляции МЭК:\n${formatCompilerErrors(rawStderr, bundleInfo.lineMap)}`);
        }

        const csvPath = path.join(this.workDir, 'VARIABLES.csv');
        const meta = parseVariablesCsv(csvPath, bundleInfo.retainVarNames);
        generateCRuntime(meta, cRuntimePath);

        // TinyCC: -B указывает на tcc_runtime (stddef.h, libtcc1.a)
        const tccArgs = [];
        if (this.tccRuntime && fs.existsSync(this.tccRuntime)) {
            const libTcc = path.join(this.tccRuntime, 'lib', 'tcc');
            if (fs.existsSync(libTcc)) {
                tccArgs.push('-B', libTcc);
            } else {
                tccArgs.push('-B', this.tccRuntime);
            }
            const includeDir = path.join(this.tccRuntime, 'include');
            if (fs.existsSync(includeDir)) {
                tccArgs.push(`-I${includeDir}`);
            }
        }

        tccArgs.push(
            '-shared',
            ...(process.platform === 'win32' ? [] : ['-fPIC']),
            `-I${this.matiecLib}`,
            `-I${this.workDir}`,
            cRuntimePath,
            path.join(this.workDir, 'Config0.c'),
            path.join(this.workDir, 'Res0.c'),
            ...(process.platform === 'win32' ? [] : ['-lpthread']),
            '-o', outLibPath
        );

        try {
            execFileSync(this.tccBin, tccArgs, { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            const rawStderr = err.stderr ? err.stderr.toString('utf-8') : err.message;
            throw new Error(`Ошибка компиляции C (TinyCC):\n${rawStderr}`);
        }

        return { outLibPath, meta };
    }

    _bindLibrary(libPath) {
        const lib = koffi.load(libPath);
        return {
            lib,
            fns: {
                plc_start: lib.func('void plc_start(void* ptr, unsigned long start_tick)'),
                plc_pause: lib.func('void plc_pause()'),
                plc_resume: lib.func('void plc_resume()'),
                plc_get_tick: lib.func('unsigned long plc_get_tick()'),
                plc_stop: lib.func('void plc_stop()'),
                plc_wait_win: process.platform === 'win32' ? lib.func('void plc_wait_next_cycle_win()') : null
            }
        };
    }

    /**
     * Холодный старт ПЛК с автоматическим восстановлением RETAIN-переменных с диска
     */
    start(projectDir) {
        const { outLibPath, meta } = this.compileProject(projectDir);
        const { lib, fns } = this._bindLibrary(outLibPath);

        this.meta = meta;
        this.bridge = createMemoryBridge(meta);
        this.lib = lib;
        this.fns = fns;

        const savedRetain = this.retainManager.load();
        if (Object.keys(savedRetain).length > 0) {
            this.bridge.writeInputs(savedRetain);
            console.log('[Retain] Восстановлены энергонезависимые переменные:', savedRetain);
        }

        this.fns.plc_start(this.bridge.sab, 0);
        this.isRunning = true;

        this.retainManager.startAutoSave(() => this.bridge.readRetainSnapshot());
        this._startListenerLoop();
    }

    /**
     * Online Change без остановки процесса.
     * - sameMemoryLayout → hot-swap (zero downtime)
     * - иначе → state migration с переносом значений
     */
    onlineUpdate(projectDir) {
        if (!this.isRunning) {
            this.start(projectDir);
            return { mode: 'cold_start' };
        }

        const { outLibPath: newLibPath, meta: newMeta } = this.compileProject(projectDir);
        const { lib: newLib, fns: newFns } = this._bindLibrary(newLibPath);

        const sameMemoryLayout = (this.meta.signature === newMeta.signature);

        if (sameMemoryLayout) {
            this.fns.plc_pause();
            const savedTick = this.fns.plc_get_tick();
            this.fns.plc_stop();
            this.lib.unload();

            this.lib = newLib;
            this.fns = newFns;
            this.meta = newMeta;
            this.fns.plc_start(this.bridge.sab, savedTick);

            return { mode: 'hot_swap_zero_downtime', tick: savedTick };
        } else {
            this.fns.plc_pause();
            const savedTick = this.fns.plc_get_tick();
            const oldState = this.bridge.readOutputs();
            this.fns.plc_stop();
            this.lib.unload();

            const newBridge = createMemoryBridge(newMeta);
            newBridge.writeInputs(oldState);

            this.lib = newLib;
            this.fns = newFns;
            this.meta = newMeta;
            this.bridge = newBridge;
            this.fns.plc_start(this.bridge.sab, savedTick);

            return { mode: 'state_migrated', tick: savedTick };
        }
    }

    writeInputs(obj) {
        if (this.bridge) this.bridge.writeInputs(obj);
    }

    readOutputs() {
        return this.bridge ? this.bridge.readOutputs() : {};
    }

    getDiagnostics() {
        return this.bridge ? this.bridge.readDiagnostics() : null;
    }

    resetDiagnostics() {
        if (this.bridge) this.bridge.resetDiagnostics();
    }

    async _startListenerLoop() {
        let lastOutSeq = Atomics.load(this.bridge.ctrlView, 0);
        let lastOverruns = 0;

        while (this.isRunning) {
            if (process.platform === 'win32') {
                await new Promise((resolve) => this.fns.plc_wait_win.async(resolve));
            } else {
                const res = Atomics.waitAsync(this.bridge.ctrlView, 0, lastOutSeq);
                if (res.async) await res.value;
            }

            if (!this.isRunning) break;

            const currentSeq = Atomics.load(this.bridge.ctrlView, 0);
            if (currentSeq === lastOutSeq) continue;
            lastOutSeq = currentSeq;

            const diag = this.bridge.readDiagnostics();
            if (diag.overrunCount > lastOverruns) {
                lastOverruns = diag.overrunCount;
                if (this.onOverrunCallback) this.onOverrunCallback(diag);
            }

            if (this.onCycleCallback) {
                this.onCycleCallback(this.bridge.readOutputs(), diag);
            }
        }
    }

    stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.retainManager.stopAutoSave();

        if (this.fns) {
            this.fns.plc_pause();
            const finalRetain = this.bridge.readRetainSnapshot();
            this.retainManager.save(finalRetain, true);
            this.fns.plc_stop();
        }
        if (this.lib) this.lib.unload();
    }
}

module.exports = { SoftPlcEngine, resolveToolchain, detectPlatformKey };
