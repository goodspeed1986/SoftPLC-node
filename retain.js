const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Менеджер энергонезависимой памяти (RETAIN / PERSISTENT)
 * Формат бинарного файла (.ret):
 * [0..3]   Magic bytes: "RETN" (0x4E544552)
 * [4..7]   Version: 1 (uint32 LE)
 * [8..11]  Data length in bytes (uint32 LE)
 * [12..15] CRC32 checksum of payload (uint32 LE)
 * [16..N]  Payload: JSON-serialized map { "VAR_NAME": value } или бинарный дамп
 *
 * Использование JSON-пейлоада поверх бинарного заголовка с CRC32 и атомарной записью (.tmp -> rename)
 * позволяет безопасно восстанавливать RETAIN-переменные по именам даже после изменения состава
 * переменных или перекомпиляции проекта (аналог PERSISTENT в CODESYS).
 */
class RetainManager {
    constructor(filePath, options = {}) {
        this.filePath = path.resolve(filePath);
        this.tmpPath = this.filePath + '.tmp';
        this.bakPath = this.filePath + '.bak';
        this.autosaveIntervalMs = options.autosaveIntervalMs || 5000;
        this.timer = null;
        this.lastHash = '';
    }

    _calcCrc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Загружает сохраненные RETAIN-переменные с диска с проверкой целостности (CRC32).
     * Если основной файл поврежден при сбое питания, автоматически откатывается на .bak
     */
    load() {
        const candidates = [this.filePath, this.bakPath];
        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            try {
                const raw = fs.readFileSync(candidate);
                if (raw.length < 16) continue;

                const magic = raw.toString('ascii', 0, 4);
                const version = raw.readUInt32LE(4);
                const payloadLen = raw.readUInt32LE(8);
                const expectedCrc = raw.readUInt32LE(12);

                if (magic !== 'RETN' || version !== 1 || raw.length < 16 + payloadLen) {
                    continue;
                }

                const payload = raw.subarray(16, 16 + payloadLen);
                const actualCrc = this._calcCrc32(payload);
                if (actualCrc !== expectedCrc) {
                    console.warn(`[Retain] Контрольная сумма не совпала в ${candidate}, пробуем резервную копию...`);
                    continue;
                }

                const parsed = JSON.parse(payload.toString('utf-8'));
                this.lastHash = crypto.createHash('sha1').update(payload).digest('hex');
                return parsed;
            } catch (err) {
                console.warn(`[Retain] Ошибка чтения ${candidate}:`, err.message);
            }
        }
        return {};
    }

    /**
     * Атомарное сохранение состояния на диск (write -> fsync -> backup -> rename)
     * Гарантирует отсутствие повреждения файла при внезапном отключении питания ПЛК.
     */
    save(retainVarsObj, force = false) {
        if (!retainVarsObj || Object.keys(retainVarsObj).length === 0) return false;

        const payload = Buffer.from(JSON.stringify(retainVarsObj), 'utf-8');
        const currentHash = crypto.createHash('sha1').update(payload).digest('hex');

        // Если данные не изменились с прошлого сохранения — не изнашиваем Flash/SD-карту
        if (!force && currentHash === this.lastHash) {
            return false;
        }

        const header = Buffer.alloc(16);
        header.write('RETN', 0, 4, 'ascii');
        header.writeUInt32LE(1, 4);
        header.writeUInt32LE(payload.length, 8);
        header.writeUInt32LE(this._calcCrc32(payload), 12);

        const fullBuf = Buffer.concat([header, payload]);

        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

        // 1. Пишем во временный файл и принудительно сбрасываем буфер ОС на носитель (fsync)
        const fd = fs.openSync(this.tmpPath, 'w');
        try {
            fs.writeSync(fd, fullBuf, 0, fullBuf.length);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }

        // 2. Текущий рабочий файл сохраняем как .bak
        if (fs.existsSync(this.filePath)) {
            fs.copyFileSync(this.filePath, this.bakPath);
        }

        // 3. Атомарно заменяем основной файл
        fs.renameSync(this.tmpPath, this.filePath);
        this.lastHash = currentHash;
        return true;
    }

    /**
     * Запускает фоновое сохранение при изменении значений (защита Flash от лишних перезаписей)
     */
    startAutoSave(getRetainSnapshotFn) {
        this.stopAutoSave();
        this.timer = setInterval(() => {
            try {
                const snapshot = getRetainSnapshotFn();
                this.save(snapshot, false);
            } catch (err) {
                console.error('[Retain] Ошибка автосохранения:', err.message);
            }
        }, this.autosaveIntervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stopAutoSave() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = { RetainManager };
