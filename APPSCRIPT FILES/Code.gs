// Code.gs 447
function normalizeEmailParam_(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch (e) {}
  return s.trim().toLowerCase();
}

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

  // Your "Designer Emails" tab is Role | Name | Email (no need to rely on headers)
  const sh = getSheet_(CFG.SHEET_USERS); // uses Config.gs helpers
  const values = sh.getDataRange().getValues();
  if (!values || values.length < 2) return false;

  for (let r = 1; r < values.length; r++) {
    const role = String(values[r][0] || '');
    const em = String(values[r][2] || '').trim().toLowerCase();
    if (em === email) {
      const roles = rolesFrom_(role);
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
  const actorEmail = normalizeEmailParam_(getSessionEmail_()); // real signed-in user
  const impRaw = e && e.parameter ? e.parameter.impersonate : '';
  const impEmail = normalizeEmailParam_(impRaw);

  const actorIsAdmin = isAdminEmail_(actorEmail);

  // Only ADMIN can impersonate; everyone else stays as themselves
  const targetEmail = (actorIsAdmin && impEmail) ? impEmail : actorEmail;
//////////
  const t = HtmlService.createTemplateFromFile('Index');
  t.webAppUrl = ScriptApp.getService().getUrl();

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
