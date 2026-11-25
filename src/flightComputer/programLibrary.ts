import { ProgramLanguage } from './apiTypes';
import { EXAMPLE_PROGRAMS, StoredProgram } from './examplePrograms';
import { AUTO_DEMOS } from './demoPrograms';
import { RETURN_HOME_PROGRAM } from './coastalProgram';

const DB_NAME = 'reentry_flight_programs_v1';
const STORE_NAME = 'programs';
const LS_FALLBACK_KEY = 'reentry_programs_fallback_v1';

/**
 * Local persistent program library backed by IndexedDB (with graceful localStorage fallback).
 * Supports create, rename, duplicate, delete, save, import/export, and restoring starter examples.
 * Imported or opened programs NEVER auto-execute; explicit RUN/DEPLOY is always required.
 */
export class ProgramLibrary {
  private db: IDBDatabase | null = null;
  private programs: StoredProgram[] = [];

  public async init(): Promise<StoredProgram[]> {
    try {
      this.db = await this.openDb();
      const loaded = await this.readAllFromDb();
      if (loaded.length === 0) {
        this.programs = EXAMPLE_PROGRAMS.map((p) => ({ ...p }));
        for (const p of this.programs) {
          await this.putInDb(p);
        }
      } else {
        this.programs = loaded.sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch {
      // Graceful fallback when IndexedDB is unavailable
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      if (raw) {
        try {
          this.programs = JSON.parse(raw) as StoredProgram[];
        } catch {
          this.programs = EXAMPLE_PROGRAMS.map((p) => ({ ...p }));
        }
      } else {
        this.programs = EXAMPLE_PROGRAMS.map((p) => ({ ...p }));
      }
    }
    // Add newly shipped demos to existing libraries without replacing saved edits.
    for (const program of [...AUTO_DEMOS.map(demo => demo.program), RETURN_HOME_PROGRAM]) {
      if (!this.programs.some(p => p.id === program.id)) {
        this.programs.push({ ...program });
        await this.persistOne(program);
      }
    }
    return this.getAll();
  }

  public getAll(): StoredProgram[] {
    return [...this.programs].sort((a, b) => a.name.localeCompare(b.name));
  }

  public getById(id: string): StoredProgram | undefined {
    return this.programs.find((p) => p.id === id);
  }

  public async save(program: StoredProgram): Promise<StoredProgram> {
    const updated: StoredProgram = { ...program, updatedAt: Date.now() };
    const idx = this.programs.findIndex((p) => p.id === updated.id);
    if (idx >= 0) {
      this.programs[idx] = updated;
    } else {
      this.programs.push(updated);
    }
    await this.persistOne(updated);
    return updated;
  }

  public async create(name: string, language: ProgramLanguage, code?: string): Promise<StoredProgram> {
    const ext = language === 'python' ? '.py' : '.js';
    const cleanName = name.endsWith(ext) ? name : `${name}${ext}`;
    const starter =
      code ??
      (language === 'python'
        ? `# ${cleanName} — REENTRY Python Flight Program\n\ndef init(api):\n    api.log("Initialized ${cleanName}")\n\ndef update(t, api):\n    pass\n`
        : `// ${cleanName} — REENTRY JavaScript Flight Program\n\nfunction init(api) {\n  api.log("Initialized ${cleanName}");\n}\n\nfunction update(t, api) {\n  // Read telemetry from t and issue validated commands via api\n}\n`);

    const prog: StoredProgram = {
      id: `prog-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: cleanName,
      language,
      code: starter,
      updatedAt: Date.now(),
    };
    return this.save(prog);
  }

  public async rename(id: string, newName: string): Promise<StoredProgram | null> {
    const existing = this.getById(id);
    if (!existing) return null;
    const trimmed = newName.trim();
    if (!trimmed) return existing;
    return this.save({ ...existing, name: trimmed });
  }

  public async duplicate(id: string): Promise<StoredProgram | null> {
    const existing = this.getById(id);
    if (!existing) return null;
    const base = existing.name.replace(/\.(js|py)$/i, '');
    const ext = existing.language === 'python' ? '.py' : '.js';
    return this.create(`${base}_copy${ext}`, existing.language, existing.code);
  }

  public async remove(id: string): Promise<void> {
    this.programs = this.programs.filter((p) => p.id !== id);
    if (this.db) {
      await new Promise<void>((resolve, reject) => {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(this.programs));
    }
  }

  public async restoreExamples(): Promise<StoredProgram[]> {
    for (const ex of EXAMPLE_PROGRAMS) {
      await this.save({ ...ex, updatedAt: Date.now() });
    }
    return this.getAll();
  }

  public exportProgram(program: StoredProgram): void {
    const blob = new Blob([program.code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = program.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private readAllFromDb(): Promise<StoredProgram[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as StoredProgram[]) || []);
      req.onerror = () => reject(req.error);
    });
  }

  private async persistOne(p: StoredProgram): Promise<void> {
    if (this.db) {
      await this.putInDb(p);
    } else {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(this.programs));
    }
  }

  private putInDb(p: StoredProgram): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(p);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
