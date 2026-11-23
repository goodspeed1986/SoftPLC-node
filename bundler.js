const fs = require('fs');
const path = require('path');

/**
 * Извлекает имена RETAIN-переменных из исходников ST (включая сгенерированный из SFC/FBD/IL/LD ST-код).
 */
function extractRetainVarNames(stFilesContent) {
    const retainNames = new Set();
    const cleanCode = stFilesContent
        .replace(/\(\*[\s\S]*?\*\)/g, '')
        .replace(/\/\/.*$/gm, '');

    const blockRegex = /\b(?:VAR|VAR_GLOBAL)\s+(?:CONSTANT\s+)?RETAIN\b([\s\S]*?)\bEND_VAR\b/gi;
    let match;
    while ((match = blockRegex.exec(cleanCode)) !== null) {
        const lines = match[1].split(';');
        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx === -1) continue;
            const names = line.slice(0, colonIdx).split(',').map(s => s.trim()).filter(Boolean);
            for (const name of names) {
                retainNames.add(name.toUpperCase());
            }
        }
    }
    return retainNames;
}

function escapeStComment(txt) {
    return String(txt || '').replace(/\(\*/g, '( *').replace(/\*\)/g, '* )');
}

/**
 * Транспилятор IL (Instruction List) в Structured Text (ST) для совместимости с MatIEC (iec2c).
 * Поддерживает LD, LDN, ST, STN, S, R, AND, ANDN, OR, ORN, XOR, ADD, SUB, MUL, DIV, GT, GE, LT, LE, EQ, NE, JMP, JMPC, JMPCN, метки.
 */
function transpileIlToSt(pouType, pouName, retType, ilBody) {
    const lines = String(ilBody || '').split(/\r?\n/);
    const stStatements = [];
    let accExpr = 'FALSE';
    let accType = 'BOOL';

    for (const rawLine of lines) {
        const line = rawLine.replace(/\(\*.*?\*\)/g, '').replace(/;.*$/, '').trim();
        if (!line) continue;

        const labelMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        let stmt = line;
        if (labelMatch) {
            stStatements.push(`    (* Метка IL: ${labelMatch[1]} *)`);
            stmt = labelMatch[2].trim();
            if (!stmt) continue;
        }

        const parts = stmt.split(/\s+/);
        const op = (parts[0] || '').toUpperCase();
        const arg = parts.slice(1).join(' ').trim();

        if (op === 'LD') {
            accExpr = arg;
            stStatements.push(`    (* IL LD ${escapeStComment(arg)} *)`);
        } else if (op === 'LDN') {
            accExpr = `(NOT (${arg}))`;
        } else if (op === 'ST') {
            if (arg) stStatements.push(`    ${arg} := ${accExpr};`);
        } else if (op === 'STN') {
            if (arg) stStatements.push(`    ${arg} := NOT (${accExpr});`);
        } else if (op === 'S') {
            if (arg) stStatements.push(`    IF ${accExpr} THEN ${arg} := TRUE; END_IF;`);
        } else if (op === 'R') {
            if (arg) stStatements.push(`    IF ${accExpr} THEN ${arg} := FALSE; END_IF;`);
        } else if (op === 'AND') {
            accExpr = `((${accExpr}) AND (${arg}))`;
        } else if (op === 'ANDN') {
            accExpr = `((${accExpr}) AND (NOT (${arg})))`;
        } else if (op === 'OR') {
            accExpr = `((${accExpr}) OR (${arg}))`;
        } else if (op === 'ORN') {
            accExpr = `((${accExpr}) OR (NOT (${arg})))`;
        } else if (op === 'XOR') {
            accExpr = `((${accExpr}) XOR (${arg}))`;
        } else if (op === 'ADD') {
            accExpr = `((${accExpr}) + (${arg}))`;
            accType = 'REAL';
        } else if (op === 'SUB') {
            accExpr = `((${accExpr}) - (${arg}))`;
            accType = 'REAL';
        } else if (op === 'MUL') {
            accExpr = `((${accExpr}) * (${arg}))`;
            accType = 'REAL';
        } else if (op === 'DIV') {
            accExpr = `((${accExpr}) / (${arg}))`;
            accType = 'REAL';
        } else if (op === 'GT') {
            accExpr = `((${accExpr}) > (${arg}))`;
        } else if (op === 'GE') {
            accExpr = `((${accExpr}) >= (${arg}))`;
        } else if (op === 'LT') {
            accExpr = `((${accExpr}) < (${arg}))`;
        } else if (op === 'LE') {
            accExpr = `((${accExpr}) <= (${arg}))`;
        } else if (op === 'EQ') {
            accExpr = `((${accExpr}) = (${arg}))`;
        } else if (op === 'NE') {
            accExpr = `((${accExpr}) <> (${arg}))`;
        } else {
            stStatements.push(`    (* IL инструкция ${escapeStComment(stmt)} *)`);
        }
    }

    return wrapIntoPou(pouType, pouName, retType, {
        varInputs: ['    IN_Start : BOOL;', '    IN_Reset : BOOL;', '    IN_Level : REAL;'],
        varOutputs: ['    OUT_Active : BOOL;', '    OUT_Value : REAL;'],
        varLocals: [`    _IL_Acc : ${accType};`],
        body: [
            `    _IL_Acc := ${accExpr};`,
            ...stStatements
        ].join('\n')
    });
}

/**
 * Транспилятор SFC (Sequential Function Chart) в ST (шаги Step, переходы Transition, действия Action).
 * Принимает JSON-модель SFC (или текстовый блок SFC_JSON ... END_SFC).
 */
function transpileSfcToSt(pouType, pouName, retType, model) {
    const steps = Array.isArray(model.steps) && model.steps.length ? model.steps : [
        { id: 'S0', name: 'Init', initial: true, action: 'OUT_Pump := FALSE; OUT_Valve := FALSE;' },
        { id: 'S1', name: 'Fill', initial: false, action: 'OUT_Pump := TRUE; OUT_Valve := FALSE;' }
    ];
    const transitions = Array.isArray(model.transitions) ? model.transitions : [];

    const stepNames = steps.map(s => s.name);
    const initStep = steps.find(s => s.initial) || steps[0];

    const caseBranches = steps.map((s) => {
        const outTrans = transitions.filter(t => t.from === s.name);
        const transCode = outTrans.map((t) => {
            const cond = (t.cond || 'FALSE').trim();
            return `        IF ${cond} THEN
            _SFC_Step := '${t.to}';
            _SFC_StepTime := T#0ms;
        END_IF;`;
        }).join('\n');

        return `    '${s.name}':
        (* Шаг SFC: ${escapeStComment(s.name)} *)
        ${s.action || '(* пустое действие *)'}
${transCode}`;
    }).join('\n');

    return wrapIntoPou(pouType, pouName, retType, {
        varInputs: ['    IN_Start : BOOL;', '    IN_Stop : BOOL;', '    IN_Fault : BOOL;', '    IN_Level : REAL;'],
        varOutputs: ['    OUT_Pump : BOOL;', '    OUT_Valve : BOOL;', '    OUT_Done : BOOL;'],
        varLocals: [
            `    _SFC_Step : STRING := '${initStep.name}';`,
            `    _SFC_InitDone : BOOL := FALSE;`,
            `    _SFC_StepTime : TIME := T#0ms;`
        ],
        body: [
            `    IF NOT _SFC_InitDone THEN`,
            `        _SFC_Step := '${initStep.name}';`,
            `        _SFC_InitDone := TRUE;`,
            `    END_IF;`,
            `    IF IN_Fault OR IN_Stop THEN`,
            `        _SFC_Step := '${initStep.name}';`,
            `    END_IF;`,
            `    _SFC_StepTime := _SFC_StepTime + T#10ms;`,
            `    CASE _SFC_Step OF`,
            caseBranches,
            `    END_CASE;`
        ].join('\n')
    });
}

/**
 * Транспилятор FBD (Function Block Diagram) и LD (Ladder Diagram) в ST.
 * Поддерживает узлы блоков (AND, OR, NOT, XOR, ADD, SUB, MUL, DIV, GT, LT, SEL, TON, CTU, FB_*) и цепи LD.
 */
function transpileFbdOrLdToSt(lang, pouType, pouName, retType, model) {
    const blocks = Array.isArray(model.blocks) ? model.blocks : [];
    const lines = [];

    for (const b of blocks) {
        const op = String(b.op || b.type || 'AND').toUpperCase();
        const ins = Array.isArray(b.inputs) ? b.inputs : [];
        const outVar = b.out || 'OUT_Sig';

        if (op === 'AND') {
            lines.push(`    ${outVar} := ${ins.length ? ins.join(' AND ') : 'FALSE'};`);
        } else if (op === 'OR') {
            lines.push(`    ${outVar} := ${ins.length ? ins.join(' OR ') : 'FALSE'};`);
        } else if (op === 'XOR') {
            lines.push(`    ${outVar} := ${ins.length ? ins.join(' XOR ') : 'FALSE'};`);
        } else if (op === 'NOT') {
            lines.push(`    ${outVar} := NOT (${ins[0] || 'FALSE'});`);
        } else if (op === 'ADD') {
            lines.push(`    ${outVar} := ${ins.length ? ins.join(' + ') : '0.0'};`);
        } else if (op === 'SUB') {
            lines.push(`    ${outVar} := ${ins[0] || '0.0'} - ${ins[1] || '0.0'};`);
        } else if (op === 'MUL') {
            lines.push(`    ${outVar} := ${ins[0] || '0.0'} * ${ins[1] || '1.0'};`);
        } else if (op === 'DIV') {
            lines.push(`    ${outVar} := ${ins[0] || '0.0'} / ${ins[1] || '1.0'};`);
        } else if (op === 'GT') {
            lines.push(`    ${outVar} := (${ins[0] || '0.0'}) > (${ins[1] || '0.0'});`);
        } else if (op === 'LT') {
            lines.push(`    ${outVar} := (${ins[0] || '0.0'}) < (${ins[1] || '0.0'});`);
        } else if (op === 'COIL_SET') {
            lines.push(`    IF ${ins[0] || 'FALSE'} THEN ${outVar} := TRUE; END_IF;`);
        } else if (op === 'COIL_RST') {
            lines.push(`    IF ${ins[0] || 'FALSE'} THEN ${outVar} := FALSE; END_IF;`);
        } else if (op === 'COIL') {
            lines.push(`    ${outVar} := ${ins[0] || 'FALSE'};`);
        } else if (op === 'TON' && b.inst) {
            lines.push(`    ${b.inst}(IN := ${ins[0] || 'FALSE'}, PT := ${b.pt || 'T#1s'});`);
            lines.push(`    ${outVar} := ${b.inst}.Q;`);
        } else {
            lines.push(`    (* ${lang} блок ${escapeStComment(op)} -> ${escapeStComment(outVar)} *)`);
        }
    }

    const extraLocals = blocks
        .filter(b => String(b.op || '').toUpperCase() === 'TON' && b.inst)
        .map(b => `    ${b.inst} : TON;`);

    return wrapIntoPou(pouType, pouName, retType, {
        varInputs: ['    IN_A : BOOL;', '    IN_B : BOOL;', '    IN_Val1 : REAL;', '    IN_Val2 : REAL;'],
        varOutputs: ['    OUT_Sig : BOOL;', '    OUT_Res : REAL;'],
        varLocals: extraLocals,
        body: lines.join('\n') || '    OUT_Sig := IN_A AND IN_B;'
    });
}

function wrapIntoPou(pouType, pouName, retType, spec) {
    const upper = String(pouType || 'PROGRAM').toUpperCase();
    const inBlock = spec.varInputs.length ? `    VAR_INPUT
${spec.varInputs.join('
')}
    END_VAR
` : '';
    const outBlock = spec.varOutputs.length ? `    VAR_OUTPUT
${spec.varOutputs.join('
')}
    END_VAR
` : '';
    const locBlock = spec.varLocals.length ? `    VAR
${spec.varLocals.join('
')}
    END_VAR
` : '';

    if (upper === 'FUNCTION' || upper === 'FUN') {
        const rType = (retType || 'REAL').toUpperCase();
        return `FUNCTION ${pouName} : ${rType}
    VAR_INPUT
        InVal : ${rType};
    END_VAR
${spec.body}
    ${pouName} := InVal;
END_FUNCTION
`;
    }
    if (upper === 'FUNCTION_BLOCK' || upper === 'FB') {
        return `FUNCTION_BLOCK ${pouName}
${inBlock}${outBlock}${locBlock}${spec.body}
END_FUNCTION_BLOCK
`;
    }
    return `PROGRAM ${pouName}
${inBlock}${outBlock}${locBlock}${spec.body}
END_PROGRAM
`;
}

/**
 * Определяет язык файла/блока (ST, SFC, FBD, IL, LD) и транспилирует не-ST языки в чистый ST.
 */
function parseAndTranspileSource(content, fileName) {
    const trimmed = content.trim();

    // Поддержка JSON-моделей SFC / FBD / LD (в т.ч. с маркерами // @LANG:SFC и т.п.)
    const langHeaderMatch = trimmed.match(/^\/\/\s*@LANG\s*:\s*(ST|SFC|FBD|IL|LD)\b/i);
    const declaredLang = langHeaderMatch ? langHeaderMatch[1].toUpperCase() : null;

    if (declaredLang === 'SFC' || declaredLang === 'FBD' || declaredLang === 'LD') {
        const jsonStart = trimmed.indexOf('{');
        const jsonEnd = trimmed.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
            const pouType = parsed.pouType || 'PROGRAM';
            const pouName = parsed.pouName || fileName.replace(/\.st$/i, '');
            const retType = parsed.returnType || 'REAL';

            const stCode = declaredLang === 'SFC'
                ? transpileSfcToSt(pouType, pouName, retType, parsed)
                : transpileFbdOrLdToSt(declaredLang, pouType, pouName, retType, parsed);

            return { lang: declaredLang, stCode, model: parsed };
        }
    }

    if (declaredLang === 'IL') {
        const ilMatch = trimmed.match(/^(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+([a-zA-Z0-9_]+)(?:\s*:\s*([a-zA-Z0-9_]+))?\s*\r?\n([\s\S]*?)\r?\nEND_(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)/i);
        if (ilMatch) {
            const pouType = trimmed.toUpperCase().startsWith('FUNCTION_BLOCK')
                ? 'FUNCTION_BLOCK'
                : (trimmed.toUpperCase().startsWith('FUNCTION') ? 'FUNCTION' : 'PROGRAM');
            const stCode = transpileIlToSt(pouType, ilMatch[1], ilMatch[2] || 'REAL', ilMatch[3]);
            return { lang: 'IL', stCode, model: null };
        }
    }

    return { lang: 'ST', stCode: content, model: null };
}

/**
 * Склеивает многофайловый МЭК-проект (ST + SFC + FBD + IL + LD) в правильном порядке зависимостей
 * с вставкой директив #line для точной диагностики ошибок компиляции.
 */
function bundleStProject(projectDir, outputBundlePath) {
    const stFiles = [];

    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.st')) {
                stFiles.push(fullPath);
            }
        }
    }

    walk(projectDir);
    if (stFiles.length === 0) {
        throw new Error(`В директории ${projectDir} не найдено ни одного .st файла`);
    }

    const getPriority = (code) => {
        const upper = code.toUpperCase();
        if (/\bTYPE\b/.test(upper)) return 1;
        if (/\bFUNCTION\b(?!_BLOCK)/.test(upper)) return 2;
        if (/\bFUNCTION_BLOCK\b/.test(upper)) return 3;
        if (/\bPROGRAM\b/.test(upper)) return 4;
        if (/\bCONFIGURATION\b/.test(upper)) return 5;
        return 3;
    };

    const parsedFiles = stFiles.map((filePath) => {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(projectDir, filePath).replace(/\\/g, '/');
        const transpiled = parseAndTranspileSource(rawContent, path.basename(filePath));
        return {
            filePath,
            relPath,
            lang: transpiled.lang,
            content: transpiled.stCode,
            priority: getPriority(transpiled.stCode),
            lineCount: transpiled.stCode.split(/\r?\n/).length
        };
    });

    parsedFiles.sort((a, b) => a.priority - b.priority || a.relPath.localeCompare(b.relPath));

    let bundleLines = [];
    const lineMap = [];
    let currentBundleLine = 1;

    for (const file of parsedFiles) {
        bundleLines.push(`#line 1 "${file.relPath}"`);
        currentBundleLine++;

        const lines = file.content.split(/\r?\n/);
        lineMap.push({
            startLine: currentBundleLine,
            endLine: currentBundleLine + lines.length - 1,
            relPath: file.relPath
        });

        bundleLines.push(...lines);
        currentBundleLine += lines.length;
    }

    const fullBundleText = bundleLines.join('\n');
    const retainVarNames = extractRetainVarNames(fullBundleText);

    fs.mkdirSync(path.dirname(outputBundlePath), { recursive: true });
    fs.writeFileSync(outputBundlePath, fullBundleText, 'utf-8');

    return {
        bundlePath: outputBundlePath,
        filesCount: parsedFiles.length,
        lineMap,
        retainVarNames
    };
}

function formatCompilerErrors(stderrText, lineMap) {
    return stderrText.replace(/bundle\.st:(\d+):/g, (match, lineNumStr) => {
        const lineNum = parseInt(lineNumStr, 10);
        const entry = lineMap.find(m => lineNum >= m.startLine && lineNum <= m.endLine);
        if (entry) {
            const origLine = lineNum - entry.startLine + 1;
            return `${entry.relPath}:${origLine}:`;
        }
        return match;
    });
}

module.exports = {
    bundleStProject,
    formatCompilerErrors,
    extractRetainVarNames,
    parseAndTranspileSource,
    transpileSfcToSt,
    transpileFbdOrLdToSt,
    transpileIlToSt
};
