import fs from "fs/promises";
import path from "path";

/**
 * Persistencia local en JSON. En producción, SESSION_FILE_PATH debe apuntar
 * a un volumen persistente de Coolify (por defecto /data/sessions.json).
 */
export class SessionPersistence {
  constructor(filePath) {
    this.filePath = filePath;
    this.saveChain = Promise.resolve();
    this.lastError = "";
  }

  cleanSessionOnLoad(session) {
    const phoneWorkers = Array.isArray(session.phoneWorkers)
      ? session.phoneWorkers.map((worker) => ({
          ...worker,
          socketId: null,
          connected: false,
          callState: "idle"
        }))
      : [];

    return {
      ...session,
      dashboardSocketId: null,
      phoneSocketId: null,
      activePhoneSocketId: null,
      phoneWorkers
    };
  }

  async load() {
    const sessions = new Map();
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      for (const [code, session] of Object.entries(parsed)) {
        sessions.set(code, this.cleanSessionOnLoad(session));
      }
      this.lastError = "";
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.lastError = error.message;
        console.error("[PERSISTENCE] Error loading sessions:", error.message);
      }
    }
    return sessions;
  }

  save(sessionsMap) {
    const snapshot = {};
    for (const [code, session] of sessionsMap.entries()) {
      const {
        dashboardSocketId,
        phoneSocketId,
        activePhoneSocketId,
        workerCursor,
        ...persistentData
      } = session;
      snapshot[code] = JSON.parse(JSON.stringify(persistentData));
    }

    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        try {
          await fs.mkdir(path.dirname(this.filePath), { recursive: true });
          const temporaryPath = `${this.filePath}.tmp`;
          await fs.writeFile(
            temporaryPath,
            JSON.stringify(snapshot, null, 2),
            "utf8"
          );
          await fs.rename(temporaryPath, this.filePath);
          this.lastError = "";
        } catch (error) {
          this.lastError = error.message;
          console.error("[PERSISTENCE] Error saving sessions:", error.message);
        }
      });

    return this.saveChain;
  }

  async status() {
    return {
      driver: "json",
      connected: true,
      persistentFile: this.filePath,
      error: this.lastError || null
    };
  }

  async close() {
    await this.saveChain.catch(() => {});
  }
}
