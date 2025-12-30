// Config.gs
const CFG = {
  DOMAIN: "pacsands.com",

  // Spreadsheet that acts as your "database"
  SPREADSHEET_ID: "1pHE3KzJaJ5KDpDuKgO29BfJErbFxMqdnhkfOX5woupo",

  // Main data tabs
  SHEET_PROJECTS: "Project List - Designers",
  SHEET_USERS: "Designer Emails",
  SHEET_COLORS: "Phase Colors",

  // Created by setup() if missing
  SHEET_NOTIFICATIONS: "Notifications",
  SHEET_USER_SETTINGS: "User Settings"
};

// Cache the spreadsheet object so we don't repeatedly open it
let __SS_CACHE__ = null;

function getSS_() {
  if (__SS_CACHE__) return __SS_CACHE__;

  // Preferred path for webapp deployments
  if (CFG.SPREADSHEET_ID) {
    __SS_CACHE__ = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
    return __SS_CACHE__;
  }

  // Fallback (useful if script is bound to a sheet during testing)
  __SS_CACHE__ = SpreadsheetApp.getActiveSpreadsheet();
  return __SS_CACHE__;
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
  if (a) return String(a).trim();
  const e = Session.getEffectiveUser().getEmail();
  return String(e || "").trim();
}
