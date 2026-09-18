import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const TOOL_NAME = 'read_agent_context';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_EVENTS = 1000;
export const MAX_LAPS = 1000;
export const MAX_SESSIONS = 100;
export const MAX_SESSION_BYTES = 4 * 1024 * 1024;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReadInput { sessionId: string; filePath: string; startLine: number; endLine: number }
export interface ReadEvent {
    id: string;
    rootId: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    requestedEndLine: number;
    snapshotHash: string;
    isDirty: boolean;
    at: string;
    lap?: number;
}
export interface Session {
    schemaVersion: 1;
    id: string;
    label: string;
    owner: string;
    state: 'recording' | 'paused' | 'stopped';
    generation: number;
    currentLap: number;
    createdAt: string;
    roots: string[];
    coverage: 'instrumented-tool-only';
    events: ReadEvent[];
}
export interface Root { id: string; directory: string; name: string }

export function hash(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

export interface ReadRange { startLine: number; endLine: number; readCount: number }
export interface HighlightEvidence { id?: string; startLine?: number; endLine?: number; snapshotHash?: string }
export type ReadFrequency = 'single' | 'repeat' | 'frequent' | 'intense';

export function readFrequency(readCount: number): ReadFrequency {
    return readCount >= 8 ? 'intense' : readCount >= 4 ? 'frequent' : readCount >= 2 ? 'repeat' : 'single';
}

export function readHighlightRanges(events: readonly HighlightEvidence[], snapshotHash: string, lineCount: number, allowUnverified: boolean): { verified: ReadRange[]; unverified: ReadRange[] } {
    const verified: ReadRange[] = [];
    const unverified: ReadRange[] = [];
    const seen = new Set<string>();
    for (const event of events) {
        const { startLine, endLine } = event;
        if (startLine === undefined || endLine === undefined || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
            || startLine < 1 || endLine < startLine || endLine > lineCount || endLine === Number.MAX_SAFE_INTEGER) { continue; }
        if (event.id !== undefined) {
            if (seen.has(event.id)) { continue; }
            seen.add(event.id);
        }
        if (event.snapshotHash === snapshotHash) { verified.push({ startLine, endLine, readCount: 1 }); }
        else if (event.snapshotHash === undefined && allowUnverified) { unverified.push({ startLine, endLine, readCount: 1 }); }
    }
    const countRanges = (ranges: ReadRange[]): ReadRange[] => {
        const boundaries = new Map<number, number>();
        for (const range of ranges) {
            boundaries.set(range.startLine, (boundaries.get(range.startLine) ?? 0) + 1);
            boundaries.set(range.endLine + 1, (boundaries.get(range.endLine + 1) ?? 0) - 1);
        }
        const merged: ReadRange[] = [];
        let previousLine = 0;
        let readCount = 0;
        for (const [line, delta] of [...boundaries].sort(([left], [right]) => left - right)) {
            if (readCount > 0 && line > previousLine) {
                const previous = merged.at(-1);
                if (previous && previous.endLine + 1 === previousLine && previous.readCount === readCount) { previous.endLine = line - 1; }
                else { merged.push({ startLine: previousLine, endLine: line - 1, readCount }); }
            }
            readCount += delta;
            previousLine = line;
        }
        return merged;
    };
    return { verified: countRanges(verified), unverified: countRanges(unverified) };
}

export function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function excluded(relativePath: string): boolean {
    const parts = relativePath.toLowerCase().split(/[\\/]/);
    return parts.some(part => ['.git', 'node_modules', '.ssh', '.aws', '.azure', '.npmrc', '.pypirc', 'credentials', 'id_rsa', 'id_ed25519'].includes(part)
        || part === '.env' || part.startsWith('.env.') || /\.(pem|key|pfx|p12)$/.test(part));
}

export async function resolveFile(filePath: string, roots: readonly Root[]): Promise<{ root: Root; filePath: string; relativePath: string }> {
    if (!path.isAbsolute(filePath) || /^[\\/]{2}/.test(filePath) || filePath.includes('\0')
        || filePath.split(/[\\/]/).includes('..') || filePath.slice(path.parse(filePath).root.length).includes(':')) {
        throw new Error('Use an absolute local workspace file path without traversal or device syntax.');
    }
    const lexicalRoot = roots.find(root => isWithin(root.directory, filePath));
    if (!lexicalRoot || excluded(path.relative(lexicalRoot.directory, filePath))) {
        throw new Error('File is outside the workspace or excluded from tracked reads.');
    }
    const resolved = await fs.realpath(filePath);
    if (!isWithin(lexicalRoot.directory, resolved) || excluded(path.relative(lexicalRoot.directory, resolved))) {
        throw new Error('Symbolic link or junction leaves the allowed workspace scope.');
    }
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { throw new Error('Expected a text file no larger than 1 MiB.'); }
    return { root: lexicalRoot, filePath: resolved, relativePath: path.relative(lexicalRoot.directory, resolved).split(path.sep).join('/') };
}

export function validateInput(value: unknown): ReadInput {
    if (!value || typeof value !== 'object') { throw new Error('Expected read parameters.'); }
    const input = value as ReadInput;
    if (Object.keys(input).sort().join(',') !== 'endLine,filePath,sessionId,startLine'
        || typeof input.sessionId !== 'string' || typeof input.filePath !== 'string'
        || !Number.isSafeInteger(input.startLine) || !Number.isSafeInteger(input.endLine)
        || input.startLine < 1 || input.endLine < input.startLine || input.endLine - input.startLine >= 500) {
        throw new Error('Provide sessionId, filePath, and an inclusive 1-based range of at most 500 lines.');
    }
    return input;
}

export function sliceRead(text: string, input: ReadInput): { output: string; endLine: number; snapshotHash: string } {
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES || /[\u0000-\u0008\u000e-\u001f\ufffd]/.test(text)) {
        throw new Error('File must be supported text no larger than 1 MiB.');
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (input.startLine > lines.length) { throw new Error('Start line is past the end of this file.'); }
    const endLine = Math.min(input.endLine, lines.length);
    const output = lines.slice(input.startLine - 1, endLine).map((line, index) => `${input.startLine + index}: ${line}`).join('\n');
    if (output.length > 31000) { throw new Error('Response is too large. Request fewer lines.'); }
    return { output, endLine, snapshotHash: hash(text) };
}

export function summary(events: readonly ReadEvent[]): { volume: number; unique: number; repeated: number } {
    const groups = new Map<string, ReadEvent[]>();
    let volume = 0;
    for (const event of events) {
        const key = JSON.stringify([event.rootId, event.relativePath, event.snapshotHash]);
        const group = groups.get(key) ?? [];
        group.push(event);
        groups.set(key, group);
        volume += event.endLine - event.startLine + 1;
    }
    let unique = 0;
    for (const group of groups.values()) {
        let previousEnd = 0;
        for (const event of group.sort((left, right) => left.startLine - right.startLine)) {
            unique += Math.max(0, event.endLine - Math.max(previousEnd, event.startLine - 1));
            previousEnd = Math.max(previousEnd, event.endLine);
        }
    }
    return { volume, unique, repeated: volume - unique };
}

function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function parseSession(value: unknown): Session {
    if (!object(value) || value.schemaVersion !== 1 || value.coverage !== 'instrumented-tool-only'
        || typeof value.id !== 'string' || !uuid.test(value.id) || typeof value.owner !== 'string' || !uuid.test(value.owner)
        || typeof value.label !== 'string' || value.label.length > 80 || !date(value.createdAt)
        || !['recording', 'paused', 'stopped'].includes(String(value.state))
        || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0
        || !Array.isArray(value.roots) || !value.roots.length || !value.roots.every(root => typeof root === 'string' && digest.test(root))
        || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) { throw new Error('Unsupported session metadata.'); }
    const currentLap = value.currentLap === undefined ? 1 : Number(value.currentLap);
    if (!Number.isSafeInteger(currentLap) || currentLap < 1 || currentLap > MAX_LAPS) { throw new Error('Unsupported session metadata.'); }
    const seen = new Set<string>();
    const events = value.events.map((event: unknown): ReadEvent => {
        if (!object(event) || typeof event.id !== 'string' || !uuid.test(event.id) || seen.has(event.id)
            || typeof event.rootId !== 'string' || !(value.roots as string[]).includes(event.rootId)
            || typeof event.relativePath !== 'string' || !event.relativePath || event.relativePath.length > 4096
            || event.relativePath.startsWith('/') || /[\\:\x00-\x1f]/.test(event.relativePath)
            || event.relativePath.split('/').some(part => !part || part === '.' || part === '..') || excluded(event.relativePath)
            || !Number.isSafeInteger(event.startLine) || Number(event.startLine) < 1
            || !Number.isSafeInteger(event.endLine) || Number(event.endLine) < Number(event.startLine)
            || !Number.isSafeInteger(event.requestedEndLine) || Number(event.requestedEndLine) < Number(event.endLine)
            || Number(event.requestedEndLine) - Number(event.startLine) >= 500
            || typeof event.snapshotHash !== 'string' || !digest.test(event.snapshotHash)
            || typeof event.isDirty !== 'boolean' || !date(event.at)
            || (event.lap !== undefined && (!Number.isSafeInteger(event.lap) || Number(event.lap) < 1 || Number(event.lap) > currentLap))) {
            throw new Error('Invalid read metadata.');
        }
        seen.add(event.id);
        return { id: event.id, rootId: event.rootId, relativePath: event.relativePath, startLine: Number(event.startLine),
            endLine: Number(event.endLine), requestedEndLine: Number(event.requestedEndLine), snapshotHash: event.snapshotHash,
            isDirty: event.isDirty, at: event.at, lap: event.lap === undefined ? 1 : Number(event.lap) };
    });
    return { schemaVersion: 1, id: value.id, owner: value.owner, label: value.label, createdAt: value.createdAt,
        roots: value.roots, state: value.state as Session['state'], generation: Number(value.generation), currentLap,
        coverage: 'instrumented-tool-only', events };
}

export class TraceStore {
    readonly owner = randomUUID();
    private sessions = new Map<string, Session>();
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly directory: string, private readonly changed: () => void = () => {}) {}

    list(): Session[] { return structuredClone([...this.sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))); }
    get(id: string): Session | undefined { const session = this.sessions.get(id); return session ? structuredClone(session) : undefined; }
    current(): Session | undefined { return this.list().find(session => session.owner === this.owner && session.state !== 'stopped'); }

    async load(): Promise<number> {
        await fs.mkdir(this.directory, { recursive: true });
        const entries = await fs.readdir(this.directory);
        let skipped = 0;
        for (const entry of entries.filter(name => name.endsWith('.json')).slice(0, MAX_SESSIONS)) {
            try {
                const file = path.join(this.directory, entry);
                if ((await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)).size > MAX_SESSION_BYTES) { throw new Error('Invalid metadata file.'); }
                const session = parseSession(JSON.parse(await fs.readFile(file, 'utf8')));
                if (entry !== `${session.id}.json`) { throw new Error('Session identity mismatch.'); }
                this.sessions.set(session.id, session);
            } catch { skipped++; }
        }
        return skipped + Math.max(0, entries.filter(name => name.endsWith('.json')).length - MAX_SESSIONS);
    }

    private enqueue<Result>(action: () => Promise<Result>): Promise<Result> {
        const next = this.tail.then(action);
        this.tail = next.catch(() => undefined);
        return next;
    }

    private async save(session: Session): Promise<void> {
        const validated = parseSession(session);
        const body = JSON.stringify(validated);
        if (Buffer.byteLength(body) > MAX_SESSION_BYTES) { throw new Error('Session storage limit reached. Start a new session.'); }
        const target = path.join(this.directory, `${session.id}.json`);
        const temporary = `${target}.${this.owner}.tmp`;
        try {
            await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
            await fs.rename(temporary, target);
        } finally { await fs.rm(temporary, { force: true }); }
        this.sessions.set(session.id, validated);
        this.changed();
    }

    start(label: string, roots: string[]): Promise<Session> {
        return this.enqueue(async () => {
            if (this.current()) { throw new Error('Stop the current tracker session first.'); }
            const cleanLabel = label.trim();
            if (!cleanLabel || cleanLabel.length > 80 || /[\x00-\x1f]/.test(cleanLabel)) { throw new Error('Use a session name of 1-80 printable characters.'); }
            await this.prune();
            if ((await fs.readdir(this.directory)).filter(name => name.endsWith('.json')).length >= MAX_SESSIONS) {
                throw new Error('History is full. Delete a stopped session first.');
            }
            const session: Session = { schemaVersion: 1, id: randomUUID(), owner: this.owner, label: cleanLabel, state: 'recording',
                generation: 0, currentLap: 1, roots, coverage: 'instrumented-tool-only', createdAt: new Date().toISOString(), events: [] };
            await this.save(session);
            return structuredClone(session);
        });
    }

    requireRecording(id: string, generation?: number): Session {
        const session = this.get(id);
        if (!session || session.owner !== this.owner || session.state !== 'recording'
            || (generation !== undefined && generation !== session.generation)) {
            throw new Error('Tracker session is not recording here. Start or resume a session and use its current ID.');
        }
        return session;
    }

    setState(id: string, state: Session['state']): Promise<void> {
        return this.enqueue(async () => {
            const session = this.get(id);
            if (!session || session.owner !== this.owner || session.state === 'stopped') { throw new Error('This tracker session cannot be changed in this window.'); }
            session.state = state;
            session.generation++;
            await this.save(session);
        });
    }

    addLap(id: string): Promise<number> {
        return this.enqueue(async () => {
            const session = this.get(id);
            if (!session || session.owner !== this.owner || session.state === 'stopped') {
                throw new Error('Only the active tracker session can add a lap.');
            }
            if (session.currentLap >= MAX_LAPS) { throw new Error('Tracker lap limit reached. Start a new session.'); }
            session.currentLap++;
            session.generation++;
            await this.save(session);
            return session.currentLap;
        });
    }

    removeLap(id: string): Promise<number> {
        return this.enqueue(async () => {
            const session = this.get(id);
            if (!session || session.owner !== this.owner || session.state === 'stopped') {
                throw new Error('Only the active tracker session can remove a lap.');
            }
            if (session.currentLap === 1) { throw new Error('Lap 1 cannot be removed.'); }
            for (const event of session.events) {
                if ((event.lap ?? 1) === session.currentLap) { event.lap = session.currentLap - 1; }
            }
            session.currentLap--;
            session.generation++;
            await this.save(session);
            return session.currentLap;
        });
    }

    record(id: string, generation: number, event: ReadEvent, cancelled: () => boolean): Promise<void> {
        return this.enqueue(async () => {
            if (cancelled()) { throw new Error('Read cancelled.'); }
            const session = this.requireRecording(id, generation);
            if (session.events.length >= MAX_EVENTS) { throw new Error('Session event limit reached. Start a new session.'); }
            session.events.push({ ...event, lap: session.currentLap });
            await this.save(session);
        });
    }

    delete(id: string): Promise<void> {
        return this.enqueue(async () => {
            const session = this.get(id);
            if (!session || session.state !== 'stopped') { throw new Error('Only stopped sessions can be deleted; a foreign session may still be active.'); }
            await fs.rm(path.join(this.directory, `${id}.json`), { force: true });
            this.sessions.delete(id);
            this.changed();
        });
    }

    private async prune(): Promise<void> {
        for (const session of this.sessions.values()) {
            if (session.state === 'stopped' && Date.now() - Date.parse(session.createdAt) > RETENTION_MS) {
                await fs.rm(path.join(this.directory, `${session.id}.json`), { force: true });
                this.sessions.delete(session.id);
            }
        }
    }
    async flush(): Promise<void> { await this.tail; }
}