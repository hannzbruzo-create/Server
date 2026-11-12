
const { getFirestore } = require("firebase-admin/firestore");

// ==========================================
// FIRESTORE SYNC
// ==========================================
// The mobile app reaches this system through Firestore, so phones on any
// network (mobile data, campus Wi-Fi) can register and report:
//
//   devices/{uid}                     push token + sign-in: name, ID number, phone,
//                                     recipient type, Android ID (the app writes)
//   profiles/{androidId}              the sign-in, read back after a reinstall
//                                     (the app writes; this server updates it on admin edits)
//   incidents/{id}/status/{uid}       navigating / arrived / safe_confirmed (the app writes)
//   meta/activeIncident               the active alert, so the app knows its id (this server writes)
//
// Everything the app writes is copied into SQLite with the same functions the
// HTTP routes use, so the admin panel and push sending need no changes. The uid
// is the phone's anonymous Firebase user. Rules: firestore.rules.

function startFirebaseSync({
  cleanAppText, cleanAppOwner, DEVICE_ID_PATTERN, APP_STATUSES,
  saveDeviceRegistration, saveStatusReport, getActiveIncident,
}) {
  // FIRESTORE_SYNC=off: for test servers, so they never touch the real Firestore.
  if (process.env.FIRESTORE_SYNC === "off") {
    console.log("Firestore sync off (FIRESTORE_SYNC=off)");
    return { publishIncident() {}, publishProfile() {}, deleteProfile() {} };
  }

  let firestore;
  try {
    firestore = getFirestore();
  } catch (error) {
    console.warn("Firestore sync off:", error.message);
    return { publishIncident() {}, publishProfile() {}, deleteProfile() {} };
  }

  const stopped = (what) => (error) => {
    console.warn(
      `Firestore sync stopped (${what}): ${error.code || ""} ${String(error.message).split("\n")[0]}\n` +
      "  Enable Firestore and Anonymous sign-in in the Firebase console, then restart the server."
    );
  };

  // Phones registering for push (any network). Oldest first, so when a
  // reinstalled app left an older document behind (same Android ID, new uid),
  // the newest registration is the one that stays.
  const millis = (doc) => doc.data().updatedAt?.toMillis?.() ?? 0;
  firestore.collection("devices").onSnapshot((snapshot) => {
    const changes = snapshot.docChanges()
      .filter((change) => change.type !== "removed")
      .sort((a, b) => millis(a.doc) - millis(b.doc));
    for (const change of changes) {
      const data = change.doc.data();
      const uid = change.doc.id;
      const owner = cleanAppOwner({
        deviceId: uid,
        name: data.name,
        idNumber: data.idNumber,
        phone: data.phone,
        recipientType: data.recipientType,
        androidId: data.androidId,
      });
      if (typeof data.token !== "string" || !data.token.trim() || data.token.length > 4096 ||
          !owner.deviceId || Object.values(owner).includes(null)) {
        console.warn("Ignored an invalid Firestore device registration:", uid);
        continue;
      }
      try {
        saveDeviceRegistration(data.token.trim(), owner);
      } catch (error) {
        console.error("Could not save Firestore device:", error.message);
        continue;
      }
      if (owner.androidId) removeOlderInstalls(owner.androidId, uid);
    }
  }, stopped("devices"));

  // A reinstalled app signs in as a new anonymous user: delete the documents
  // its earlier installs left, so they never replace the current registration.
  function removeOlderInstalls(androidId, currentUid) {
    firestore.collection("devices").where("androidId", "==", androidId).get()
      .then((result) => Promise.all(result.docs
        .filter((doc) => doc.id !== currentUid)
        .map((doc) => doc.ref.delete())))
      .catch((error) => console.warn("Could not remove older app installs:", error.message));
  }

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

  // An admin edited a recipient who signed in on the app: update the phone's
  // copies, so the app shows the edit and the next sync keeps it.
  // device = { device_id (Firebase uid), android_id } from the devices table.
  function publishProfile(device, profile) {
    const warn = (error) => console.warn("Could not update the app profile in Firestore:", error.message);
    if (device.android_id) {
      firestore.doc(`profiles/${device.android_id}`)
        .set({ ...profile, updatedAt: new Date() }, { merge: true }).catch(warn);
    }
    if (device.device_id) {
      // update() fails on phones registered over the direct route (no document): that is fine.
      firestore.doc(`devices/${device.device_id}`)
        .update({ ...profile, updatedAt: new Date() })
        .catch((error) => { if (error.code !== 5) warn(error); });
    }
  }

  // An admin deleted a recipient: forget the phone's sign-in, so a reinstall
  // asks again and a restart does not bring the registration back.
  function deleteProfile(device) {
    const warn = (error) => console.warn("Could not delete the app profile in Firestore:", error.message);
    if (device.android_id) firestore.doc(`profiles/${device.android_id}`).delete().catch(warn);
    if (device.device_id) firestore.doc(`devices/${device.device_id}`).delete().catch(warn);
  }

  // Start-up: make Firestore match the database (e.g. an alert closed while offline).
  publishIncident(getActiveIncident());
  console.log("Firestore sync started");
  return { publishIncident, publishProfile, deleteProfile };
}

module.exports = { startFirebaseSync };
