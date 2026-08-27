import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { env } from './env.js';

/** @type {import('mysql2/promise').Pool | null} */
let mysqlPool = null;

/** @type {import('better-sqlite3').Database | null} */
let sqliteDb = null;

function resolveSqlitePath() {
  const configured = env.db.database;
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(env.projectRoot, configured);
}

export function getDbDriver() {
  return env.db.connection === 'sqlite' ? 'sqlite' : 'mysql';
}

export async function connectDatabase() {
  if (env.db.connection === 'sqlite') {
    const filePath = resolveSqlitePath();
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `SQLite database not found at ${filePath}. Point DB_DATABASE to ITrustLD_Existing/database/database.sqlite or your Laravel DB file.`,
      );
    }
    sqliteDb = new Database(filePath, { readonly: false });
    sqliteDb.pragma('foreign_keys = ON');
    return { driver: 'sqlite' };
  }

  // Laravel writes TIMESTAMP/DATETIME as naive wall-clock with a UTC MySQL session.
  // Do not SET +05:30 here: that converts TIMESTAMP again and makes old-system
  // morning times show ~5:30 later (e.g. 10:05 → 15:35). Read literal strings
  // and treat them as Asia/Colombo in slTime.js.
  mysqlPool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.username,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    dateStrings: true,
  });

  mysqlPool.on('connection', (connection) => {
    connection.query(`SET time_zone = '+00:00'`);
  });

  const connection = await mysqlPool.getConnection();
  try {
    await connection.query(`SET time_zone = '+00:00'`);
    await connection.ping();
  } finally {
    connection.release();
  }

  return { driver: 'mysql' };
}

/**
 * Run a parameterized query against the shared Laravel database.
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function query(sql, params = []) {
  if (env.db.connection === 'sqlite') {
    if (!sqliteDb) {
      throw new Error('Database not connected. Call connectDatabase() first.');
    }
    const statement = sqliteDb.prepare(sql);
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA')) {
      return statement.all(...params);
    }
    const result = statement.run(...params);
    return result;
  }

  if (!mysqlPool) {
    throw new Error('Database not connected. Call connectDatabase() first.');
  }

  // pool.query (not execute) avoids MySQL 8.0.22+ ER_WRONG_ARGUMENTS when
  // LIMIT/OFFSET placeholders are sent as JS numbers (mysql2 maps them to DOUBLE).
  const [rows] = await mysqlPool.query(sql, params);
  return rows;
}

export async function closeDatabase() {
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  if (mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }
}
