
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const { initializeApp, cert } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const db = require("./database");
const { normalizePHNumber, uniquePhones, sendTextBeeBatch, sendSMS } = require("./services/textbee");
const { startFirebaseSync } = require("./firebaseSync");
dotenv.config();

// Keep the Firebase service account outside version control.
// If FIREBASE_SERVICE_ACCOUNT_PATH is set, it may be absolute or
// relative to this server directory.
const configuredKeyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
const candidates = configuredKeyPath
  ? [path.resolve(__dirname, configuredKeyPath)]
  : [
      path.join(__dirname, "serviceAccountKey.json"),
      path.join(__dirname, "serviceAccountKey.json.json"),
    ];
const firebaseKeyPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!firebaseKeyPath) {
  throw new Error(
    "Firebase service account not found. Set FIREBASE_SERVICE_ACCOUNT_PATH or place serviceAccountKey.json in the server directory."
  );
}
const serviceAccount = JSON.parse(fs.readFileSync(firebaseKeyPath, "utf8"));

// ==========================================
// EXPRESS CONFIGURATION
// ==========================================

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

// ==========================================
// FIREBASE ADMIN
// ==========================================

initializeApp({
  credential: cert(serviceAccount),
});

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const admin = db.prepare(`
      SELECT id, name, username, role
      FROM admins
      WHERE id = ?
    `).get(decoded.adminId);

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Admin account no longer exists",
      });
    }

    req.admin = admin;
    next();

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
}

// ==========================================
// TEST ROUTE
// ==========================================

app.get("/", (req, res) => {
  res.send("TomaSafe Server is running!");
});

// ==========================================
// ADMIN LOGIN
// ==========================================

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Username and password are required",
    });
  }

  try {
    const admin = db.prepare(`
      SELECT *
      FROM admins
      WHERE username = ?
    `).get(username);

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password",
      });
    }

    const token = jwt.sign(
      {
        adminId: admin.id,
        username: admin.username,
        role: admin.role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        name: admin.name,
        username: admin.username,
        role: admin.role,
      },
    });

  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ==========================================
// CHECK CURRENT ADMIN
// ==========================================

app.get("/api/me", authenticateAdmin, (req, res) => {
  res.json({
    success: true,
    admin: req.admin,
  });
});

// ==========================================
// GET REGULAR ADMINS
// ==========================================

app.get("/api/admins", authenticateAdmin, (req, res) => {
  if (req.admin.role !== "superadmin") {
    return res.status(403).json({
      success: false,
      message: "Superadmin access required",
    });
  }

  try {
    const admins = db.prepare(`
      SELECT id, name, username, role, created_at
      FROM admins
      WHERE role = 'admin'
      ORDER BY created_at DESC
    `).all();

    return res.json({
      success: true,
      admins,
    });

  } catch (error) {
    console.error("Get admins error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load administrators",
    });
  }
});

// ==========================================
// CREATE REGULAR ADMIN
// SUPERADMIN ONLY
// ==========================================

app.post("/api/admins", authenticateAdmin, async (req, res) => {
  if (req.admin.role !== "superadmin") {
    return res.status(403).json({
      success: false,
      message: "Superadmin access required",
    });
  }

  const { name, username, password } = req.body || {};

  if (!name || !username || !password) {
    return res.status(400).json({
      success: false,
      message: "Name, username, and password are required",
    });
  }

  try {
    const existingAdmin = db.prepare(`
      SELECT id
      FROM admins
      WHERE username = ?
    `).get(username);

    if (existingAdmin) {
      return res.status(409).json({
        success: false,
        message: "Username already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = db.prepare(`
      INSERT INTO admins (
        name,
        username,
        password_hash,
        role
      )
      VALUES (?, ?, ?, 'admin')
    `).run(name, username, passwordHash);

    return res.status(201).json({
      success: true,
      message: "Admin created successfully",
      admin: {
        id: result.lastInsertRowid,
        name,
        username,
        role: "admin",
      },
    });

  } catch (error) {
    console.error("Create admin error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not create administrator",
    });
  }
});

// ==========================================
// DELETE REGULAR ADMIN
// SUPERADMIN ONLY
// ==========================================

app.delete("/api/admins/:id", authenticateAdmin, (req, res) => {
  if (req.admin.role !== "superadmin") {
    return res.status(403).json({
      success: false,
      message: "Superadmin access required",
    });
  }

  const adminId = Number(req.params.id);

  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid administrator ID",
    });
  }

  try {
    const admin = db.prepare(`
      SELECT id, role
      FROM admins
      WHERE id = ?
    `).get(adminId);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Administrator not found",
      });
    }

    if (admin.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Superadmin cannot be deleted",
      });
    }

    db.prepare(`
      DELETE FROM admins
      WHERE id = ? AND role = 'admin'
    `).run(adminId);

    return res.json({
      success: true,
      message: "Administrator deleted successfully",
    });

  } catch (error) {
    console.error("Delete admin error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not delete administrator",
    });
  }
});

// ==========================================
// REGISTER FCM DEVICE
// ==========================================

// The evacuation app sends its native FCM token here after notification
// permission is granted and whenever Firebase rotates the token.

// Optional text from the mobile app: trimmed, single line, length-limited.
// Returns undefined for missing/empty values and null when invalid.
function cleanAppText(value, max) {
  if (value == null || (typeof value === "string" && !value.trim())) return undefined;
  if (typeof value !== "string" || /[\r\n\t]/.test(value)) return null;
  const text = value.trim().replace(/ {2,}/g, " ");
  return text.length <= max ? text : null;
}

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// Save a phone's push token with its owner. A rotated token (same device id)
// replaces the phone's old registration. Used by the HTTP route and by the
// Firestore sync (firebaseSync.js), where the device id is the Firebase uid.
function saveDeviceRegistration(token, owner) {
  db.transaction(() => {
    if (owner.deviceId) {
      db.prepare("DELETE FROM devices WHERE device_id = ? AND fcm_token <> ?")
        .run(owner.deviceId, token);
    }
    db.prepare(`
      INSERT INTO devices (fcm_token, device_id, name, id_number) VALUES (?, ?, ?, ?)
      ON CONFLICT(fcm_token) DO UPDATE SET
        registered_at = CURRENT_TIMESTAMP,
        device_id = COALESCE(excluded.device_id, device_id),
        name = COALESCE(excluded.name, name),
        id_number = COALESCE(excluded.id_number, id_number)
    `).run(token, owner.deviceId ?? null, owner.name ?? null, owner.idNumber ?? null);
  })();
}

app.post("/api/devices/register", (req, res) => {
  const { token, deviceId, name, idNumber } = req.body || {};

  if (typeof token !== "string" || !token.trim() || token.length > 4096) {
    return res.status(400).json({
      success: false,
      message: "A valid native FCM token is required",
    });
  }

  // The owner's name and ID number (entered once in the app) let admins see
  // whose phone this is. Older token-only clients still register.
  const owner = {
    deviceId: deviceId == null ? undefined : (DEVICE_ID_PATTERN.test(String(deviceId)) ? String(deviceId) : null),
    name: cleanAppText(name, 80),
    idNumber: cleanAppText(idNumber, 40),
  };
  if (Object.values(owner).includes(null)) {
    return res.status(400).json({
      success: false,
      message: "Device id, name or ID number is not valid",
    });
  }

  const cleanToken = token.trim();
  try {
    saveDeviceRegistration(cleanToken, owner);

    return res.json({
      success: true,
      message: "FCM device registered successfully",
    });
  } catch (error) {
    console.error("Device registration error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Could not register device",
    });
  }
});

// Registered app users for the admin panel (never exposes the tokens).
app.get("/api/devices", authenticateAdmin, (req, res) => {
  try {
    const devices = db.prepare(`
      SELECT id, name, id_number, registered_at
      FROM devices
      ORDER BY (name IS NULL), name COLLATE NOCASE, registered_at DESC
    `).all();
    return res.json({ success: true, devices });
  } catch (error) {
    console.error("Device list error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load app users" });
  }
});

// Used by the mobile app when a device logs out or disables alerts.
app.post("/api/devices/unregister", (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ success: false, message: "FCM token is required" });
  }
  try {
    db.prepare("DELETE FROM devices WHERE fcm_token = ?").run(token.trim());
    return res.json({ success: true, message: "Device unregistered" });
  } catch (error) {
    console.error("Device unregistration error:", error.message);
    return res.status(500).json({ success: false, message: "Could not unregister device" });
  }
});

// ==========================================
// RECIPIENT MANAGEMENT
// ==========================================

const allowedRecipientTypes = [
  "student",
  "faculty",
  "campus_personnel",
];

function validateRecipient(body) {
  const { recipient_type, name, phone_number } = body || {};

  if (
    !allowedRecipientTypes.includes(recipient_type) ||
    typeof name !== "string" ||
    !name.trim() ||
    typeof phone_number !== "string" ||
    !/^09\d{9}$/.test(phone_number.trim())
  ) {
    return "Enter a valid recipient type, name, and 11-digit Philippine mobile number.";
  }

  return null;
}

// ==========================================
// GET ALL RECIPIENTS
// ==========================================

app.get("/api/recipients", authenticateAdmin, (req, res) => {
  try {
    const recipients = db.prepare(`
      SELECT id, recipient_type, name, phone_number, created_at
      FROM recipients
      ORDER BY name COLLATE NOCASE ASC
    `).all();

    return res.json({
      success: true,
      recipients,
    });

  } catch (error) {
    console.error("Get recipients error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not load recipients",
    });
  }
});

// ==========================================
// ADD RECIPIENT
// ==========================================

app.post("/api/recipients", authenticateAdmin, (req, res) => {
  const validationError = validateRecipient(req.body);

  if (validationError) {
    return res.status(400).json({
      success: false,
      message: validationError,
    });
  }

  const { recipient_type, name, phone_number } = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO recipients (
        recipient_type,
        name,
        phone_number
      )
      VALUES (?, ?, ?)
    `).run(
      recipient_type,
      name.trim(),
      phone_number.trim()
    );

    const recipient = db.prepare(`
      SELECT *
      FROM recipients
      WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json({
      success: true,
      message: "Recipient added successfully",
      recipient,
    });

  } catch (error) {
    console.error("Add recipient error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not add recipient",
    });
  }
});

// ==========================================
// UPDATE RECIPIENT
// ==========================================

app.put("/api/recipients/:id", authenticateAdmin, (req, res) => {
  const id = Number(req.params.id);
  const validationError = validateRecipient(req.body);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid recipient ID",
    });
  }

  if (validationError) {
    return res.status(400).json({
      success: false,
      message: validationError,
    });
  }

  const { recipient_type, name, phone_number } = req.body;

  try {
    const result = db.prepare(`
      UPDATE recipients
      SET
        recipient_type = ?,
        name = ?,
        phone_number = ?
      WHERE id = ?
    `).run(
      recipient_type,
      name.trim(),
      phone_number.trim(),
      id
    );

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: "Recipient not found",
      });
    }

    const recipient = db.prepare(`
      SELECT *
      FROM recipients
      WHERE id = ?
    `).get(id);

    return res.json({
      success: true,
      message: "Recipient updated successfully",
      recipient,
    });

  } catch (error) {
    console.error("Update recipient error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not update recipient",
    });
  }
});

// ==========================================
// DELETE RECIPIENT
// ==========================================

app.delete("/api/recipients/:id", authenticateAdmin, (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid recipient ID",
    });
  }

  try {
    const result = db.prepare(`
      DELETE FROM recipients
      WHERE id = ?
    `).run(id);

    if (result.changes === 0) {
      return res.status(404).json({
        success: false,
        message: "Recipient not found",
      });
    }

    return res.json({
      success: true,
      message: "Recipient deleted successfully",
    });

  } catch (error) {
    console.error("Delete recipient error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not delete recipient",
    });
  }
});

// ==========================================
// EMERGENCY NOTIFICATION CONTENT + DUPLICATE PROTECTION
// ==========================================
// Fire messages must identify the actual building by name. Reject generic
// placeholders such as "Other Building" so they are never sent to students.
function validAffectedBuilding(building) {
  return typeof building === "string" &&
    building.trim().length >= 4 && building.trim().length <= 90 &&
    !/[\r\n\t]/.test(building) &&
    !/^(other|other building|unknown|n\/?a)$/i.test(building.trim());
}

const getAlertMode = () =>
  process.env.ALERT_MODE === "live" ? "live" : "preview";

function emergencySMSMessage(type, building) {
  if (type === "fire") {
    // Brief GSM-7 message for usual campus building names; long names may
    // still exceed one SMS segment. Never claim a route is available indoors.
    return `TomaSafe FIRE: ${building}. INSIDE? Exit if safe; ` +
      "tap app push for route once outside. ELSEWHERE? " +
      "No need to evacuate; stay clear unless told.";
  }
  return "[TomaSafe] EARTHQUAKE at UST-Legazpi Rawis. " +
    "DROP, COVER, HOLD ON during shaking. When safe, follow campus personnel " +
    "and use the TomaSafe push alert for instructions and outdoor routing.";
}

// Durable guard prevents double taps and two simultaneous admins from
// submitting an identical live emergency more than once during the cooldown.
// Stored in SQLite so it also survives Express restarts.
// Do NOT auto-retry submissions with an unknown provider outcome.
db.exec(`
  CREATE TABLE IF NOT EXISTS emergency_dispatch_guard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signature TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'started'
  );
  CREATE INDEX IF NOT EXISTS idx_emergency_dispatch_guard_recent
    ON emergency_dispatch_guard(signature, created_ms);
`);
const ALERT_REPEAT_BLOCK_MS = Math.max(
  60000,
  Math.min(300000, Number(process.env.ALERT_REPEAT_BLOCK_MS) || 90000)
);
function reserveEmergencyDispatch(type, building) {
  const signature = JSON.stringify([type, building || ""]);
  const now = Date.now();
  return db.transaction(() => {
    // Keep recent records long enough for audits, but avoid unbounded growth.
    db.prepare("DELETE FROM emergency_dispatch_guard WHERE created_ms < ?")
      .run(now - 7 * 24 * 3600 * 1000);
    const recent = db.prepare(`
      SELECT id, status FROM emergency_dispatch_guard
      WHERE signature = ? AND created_ms >= ?
      ORDER BY created_ms DESC, id DESC LIMIT 1
    `).get(signature, now - ALERT_REPEAT_BLOCK_MS);
    if (recent) return { duplicate: true, id: recent.id, status: recent.status };
    const result = db.prepare(`
      INSERT INTO emergency_dispatch_guard (signature, created_ms, status)
      VALUES (?, ?, 'started')
    `).run(signature, now);
    return { duplicate: false, id: Number(result.lastInsertRowid) };
  })();
}

// ==========================================
// INCIDENTS: ONE ACTIVE ALERT AT A TIME
// ==========================================

const ACTIVE_ALERT_MESSAGE = "An alert is already active. Close it before sending another.";

const getActiveIncident = () =>
  db.prepare("SELECT * FROM incidents WHERE status = 'active' ORDER BY id DESC LIMIT 1").get() || null;

// Check and insert in one transaction, so two admins can never both start an alert.
function createIncident({ type, building, mode, admin }) {
  return db.transaction(() => {
    if (getActiveIncident()) return null;
    const { users } = db.prepare(`
      SELECT COUNT(*) AS users FROM devices WHERE name IS NOT NULL AND TRIM(name) <> ''
    `).get();
    const result = db.prepare(`
      INSERT INTO incidents (emergency_type, building, mode, triggered_by, triggered_by_name, total_users, tracked)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(type, building, mode, admin.id, admin.name, users);
    return db.prepare("SELECT * FROM incidents WHERE id = ?").get(result.lastInsertRowid);
  })();
}

function startIncident(options) {
  const incident = createIncident(options);
  if (incident) firebaseSync.publishIncident(incident);
  return incident;
}

const STATUS_ORDER = "CASE status WHEN 'safe_confirmed' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END";

// Everyone for an alert: phones that reported (navigating / arrived / safe), plus
// registered app users who have not responded at all ("no_response"), so admins
// can see exactly who still has to confirm they are safe.
function incidentPeople(incidentId) {
  // A report may come without the name; fill it in from the phone's registration.
  const reported = db.prepare(`
    SELECT s.device_id,
      COALESCE(s.name, (SELECT d.name FROM devices d WHERE d.device_id = s.device_id LIMIT 1)) AS name,
      COALESCE(s.id_number, (SELECT d.id_number FROM devices d WHERE d.device_id = s.device_id LIMIT 1)) AS id_number,
      s.status, s.area_id, s.area_name, s.updated_at
    FROM device_status s WHERE s.incident_id = ?
    ORDER BY CASE s.status WHEN 'safe_confirmed' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END, s.updated_at DESC
  `).all(incidentId);
  const silent = db.prepare(`
    SELECT COALESCE(device_id, 'device-' || id) AS device_id, name, id_number,
      'no_response' AS status, NULL AS area_id, NULL AS area_name, NULL AS updated_at
    FROM devices
    WHERE name IS NOT NULL AND TRIM(name) <> ''
      AND (device_id IS NULL OR device_id NOT IN (
        SELECT device_id FROM device_status WHERE incident_id = ?
      ))
    ORDER BY name COLLATE NOCASE
  `).all(incidentId);
  return [...reported, ...silent];
}

function incidentMonitoring(incident) {
  const people = incidentPeople(incident.id);
  const count = (status) => people.filter((person) => person.status === status).length;
  const safe = count("safe_confirmed");
  // Unregistered phones can still report, so the total is never below the list.
  const total = Math.max(incident.total_users || 0, people.length);
  return {
    total_users: total,
    safe_confirmed: safe,
    remaining: Math.max(0, total - safe),
    navigating: count("navigating"),
    arrived: count("arrived"),
    no_response: count("no_response"),
    people,
  };
}

app.post("/api/emergency", authenticateAdmin, async (req, res) => {
  const { type, building } = req.body || {};
  if (!["fire", "earthquake"].includes(type)) {
    return res.status(400).json({
      success: false,
      message: "Only Fire and Earthquake alerts are supported",
    });
  }
  // No alert spamming: only one active alert at a time.
  if (getActiveIncident()) {
    return res.status(409).json({ success: false, activeIncident: true, message: ACTIVE_ALERT_MESSAGE });
  }
  if (type === "fire" && !validAffectedBuilding(building)) {
    return res.status(400).json({
      success: false,
      message: "Select the exact affected building name (not Other Building)",
    });
  }

  const selectedBuilding = type === "fire" ? building.trim().replace(/ {2,}/g, " ") : null;
  const mode = getAlertMode();

  let phones, invalidRecipients, tokens;
  try {
    // ALL registered SMS recipients; each valid phone number is contacted once.
    const rows = db.prepare("SELECT phone_number FROM recipients").all();
    phones = uniquePhones(rows.map((row) => row.phone_number));
    invalidRecipients = rows.filter((row) => !normalizePHNumber(row.phone_number)).length;

    // FCM registrations are independent from the SMS recipient list.
    const devices = db.prepare("SELECT fcm_token FROM devices").all();
    tokens = [...new Set(devices.map((device) => device.fcm_token).filter(Boolean))];
  } catch (error) {
    console.error("Could not load emergency recipients:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load the registered recipients",
    });
  }

  // Safe first run. No SMS or FCM is sent until ALERT_MODE=live is set. A
  // preview incident still starts, so monitoring and safe reports can be tested.
  if (mode !== "live") {
    const incident = startIncident({ type, building: selectedBuilding, mode: "preview", admin: req.admin });
    if (!incident) {
      return res.status(409).json({ success: false, activeIncident: true, message: ACTIVE_ALERT_MESSAGE });
    }
    return res.json({
      success: true,
      mode: "preview",
      incident,
      message: "Preview only: no SMS or FCM notifications were sent",
      sms: {
        status: "preview_only", targeted: phones.length, queued: 0,
        failed: 0, invalidRecipients, batchIds: [],
      },
      fcm: { status: "preview_only", targeted: tokens.length, successful: 0, failed: 0 },
    });
  }

  if (!phones.length && !tokens.length) {
    return res.status(409).json({
      success: false,
      message: "No SMS recipients or FCM devices have been registered",
    });
  }

  // Reserve before contacting external SMS/FCM providers. A duplicate
  // request returns before either channel is called, even during slow sends.
  let dispatchReservation;
  try {
    dispatchReservation = reserveEmergencyDispatch(type, selectedBuilding);
  } catch (error) {
    console.error("Emergency dispatch guard failed:", error.message);
    return res.status(503).json({ success: false,
      message: "Cannot confirm duplicate protection. No alert sent." });
  }
  if (dispatchReservation.duplicate) {
    return res.status(409).json({
      success: false, duplicateBlocked: true,
      message: "An identical emergency alert was recently submitted. " +
        "No new SMS or FCM was sent. Check alert history and TextBee batches " +
        "before intentionally sending another alert.",
    });
  }

  // Start the incident before sending, so the push can carry its id.
  let incident;
  try {
    incident = startIncident({ type, building: selectedBuilding, mode: "live", admin: req.admin });
  } catch (error) {
    console.error("Could not start incident:", error.message);
    return res.status(500).json({ success: false, message: "Could not start the alert. No SMS or FCM was sent." });
  }
  if (!incident) {
    return res.status(409).json({ success: false, activeIncident: true, message: ACTIVE_ALERT_MESSAGE });
  }

  const notification = type === "fire"
    ? {
        title: "FIRE ALERT",
        body: `Fire reported at ${selectedBuilding}. Follow campus safety instructions.`,
      }
    : {
        title: "EARTHQUAKE ALERT",
        body: "DROP, COVER and HOLD ON during shaking. Evacuate when it is safe.",
      };

  // Deliver through both channels concurrently; a failure in one must not
  // prevent an attempt in the other.
  async function dispatchFCM() {
    if (!tokens.length) {
      return { status: "no_recipients", targeted: 0, successful: 0, failed: 0 };
    }
    let successful = 0;
    let failed = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      try {
        const response = await getMessaging().sendEachForMulticast({
          tokens: chunk,
          notification,
          // TomaSafe mobile uses this type when the recipient taps the alert,
          // and the incident id to report navigation and safe status.
          data: { type, incidentId: String(incident.id) },
          android: {
            priority: "high",
            notification: { channelId: "emergency" },
          },
        });
        successful += response.successCount;
        failed += response.failureCount;
        // Uninstalled apps and old builds leave dead tokens: log why each send failed and
        // forget tokens FCM says will never work again.
        const dead = [];
        response.responses.forEach((result, index) => {
          if (result.success) return;
          const code = result.error?.code || "unknown";
          console.warn(`FCM send failed (${code}):`, result.error?.message);
          if (["messaging/registration-token-not-registered", "messaging/invalid-registration-token",
               "messaging/invalid-argument", "messaging/mismatched-credential"].includes(code)) {
            dead.push(chunk[index]);
          }
        });
        if (dead.length) {
          const remove = db.prepare("DELETE FROM devices WHERE fcm_token = ?");
          db.transaction(() => dead.forEach((token) => remove.run(token)))();
          console.warn(`Removed ${dead.length} dead FCM token(s)`);
        }
      } catch (error) {
        failed += chunk.length;
        console.error("FCM batch failed:", error.message);
      }
    }
    return {
      status: failed ? (successful ? "partial" : "failed") : "accepted_by_fcm",
      targeted: tokens.length, successful, failed,
    };
  }

  async function dispatchSMS() {
    if (!phones.length) {
      return {
        status: "no_recipients", targeted: 0, queued: 0, failed: 0,
        invalidRecipients, batchIds: [],
      };
    }
    if (!process.env.TEXTBEE_API_KEY) {
      return {
        status: "not_configured", targeted: phones.length, queued: 0,
        failed: phones.length, invalidRecipients, batchIds: [],
      };
    }
    try {
      const result = await sendSMS({
        recipients: phones,
        message: emergencySMSMessage(type, selectedBuilding),
        // sendSMS batches recipients to avoid submitting one huge request.
        batchSize: process.env.SMS_BATCH_SIZE || 10,
      });
      return { ...result, invalidRecipients };
    } catch (error) {
      console.error("TextBee SMS submission error:", error.message);
      return {
        status: "failed_or_unknown", targeted: phones.length,
        queued: 0, failed: phones.length, invalidRecipients,
        batchIds: [], errors: ["Check TextBee history before retrying"],
      };
    }
  }

  const [fcm, sms] = await Promise.all([dispatchFCM(), dispatchSMS()]);
  // Preserve the duplicate guard regardless of send outcome. Retrying a
  // timed-out TextBee request can generate another SMS batch.
  try {
    db.prepare("UPDATE emergency_dispatch_guard SET status = ? WHERE id = ?")
      .run(`fcm:${fcm.status}|sms:${sms.status}`, dispatchReservation.id);
  } catch (error) {
    console.error("Could not record dispatch guard outcome:", error.message);
  }

  let alert;
  try {
    const record = db.prepare(`
      INSERT INTO alert_history (
        emergency_type, building, triggered_by, triggered_by_name,
        fcm_success, fcm_failure, sms_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      type, selectedBuilding, req.admin.id, req.admin.name,
      fcm.successful, fcm.failed, sms.status,
    );
    alert = db.prepare("SELECT * FROM alert_history WHERE id = ?")
      .get(record.lastInsertRowid);
    db.prepare("UPDATE incidents SET alert_id = ? WHERE id = ?").run(alert.id, incident.id);
    incident.alert_id = alert.id;
  } catch (error) {
    // Alerts MAY have already been queued. Never suggest an automatic retry.
    console.error("Emergency was attempted, but alert history could not be saved:", error.message);
    return res.status(500).json({
      success: false,
      message: "Alert sending was attempted but history saving failed. Check FCM and TextBee before retrying.",
      mode, fcm, sms, incident,
    });
  }

  // 'success' refers to backend processing, not SMS handset delivery.
  return res.status(201).json({
    success: true,
    mode,
    message: "Emergency processed. Check per-channel results and TextBee delivery status.",
    alert, fcm, sms, incident,
  });
});

// ==========================================
// ACTIVE INCIDENT, MONITORING AND CLOSING (ADMIN)
// ==========================================

const incidentById = (id) => db.prepare("SELECT * FROM incidents WHERE id = ?").get(Number(id));

app.get("/api/incidents/active", authenticateAdmin, (req, res) => {
  try {
    return res.json({ success: true, incident: getActiveIncident() });
  } catch (error) {
    console.error("Active incident error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load the active alert" });
  }
});

app.get("/api/incidents/:id/monitoring", authenticateAdmin, (req, res) => {
  try {
    const incident = incidentById(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: "Alert not found" });
    return res.json({ success: true, monitoring: incidentMonitoring(incident) });
  } catch (error) {
    console.error("Monitoring error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load monitoring data" });
  }
});

app.get("/api/incidents/:id/people", authenticateAdmin, (req, res) => {
  try {
    const incident = incidentById(req.params.id);
    if (!incident) return res.status(404).json({ success: false, message: "Alert not found" });
    return res.json({ success: true, people: incidentPeople(incident.id) });
  } catch (error) {
    console.error("Incident people error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load the people list" });
  }
});

app.patch("/api/incidents/:id/close", authenticateAdmin, (req, res) => {
  try {
    const closed = db.transaction(() => {
      const incident = incidentById(req.params.id);
      if (!incident || incident.status !== "active") return null;
      // Freeze the same numbers the dashboard showed, for History.
      const { safe_confirmed, total_users } = incidentMonitoring(incident);
      db.prepare(`
        UPDATE incidents
        SET status = 'closed', closed_at = CURRENT_TIMESTAMP, ended_at = CURRENT_TIMESTAMP,
            closed_by_name = ?, safe_count = ?, total_users = ?
        WHERE id = ?
      `).run(req.admin.name, safe_confirmed, total_users, incident.id);
      return incidentById(incident.id);
    })();
    if (!closed) {
      return res.status(409).json({ success: false, message: "This alert is not active (it may already be closed)" });
    }
    firebaseSync.publishIncident(null);
    return res.json({ success: true, incident: closed });
  } catch (error) {
    console.error("Close incident error:", error.message);
    return res.status(500).json({ success: false, message: "Could not close the alert" });
  }
});

// ==========================================
// MOBILE APP: CURRENT ALERT AND STATUS REPORTS
// ==========================================
// Public like /api/devices/register: the app reports navigating, arriving
// in an evacuation area, and confirming safe for the active alert.

app.get("/api/app/incident", (req, res) => {
  try {
    const incident = getActiveIncident();
    return res.json({
      success: true,
      incident: incident
        ? { id: incident.id, emergency_type: incident.emergency_type, building: incident.building }
        : null,
    });
  } catch (error) {
    console.error("App incident error:", error.message);
    return res.status(500).json({ success: false, message: "Could not load the current alert" });
  }
});

const APP_STATUSES = ["navigating", "arrived", "safe_confirmed"];

// Save a phone's status for an active alert. Statuses only move forward:
// navigating -> arrived -> safe_confirmed. Returns false when the alert is not active.
function saveStatusReport(incidentId, deviceId, status, fields) {
  const incident = incidentById(incidentId);
  if (!incident || incident.status !== "active") return false;
  db.prepare(`
    INSERT INTO device_status (incident_id, device_id, name, id_number, status, area_id, area_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(incident_id, device_id) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      id_number = COALESCE(excluded.id_number, id_number),
      status = CASE
        WHEN status = 'safe_confirmed' THEN status
        WHEN status = 'arrived' AND excluded.status = 'navigating' THEN status
        ELSE excluded.status END,
      area_id = COALESCE(excluded.area_id, area_id),
      area_name = COALESCE(excluded.area_name, area_name),
      updated_at = CURRENT_TIMESTAMP
  `).run(incident.id, String(deviceId), fields.name ?? null, fields.idNumber ?? null, status,
    fields.areaId ?? null, fields.areaName ?? null);
  return true;
}

app.post("/api/app/status", (req, res) => {
  const { incidentId, deviceId, status, areaId, areaName, name, idNumber } = req.body || {};
  const fields = {
    areaId: cleanAppText(areaId, 40),
    areaName: cleanAppText(areaName, 80),
    name: cleanAppText(name, 80),
    idNumber: cleanAppText(idNumber, 40),
  };
  if (!Number.isInteger(Number(incidentId)) || !DEVICE_ID_PATTERN.test(String(deviceId ?? "")) ||
      !APP_STATUSES.includes(status) || Object.values(fields).includes(null)) {
    return res.status(400).json({ success: false, message: "Invalid status report" });
  }
  try {
    if (!saveStatusReport(incidentId, deviceId, status, fields)) {
      return res.status(409).json({ success: false, message: "This alert is no longer active" });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Status report error:", error.message);
    return res.status(500).json({ success: false, message: "Could not save the status" });
  }
});

// ==========================================
// GET ALERT HISTORY
// ==========================================

app.get("/api/alerts/history", authenticateAdmin, (req, res) => {
  try {
    // Every incident (live and preview) with its sender, closing details and
    // safe count, plus older alerts sent before incidents existed.
    const incidents = db.prepare(`
      SELECT
        i.id AS incident_id, i.alert_id, i.emergency_type, i.building, i.mode, i.status,
        i.triggered_by_name, i.started_at AS sent_at, i.closed_at, i.closed_by_name, i.total_users,
        COALESCE(i.safe_count, (
          SELECT COUNT(*) FROM device_status d
          WHERE d.incident_id = i.id AND d.status = 'safe_confirmed'
        )) AS safe_count,
        a.fcm_success, a.fcm_failure, a.sms_status
      FROM incidents i
      LEFT JOIN alert_history a ON a.id = i.alert_id
      WHERE i.tracked = 1
    `).all().map((row) => ({ ...row, key: `incident-${row.incident_id}` }));

    const linked = new Set(incidents.map((row) => row.alert_id).filter(Boolean));
    const older = db.prepare(`
      SELECT
        id AS alert_id, emergency_type, building, triggered_by_name,
        fcm_success, fcm_failure, sms_status, sent_at
      FROM alert_history
    `).all()
      .filter((row) => !linked.has(row.alert_id))
      .map((row) => ({ ...row, key: `alert-${row.alert_id}`, mode: "live", status: "sent" }));

    const alerts = [...incidents, ...older]
      .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));

    return res.json({
      success: true,
      alerts,
    });

  } catch (error) {
    console.error("Alert history error:", error);

    return res.status(500).json({
      success: false,
      message: "Could not retrieve alert history",
    });
  }
});



// ==========================================
// TEXTBEE - OPTIONAL SINGLE-RECIPIENT CONNECTIVITY CHECK
// ==========================================
// Only this test endpoint sends to one chosen number. Emergency alerts use
// /api/emergency to notify every unique registered SMS recipient.
// A signed-in admin must explicitly choose and confirm one phone number.
app.post("/api/sms/test", authenticateAdmin, async (req, res) => {
  const { phone_number, confirm } = req.body || {};
  const recipient = normalizePHNumber(phone_number);

  if (!recipient) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid Philippine number (e.g. 09XXXXXXXXX).",
    });
  }

  if (confirm !== "SEND_TEST_SMS") {
    return res.status(400).json({
      success: false,
      message: "Confirm this one-number test with confirm: SEND_TEST_SMS.",
    });
  }

  if (!process.env.TEXTBEE_API_KEY) {
    return res.status(503).json({
      success: false,
      message: "TEXTBEE_API_KEY is missing from your server .env file.",
    });
  }

  const message =
    "[TomaSafe TEST] This is a system SMS test, NOT an emergency. " +
    "No action is required.";

  // A repeated test click must not generate another SMS request.
  // Persist the reservation even if the TextBee outcome is uncertain.
  const testSignature = `sms-test:${recipient}`;
  const now = Date.now();
  try {
    const isReserved = db.transaction(() => {
      const prior = db.prepare(`
        SELECT id FROM emergency_dispatch_guard
        WHERE signature = ? AND created_ms >= ? LIMIT 1
      `).get(testSignature, now - ALERT_REPEAT_BLOCK_MS);
      if (prior) return true;
      db.prepare(`
        INSERT INTO emergency_dispatch_guard(signature, created_ms, status)
        VALUES (?, ?, 'test-submitted')
      `).run(testSignature, now);
      return false;
    })();
    if (isReserved) return res.status(409).json({
      success: false,
      message: "A test SMS was submitted recently. Check TextBee history before retrying."
    });
  } catch (error) {
    return res.status(503).json({ success: false,
      message: "Unable to verify test deduplication; nothing was sent." });
  }

  try {
    const result = await sendTextBeeBatch({
      recipients: [recipient],
      message,
    });

    return res.status(202).json({
      success: true,
      status: result.status, // queued_not_delivered
      queued: result.queued,
      batchId: result.batchId,
      message: "TextBee accepted the test request for processing; delivery is not yet confirmed.",
    });
  } catch (error) {
    // Request timeouts can have an unknown outcome: do NOT retry automatically.
    console.error("TextBee SMS test error:", error.message);
    return res.status(502).json({
      success: false,
      message: error.message,
    });
  }
});



// ==========================================
// START SERVER
// ==========================================

// Phones on any network register and report through Firestore; copy that
// into SQLite so the admin panel and push sending work the same way.
const firebaseSync = startFirebaseSync({
  cleanAppText, DEVICE_ID_PATTERN, APP_STATUSES,
  saveDeviceRegistration, saveStatusReport, getActiveIncident,
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
