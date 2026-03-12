import fs from 'fs/promises';
import path from 'path';

/**
 * Simple JSON-based persistence for sessions.
 * Omit transient socket IDs when saving.
 */
export class SessionPersistence {
  constructor(filePath) {
    this.filePath = filePath;
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
    try {
      const plainObject = {};
      for (const [code, session] of sessionsMap.entries()) {
        const { dashboardSocketId, phoneSocketId, ...persistentData } = session;
        plainObject[code] = persistentData;
      }
      await fs.writeFile(this.filePath, JSON.stringify(plainObject, null, 2), 'utf8');
    } catch (error) {
      console.error('[PERSISTENCE] Error saving sessions:', error);
    }
  }
}
