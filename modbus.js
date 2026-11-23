const net = require('net');

class ModbusFieldBus {
    constructor(engine, options = {}) {
        this.engine = engine;
        this.port = options.port || 5020;
        this.simulatorEnabled = true;

        this.discreteInputs = new Uint8Array(64);    // FC02 (Датчики -> входы ПЛК)
        this.coils = new Uint8Array(64);             // FC01/05 (Выходы ПЛК -> реле/насосы)
        this.inputRegisters = new Uint16Array(64);   // FC04
        this.holdingRegisters = new Uint16Array(64); // FC03/06 (Аналоговые входы/уставки)

        this.plant = {
            startBtn: false,
            stopBtn: false,
            faultSensor: false,
            waterLevel: 35.0,
            temperature: 24.5,
            pumpRunning: false,
            valveOpen: false,
            heaterOn: false
        };

        this.server = null;
        this.loopTimer = null;
    }

    start() {
        this._startTcpServer();
        this.loopTimer = setInterval(() => this._tick(), 20);
        console.log(`[Modbus TCP] Сервер запущен на порту ${this.port} (симулятор стенда активен)`);
    }

    stop() {
        if (this.loopTimer) clearInterval(this.loopTimer);
        if (this.server) this.server.close();
    }

    _tick() {
        if (!this.engine || !this.engine.isRunning || !this.engine.meta || !this.engine.bridge) return;

        // 1. Шаг физической модели объекта
        if (this.simulatorEnabled) {
            this._stepPhysics(0.02);
            this.discreteInputs[0] = this.plant.startBtn ? 1 : 0;
            this.discreteInputs[1] = this.plant.stopBtn ? 1 : 0;
            this.discreteInputs[2] = this.plant.faultSensor ? 1 : 0;
            this.discreteInputs[3] = this.plant.waterLevel >= 90.0 ? 1 : 0;

            this._writeFloat32ToRegisters(0, this.plant.waterLevel);
            this._writeFloat32ToRegisters(2, this.plant.temperature);
            this.holdingRegisters[4] = Math.round(this.plant.waterLevel * 10);
        }

        // 2. Формируем пакет входов для SharedArrayBuffer (SeqLock внутри engine.writeInputs)
        const inputPatch = {};
        for (const field of this.engine.meta.inputs) {
            const fullName = field.name;
            const shortName = field.rawName;

            // Если тег зафиксирован в отладчике (Force), берем принудительное значение
            if (this.engine.forcedVars && this.engine.forcedVars.has(fullName)) {
                inputPatch[fullName] = this.engine.forcedVars.get(fullName);
                continue;
            }

            if (field.varClass === 'IN' || field.varClass === 'INOUT') {
                if (shortName.includes('START')) inputPatch[fullName] = Boolean(this.discreteInputs[0]);
                else if (shortName.includes('STOP')) inputPatch[fullName] = Boolean(this.discreteInputs[1]);
                else if (shortName.includes('FAULT') || shortName.includes('ERR')) inputPatch[fullName] = Boolean(this.discreteInputs[2]);
                else if (shortName.includes('LEVEL')) {
                    inputPatch[fullName] = field.iecType === 'REAL'
                        ? this._readFloat32FromRegisters(0)
                        : this.holdingRegisters[4];
                } else if (shortName.includes('TEMP')) {
                    inputPatch[fullName] = field.iecType === 'REAL'
                        ? this._readFloat32FromRegisters(2)
                        : Math.round(this.plant.temperature * 10);
                }
            }
        }

        // Также поддерживаем Force для любых внутренних / выходных переменных,
        // если они присутствуют в карте входов (например, RETAIN)
        if (this.engine.forcedVars) {
            for (const [k, v] of this.engine.forcedVars.entries()) {
                inputPatch[k] = v;
            }
        }

        if (Object.keys(inputPatch).length > 0) {
            this.engine.writeInputs(inputPatch);
        }

        // 3. Читаем выходы C-модуля -> обновляем Coils Modbus и физическую модель
        const outputs = this.engine.readOutputs();
        for (const field of this.engine.meta.outputs) {
            const val = outputs[field.name];
            if (val === undefined) continue;
            const shortName = field.rawName;

            if (shortName.includes('PUMP') || shortName.includes('MOTOR')) {
                this.coils[0] = val ? 1 : 0;
                this.plant.pumpRunning = Boolean(val);
            } else if (shortName.includes('VALVE')) {
                this.coils[1] = val ? 1 : 0;
                this.plant.valveOpen = Boolean(val);
            } else if (shortName.includes('HEAT')) {
                this.coils[2] = val ? 1 : 0;
                this.plant.heaterOn = Boolean(val);
            } else if (shortName.includes('ALARM')) {
                this.coils[3] = val ? 1 : 0;
            }
        }
    }

    _stepPhysics(dt) {
        if (this.plant.pumpRunning && !this.plant.faultSensor) {
            this.plant.waterLevel += 5.0 * dt;
        }
        const outflow = this.plant.valveOpen ? 4.0 : 0.9;
        this.plant.waterLevel -= outflow * dt;
        this.plant.waterLevel = Math.max(0, Math.min(100, this.plant.waterLevel));

        const targetTemp = this.plant.heaterOn ? 72.0 : (this.plant.pumpRunning ? 36.0 : 22.0);
        this.plant.temperature += (targetTemp - this.plant.temperature) * 0.2 * dt;
    }

    _writeFloat32ToRegisters(regIndex, value) {
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(value, 0);
        this.holdingRegisters[regIndex] = buf.readUInt16BE(0);
        this.holdingRegisters[regIndex + 1] = buf.readUInt16BE(2);
    }

    _readFloat32FromRegisters(regIndex) {
        const buf = Buffer.alloc(4);
        buf.writeUInt16BE(this.holdingRegisters[regIndex] || 0, 0);
        buf.writeUInt16BE(this.holdingRegisters[regIndex + 1] || 0, 2);
        return buf.readFloatBE(0);
    }

    _startTcpServer() {
        this.server = net.createServer((socket) => {
            socket.on('data', (data) => {
                if (data.length < 8) return;
                const tid = data.readUInt16BE(0);
                const uid = data.readUInt8(6);
                const fc = data.readUInt8(7);
                let pduResponse = null;

                if (fc === 1 || fc === 2) {
                    const start = data.readUInt16BE(8);
                    const count = data.readUInt16BE(10);
                    const src = fc === 1 ? this.coils : this.discreteInputs;
                    const byteCount = Math.ceil(count / 8);
                    const payload = Buffer.alloc(2 + byteCount);
                    payload.writeUInt8(fc, 0);
                    payload.writeUInt8(byteCount, 1);
                    for (let i = 0; i < count; i++) {
                        if (src[start + i]) payload[2 + (i >> 3)] |= (1 << (i & 7));
                    }
                    pduResponse = payload;
                } else if (fc === 3 || fc === 4) {
                    const start = data.readUInt16BE(8);
                    const count = data.readUInt16BE(10);
                    const src = fc === 3 ? this.holdingRegisters : this.inputRegisters;
                    const payload = Buffer.alloc(2 + count * 2);
                    payload.writeUInt8(fc, 0);
                    payload.writeUInt8(count * 2, 1);
                    for (let i = 0; i < count; i++) {
                        payload.writeUInt16BE(src[start + i] || 0, 2 + i * 2);
                    }
                    pduResponse = payload;
                } else if (fc === 5) {
                    const addr = data.readUInt16BE(8);
                    const val = data.readUInt16BE(10) === 0xFF00 ? 1 : 0;
                    if (addr < this.coils.length) this.coils[addr] = val;
                    pduResponse = data.subarray(7, 12);
                } else if (fc === 6) {
                    const addr = data.readUInt16BE(8);
                    const val = data.readUInt16BE(10);
                    if (addr < this.holdingRegisters.length) this.holdingRegisters[addr] = val;
                    pduResponse = data.subarray(7, 12);
                }

                if (pduResponse) {
                    const mbap = Buffer.alloc(7);
                    mbap.writeUInt16BE(tid, 0);
                    mbap.writeUInt16BE(0, 2);
                    mbap.writeUInt16BE(pduResponse.length + 1, 4);
                    mbap.writeUInt8(uid, 6);
                    socket.write(Buffer.concat([mbap, pduResponse]));
                }
            });
            socket.on('error', () => {});
        });
        this.server.listen(this.port, '0.0.0.0');
    }
}

module.exports = { ModbusFieldBus };
