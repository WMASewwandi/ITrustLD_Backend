import { getDbDriver, query } from '../config/database.js';

let schemaReady = false;

async function tableExists(name) {
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

async function columnExists(table, column) {
  if (getDbDriver() === 'sqlite') {
    const rows = await query(`PRAGMA table_info(${table})`);
    return rows.some((row) => row.name === column);
  }
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  return rows.length > 0;
}

export async function ensureLoyaltyGiftSchema() {
  if (schemaReady) return;

  const giftsExists = await tableExists('loyalty_gifts');
  if (!giftsExists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS loyalty_gifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          audience_type TEXT NOT NULL DEFAULT 'normal',
          is_affiliate INTEGER NOT NULL DEFAULT 0,
          allowed_levels TEXT NOT NULL,
          expires_at TEXT,
          is_active INTEGER NOT NULL DEFAULT 1,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE loyalty_gifts (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT NULL,
          audience_type VARCHAR(20) NOT NULL DEFAULT 'normal',
          is_affiliate TINYINT(1) NOT NULL DEFAULT 0,
          allowed_levels JSON NOT NULL,
          expires_at DATETIME NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          is_deleted TINYINT(1) NOT NULL DEFAULT 0,
          created_by BIGINT UNSIGNED NULL,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
  } else if (!(await columnExists('loyalty_gifts', 'audience_type'))) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE loyalty_gifts ADD COLUMN audience_type TEXT NOT NULL DEFAULT 'normal'`);
      await query(
        `UPDATE loyalty_gifts SET audience_type = CASE WHEN is_affiliate = 1 THEN 'affiliate' ELSE 'normal' END`,
      );
    } else {
      await query(
        `ALTER TABLE loyalty_gifts ADD COLUMN audience_type VARCHAR(20) NOT NULL DEFAULT 'normal' AFTER description`,
      );
      await query(
        `UPDATE loyalty_gifts SET audience_type = CASE WHEN is_affiliate = 1 THEN 'affiliate' ELSE 'normal' END`,
      );
    }
  }

  if (!(await columnExists('loyalty_gifts', 'expires_at'))) {
    if (getDbDriver() === 'sqlite') {
      await query(`ALTER TABLE loyalty_gifts ADD COLUMN expires_at TEXT`);
    } else {
      await query(`ALTER TABLE loyalty_gifts ADD COLUMN expires_at DATETIME NULL AFTER allowed_levels`);
    }
  }

  const claimsExists = await tableExists('loyalty_gift_claims');
  if (!claimsExists) {
    if (getDbDriver() === 'sqlite') {
      await query(`
        CREATE TABLE IF NOT EXISTS loyalty_gift_claims (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          gift_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          delivery_address TEXT NOT NULL,
          contact_phone TEXT,
          status TEXT NOT NULL DEFAULT 'Pending',
          rejection_reason TEXT,
          processed_by INTEGER,
          processed_at TEXT,
          created_at TEXT,
          updated_at TEXT
        )
      `);
    } else {
      await query(`
        CREATE TABLE loyalty_gift_claims (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          gift_id BIGINT UNSIGNED NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          delivery_address TEXT NOT NULL,
          contact_phone VARCHAR(50) NULL,
          status ENUM('Pending','Approved','Rejected','Delivered') NOT NULL DEFAULT 'Pending',
          rejection_reason TEXT NULL,
          processed_by BIGINT UNSIGNED NULL,
          processed_at TIMESTAMP NULL,
          created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_gift_user (gift_id, user_id),
          INDEX idx_status (status)
        )
      `);
    }
  }

  schemaReady = true;
}
