/**
 * Web app entry point.
 * Serves the dashboard UI and injects the signed-in user.
 */
function doGet(e) {
  const email = getSignedInEmail_(e);

  if (!email) {
    return HtmlService
      .createHtmlOutput('Please sign in with your @pacsands.com Google account.');
  }

  if (!isAllowedDomain_(email)) {
    return HtmlService
      .createHtmlOutput('Unauthorized. Use your @pacsands.com account.');
  }

  // Serve the real UI (public/Index.html) as a template
  const t = HtmlService.createTemplateFromFile('public/Index');
  t.userEmail = email;
  t.userName = email.split('@')[0];
  t.appBase = ScriptApp.getService().getUrl(); // your .../exec URL

  return t.evaluate()
    .setTitle('Project Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * HTML templating helper.
 * Usage in HTML: <?!= include('public/js/AnimationsJs'); ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getSignedInEmail_(e) {
  // Works when deployed as: "Execute as: User accessing the web app"
  const active = Session.getActiveUser().getEmail();
  if (active) return active;

  const effective = Session.getEffectiveUser().getEmail();
  if (effective) return effective;

  // Dev fallback only (optional): allow ?email=... for testing
  return (e && e.parameter && e.parameter.email) ? String(e.parameter.email) : '';
}

function isAllowedDomain_(email) {
  return String(email).toLowerCase().endsWith('@pacsands.com');
}
