// Code.gs

/**
 * Include helper for Apps Script HTML templates.
 * Usage in HTML: <?!= include('CoreJs'); ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function doGet(e) {
  const email = getMyEmail_(); // from Config.gs

  // Render Index.html as a template so it can use <?!= ... ?> includes.
  const t = HtmlService.createTemplateFromFile('Index');

  // Mimic your old Node server behavior: inject a "current user" object.
  // We'll enrich this later (role/name/etc) once we read your Google Sheet.
  t.currentUserJson = JSON.stringify({ email });

  return t.evaluate()
    .setTitle('Project Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
