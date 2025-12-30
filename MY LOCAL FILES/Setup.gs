// Setup.gs
function setup() {
  const ss = getSS_();

  // Create Notifications tab if missing
  if (!ss.getSheetByName(CFG.SHEET_NOTIFICATIONS)) {
    const sh = ss.insertSheet(CFG.SHEET_NOTIFICATIONS);
    sh.getRange(1, 1, 1, 10).setValues([[
      "id", "createdAtMs", "createdAtDisplay", "email", "name",
      "role", "message", "projectNumber", "rowIndex", "ackedAtMs"
    ]]);
    sh.setFrozenRows(1);
  }

  // Create User Settings tab if missing (for PM custom sort order, etc.)
  if (!ss.getSheetByName(CFG.SHEET_USER_SETTINGS)) {
    const sh = ss.insertSheet(CFG.SHEET_USER_SETTINGS);
    sh.getRange(1, 1, 1, 5).setValues([[
      "email", "name", "role", "customSortOrderJson", "updatedAtMs"
    ]]);
    sh.setFrozenRows(1);
  }

  SpreadsheetApp.getUi().alert("Setup complete ✅");
}

function testWhoAmI() {
  const email = getMyEmail_();
  Logger.log("Email: " + email);
  return email;
}
