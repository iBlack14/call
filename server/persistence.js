import fs from 'fs/promises';
import path from 'path';

/**
 * Simple JSON-based persistence for sessions.
 * Omit transient socket IDs when saving.
 */
export class SessionPersistence {
  constructor(filePath) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
    this.tmpPath = `${filePath}.tmp`;
    this.pendingWrite = null;
    this.flushTimer = null;
    this.lastSnapshot = null;
  }

  async load() {
    try {
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      const sessions = new Map();
      
      for (const [code, session] of Object.entries(parsed)) {
        // Reset socket IDs as they are invalid after restart
        sessions.set(code, {
          ...session,
          dashboardSocketId: null,
          phoneSocketId: null
        });
      }
      return sessions;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[PERSISTENCE] Error loading sessions:', error);
      }
      return new Map();
    }
  }

  async save(sessionsMap) {
    this.lastSnapshot = sessionsMap;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pendingWrite = this.#writeSnapshot(this.lastSnapshot).catch((error) => {
        console.error('[PERSISTENCE] Error saving sessions:', error);
      });
    }, 250);
    return this.pendingWrite;
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      this.pendingWrite = this.#writeSnapshot(this.lastSnapshot).catch((error) => {
        console.error('[PERSISTENCE] Error saving sessions:', error);
      });
    }

    if (this.pendingWrite) {
      await this.pendingWrite;
      this.pendingWrite = null;
    }
  }

  async #writeSnapshot(sessionsMap) {
    if (!sessionsMap) return;
    try {
      await fs.mkdir(this.dirPath, { recursive: true });
      const plainObject = {};
      for (const [code, session] of sessionsMap.entries()) {
        const { dashboardSocketId, phoneSocketId, ...persistentData } = session;
        plainObject[code] = persistentData;
      }
      await fs.writeFile(this.tmpPath, JSON.stringify(plainObject, null, 2), 'utf8');
      await fs.rename(this.tmpPath, this.filePath);
    } finally {
      this.pendingWrite = null;
    }
  }
}
