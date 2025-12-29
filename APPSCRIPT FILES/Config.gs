// Config.gs
const CFG = {
  DOMAIN: "pacsands.com",

  SPREADSHEET_ID: "1pHE3KzJaJ5KDpDuKgO29BfJErbFxMqdnhkfOX5woupo",

  SHEET_PROJECTS: "Project List - Designers",
  SHEET_USERS: "Designer Emails",
  SHEET_COLORS: "Phase Colors",

  // We'll create these if missing:
  SHEET_NOTIFICATIONS: "Notifications",
  SHEET_USER_SETTINGS: "User Settings"
};

function getSS_() {
  return SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
}

function getSheet_(name) {
  const ss = getSS_();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("Missing sheet tab: " + name);
  return sh;
}

function getMyEmail_() {
  // In-domain deployments typically return the user's email.
  // We use both for reliability.
  const a = Session.getActiveUser().getEmail();
  if (a) return a;
  const e = Session.getEffectiveUser().getEmail();
  return e || "";
}
