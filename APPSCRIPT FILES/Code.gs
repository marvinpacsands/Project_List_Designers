// Code.gs
function doGet(e) {
  // Step 4 goal: confirm web app can render something and detect user email.
  const email = getMyEmail_();

  const html = HtmlService.createHtmlOutput(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>Dashboard Bootstrap</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 16px; }
          .box { padding: 12px; border: 1px solid #ddd; border-radius: 8px; }
          code { background:#f6f6f6; padding:2px 6px; border-radius:6px; }
        </style>
      </head>
      <body>
        <h2>Dashboard Web App is Running ✅</h2>
        <div class="box">
          <div><b>Detected email:</b> <code>${email || "(blank)"}</code></div>
          <div style="margin-top:8px;">Next: we’ll load role + projects from the Sheet and then inject your full UI.</div>
        </div>
      </body>
    </html>
  `);

  return html
    .setTitle("Dashboard Bootstrap")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // useful later if we embed in Google Sites
}
