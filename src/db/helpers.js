import { getDbDriver, query } from '../config/database.js';

export async function tableExists(name) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      [name],
    );
    return rows.length > 0;
  }
  const rows = await query(`SHOW TABLES LIKE ?`, [name]);
  return rows.length > 0;
}

export async function columnExists(table, column) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some(
      (row) => String(row.name).toLowerCase() === String(column).toLowerCase(),
    );
  }
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return rows.length > 0;
}

/** Add a column only if missing. mysqlSql / sqliteSql are full ADD COLUMN fragments after ADD COLUMN. */
export async function addColumnIfMissing(table, column, { mysql, sqlite }) {
  if (await columnExists(table, column)) return false;
  const driver = getDbDriver();
  const ddl = driver === 'sqlite' ? sqlite : mysql;
  if (!ddl) {
    throw new Error(`No ${driver} DDL provided for ${table}.${column}`);
  }
  await query(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

export async function createTableIfMissing(name, { mysql, sqlite }) {
  if (await tableExists(name)) return false;
  const driver = getDbDriver();
  const ddl = driver === 'sqlite' ? sqlite : mysql;
  if (!ddl) {
    throw new Error(`No ${driver} DDL provided for table ${name}`);
  }
  await query(ddl);
  return true;
}

export function migrationContext() {
  return {
    query,
    driver: getDbDriver(),
    tableExists,
    columnExists,
    addColumnIfMissing,
    createTableIfMissing,
  };
}
