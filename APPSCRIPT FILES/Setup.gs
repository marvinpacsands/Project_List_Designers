// Setup.gs
function setup() {
  const ss = getSS_();

  // 1) Create Notifications tab if missing
  if (!ss.getSheetByName(CFG.SHEET_NOTIFICATIONS)) {
    const sh = ss.insertSheet(CFG.SHEET_NOTIFICATIONS);
    sh.getRange(1, 1, 1, 10).setValues([[
      "id", "createdAtMs", "createdAtDisplay", "email", "name",
      "role", "message", "projectNumber", "rowIndex", "ackedAtMs"
    ]]);
    sh.setFrozenRows(1);
  }

  // 2) Create User Settings tab if missing (for PM custom sort order, etc.)
  if (!ss.getSheetByName(CFG.SHEET_USER_SETTINGS)) {
    const sh = ss.insertSheet(CFG.SHEET_USER_SETTINGS);
    sh.getRange(1, 1, 1, 5).setValues([[
      "email", "name", "role", "customSortOrderJson", "updatedAtMs"
    ]]);
    sh.setFrozenRows(1);
  }

  // 3) Ensure stable identity columns exist + backfill them (Email - DESIGNER1/2/3)
  const projectsSh = ss.getSheetByName(CFG.SHEET_PROJECTS);
  if (projectsSh) {
    const required = [
      "Email - DESIGNER1",
      "Email - DESIGNER2",
      "Email - DESIGNER3"
    ];
    const map = ensureColumns_(projectsSh, required);
    backfillDesignerEmailIdentity_(projectsSh, map);
  }

  SpreadsheetApp.getUi().alert("Setup complete ✅");
}

/**
 * Backfills Email - DESIGNER1/2/3 using current values in DESIGNER1/2/3
 * and your Designer Emails sheet mapping (name -> email).
 * - Does NOT change the visible designer name cells.
 * - Only fills email columns when they are blank.
 */
function backfillDesignerEmailIdentity_(projectsSh, map) {
  const lastRow = projectsSh.getLastRow();
  if (lastRow < 2) return;

  const needNameCols = ["DESIGNER1", "DESIGNER2", "DESIGNER3"];
  for (const h of needNameCols) {
    if (map[h] === undefined) return; // If the project sheet doesn't have these, skip silently.
  }

  const emailHeaders = ["Email - DESIGNER1", "Email - DESIGNER2", "Email - DESIGNER3"];
  for (const h of emailHeaders) {
    if (map[h] === undefined) return; // Shouldn't happen after ensureColumns_, but safe.
  }

  const userIndex = buildUserIndex_();

  // Read rows 2..end across all columns so indices align with header map.
  const range = projectsSh.getRange(2, 1, lastRow - 1, projectsSh.getLastColumn());
  const rows = range.getValues();

  let changed = false;

  rows.forEach(row => {
    for (let slot = 1; slot <= 3; slot++) {
      const nameVal = String(row[map[`DESIGNER${slot}`]] || "").trim();
      const emailCellIdx = map[`Email - DESIGNER${slot}`];
      const existingEmail = String(row[emailCellIdx] || "").trim();

      if (existingEmail) continue;
      if (!nameVal) continue;

      const resolvedEmail = resolveEmailFromDesignerValue_(nameVal, userIndex);
      if (resolvedEmail) {
        row[emailCellIdx] = resolvedEmail;
        changed = true;
      }
    }
  });

  if (!changed) return;

  // Write back ONLY the three email columns (no other data changes)
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
