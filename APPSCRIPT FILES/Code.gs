// Code.gs
function getSessionEmail_() {
  return String(Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
}

function rolesFrom_(roleStr) {
  return String(roleStr || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Reads ADMIN role from your users table.
 * Tries "Designer Emails" first, then "User settings".
 * Expects headers including: Email, Role (case-insensitive)
 */
function isAdminEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return false;

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID); // <-- uses your existing Config constant
  const sh =
    ss.getSheetByName('Designer Emails') ||
    ss.getSheetByName('User settings');

  if (!sh) return false;

  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return false;

  const headers = values[0].map(h => String(h || '').trim().toLowerCase());
  const emailCol = headers.indexOf('email');
  const roleCol = headers.indexOf('role');

  if (emailCol === -1 || roleCol === -1) return false;

  for (let i = 1; i < values.length; i++) {
    const rowEmail = String(values[i][emailCol] || '').trim().toLowerCase();
    if (rowEmail === email) {
      const roles = rolesFrom_(values[i][roleCol]);
      return roles.includes('ADMIN');
    }
  }
  return false;
}

/**
 * Include helper for Apps Script HTML templates.
 * Usage in HTML: <?!= include('CoreJs'); ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet(e) {
  const actorEmail = getSessionEmail_();            // real signed-in user
  const imp = e && e.parameter ? e.parameter.impersonate : '';

  const actorIsAdmin = isAdminEmail_(actorEmail);

  // Only ADMIN can impersonate; everyone else stays as themselves
  const targetEmail = (actorIsAdmin && imp) ? String(imp).trim().toLowerCase() : actorEmail;

  const t = HtmlService.createTemplateFromFile('Index');

  // Frontend will use window.currentUser.email (targetEmail)
  t.currentUserJson = JSON.stringify({
    email: targetEmail,
    actorEmail: actorEmail,
    isImpersonating: targetEmail !== actorEmail,
    isAdmin: actorIsAdmin
  });

  return t.evaluate()
    .setTitle('Project Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
