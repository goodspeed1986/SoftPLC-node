const fs = require('fs');

const TYPE_MAP = {
    BOOL:  { cType: 'uint8_t',  size: 1, align: 1, read: 'getUint8',    write: 'setUint8',    isBool: true },
    BYTE:  { cType: 'uint8_t',  size: 1, align: 1, read: 'getUint8',    write: 'setUint8' },
    SINT:  { cType: 'int8_t',   size: 1, align: 1, read: 'getInt8',     write: 'setInt8' },
    USINT: { cType: 'uint8_t',  size: 1, align: 1, read: 'getUint8',    write: 'setUint8' },
    INT:   { cType: 'int16_t',  size: 2, align: 2, read: 'getInt16',    write: 'setInt16' },
    UINT:  { cType: 'uint16_t', size: 2, align: 2, read: 'getUint16',   write: 'setUint16' },
    WORD:  { cType: 'uint16_t', size: 2, align: 2, read: 'getUint16',   write: 'setUint16' },
    DINT:  { cType: 'int32_t',  size: 4, align: 4, read: 'getInt32',    write: 'setInt32' },
    UDINT: { cType: 'uint32_t', size: 4, align: 4, read: 'getUint32',   write: 'setUint32' },
    DWORD: { cType: 'uint32_t', size: 4, align: 4, read: 'getUint32',   write: 'setUint32' },
    REAL:  { cType: 'float',    size: 4, align: 4, read: 'getFloat32',  write: 'setFloat32' },
    LINT:  { cType: 'int64_t',  size: 8, align: 8, read: 'getBigInt64', write: 'setBigInt64' },
    ULINT: { cType: 'uint64_t', size: 8, align: 8, read: 'getBigUint64',write: 'setBigUint64' },
    LREAL: { cType: 'double',   size: 8, align: 8, read: 'getFloat64',  write: 'setFloat64' },
};

function toCVariableExpr(iecPath) {
    const parts = iecPath.split('.');
    if (parts.length === 2) return `${parts[0]}__${parts[1]}`;
    if (parts.length >= 4) {
        const res = parts[1];
        const inst = parts[2];
        const fieldPath = parts.slice(3).join('.');
        return `${res}__${inst}.${fieldPath}`;
    }
    return iecPath.replace(/\./g, '__');
}

function parseVariablesCsv(csvPath, retainVarNames = new Set()) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('//'));

    const inputs = [];
    const outputs = [];
    const externStructs = new Map();

    for (const line of lines) {
        const cols = line.split(';');
        if (cols.length < 5) continue;

        const fullPath = cols[1].trim();
        const iecType  = cols[2].trim().toUpperCase();
        const varClass = cols[4].trim().toUpperCase();
        const parts = fullPath.split('.');

        // Определяем extern-структуры экземпляров программ
        if (parts.length === 3 && !TYPE_MAP[iecType]) {
            externStructs.set(`${parts[1]}__${parts[2]}`, iecType);
            continue;
        }

        if (parts.length > 4) continue;

        const typeInfo = TYPE_MAP[iecType];
        if (!typeInfo) continue;

        const rawVarName = parts[parts.length - 1].toUpperCase();
        const shortName = parts.slice(2).join('_') || rawVarName;
        const cExpr = toCVariableExpr(fullPath);
        const isRetain = retainVarNames.has(rawVarName);

        const item = {
            name: shortName,
            rawName: rawVarName,
            cField: `var_${inputs.length + outputs.length}`,
            cExpr,
            iecType,
            varClass,
            isRetain,
            ...typeInfo
        };

        // RETAIN-переменные должны поддерживаться и на запись (при восстановлении с диска),
        // и на чтение (при периодическом сохранении на диск).
        if (isRetain) {
            inputs.push(item);
            outputs.push({ ...item, cField: `var_out_${inputs.length + outputs.length}` });
        } else if (varClass === 'IN' || varClass === 'INOUT') {
            inputs.push(item);
            outputs.push({ ...item, cField: `var_out_${inputs.length + outputs.length}` });
        } else if (varClass === 'OUT' || varClass === 'GLOBAL' || varClass === 'VAR') {
            outputs.push(item);
        }
    }

    // Первые 32 байта — системный заголовок + диагностика
    let offset = 32;
    const structFields = [];

    const placeField = (field) => {
        const padding = (field.align - (offset % field.align)) % field.align;
        if (padding > 0) {
            structFields.push(`    uint8_t _pad_${offset}[${padding}];`);
            offset += padding;
        }
        field.offset = offset;
        structFields.push(`    ${field.cType} ${field.cField}; // ${field.name} (${field.iecType}${field.isRetain ? ' RETAIN' : ''}) @ ${offset}`);
        offset += field.size;
    };

    inputs.forEach(placeField);
    outputs.forEach(placeField);

    const totalSize = Math.ceil(Math.max(offset, 64) / 64) * 64;
    const signature = JSON.stringify({
        inputs: inputs.map(i => [i.name, i.iecType, i.offset]),
        outputs: outputs.map(o => [o.name, o.iecType, o.offset])
    });

    return { inputs, outputs, structFields, externStructs, totalSize, signature };
}

function generateCRuntime(meta, outputCPath) {
    const externDecls = Array.from(meta.externStructs.entries())
        .map(([instName, typeName]) => `extern ${typeName} ${instName};`)
        .join('\n');

    const readInputsCode = meta.inputs
        .map(f => `            ${f.cType} tmp_${f.cField} = shm->${f.cField};`)
        .join('\n');

    const applyInputsCode = meta.inputs
        .map(f => `                ${f.cExpr} = tmp_${f.cField};`)
        .join('\n');

    const writeOutputsCode = meta.outputs
        .map(f => `        shm->${f.cField} = ${f.cExpr};`)
        .join('\n');

    const cCode = `/* Автоматически сгенерировано SoftPLC Codegen v1.3 (RETAIN + Diagnostics + OnlineChange) */
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "iec_std_lib.h"
#include "POUS.h"
#include "Config0.h"

#ifdef _WIN32
    #define WIN32_LEAN_AND_MEAN
    #include <windows.h>
    #define EXPORT __declspec(dllexport)
#else
    #define _GNU_SOURCE
    #include <pthread.h>
    #include <time.h>
    #include <unistd.h>
    #include <sys/syscall.h>
    #include <linux/futex.h>
    #define EXPORT __attribute__((visibility("default")))
#endif

extern void config_init__(void);
extern void config_run__(unsigned long tick);
extern IEC_TIME __CURRENT_TIME;
extern unsigned long long common_ticktime__;

${externDecls}

#pragma pack(push, 1)
typedef struct {
    volatile int32_t out_seq;        // 0..3
    volatile int32_t in_seq;         // 4..7
    volatile uint32_t last_scan_us;  // 8..11
    volatile uint32_t max_scan_us;   // 12..15
    volatile uint32_t overrun_count; // 16..19
    volatile uint32_t target_cycle_us;// 20..23
    volatile int32_t last_jitter_us; // 24..27
    volatile uint32_t cmd_flags;     // 28..31: bit 0 = reset max_scan_us
${meta.structFields.join('\n')}
} SharedMemoryLayout;
#pragma pack(pop)

static SharedMemoryLayout* shm = NULL;
static volatile bool is_running = false;
static volatile bool is_paused = false;
static volatile bool thread_ack_paused = false;
static unsigned long current_tick = 0;

#ifdef _WIN32
    static HANDLE plc_thread = NULL;
    static HANDLE win_wake_event = NULL;
#else
    static pthread_t plc_thread;
#endif

static inline int32_t atomic_load_acq(volatile int32_t* ptr) {
    return __atomic_load_n(ptr, __ATOMIC_ACQUIRE);
}
static inline int32_t atomic_add_rel(volatile int32_t* ptr, int32_t val) {
    return __atomic_fetch_add(ptr, val, __ATOMIC_RELEASE);
}
static inline void memory_barrier(void) {
    __sync_synchronize();
}

static inline void wake_js_listener(void) {
#ifdef _WIN32
    if (win_wake_event) SetEvent(win_wake_event);
#else
    syscall(SYS_futex, (int*)&shm->out_seq, FUTEX_WAKE_PRIVATE, 1, NULL, NULL, 0);
#endif
}

static inline uint64_t get_monotonic_ns(void) {
#ifdef _WIN32
    static LARGE_INTEGER freq = {0};
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    LARGE_INTEGER count;
    QueryPerformanceCounter(&count);
    return (uint64_t)((count.QuadPart * 1000000000ULL) / freq.QuadPart);
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
}

static void apply_inputs_from_shm(int32_t* last_in_seq) {
    int32_t seq1 = atomic_load_acq(&shm->in_seq);
    if ((seq1 & 1) == 0 && seq1 != *last_in_seq) {
${readInputsCode}
        memory_barrier();
        int32_t seq2 = atomic_load_acq(&shm->in_seq);
        if (seq1 == seq2) {
${applyInputsCode}
            *last_in_seq = seq1;
        }
    }
}

static void write_outputs_to_shm(void) {
${writeOutputsCode}
}

static void run_plc_cycle_loop(void) {
    uint64_t cycle_ns = (common_ticktime__ > 0) ? common_ticktime__ : 10000000ULL;
    shm->target_cycle_us = (uint32_t)(cycle_ns / 1000ULL);

    uint64_t next_tick_ns = get_monotonic_ns();
    int32_t last_in_seq = 0;

    while (is_running) {
        if (is_paused) {
            thread_ack_paused = true;
#ifdef _WIN32
            Sleep(1);
#else
            usleep(500);
#endif
            next_tick_ns = get_monotonic_ns();
            continue;
        }
        thread_ack_paused = false;

        uint64_t scan_start_ns = get_monotonic_ns();
        shm->last_jitter_us = (int32_t)((int64_t)(scan_start_ns - next_tick_ns) / 1000LL);

        if (shm->cmd_flags & 1) {
            shm->max_scan_us = 0;
            shm->cmd_flags &= ~1U;
        }

        // 1. Читаем входы и восстановленные RETAIN-значения из SharedArrayBuffer
        apply_inputs_from_shm(&last_in_seq);

        // 2. Обновляем системное время МЭК
        __CURRENT_TIME.tv_sec  = (long)(scan_start_ns / 1000000000ULL);
        __CURRENT_TIME.tv_nsec = (long)(scan_start_ns % 1000000000ULL);

        // 3. Выполняем скан ПЛК
        config_run__(current_tick++);

        // 4. Выгружаем выходы и актуальные значения RETAIN-переменных
        write_outputs_to_shm();

        // 5. Диагностика и Watchdog
        uint64_t scan_end_ns = get_monotonic_ns();
        uint64_t elapsed_ns = scan_end_ns - scan_start_ns;
        uint32_t elapsed_us = (uint32_t)(elapsed_ns / 1000ULL);

        shm->last_scan_us = elapsed_us;
        if (elapsed_us > shm->max_scan_us) {
            shm->max_scan_us = elapsed_us;
        }
        if (elapsed_ns > cycle_ns) {
            shm->overrun_count++;
        }

        // 6. Сигнал Node.js
        atomic_add_rel(&shm->out_seq, 1);
        wake_js_listener();

        // 7. Планирование следующего такта
        next_tick_ns += cycle_ns;
        if (scan_end_ns > next_tick_ns) {
            next_tick_ns = scan_end_ns + cycle_ns;
        }
#ifdef _WIN32
        uint64_t current = get_monotonic_ns();
        if (next_tick_ns > current) {
            DWORD sleep_ms = (DWORD)((next_tick_ns - current) / 1000000ULL);
            if (sleep_ms > 0) Sleep(sleep_ms);
            while (get_monotonic_ns() < next_tick_ns) {}
        }
#else
        struct timespec ts;
        ts.tv_sec  = (time_t)(next_tick_ns / 1000000000ULL);
        ts.tv_nsec = (long)(next_tick_ns % 1000000000ULL);
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &ts, NULL);
#endif
    }
}

#ifdef _WIN32
static DWORD WINAPI thread_entry(LPVOID arg) { run_plc_cycle_loop(); return 0; }
EXPORT void plc_wait_next_cycle_win(void) {
    if (win_wake_event) WaitForSingleObject(win_wake_event, 100);
}
#else
static void* thread_entry(void* arg) { run_plc_cycle_loop(); return NULL; }
#endif

EXPORT void plc_init_only(void* shared_buffer_ptr) {
    shm = (SharedMemoryLayout*)shared_buffer_ptr;
    config_init__();
    // Сразу применяем начальные входы / восстановленные RETAIN-значения до первого скана!
    int32_t dummy_seq = 0;
    apply_inputs_from_shm(&dummy_seq);
    write_outputs_to_shm();
}

EXPORT void plc_start(void* shared_buffer_ptr, unsigned long start_tick) {
    if (is_running || !shared_buffer_ptr) return;
    current_tick = start_tick;
    plc_init_only(shared_buffer_ptr);
    is_running = true;
    is_paused = false;
#ifdef _WIN32
    win_wake_event = CreateEvent(NULL, FALSE, FALSE, NULL);
    plc_thread = CreateThread(NULL, 0, thread_entry, NULL, 0, NULL);
    SetThreadPriority(plc_thread, THREAD_PRIORITY_HIGHEST);
#else
    pthread_create(&plc_thread, NULL, thread_entry, NULL);
#endif
}

EXPORT void plc_pause(void) {
    if (!is_running) return;
    is_paused = true;
    while (!thread_ack_paused) {
#ifdef _WIN32
        Sleep(0);
#else
        sched_yield();
#endif
    }
}

EXPORT void plc_resume(void) {
    is_paused = false;
}

EXPORT unsigned long plc_get_tick(void) {
    return current_tick;
}

EXPORT void plc_stop(void) {
    if (!is_running) return;
    is_running = false;
    is_paused = false;
#ifdef _WIN32
    if (win_wake_event) SetEvent(win_wake_event);
    WaitForSingleObject(plc_thread, INFINITE);
    CloseHandle(plc_thread);
    CloseHandle(win_wake_event);
    win_wake_event = NULL;
#else
    pthread_join(plc_thread, NULL);
#endif
    shm = NULL;
}
`;
    fs.writeFileSync(outputCPath, cCode, 'utf-8');
}

function createMemoryBridge(meta) {
    const sab = new SharedArrayBuffer(meta.totalSize);
    const ctrlView = new Int32Array(sab);
    const uintView = new Uint32Array(sab);
    const dataView = new DataView(sab);

    return {
        sab,
        ctrlView,
        writeInputs(valuesObj) {
            Atomics.add(ctrlView, 1, 1);
            for (const field of meta.inputs) {
                if (valuesObj[field.name] !== undefined) {
                    const val = field.isBool ? (valuesObj[field.name] ? 1 : 0) : valuesObj[field.name];
                    dataView[field.write](field.offset, val, true);
                }
            }
            Atomics.add(ctrlView, 1, 1);
        },
        readOutputs() {
            const result = {};
            for (const field of meta.outputs) {
                const raw = dataView[field.read](field.offset, true);
                result[field.name] = field.isBool ? (raw === 1) : raw;
            }
            return result;
        },
        /**
         * Извлекает только энергонезависимые (RETAIN) переменные для сохранения на диск
         */
        readRetainSnapshot() {
            const retainObj = {};
            for (const field of meta.outputs) {
                if (field.isRetain) {
                    const raw = dataView[field.read](field.offset, true);
                    retainObj[field.name] = field.isBool ? (raw === 1) : raw;
                }
            }
            return retainObj;
        },
        readDiagnostics() {
            const lastScanUs = Atomics.load(uintView, 2);
            const maxScanUs = Atomics.load(uintView, 3);
            const overrunCount = Atomics.load(uintView, 4);
            const targetCycleUs = Atomics.load(uintView, 5);
            const lastJitterUs = Atomics.load(ctrlView, 6);
            const cpuLoadPct = targetCycleUs > 0 ? +((lastScanUs / targetCycleUs) * 100).toFixed(1) : 0;

            return {
                tickSeq: Atomics.load(ctrlView, 0),
                lastScanUs,
                maxScanUs,
                overrunCount,
                targetCycleUs,
                lastJitterUs,
                cpuLoadPct
            };
        },
        resetDiagnostics() {
            Atomics.or(uintView, 7, 1);
        }
    };
}

module.exports = { parseVariablesCsv, generateCRuntime, createMemoryBridge };
