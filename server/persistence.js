import fs from 'fs/promises';
import path from 'path';
import mysql from 'mysql2/promise';

/**
 * Hybrid persistent storage: MySQL (cPanel) if configured,
 * falling back to local JSON if DB is down or unconfigured.
 */
export class SessionPersistence {
  constructor(filePath) {
    this.filePath = filePath;
    this.pool = null;
    this.usingDb = false;
  }

  async initDb() {
    if (this.pool) return;
    
    const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    if (!DB_HOST || !DB_USER || !DB_NAME) {
      console.log("[PERSISTENCE] No DB config found in .env, falling back to local JSON.");
      return;
    }

    try {
      this.pool = mysql.createPool({
        host: DB_HOST,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      });

      // Asegurar que la tabla exista
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
          id VARCHAR(50) PRIMARY KEY,
          data JSON NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);
      
      this.usingDb = true;
      console.log("[PERSISTENCE] Conectado exitosamente a la base de datos MySQL en cPanel.");
    } catch (e) {
      console.error("[PERSISTENCE] Error conectando a MySQL cPanel. Usando JSON local. Detalle:", e.message);
      this.usingDb = false;
    }
  }

  async load() {
    await this.initDb();
    const sessions = new Map();

    try {
      if (this.usingDb) {
        const [rows] = await this.pool.query("SELECT id, data FROM sessions");
        if (rows.length === 0) {
           // Si la DB está vacía, intentar migrar desde el JSON local (solo primera vez)
           try {
             const localData = await fs.readFile(this.filePath, 'utf8');
             const parsed = JSON.parse(localData);
             if (Object.keys(parsed).length > 0) {
                console.log("[PERSISTENCE] Migrando sesiones locales a la Base de Datos...");
                for (const [code, session] of Object.entries(parsed)) {
                   await this.pool.query("INSERT IGNORE INTO sessions (id, data) VALUES (?, ?)", [code, JSON.stringify(session)]);
                   rows.push({ id: code, data: session });
                }
             }
           } catch(e) {} // Ignorar si no hay JSON
        }
        
        for (const row of rows) {
          sessions.set(row.id, this.cleanSessionOnLoad(typeof row.data === 'string' ? JSON.parse(row.data) : row.data));
        }
        return sessions;
      }

      // Fallback JSON
      const data = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      for (const [code, session] of Object.entries(parsed)) {
        sessions.set(code, this.cleanSessionOnLoad(session));
      }
      return sessions;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('[PERSISTENCE] Error loading sessions:', error.message);
      }
      return new Map();
    }
  }

  cleanSessionOnLoad(session) {
    // Reset socket IDs as they are invalid after restart
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

  async save(sessionsMap) {
    try {
      if (this.usingDb) {
        // En MySQL, actualizamos los registros uno por uno (o en batch).
        // Primero, sacamos los IDs vigentes para borrar los viejos si queremos, pero por seguridad solo haremos UPSERT.
        const connection = await this.pool.getConnection();
        try {
          await connection.beginTransaction();
          for (const [code, session] of sessionsMap.entries()) {
             const { dashboardSocketId, phoneSocketId, activePhoneSocketId, workerCursor, ...persistentData } = session;
             await connection.query(
               "INSERT INTO sessions (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data=VALUES(data)",
               [code, JSON.stringify(persistentData)]
             );
          }
          await connection.commit();
        } catch (err) {
          await connection.rollback();
          throw err;
        } finally {
          connection.release();
        }
        return;
      }

      // Fallback JSON
      const plainObject = {};
      for (const [code, session] of sessionsMap.entries()) {
        const {
          dashboardSocketId,
          phoneSocketId,
          activePhoneSocketId,
          workerCursor,
          ...persistentData
        } = session;
        plainObject[code] = persistentData;
      }
      await fs.writeFile(this.filePath, JSON.stringify(plainObject, null, 2), 'utf8');
    } catch (error) {
      console.error('[PERSISTENCE] Error saving sessions:', error.message);
    }
  }
}
