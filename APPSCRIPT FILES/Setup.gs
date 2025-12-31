// Setup.gs 447
function setup() {
  const ss = getSS_();

  ensureNotificationsSheet_(ss);
  ensureUserSettingsSheet_(ss);

  // Keep Step 1 behavior (stable designer identity columns)
  ensureDesignerEmailIdentityColumns_(ss);

  SpreadsheetApp.getUi().alert("Setup complete ✅");
}

/**
 * Notifications sheet must match local notification objects:
 * id, createdAt, readBy, targetRole, targetName, title, body, projectNumber
 * plus optional fields used by completed/confetti modal:
 * type, projectName, status, team, hideViewButton
 */
function ensureNotificationsSheet_(ss) {
  const headers = [
    "id",
    "createdAt",        // number (ms)
    "readByJson",       // JSON array string
    "targetRole",       // 'PM' | 'DESIGNER' | 'ANY'
    "targetName",       // name/email (can be comma-separated)
    "title",
    "body",             // HTML string
    "projectNumber",

    // Optional fields used by local UI (completed modal / special behaviors)
    "type",             // e.g. 'COMPLETED_MODAL'
    "projectName",
    "status",
    "teamJson",         // JSON array string
    "hideViewButton"    // true/false
  ];

  let sh = ss.getSheetByName(CFG.SHEET_NOTIFICATIONS);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_NOTIFICATIONS);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return;
  }

  // Ensure all needed columns exist (won't delete anything)
  ensureColumns_(sh, headers);
  sh.setFrozenRows(1);

  // If an older schema exists, try a light migration into the new columns.
  migrateOldNotificationsIfNeeded_(sh);
}

function migrateOldNotificationsIfNeeded_(sh) {
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h || "").trim());
  const map = {};
  header.forEach((h, i) => { if (h) map[h] = i; });

  // Old schema signals
  const hasOld = map["createdAtMs"] !== undefined || map["message"] !== undefined || map["ackedAtMs"] !== undefined;
  if (!hasOld) return;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const range = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
  const rows = range.getValues();

  let changed = false;

  rows.forEach(row => {
    // createdAt
    if (map["createdAt"] !== undefined) {
      const cur = row[map["createdAt"]];
      const fallback = map["createdAtMs"] !== undefined ? row[map["createdAtMs"]] : "";
      if (!cur && fallback) {
        row[map["createdAt"]] = Number(fallback) || "";
        changed = true;
      }
    }

    // title/body
    if (map["title"] !== undefined) {
      if (!row[map["title"]]) {
        row[map["title"]] = "Notification";
        changed = true;
      }
    }
    if (map["body"] !== undefined && map["message"] !== undefined) {
      if (!row[map["body"]] && row[map["message"]]) {
        row[map["body"]] = String(row[map["message"]]);
        changed = true;
      }
    }

    // targetRole/targetName
    if (map["targetRole"] !== undefined && map["role"] !== undefined) {
      if (!row[map["targetRole"]] && row[map["role"]]) {
        row[map["targetRole"]] = String(row[map["role"]]);
        changed = true;
      }
    }
    if (map["targetName"] !== undefined) {
      const oldName = map["name"] !== undefined ? row[map["name"]] : "";
      const oldEmail = map["email"] !== undefined ? row[map["email"]] : "";
      if (!row[map["targetName"]] && (oldName || oldEmail)) {
        row[map["targetName"]] = String(oldName || oldEmail);
        changed = true;
      }
    }

    // readByJson (if old ack exists, mark as read by that email)
    if (map["readByJson"] !== undefined) {
      const cur = String(row[map["readByJson"]] || "").trim();
      if (!cur) {
        const ack = map["ackedAtMs"] !== undefined ? row[map["ackedAtMs"]] : "";
        const em = map["email"] !== undefined ? String(row[map["email"]] || "").trim() : "";
        if (ack && em) {
          row[map["readByJson"]] = JSON.stringify([em]);
        } else {
          row[map["readByJson"]] = JSON.stringify([]);
        }
        changed = true;
      }
    }
  });

  if (changed) range.setValues(rows);
}

function ensureUserSettingsSheet_(ss) {
  const headers = ["email", "name", "role", "customSortOrderJson", "updatedAtMs"];

  let sh = ss.getSheetByName(CFG.SHEET_USER_SETTINGS);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_USER_SETTINGS);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return;
  }

  ensureColumns_(sh, headers);
  sh.setFrozenRows(1);
}

function ensureDesignerEmailIdentityColumns_(ss) {
  const projectsSh = ss.getSheetByName(CFG.SHEET_PROJECTS);
  if (!projectsSh) return;

  const required = ["Email - DESIGNER1", "Email - DESIGNER2", "Email - DESIGNER3"];
  const map = ensureColumns_(projectsSh, required);

  backfillDesignerEmailIdentity_(projectsSh, map);
}

/**
 * Backfills Email - DESIGNER1/2/3 using existing DESIGNER1/2/3
 * and Designer Emails mapping. (No UI change.)
 */
function backfillDesignerEmailIdentity_(projectsSh, map) {
  const lastRow = projectsSh.getLastRow();
  if (lastRow < 2) return;

  const need = ["DESIGNER1", "DESIGNER2", "DESIGNER3"];
  for (const h of need) {
    if (map[h] === undefined) return;
  }

  const userIndex = buildUserIndex_();

  const range = projectsSh.getRange(2, 1, lastRow - 1, projectsSh.getLastColumn());
  const rows = range.getValues();

  let changed = false;

  rows.forEach(row => {
    for (let slot = 1; slot <= 3; slot++) {
      const nameVal = String(row[map[`DESIGNER${slot}`]] || "").trim();
      const emailIdx = map[`Email - DESIGNER${slot}`];
      const existing = String(row[emailIdx] || "").trim();

      if (existing || !nameVal) continue;

      const resolved = resolveEmailFromDesignerValue_(nameVal, userIndex);
      if (resolved) {
        row[emailIdx] = resolved;
        changed = true;
      }
    }
  });

  if (!changed) return;

  // Write back only email columns (minimal risk)
  const col1 = map["Email - DESIGNER1"] + 1;
  const col2 = map["Email - DESIGNER2"] + 1;
  const col3 = map["Email - DESIGNER3"] + 1;

  projectsSh.getRange(2, col1, rows.length, 1).setValues(rows.map(r => [r[map["Email - DESIGNER1"]]]));
  projectsSh.getRange(2, col2, rows.length, 1).setValues(rows.map(r => [r[map["Email - DESIGNER2"]]]));
  projectsSh.getRange(2, col3, rows.length, 1).setValues(rows.map(r => [r[map["Email - DESIGNER3"]]]));
}

function testWhoAmI() {
  const email = getMyEmail_();
  Logger.log("Email: " + email);
  return email;
}
