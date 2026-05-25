import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SENSITIVE_KEYS = [
    'api_key', 'proxy_password', 'secret_id', 'reverse_proxy',
    'api_server', 'custom_url', 'azure_base_url',
];

function stripSensitive(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const cleaned = Array.isArray(obj) ? [...obj] : { ...obj };
    for (const key of SENSITIVE_KEYS) {
        if (key in cleaned) {
            cleaned[key] = '[REDACTED]';
        }
    }
    return cleaned;
}

function getLogDir(request, charName) {
    const userDir = request.user?.directories?.root;
    if (!userDir) return null;
    const base = path.join(userDir, 'prompt-logs');
    if (charName) {
        const safe = charName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unknown';
        return path.join(base, safe);
    }
    return base;
}

function ensureLogDir(logDir) {
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
}

function getNextRoundName(logDir, isRetry) {
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.startsWith('round_')) : [];

    let maxRound = 0;
    let maxRetry = 0;
    for (const f of files) {
        const roundMatch = f.match(/^round_(\d+)(?:_retry_(\d+))?\.json$/);
        if (roundMatch) {
            const r = parseInt(roundMatch[1], 10);
            if (r > maxRound) {
                maxRound = r;
                maxRetry = 0;
            }
            if (r === maxRound && roundMatch[2]) {
                maxRetry = Math.max(maxRetry, parseInt(roundMatch[2], 10));
            }
        }
    }

    if (isRetry && maxRound > 0) {
        return `round_${maxRound}_retry_${maxRetry + 1}.json`;
    }
    return `round_${maxRound + 1}.json`;
}

function classifySource(identifier) {
    if (!identifier) return null;
    if (['main', 'nsfw', 'jailbreak'].includes(identifier)) return 'preset';
    if (/^chatHistory-/.test(identifier)) return 'chat';
    if (identifier === 'worldInfoBefore' || identifier === 'worldInfoAfter') return 'worldInfo';
    if (['charDescription', 'charPersonality', 'scenario', 'personaDescription'].includes(identifier)) return 'charCard';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(identifier)) return 'preset';
    return 'other';
}

const requestIdToPath = new Map();

export function generateRequestId() {
    return crypto.randomUUID().substring(0, 8);
}

export function logInput(request, requestId, requestBody, apiType) {
    try {
        const charName = requestBody?.char_name || requestBody?.charName || '';
        const logDir = getLogDir(request, charName);
        if (!logDir) return;
        ensureLogDir(logDir);

        const timestamp = new Date().toISOString();
        const isRetry = requestBody?.type === 'swipe' || requestBody?.type === 'regenerate';
        const fileName = getNextRoundName(logDir, isRetry);
        const filePath = path.join(logDir, fileName);

        const cleaned = stripSensitive(requestBody);
        if (cleaned._message_identifiers && Array.isArray(cleaned.messages)) {
            const ids = cleaned._message_identifiers;
            cleaned.messages = cleaned.messages.map((msg, i) => {
                const id = ids[i] || null;
                const source = classifySource(id);
                return {
                    ...msg,
                    ...(id ? { identifier: id } : {}),
                    ...(source ? { source } : {}),
                };
            });
            delete cleaned._message_identifiers;
        }
        const logEntry = {
            request_id: requestId,
            timestamp: timestamp,
            api_type: apiType,
            input: cleaned,
            output: null,
        };

        fs.writeFileSync(filePath, JSON.stringify(logEntry, null, 2), 'utf8');
        requestIdToPath.set(requestId, filePath);
    } catch (error) {
        console.error('prompt-logger: Failed to log input:', error.message);
    }
}

export function logOutput(request, requestId, outputData) {
    try {
        const filePath = requestIdToPath.get(requestId);
        if (!filePath || !fs.existsSync(filePath)) return;

        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        content.output = outputData;
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8');
        requestIdToPath.delete(requestId);
    } catch (error) {
        console.error('prompt-logger: Failed to log output:', error.message);
    }
}
