const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const AdmZip = require('adm-zip');
const { SoftPlcEngine } = require('./index');
const { ModbusFieldBus } = require('./modbus');

const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = path.join(__dirname, 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

function listProjects() {
    return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
}

function sanitizeProjectName(raw) {
    return String(raw || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '');
}

function sanitizePouName(raw, prefix) {
    let cleaned = String(raw || '')
        .trim()
        .replace(/[^a-zA-Z0-9_]/g, '_');
    if (!cleaned) cleaned = `${prefix}_Item`;
    if (!/^[a-zA-Z_]/.test(cleaned)) cleaned = `${prefix}_${cleaned}`;
    return cleaned;
}

function getProjectSrcDir(projectName) {
    const safe = sanitizeProjectName(projectName);
    if (!safe) throw new Error('Некорректное имя проекта');
    return path.join(PROJECTS_DIR, safe, 'src');
}

function ensureDefaultProject() {
    const existing = listProjects();
    if (existing.length > 0) return existing[0];
    const srcDir = getProjectSrcDir('pump_station');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'config.st'), `CONFIGURATION STD_CONF
    RESOURCE STD_RESSOURCE ON PLC
        TASK MainTask(INTERVAL := T#10ms, PRIORITY := 1);
        PROGRAM MainInst WITH MainTask : PRG_MainLogic;
    END_RESOURCE
END_CONFIGURATION
`, 'utf8');
    return 'pump_station';
}

function scanProjectStructure(srcDir) {
    const programs = [];
    const functionBlocks = [];
    const functions = [];
    const tasks = [];

    if (!fs.existsSync(srcDir)) {
        return { programs, functionBlocks, functions, tasks };
    }

    const stFiles = fs.readdirSync(srcDir).filter(f => f.toLowerCase().endsWith('.st')).sort();
    for (const fileName of stFiles) {
        const content = fs.readFileSync(path.join(srcDir, fileName), 'utf8');
        const langMatch = content.match(/^\/\/\s*@LANG\s*:\s*(ST|SFC|FBD|IL|LD)\b/i);
        if (langMatch) {
            const jStart = content.indexOf('{');
            const jEnd = content.lastIndexOf('}');
            if (jStart !== -1 && jEnd !== -1) {
                try {
                    const meta = JSON.parse(content.slice(jStart, jEnd + 1));
                    const pName = meta.pouName || fileName.replace(/\.st$/i, '');
                    const pType = String(meta.pouType || 'PROGRAM').toUpperCase();
                    if (pType === 'FUNCTION_BLOCK') functionBlocks.push({ name: pName, file: fileName });
                    else if (pType === 'FUNCTION') functions.push({ name: pName, file: fileName });
                    else programs.push({ name: pName, file: fileName });
                    continue;
                } catch (_) {}
            }
        }

        const clean = content.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\/\/.*$/gm, '');
        let m;
        const prgRe = /\bPROGRAM\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
        while ((m = prgRe.exec(clean)) !== null) programs.push({ name: m[1], file: fileName });

        const fbRe = /\bFUNCTION_BLOCK\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
        while ((m = fbRe.exec(clean)) !== null) functionBlocks.push({ name: m[1], file: fileName });

        const fnRe = /\bFUNCTION\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gi;
        while ((m = fnRe.exec(clean)) !== null) functions.push({ name: m[1], file: fileName });

        const taskRe = /\bTASK\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/gi;
        while ((m = taskRe.exec(clean)) !== null) tasks.push({ name: m[1], params: m[2].trim(), file: fileName });
    }

    return { programs, functionBlocks, functions, tasks };
}

function buildPouTemplate(pouType, pouName, retType = 'REAL') {
    const upper = String(pouType || '').toUpperCase();
    if (upper === 'FUNCTION' || upper === 'FUN') {
        const safeRet = (retType || 'REAL').toUpperCase();
        return `FUNCTION ${pouName} : ${safeRet}
    VAR_INPUT
        InVal : ${safeRet};
    END_VAR
    VAR
        TempVal : ${safeRet};
    END_VAR
    TempVal := InVal;
    ${pouName} := TempVal;
END_FUNCTION
`;
    }
    if (upper === 'FUNCTION_BLOCK' || upper === 'FB') {
        return `FUNCTION_BLOCK ${pouName}
    VAR_INPUT
        Enable : BOOL;
    END_VAR
    VAR_OUTPUT
        Active : BOOL;
    END_VAR
    VAR
        EdgeTrig : R_TRIG;
        PulseGen : TON;
    END_VAR
    EdgeTrig(CLK := Enable);
    PulseGen(IN := Enable, PT := T#1s);
    Active := Enable;
END_FUNCTION_BLOCK
`;
    }
    return `PROGRAM ${pouName}
    VAR_INPUT
        IN_Start : BOOL;
    END_VAR
    VAR_OUTPUT
        OUT_Run  : BOOL;
    END_VAR
    VAR
        CycleCnt : DINT := 0;
    END_VAR
    CycleCnt := CycleCnt + 1;
    OUT_Run := IN_Start;
END_PROGRAM
`;
}

function bindProgramToTask(srcDir, taskName, programName) {
    const structure = scanProjectStructure(srcDir);
    const isFb = structure.functionBlocks.some(x => x.name.toLowerCase() === String(programName).toLowerCase());
    const isFn = structure.functions.some(x => x.name.toLowerCase() === String(programName).toLowerCase());
    if (isFb || isFn) {
        throw new Error(`В МЭК 61131-3 и CODESYS 2.3 к TASK можно привязывать только PROGRAM (PRG). Объект "${programName}" является ${isFn ? 'FUNCTION' : 'FUNCTION_BLOCK'}.`);
    }
    const isPrg = structure.programs.some(x => x.name.toLowerCase() === String(programName).toLowerCase());
    if (!isPrg) {
        throw new Error(`Программа "${programName}" не найдена в исходниках проекта.`);
    }

    const configPath = path.join(srcDir, 'config.st');
    let cfgText = fs.existsSync(configPath)
        ? fs.readFileSync(configPath, 'utf8')
        : `CONFIGURATION STD_CONF
    RESOURCE STD_RESSOURCE ON PLC
        TASK MainTask(INTERVAL := T#10ms, PRIORITY := 1);
        PROGRAM MainInst WITH MainTask : ${programName};
    END_RESOURCE
END_CONFIGURATION
`;

    const safeTask = sanitizePouName(taskName, 'Task');
    if (!new RegExp(`\bTASK\s+${safeTask}\b`, 'i').test(cfgText)) {
        cfgText = cfgText.replace(
            /(RESOURCE\s+[a-zA-Z0-9_]+\s+ON\s+[a-zA-Z0-9_]+\s*)/i,
            `$1\n        TASK ${safeTask}(INTERVAL := T#20ms, PRIORITY := 2);\n`
        );
    }

    const instName = `Inst_${safeTask}_${programName}`;
    const taskBindLine = `        PROGRAM ${instName} WITH ${safeTask} : ${programName};`;
    const existingBindRe = new RegExp(`^[ \t]*PROGRAM\s+[a-zA-Z0-9_]+\s+WITH\s+${safeTask}\s*:[^;\r\n]+;`, 'im');
    if (existingBindRe.test(cfgText)) {
        cfgText = cfgText.replace(existingBindRe, taskBindLine);
    } else if (/END_RESOURCE/i.test(cfgText)) {
        cfgText = cfgText.replace(/([ \t]*END_RESOURCE)/i, `${taskBindLine}\n$1`);
    }

    fs.writeFileSync(configPath, cfgText, 'utf8');
}

let activeProject = ensureDefaultProject();

const engine = new SoftPlcEngine({
    workDir: path.join(__dirname, 'build'),
    retainFile: path.join(PROJECTS_DIR, activeProject, 'plc_retain.ret')
});
engine.forcedVars = new Map();

const modbus = new ModbusFieldBus(engine, { port: 5020 });

function readBodyBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJson(req) {
    const buf = await readBodyBuffer(req);
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

function switchProject(projectName, autoStart = true) {
    const safe = sanitizeProjectName(projectName);
    const srcDir = getProjectSrcDir(safe);
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Проект "${safe}" не найден`);
    }

    if (engine.isRunning) {
        engine.stop();
    }
    engine.forcedVars.clear();
    activeProject = safe;

    const { RetainManager } = require('./retain');
    engine.retainManager = new RetainManager(
        path.join(PROJECTS_DIR, activeProject, 'plc_retain.ret'),
        { autosaveIntervalMs: 5000 }
    );

    if (autoStart) {
        try {
            engine.start(srcDir);
            return { started: true };
        } catch (err) {
            return { started: false, compileError: err.message };
        }
    }
    return { started: false };
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
        if (req.method === 'GET' && url.pathname === '/api/projects') {
            return sendJson(res, 200, { activeProject, projects: listProjects() });
        }

        if (req.method === 'POST' && url.pathname === '/api/projects/create') {
            const { name } = await readJson(req);
            const safe = sanitizeProjectName(name);
            if (!safe) return sendJson(res, 400, { ok: false, error: 'Укажите корректное имя проекта' });
            const projRoot = path.join(PROJECTS_DIR, safe);
            if (fs.existsSync(projRoot)) return sendJson(res, 409, { ok: false, error: `Проект "${safe}" уже существует` });

            const srcDir = path.join(projRoot, 'src');
            fs.mkdirSync(srcDir, { recursive: true });
            fs.writeFileSync(path.join(srcDir, 'config.st'), `CONFIGURATION STD_CONF
    RESOURCE STD_RESSOURCE ON PLC
        TASK MainTask(INTERVAL := T#10ms, PRIORITY := 1);
        PROGRAM MainInst WITH MainTask : PRG_Main;
    END_RESOURCE
END_CONFIGURATION
`, 'utf8');
            fs.writeFileSync(path.join(srcDir, 'prg_main.st'), buildPouTemplate('PROGRAM', 'PRG_Main'), 'utf8');

            const sw = switchProject(safe, true);
            return sendJson(res, 200, { ok: true, activeProject, projects: listProjects(), ...sw });
        }

        if (req.method === 'POST' && url.pathname === '/api/projects/select') {
            const { name } = await readJson(req);
            const sw = switchProject(name, true);
            return sendJson(res, 200, { ok: true, activeProject, ...sw });
        }

        if (req.method === 'DELETE' && url.pathname === '/api/projects') {
            const target = sanitizeProjectName(url.searchParams.get('name'));
            const all = listProjects();
            if (all.length <= 1) return sendJson(res, 400, { ok: false, error: 'Нельзя удалить единственный проект' });
            const projRoot = path.join(PROJECTS_DIR, target);
            if (fs.existsSync(projRoot)) {
                if (target === activeProject && engine.isRunning) engine.stop();
                fs.rmSync(projRoot, { recursive: true, force: true });
            }
            if (target === activeProject) switchProject(listProjects()[0], true);
            return sendJson(res, 200, { ok: true, activeProject, projects: listProjects() });
        }

        if (req.method === 'GET' && url.pathname === '/api/projects/export') {
            const target = sanitizeProjectName(url.searchParams.get('name') || activeProject);
            const projRoot = path.join(PROJECTS_DIR, target);
            if (!fs.existsSync(projRoot)) {
                res.writeHead(404);
                return res.end('Project not found');
            }
            const zip = new AdmZip();
            const srcDir = path.join(projRoot, 'src');
            if (fs.existsSync(srcDir)) zip.addLocalFolder(srcDir, 'src');
            const retFile = path.join(projRoot, 'plc_retain.ret');
            if (fs.existsSync(retFile)) zip.addLocalFile(retFile);
            zip.addFile('project.json', Buffer.from(JSON.stringify({
                name: target,
                exportedAt: new Date().toISOString(),
                format: 'softplc-project-v3-iec-multilang'
            }, null, 2), 'utf8'));
            const zipBuffer = zip.toBuffer();
            res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': `attachment; filename="${target}.zip"`,
                'Content-Length': zipBuffer.length
            });
            return res.end(zipBuffer);
        }

        if (req.method === 'POST' && url.pathname === '/api/projects/import') {
            const rawZip = await readBodyBuffer(req);
            if (!rawZip || rawZip.length === 0) return sendJson(res, 400, { ok: false, error: 'Пустой ZIP-архив' });
            const zip = new AdmZip(rawZip);
            const entries = zip.getEntries();
            let requestedName = sanitizeProjectName(url.searchParams.get('name'));
            if (!requestedName) {
                const manifestEntry = entries.find(e => e.entryName.endsWith('project.json'));
                if (manifestEntry) {
                    try {
                        requestedName = sanitizeProjectName(JSON.parse(manifestEntry.getData().toString('utf8')).name);
                    } catch (_) {}
                }
            }
            if (!requestedName) requestedName = `imported_${Date.now()}`;
            let finalName = requestedName;
            let counter = 1;
            while (fs.existsSync(path.join(PROJECTS_DIR, finalName))) finalName = `${requestedName}_${counter++}`;

            const projRoot = path.join(PROJECTS_DIR, finalName);
            const srcDir = path.join(projRoot, 'src');
            fs.mkdirSync(srcDir, { recursive: true });
            let stCount = 0;
            for (const entry of entries) {
                if (entry.isDirectory) continue;
                const entryName = entry.entryName.replace(/\\/g, '/');
                if (entryName.includes('..')) continue;
                const baseName = path.basename(entryName);
                if (baseName.toLowerCase().endsWith('.st')) {
                    const relInsideSrc = entryName.startsWith('src/') ? entryName.slice(4) : baseName;
                    const destPath = path.join(srcDir, relInsideSrc);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.writeFileSync(destPath, entry.getData());
                    stCount++;
                } else if (baseName === 'plc_retain.ret') {
                    fs.writeFileSync(path.join(projRoot, 'plc_retain.ret'), entry.getData());
                }
            }
            if (stCount === 0) {
                fs.rmSync(projRoot, { recursive: true, force: true });
                return sendJson(res, 400, { ok: false, error: 'В ZIP-архиве не найдено ни одного .st файла' });
            }
            const sw = switchProject(finalName, true);
            return sendJson(res, 200, { ok: true, importedProject: finalName, filesCount: stCount, activeProject, projects: listProjects(), ...sw });
        }

        if (req.method === 'POST' && url.pathname === '/api/pou/create') {
            const { pouType, pouLang, name, returnType, taskName, bindTask } = await readJson(req);
            const upperType = String(pouType || 'PROGRAM').toUpperCase();
            const upperLang = String(pouLang || 'ST').toUpperCase();
            const prefix = upperType === 'FUNCTION' ? 'F' : (upperType === 'FUNCTION_BLOCK' ? 'FB' : 'PRG');
            const pouName = sanitizePouName(name, prefix);
            const fileName = `${pouName.toLowerCase()}.st`;
            const srcDir = getProjectSrcDir(activeProject);
            const filePath = path.join(srcDir, fileName);

            if (fs.existsSync(filePath)) {
                return sendJson(res, 409, { ok: false, error: `POU "${pouName}" (${fileName}) уже существует` });
            }

            let code = '';
            if (upperLang === 'SFC') {
                code = `// @LANG:SFC
${JSON.stringify({
                    pouType: upperType,
                    pouName,
                    steps: [
                        { id: 'S0', name: 'Step0', initial: true, action: 'OUT_Pump := FALSE; OUT_Valve := FALSE; OUT_Done := FALSE;' },
                        { id: 'S1', name: 'Step1', initial: false, action: 'OUT_Pump := TRUE; OUT_Valve := FALSE; OUT_Done := FALSE;' }
                    ],
                    transitions: [
                        { from: 'Step0', to: 'Step1', cond: 'IN_Start AND NOT IN_Fault' },
                        { from: 'Step1', to: 'Step0', cond: 'IN_Stop OR IN_Fault' }
                    ]
                }, null, 2)}
`;
            } else if (upperLang === 'FBD' || upperLang === 'LD') {
                code = `// @LANG:${upperLang}
${JSON.stringify({
                    pouType: upperType,
                    pouName,
                    blocks: [
                        { op: 'AND', inputs: ['IN_A', 'IN_B'], out: 'OUT_Sig' },
                        { op: 'ADD', inputs: ['IN_Val1', 'IN_Val2'], out: 'OUT_Res' }
                    ]
                }, null, 2)}
`;
            } else if (upperLang === 'IL') {
                code = `// @LANG:IL
${upperType} ${pouName}${upperType === 'FUNCTION' ? ` : ${(returnType || 'REAL').toUpperCase()}` : ''}
LD IN_Start
ST OUT_Active
END_${upperType}
`;
            } else {
                code = buildPouTemplate(upperType, pouName, returnType);
            }

            fs.writeFileSync(filePath, code, 'utf8');

            if (bindTask && taskName) {
                if (upperType !== 'PROGRAM') {
                    return sendJson(res, 400, {
                        ok: false,
                        error: `К TASK можно привязывать только PROGRAM (PRG). Тип ${upperType} не поддерживает прямой запуск по задаче.`
                    });
                }
                bindProgramToTask(srcDir, taskName, pouName);
            }

            return sendJson(res, 200, {
                ok: true,
                fileName,
                pouName,
                pouType: upperType,
                pouLang: upperLang,
                structure: scanProjectStructure(srcDir)
            });
        }

        if (req.method === 'POST' && url.pathname === '/api/task/bind') {
            const { taskName, programName } = await readJson(req);
            const srcDir = getProjectSrcDir(activeProject);
            bindProgramToTask(srcDir, taskName, programName);
            return sendJson(res, 200, { ok: true, structure: scanProjectStructure(srcDir) });
        }

        if (req.method === 'GET' && url.pathname === '/api/files') {
            const srcDir = getProjectSrcDir(activeProject);
            const files = fs.readdirSync(srcDir)
                .filter(f => f.toLowerCase().endsWith('.st'))
                .sort()
                .map(name => ({
                    name,
                    content: fs.readFileSync(path.join(srcDir, name), 'utf8')
                }));
            return sendJson(res, 200, { project: activeProject, files, structure: scanProjectStructure(srcDir) });
        }

        if (req.method === 'POST' && url.pathname === '/api/files') {
            const { name, content } = await readJson(req);
            const safeName = path.basename(name || '');
            if (!safeName.toLowerCase().endsWith('.st')) {
                return sendJson(res, 400, { ok: false, error: 'Файл должен иметь расширение .st' });
            }
            const srcDir = getProjectSrcDir(activeProject);
            fs.writeFileSync(path.join(srcDir, safeName), content, 'utf8');
            return sendJson(res, 200, { ok: true, structure: scanProjectStructure(srcDir) });
        }

        if (req.method === 'DELETE' && url.pathname === '/api/files') {
            const safeName = path.basename(url.searchParams.get('name') || '');
            const srcDir = getProjectSrcDir(activeProject);
            const target = path.join(srcDir, safeName);
            if (fs.existsSync(target)) fs.unlinkSync(target);
            return sendJson(res, 200, { ok: true, structure: scanProjectStructure(srcDir) });
        }

        if (req.method === 'POST' && url.pathname === '/api/compile') {
            const srcDir = getProjectSrcDir(activeProject);
            try {
                const resUpdate = engine.onlineUpdate(srcDir);
                return sendJson(res, 200, {
                    ok: true,
                    mode: resUpdate.mode,
                    tick: resUpdate.tick || 0,
                    log: `Проект [${activeProject}] собран. Режим: ${resUpdate.mode} (Tick: ${resUpdate.tick || 0})`
                });
            } catch (err) {
                return sendJson(res, 200, { ok: false, error: err.message });
            }
        }

        if (req.method === 'POST' && url.pathname === '/api/force') {
            const { name, value, enabled } = await readJson(req);
            if (enabled) engine.forcedVars.set(name, value);
            else engine.forcedVars.delete(name);
            return sendJson(res, 200, { ok: true });
        }

        if (req.method === 'POST' && url.pathname === '/api/plant') {
            const patch = await readJson(req);
            Object.assign(modbus.plant, patch);
            return sendJson(res, 200, { ok: true, plant: modbus.plant });
        }

        if (req.method === 'POST' && url.pathname === '/api/system') {
            const { action } = await readJson(req);
            if (action === 'resetMaxScan') engine.resetDiagnostics();
            else if (action === 'saveRetain' && engine.bridge) engine.retainManager.save(engine.bridge.readRetainSnapshot(), true);
            return sendJson(res, 200, { ok: true });
        }

        const filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return fs.createReadStream(filePath).pipe(res);
        }

        res.writeHead(404);
        res.end('Not Found');
    } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
    }
});

const wss = new WebSocketServer({ server });

setInterval(() => {
    if (wss.clients.size === 0) return;
    const diag = engine.getDiagnostics() || {
        tickSeq: 0, lastScanUs: 0, maxScanUs: 0, overrunCount: 0,
        targetCycleUs: 10000, lastJitterUs: 0, cpuLoadPct: 0
    };
    const variables = [];
    if (engine.isRunning && engine.meta && engine.bridge) {
        const liveValues = engine.readOutputs();
        for (const field of engine.meta.outputs) {
            variables.push({
                name: field.name,
                iecType: field.iecType,
                varClass: field.varClass,
                isRetain: field.isRetain,
                offset: field.offset,
                value: liveValues[field.name],
                forced: engine.forcedVars.has(field.name)
            });
        }
    }
    const packet = JSON.stringify({
        activeProject,
        isRunning: engine.isRunning,
        telemetry: diag,
        variables,
        plant: modbus.plant,
        modbus: {
            coils: Array.from(modbus.coils.slice(0, 8)),
            discreteInputs: Array.from(modbus.discreteInputs.slice(0, 8)),
            holdingRegisters: Array.from(modbus.holdingRegisters.slice(0, 8))
        }
    });
    for (const client of wss.clients) {
        if (client.readyState === 1) client.send(packet);
    }
}, 50);

(async () => {
    try {
        engine.start(getProjectSrcDir(activeProject));
    } catch (err) {
        console.warn(`[SoftPLC] Стартовый проект "${activeProject}" ожидает компиляции в Web-IDE:`, err.message);
    }
    modbus.start();
    server.listen(PORT, () => {
        console.log(`[Web-IDE v1.7 IEC Multi-Lang (ST/SFC/FBD/IL/LD)] Открыто: http://localhost:${PORT}`);
    });
})();
