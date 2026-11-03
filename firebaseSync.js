
const { getFirestore } = require("firebase-admin/firestore");

// ==========================================
// FIRESTORE SYNC
// ==========================================
// The mobile app reaches this system through Firestore, so phones on any
// network (mobile data, campus Wi-Fi) can register and report:
//
//   devices/{uid}                     push token, name, ID number (the app writes)
//   incidents/{id}/status/{uid}       navigating / arrived / safe_confirmed (the app writes)
//   meta/activeIncident               the active alert, so the app knows its id (this server writes)
//
// Everything the app writes is copied into SQLite with the same functions the
// HTTP routes use, so the admin panel and push sending need no changes. The uid
// is the phone's anonymous Firebase user. Rules: firestore.rules.

function startFirebaseSync({
  cleanAppText, DEVICE_ID_PATTERN, APP_STATUSES,
  saveDeviceRegistration, saveStatusReport, getActiveIncident,
}) {
  // FIRESTORE_SYNC=off: for test servers, so they never touch the real Firestore.
  if (process.env.FIRESTORE_SYNC === "off") {
    console.log("Firestore sync off (FIRESTORE_SYNC=off)");
    return { publishIncident() {} };
  }

  let firestore;
  try {
    firestore = getFirestore();
  } catch (error) {
    console.warn("Firestore sync off:", error.message);
    return { publishIncident() {} };
  }

  const stopped = (what) => (error) => {
    console.warn(
      `Firestore sync stopped (${what}): ${error.code || ""} ${String(error.message).split("\n")[0]}\n` +
      "  Enable Firestore and Anonymous sign-in in the Firebase console, then restart the server."
    );
  };

  // Phones registering for push (any network).
  firestore.collection("devices").onSnapshot((snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "removed") continue;
      const data = change.doc.data();
      const uid = change.doc.id;
      const owner = {
        deviceId: DEVICE_ID_PATTERN.test(uid) ? uid : null,
        name: cleanAppText(data.name, 80),
        idNumber: cleanAppText(data.idNumber, 40),
      };
      if (typeof data.token !== "string" || !data.token.trim() || data.token.length > 4096 ||
          Object.values(owner).includes(null)) {
        console.warn("Ignored an invalid Firestore device registration:", uid);
        continue;
      }
      try {
        saveDeviceRegistration(data.token.trim(), owner);
      } catch (error) {
        console.error("Could not save Firestore device:", error.message);
      }
    }
  }, stopped("devices"));

  // Status reports for alerts (navigating / arrived / safe).
  firestore.collectionGroup("status").onSnapshot((snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "removed") continue;
      const incidentId = Number(change.doc.ref.parent.parent?.id);
      const data = change.doc.data();
      const fields = {
        areaId: cleanAppText(data.areaId, 40),
        areaName: cleanAppText(data.areaName, 80),
        name: cleanAppText(data.name, 80),
        idNumber: cleanAppText(data.idNumber, 40),
      };
      if (!Number.isInteger(incidentId) || !DEVICE_ID_PATTERN.test(change.doc.id) ||
          !APP_STATUSES.includes(data.status) || Object.values(fields).includes(null)) {
        continue;
      }
      try {
        // Reports for closed alerts (e.g. old documents on start-up) are ignored.
        saveStatusReport(incidentId, change.doc.id, data.status, fields);
      } catch (error) {
        console.error("Could not save Firestore status:", error.message);
      }
    }
  }, stopped("status"));

  function publishIncident(incident) {
    const doc = incident
      ? { active: true, id: String(incident.id), emergency_type: incident.emergency_type, building: incident.building ?? null }
      : { active: false, id: null };
    firestore.doc("meta/activeIncident").set({ ...doc, updatedAt: new Date() })
      .catch((error) => console.warn("Could not publish the active alert to Firestore:", error.message));
  }

  // Start-up: make Firestore match the database (e.g. an alert closed while offline).
  publishIncident(getActiveIncident());
  console.log("Firestore sync started");
  return { publishIncident };
}

module.exports = { startFirebaseSync };
