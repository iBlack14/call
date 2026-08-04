import fs from "fs/promises";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/**
 * Supabase is the authoritative session store in production. A local JSON
 * snapshot remains available for development and one-time migration.
 */
export class SessionPersistence {
  constructor(filePath) {
    this.filePath = filePath;
    this.client = null;
    this.table = process.env.SUPABASE_SESSIONS_TABLE || "call_sessions";
    this.usingSupabase = false;
    this.required = process.env.SUPABASE_REQUIRED === "1";
    this.saveChain = Promise.resolve();
    this.lastError = "";
    this.knownRemoteCodes = new Set();
    this.saveRevision = 0;
    this.saveScheduled = false;
    this.pendingSessionsMap = null;
  }

  cleanSessionOnLoad(session = {}) {
    const phoneWorkers = Array.isArray(session.phoneWorkers)
      ? session.phoneWorkers.map((worker) => ({
          ...worker,
          socketId: null,
          connected: false,
          campaignLastState: worker.campaignLastState || worker.callState || "idle",
          callState: "offline",
          disconnectedAt: new Date().toISOString()
        }))
      : [];
    const campaign = session.campaign && typeof session.campaign === "object"
      ? {
          ...session.campaign,
          activeWorkerSocketId: null,
          contacts: Array.isArray(session.campaign.contacts) ? session.campaign.contacts : []
        }
      : session.campaign;

    return {
      ...session,
      campaign,
      dashboardSocketId: null,
      phoneSocketId: null,
      activePhoneSocketId: null,
      callState: "idle",
      phoneWorkers
    };
  }

  async init() {
    if (this.client || this.usingSupabase) return;
    const url = String(process.env.SUPABASE_URL || "").trim();
    const secretKey = String(
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      ""
    ).trim();

    if (!url || !secretKey) {
      if (this.required) {
        throw new Error(
          "SUPABASE_REQUIRED=1 pero faltan SUPABASE_URL y SUPABASE_SECRET_KEY"
        );
      }
      console.log("[PERSISTENCE] Supabase no configurado; usando JSON local.");
      return;
    }

    this.client = createClient(url, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      realtime: {
        transport: WebSocket
      }
    });

    const { error } = await this.client
      .from(this.table)
      .select("code", { head: true, count: "exact" })
      .limit(1);

    if (error) {
      this.lastError = error.message;
      this.client = null;
      if (this.required) throw new Error(`Supabase: ${error.message}`);
      console.error("[PERSISTENCE] Supabase no disponible:", error.message);
      return;
    }

    this.usingSupabase = true;
    this.lastError = "";
    console.log(`[PERSISTENCE] Supabase conectado (${this.table}).`);
  }

  async loadLocalFile() {
    const sessions = new Map();
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(data);
      for (const [code, session] of Object.entries(parsed)) {
        sessions.set(code, this.cleanSessionOnLoad(session));
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.lastError = error.message;
        console.error("[PERSISTENCE] Error leyendo JSON:", error.message);
      }
    }
    return sessions;
  }

  async load() {
    await this.init();
    if (!this.usingSupabase) return this.loadLocalFile();

    const { data, error } = await this.client
      .from(this.table)
      .select("code,data")
      .range(0, 9999);
    if (error) throw new Error(`Supabase load: ${error.message}`);

    const sessions = new Map();
    for (const row of data || []) {
      sessions.set(row.code, this.cleanSessionOnLoad(row.data));
    }
    this.knownRemoteCodes = new Set((data || []).map((row) => row.code));

    if (!sessions.size) {
      const localSessions = await this.loadLocalFile();
      if (localSessions.size) {
        console.log(
          `[PERSISTENCE] Migrando ${localSessions.size} sesiones JSON a Supabase.`
        );
        await this.save(localSessions);
        return localSessions;
      }
    }

    this.lastError = "";
    return sessions;
  }

  createSnapshot(sessionsMap) {
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
    return snapshot;
  }

  async saveLocalSnapshot(snapshot) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      temporaryPath,
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
    await fs.rename(temporaryPath, this.filePath);
  }

  async persistSnapshot(snapshot) {
    const errors = [];
    if (this.usingSupabase) {
      try {
        const rows = Object.entries(snapshot).map(([code, data]) => ({
          code,
          data,
          updated_at: new Date().toISOString()
        }));
        if (rows.length) {
          const { error } = await this.client
            .from(this.table)
            .upsert(rows, { onConflict: "code" });
          if (error) throw new Error(`Supabase save: ${error.message}`);
        }
        const currentCodes = new Set(Object.keys(snapshot));
        const deletedCodes = [...this.knownRemoteCodes].filter((code) => !currentCodes.has(code));
        if (deletedCodes.length) {
          const { error } = await this.client.from(this.table).delete().in("code", deletedCodes);
          if (error) throw new Error(`Supabase delete: ${error.message}`);
        }
        this.knownRemoteCodes = currentCodes;
      } catch (error) {
        errors.push(error.message);
        console.error("[PERSISTENCE] Error guardando en Supabase:", error.message);
      }
    }

    // The local snapshot is an independent recovery path and must still be
    // written if the remote database has a temporary outage.
    try {
      await this.saveLocalSnapshot(snapshot);
    } catch (error) {
      errors.push(`JSON local: ${error.message}`);
      console.error("[PERSISTENCE] Error guardando JSON local:", error.message);
    }
    this.lastError = errors.join(" | ");
  }

  save(sessionsMap) {
    this.pendingSessionsMap = sessionsMap;
    this.saveRevision += 1;
    if (this.saveScheduled) return this.saveChain;

    this.saveScheduled = true;
    this.saveChain = this.saveChain
      .catch(() => {})
      .then(async () => {
        // Coalesce bursts such as dialing -> in_call -> ended and snapshot only
        // the newest state. This keeps large campaigns from blocking pings.
        await new Promise((resolve) => setTimeout(resolve, 75));
        while (this.pendingSessionsMap) {
          const revision = this.saveRevision;
          const snapshot = this.createSnapshot(this.pendingSessionsMap);
          await this.persistSnapshot(snapshot);
          if (revision === this.saveRevision) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        this.saveScheduled = false;
      });
    return this.saveChain;
  }

  async status() {
    if (!this.usingSupabase || !this.client) {
      return {
        driver: "json",
        connected: !this.required,
        error: this.lastError || null
      };
    }

    const { count, error } = await this.client
      .from(this.table)
      .select("code", { head: true, count: "exact" });
    if (error) {
      this.lastError = error.message;
      return {
        driver: "supabase",
        connected: false,
        table: this.table,
        error: error.message
      };
    }

    return {
      driver: "supabase",
      connected: true,
      table: this.table,
      sessionCount: Number(count || 0),
      error: null
    };
  }

  async close() {
    await this.saveChain.catch(() => {});
  }
}
