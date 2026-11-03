
const Database = require("better-sqlite3");

const db = new Database("evacuation.db");

console.log("Database connected");

// ==========================================
// ADMINS
// ==========================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log("Admins table ready");

// ==========================================
// ADD ROLE COLUMN IF IT DOESN'T EXIST
// ==========================================

const adminColumns = db.prepare(`
  PRAGMA table_info(admins)
`).all();

const hasRoleColumn = adminColumns.some(
  (column) => column.name === "role"
);

if (!hasRoleColumn) {
  db.prepare(`
    ALTER TABLE admins
    ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'
  `).run();

  console.log("Role column added to admins table");
}

// ==========================================
// FCM DEVICES
// ==========================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fcm_token TEXT NOT NULL UNIQUE,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log("Devices table ready");

// Who owns each registered device (entered once in the mobile app), so
// admins can tell whose phone a registration is. device_id is a random id
// the app keeps, so a rotated FCM token replaces the old row.
const deviceColumns = db.prepare(`
  PRAGMA table_info(devices)
`).all().map((column) => column.name);

for (const [name, type] of [["device_id", "TEXT"], ["name", "TEXT"], ["id_number", "TEXT"]]) {
  if (!deviceColumns.includes(name)) {
    db.prepare(`ALTER TABLE devices ADD COLUMN ${name} ${type}`).run();
    console.log(`Devices column added: ${name}`);
  }
}

// ==========================================
// RECIPIENT MANAGEMENT
// ==========================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    recipient_type TEXT NOT NULL
      CHECK (
        recipient_type IN (
          'student',
          'faculty',
          'campus_personnel'
        )
      ),

    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log("Recipients table ready");

// ==========================================
// ALERT HISTORY
// ==========================================

db.prepare(`
  CREATE TABLE IF NOT EXISTS alert_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    emergency_type TEXT NOT NULL
      CHECK (
        emergency_type IN (
          'fire',
          'earthquake'
        )
      ),

    building TEXT,

    triggered_by INTEGER NOT NULL,
    triggered_by_name TEXT NOT NULL,

    fcm_success INTEGER NOT NULL DEFAULT 0,
    fcm_failure INTEGER NOT NULL DEFAULT 0,

    sms_status TEXT NOT NULL DEFAULT 'not_integrated',

    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (triggered_by)
      REFERENCES admins(id)
  )
`).run();

console.log("Alert history table ready");

// ==========================================
// INCIDENTS (ONE ACTIVE ALERT AT A TIME)
// ==========================================
// An incident starts when an admin sends an alert and ends when an admin
// closes it. total_users is the number of named app users when it started;
// safe_count is frozen when it is closed, for the history page. tracked = 1
// marks incidents with safety monitoring (older test rows stay 0).

db.prepare(`
  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    emergency_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    triggered_by INTEGER NOT NULL,
    triggered_by_name TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    FOREIGN KEY (triggered_by) REFERENCES admins(id)
  )
`).run();

// The table may already exist from an earlier version: add what is missing.
const incidentColumns = db.prepare(`
  PRAGMA table_info(incidents)
`).all().map((column) => column.name);

for (const [name, definition] of [
  ["building", "TEXT"],
  ["alert_id", "INTEGER REFERENCES alert_history(id)"],
  ["mode", "TEXT NOT NULL DEFAULT 'live'"],
  ["total_users", "INTEGER NOT NULL DEFAULT 0"],
  ["closed_at", "DATETIME"],
  ["closed_by_name", "TEXT"],
  ["safe_count", "INTEGER"],
  ["tracked", "INTEGER NOT NULL DEFAULT 0"],
]) {
  if (!incidentColumns.includes(name)) {
    db.prepare(`ALTER TABLE incidents ADD COLUMN ${name} ${definition}`).run();
    console.log(`Incidents column added: ${name}`);
  }
}

console.log("Incidents table ready");

// ==========================================
// DEVICE STATUS PER INCIDENT
// ==========================================
// Reported by the mobile app: navigating -> arrived -> safe_confirmed.

db.prepare(`
  CREATE TABLE IF NOT EXISTS device_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    incident_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    name TEXT,
    id_number TEXT,

    status TEXT NOT NULL
      CHECK (status IN ('navigating', 'arrived', 'safe_confirmed')),
    area_id TEXT,
    area_name TEXT,

    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (incident_id, device_id),
    FOREIGN KEY (incident_id) REFERENCES incidents(id)
  )
`).run();

console.log("Device status table ready");

// ==========================================
// EXPORT DATABASE
// ==========================================

module.exports = db;
