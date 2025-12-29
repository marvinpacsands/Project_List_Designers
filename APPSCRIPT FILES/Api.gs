/**
 * Api.gs
 * Implements:
 *  GET  /api/bootstrap
 *  GET  /api/projects?mode=mine|pm|ops&email=...&pm=...&includeUnassigned=...
 *  POST /api/update
 *  POST /api/custom-order
 *  GET  /api/notifications
 *  POST /api/notifications/ack
 *
 * Sheet-backed (Google Sheets is source of truth).
 */

// ======== CONFIG (edit these if your tab names differ) ========
const APP_CONFIG = {
  // Set this in Script Properties as SPREADSHEET_ID (recommended),
  // OR hardcode here as fallback:
  SPREADSHEET_ID_FALLBACK: '',

  SHEETS: {
    PROJECTS: 'Project List - Designers', // your main data table
    PEOPLE: 'Designer Emails',            // role/name/email list
    COLORS: 'Phase Colors',               // phase -> hex color
    USER_SETTINGS: 'User Settings',       // email/name/role/customSortOrderJson
    NOTIFICATIONS: 'Notifications'        // notifications table (optional)
  },

  HEADER_ROW: 1
};

// ======== Public entrypoints (these should be called by Code.gs router) ========
function api_doGet(e) {
  const route = api_route_(e);
  try {
    if (route === 'bootstrap') return api_json_(api_bootstrap_(e));
    if (route === 'projects') return api_json_(api_projects_(e));
    if (route === 'notifications') return api_json_(api_notifications_(e));
    return api_json_({ ok: false, error: 'Unknown GET route', route });
  } catch (err) {
    return api_json_({ ok: false, error: String(err && err.message ? err.message : err), stack: String(err && err.stack ? err.stack : '') }, 500);
  }
}

function api_doPost(e) {
  const route = api_route_(e);
  const body = api_parseBody_(e);
  try {
    if (route === 'update') return api_json_(api_update_(body));
    if (route === 'custom-order') return api_json_(api_customOrder_(body));
    if (route === 'notifications/ack') return api_json_(api_notificationsAck_(body));
    return api_json_({ ok: false, error: 'Unknown POST route', route });
  } catch (err) {
    return api_json_({ ok: false, error: String(err && err.message ? err.message : err), stack: String(err && err.stack ? err && err.stack : '') }, 500);
  }
}

// ======== ROUTING ========
function api_route_(e) {
  const pathInfo = (e && e.pathInfo) ? String(e.pathInfo) : '';
  // Expected: /api/bootstrap, /api/projects, /api/update, ...
  const cleaned = pathInfo.replace(/^\/+/, ''); // remove leading /
  if (!cleaned) return '';
  if (cleaned.startsWith('api/')) return cleaned.slice(4); // remove "api/"
  return cleaned; // if already passed in as just "bootstrap", etc.
}

// ======== BOOTSTRAP ========
function api_bootstrap_(e) {
  const email = api_param_(e, 'email') || api_activeEmail_() || '';
  const people = api_readPeople_();
  const phaseColors = api_readPhaseColors_();

  // Resolve name + roles
  const userSettings = api_readUserSettingsByEmail_(email);
  const person = people.find(p => api_norm_(p.email) === api_norm_(email));
  const name = (userSettings && userSettings.name) || (person && person.name) || email;
  const roleRaw = (userSettings && userSettings.role) || (person && person.role) || '';
  const roles = api_rolesFromRoleString_(roleRaw);

  // Numeric priorities 1-10 + blank (your UI expects these)
  const priorityOptions = [''].concat(Array.from({ length: 10 }, (_, i) => String(i + 1)));

  return {
    ok: true,
    email,
    name,
    roles,
    priorityOptions,
    phaseColors,
    logoUrl: '', // optional (keep blank if not using)
  };
}

// ======== PROJECTS ========
function api_projects_(e) {
  const mode = (api_param_(e, 'mode') || 'mine').toLowerCase();
  const email = api_param_(e, 'email') || api_activeEmail_() || '';
  const pmFilter = api_param_(e, 'pm') || '';
  const includeUnassigned = String(api_param_(e, 'includeUnassigned') || '').toLowerCase() === 'true';

  const ss = api_ss_();
  const projectsSheet = api_getSheet_(ss, [APP_CONFIG.SHEETS.PROJECTS, 'Sheet 1']);
  const people = api_readPeople_();
  const phaseColors = api_readPhaseColors_();
  const userSettings = api_readUserSettingsByEmail_(email);

  // Resolve the "display name" for matching designer slots
  const person = people.find(p => api_norm_(p.email) === api_norm_(email));
  const requesterName = (userSettings && userSettings.name) || (person && person.name) || email;

  const table = api_readTable_(projectsSheet);
  const rawProjects = table.rows.map(r => api_projectFromRow_(r));

  // Build pmList for PM dropdown
  const pmList = api_unique_(rawProjects.map(p => p.pmName || 'Unassigned'))
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));

  // Transform into UI rows (team[], pm{}, etc.)
  let rows = rawProjects.map(p => api_toUiRow_(p));

  if (mode === 'mine') {
    // Show projects where the requester is in any designer slot
    rows = rows
      .map(r => api_attachMySlot_(r, requesterName))
      .filter(r => !!r.my && !!r.my.slot);

  } else if (mode === 'pm') {
    // PM view: filter by pm name unless "__ALL__"
    if (pmFilter && pmFilter !== '__ALL__') {
      if (pmFilter === 'Unassigned') {
        rows = rows.filter(r => !r.pmName || api_norm_(r.pmName) === api_norm_('Unassigned'));
      } else {
        rows = rows.filter(r => api_norm_(r.pmName) === api_norm_(pmFilter));
      }
    }

    // includeUnassigned: append unassigned if toggled
    if (!includeUnassigned) {
      // If PM picked a specific PM, we usually hide unassigned unless toggled
      if (pmFilter && pmFilter !== '__ALL__' && pmFilter !== 'Unassigned') {
        rows = rows.filter(r => api_norm_(r.pmName) !== api_norm_('Unassigned'));
      }
    }

  } else if (mode === 'ops') {
    // Ops view: typically show operational = true (and/or whatever you want)
    // Keep everything if operational column is blank in your sheet
    rows = rows.filter(r => r.operational === true || r.operational === 'TRUE' || r.operational === 'true' || r.operational === 1 || r.operational === '1' || r.operational === '' || r.operational == null);
  }

  // Custom sort order (PM only)
  let customSortOrder = [];
  if (userSettings && userSettings.customSortOrderJson) {
    try { customSortOrder = JSON.parse(userSettings.customSortOrderJson) || []; } catch (e2) {}
  }

  return {
    ok: true,
    mode,
    email,
    requesterName,
    projects: rows,
    people,
    pmList,
    customSortOrder,
    phaseColors
  };
}

// ======== UPDATE ========
function api_update_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const email = (body && body.email) || api_activeEmail_() || '';
    const mode = (body && body.mode) || '';
    const payload = (body && body.payload) || {};

    const ss = api_ss_();
    const projectsSheet = api_getSheet_(ss, [APP_CONFIG.SHEETS.PROJECTS, 'Sheet 1']);
    const table = api_readTable_(projectsSheet);

    const rowIndex = String(payload.rowIndex || '');
    if (!rowIndex) return { ok: false, error: 'Missing payload.rowIndex' };

    // Find row by rowIndex column
    const idxCol = api_findCol_(table.headers, ['rowIndex']);
    if (!idxCol) return { ok: false, error: 'Could not find "rowIndex" column in Projects sheet.' };

    let targetRowNumber = -1; // sheet row number (1-based)
    for (let i = 0; i < table.rows.length; i++) {
      const r = table.rows[i];
      if (String(r[idxCol] || '') === rowIndex) {
        targetRowNumber = table.startRow + i;
        break;
      }
    }
    if (targetRowNumber < 0) return { ok: false, error: 'rowIndex not found in sheet', rowIndex };

    // Resolve name for mine-mode updates (to know which slot to write)
    const people = api_readPeople_();
    const userSettings = api_readUserSettingsByEmail_(email);
    const person = people.find(p => api_norm_(p.email) === api_norm_(email));
    const name = (userSettings && userSettings.name) || (person && person.name) || email;

    // Column map (canonical)
    const col = (keys) => api_findCol_(table.headers, keys);

    const updates = [];

    // Common fields that might be updated
    const c_pm = col(['pm']);
    const c_pmNotes = col(['pmNotes']);
    const c_opsNotes = col(['operationalNotes']);
    const c_d1 = col(['designer1']);
    const c_d2 = col(['designer2']);
    const c_d3 = col(['designer3']);
    const c_p1 = col(['priority1']);
    const c_p2 = col(['priority2']);
    const c_p3 = col(['priority3']);
    const c_n1 = col(['notes1']);
    const c_n2 = col(['notes2']);
    const c_n3 = col(['notes3']);

    // lastModified columns
    const c_lmDate = col(['lastModified/dateDisplay']);
    const c_lmMs = col(['lastModified/dateMs']);
    const c_lmBy = col(['lastModified/by']);
    const c_lmDisp = col(['lastModified/display']);

    if (mode === 'mine') {
      // Write to the slot matching this user's name
      const existing = api_projectFromRow_(table.rows[targetRowNumber - table.startRow]); // raw project
      const slot = api_findMySlot_(existing, name);
      if (!slot) return { ok: false, error: 'User not assigned to any designer slot for this project.', name, rowIndex };

      if (slot === 1) {
        if (c_p1) updates.push([c_p1, payload.priority ?? '']);
        if (c_n1) updates.push([c_n1, payload.notes ?? '']);
      } else if (slot === 2) {
        if (c_p2) updates.push([c_p2, payload.priority ?? '']);
        if (c_n2) updates.push([c_n2, payload.notes ?? '']);
      } else if (slot === 3) {
        if (c_p3) updates.push([c_p3, payload.priority ?? '']);
        if (c_n3) updates.push([c_n3, payload.notes ?? '']);
      }

    } else if (mode === 'pm') {
      if (c_pm) updates.push([c_pm, payload.pmName ?? '']);
      if (c_pmNotes) updates.push([c_pmNotes, payload.pmNotes ?? '']);

      if (c_d1) updates.push([c_d1, payload.designer1 ?? '']);
      if (c_d2) updates.push([c_d2, payload.designer2 ?? '']);
      if (c_d3) updates.push([c_d3, payload.designer3 ?? '']);

      if (c_p1) updates.push([c_p1, payload.designer1Priority ?? '']);
      if (c_p2) updates.push([c_p2, payload.designer2Priority ?? '']);
      if (c_p3) updates.push([c_p3, payload.designer3Priority ?? '']);

    } else if (mode === 'ops') {
      if (c_pm) updates.push([c_pm, payload.pmName ?? '']);
      if (c_opsNotes) updates.push([c_opsNotes, payload.operationalNotes ?? '']);

      if (c_d1) updates.push([c_d1, payload.designer1 ?? '']);
      if (c_d2) updates.push([c_d2, payload.designer2 ?? '']);
      if (c_d3) updates.push([c_d3, payload.designer3 ?? '']);
    }

    // Apply updates
    updates.forEach(([colIdx, val]) => {
      projectsSheet.getRange(targetRowNumber, colIdx).setValue(val);
    });

    // Update lastModified
    const now = new Date();
    const nowMs = Date.now();
    const tz = Session.getScriptTimeZone() || 'America/Los_Angeles';
    const dateDisplay = Utilities.formatDate(now, tz, 'M/d/yyyy');
    const display = dateDisplay;

    if (c_lmDate) projectsSheet.getRange(targetRowNumber, c_lmDate).setValue(now);
    if (c_lmMs) projectsSheet.getRange(targetRowNumber, c_lmMs).setValue(String(nowMs));
    if (c_lmBy) projectsSheet.getRange(targetRowNumber, c_lmBy).setValue(email);
    if (c_lmDisp) projectsSheet.getRange(targetRowNumber, c_lmDisp).setValue(display);

    return { ok: true, savedAtMs: nowMs, savedAtDisplay: dateDisplay };

  } finally {
    lock.releaseLock();
  }
}

// ======== CUSTOM ORDER ========
function api_customOrder_(body) {
  const email = (body && body.email) || '';
  const orderedRowIndexes = (body && body.orderedRowIndexes) || [];
  const ss = api_ss_();
  const sheet = api_getSheet_(ss, [APP_CONFIG.SHEETS.USER_SETTINGS]);

  const table = api_readTable_(sheet);
  const c_email = api_findCol_(table.headers, ['email']);
  const c_sort = api_findCol_(table.headers, ['customSortOrderJson']);
  const c_updated = api_findCol_(table.headers, ['updatedAtMs']);
  if (!c_email || !c_sort) return { ok: false, error: 'User Settings sheet missing email/customSortOrderJson columns.' };

  // Find user row; if not exists, append
  let rowNum = -1;
  for (let i = 0; i < table.rows.length; i++) {
    if (api_norm_(table.rows[i][c_email]) === api_norm_(email)) {
      rowNum = table.startRow + i;
      break;
    }
  }
  if (rowNum < 0) {
    rowNum = sheet.getLastRow() + 1;
    sheet.getRange(rowNum, c_email).setValue(email);
  }

  sheet.getRange(rowNum, c_sort).setValue(JSON.stringify(orderedRowIndexes.map(String)));
  if (c_updated) sheet.getRange(rowNum, c_updated).setValue(String(Date.now()));

  return { ok: true };
}

// ======== NOTIFICATIONS (basic; safe if sheet empty) ========
function api_notifications_(e) {
  const email = api_param_(e, 'email') || api_activeEmail_() || '';
  const name = api_param_(e, 'name') || email;

  const ss = api_ss_();
  const sheet = ss.getSheetByName(APP_CONFIG.SHEETS.NOTIFICATIONS);
  if (!sheet) return { ok: true, notifications: [] };

  const table = api_readTable_(sheet);

  const c_id = api_findCol_(table.headers, ['id']);
  const c_created = api_findCol_(table.headers, ['createdAt']);
  const c_readBy = api_findCol_(table.headers, ['readByJson']);
  const c_targetRole = api_findCol_(table.headers, ['targetRole']);
  const c_targetName = api_findCol_(table.headers, ['targetName']);
  const c_title = api_findCol_(table.headers, ['title']);
  const c_body = api_findCol_(table.headers, ['body']);
  const c_proj = api_findCol_(table.headers, ['projectNumber']);

  const userSettings = api_readUserSettingsByEmail_(email);
  const roles = api_rolesFromRoleString_((userSettings && userSettings.role) || '');

  const notifs = table.rows.map(r => {
    let readBy = {};
    try { readBy = JSON.parse(r[c_readBy] || '{}') || {}; } catch (e2) {}
    return {
      id: r[c_id],
      createdAt: r[c_created],
      readByJson: r[c_readBy] || '{}',
      readBy,
      targetRole: r[c_targetRole] || '',
      targetName: r[c_targetName] || '',
      title: r[c_title] || '',
      body: r[c_body] || '',
      projectNumber: r[c_proj] || ''
    };
  }).filter(n => {
    // target matching
    const tr = api_norm_(n.targetRole);
    const tn = api_norm_(n.targetName);
    const roleMatch = !tr || roles.some(rr => api_norm_(rr) === tr);
    const nameMatch = !tn || api_norm_(name) === tn;
    const unread = !n.readBy || !n.readBy[email];
    return unread && (roleMatch || nameMatch);
  });

  return { ok: true, notifications: notifs };
}

function api_notificationsAck_(body) {
  const email = (body && body.email) || '';
  const id = (body && body.id) || '';
  if (!email || !id) return { ok: false, error: 'Missing email or id' };

  const ss = api_ss_();
  const sheet = ss.getSheetByName(APP_CONFIG.SHEETS.NOTIFICATIONS);
  if (!sheet) return { ok: true };

  const table = api_readTable_(sheet);
  const c_id = api_findCol_(table.headers, ['id']);
  const c_readBy = api_findCol_(table.headers, ['readByJson']);
  if (!c_id || !c_readBy) return { ok: false, error: 'Notifications sheet missing id/readByJson.' };

  for (let i = 0; i < table.rows.length; i++) {
    if (String(table.rows[i][c_id] || '') === String(id)) {
      const rowNum = table.startRow + i;
      let readBy = {};
      try { readBy = JSON.parse(table.rows[i][c_readBy] || '{}') || {}; } catch (e2) {}
      readBy[email] = Date.now();
      sheet.getRange(rowNum, c_readBy).setValue(JSON.stringify(readBy));
      break;
    }
  }
  return { ok: true };
}

// ======== Helpers ========
function api_ss_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID') || APP_CONFIG.SPREADSHEET_ID_FALLBACK || '';
  if (!id) throw new Error('Missing SPREADSHEET_ID. Set it in Script Properties.');
  return SpreadsheetApp.openById(id);
}

function api_getSheet_(ss, names) {
  for (const n of names) {
    const sh = ss.getSheetByName(n);
    if (sh) return sh;
  }
  throw new Error('Could not find any of these sheets: ' + JSON.stringify(names));
}

function api_readTable_(sheet) {
  const rng = sheet.getDataRange();
  const values = rng.getValues();
  const headerRow = APP_CONFIG.HEADER_ROW;

  const headers = {};
  const headerVals = values[headerRow - 1] || [];
  for (let c = 0; c < headerVals.length; c++) {
    const h = headerVals[c];
    if (!h) continue;
    const key = api_normHeader_(h);
    // 1-based col index
    if (!headers[key]) headers[key] = c + 1;
  }

  const startRow = headerRow + 1;
  const rows = [];
  for (let r = startRow; r <= values.length; r++) {
    const row = values[r - 1];
    // skip blank rows (no projectName + no projectNumber)
    if (!row || row.join('').trim() === '') continue;
    rows.push(row);
  }

  return { headers, rows, startRow };
}

function api_findCol_(headers, variants) {
  for (const v of variants) {
    const k = api_normHeader_(v);
    if (headers[k]) return headers[k];
  }
  return null;
}

function api_projectFromRow_(row) {
  // Minimal canonical extract from row array, using safe indices later in api_toUiRow_
  // We'll keep raw values in an object by canonical field names.
  // This is a “best effort” — if your sheet uses the standard headers from db.json->xlsx, it will match perfectly.
  const raw = {};
  // We'll populate later using header-based getters in api_toUiRow_ via direct col reads if needed.
  // For simplicity, store row array itself.
  raw.__row = row;
  return raw;
}

function api_toUiRow_(raw) {
  // Re-read using headers each time is expensive; we already have row array only.
  // Instead, we use a fixed mapping when the sheet uses canonical headers exported from db.json->xlsx:
  // Columns 1..26 match: id, projectName, status, createdDate, projectNumber, rowIndex, lastModified/*, pmPriority, pmNotes, pm, priority/notes/designer 1..3, internalId, operational, operationalNotes
  const r = raw.__row || [];

  const id = r[0];
  const projectName = r[1];
  const status = r[2];
  const createdDate = r[3];
  const projectNumber = r[4];
  const rowIndex = r[5];

  const lastModified = {
    dateDisplay: r[6] || '',
    dateMs: r[7] || '',
    by: r[8] || '',
    display: r[9] || ''
  };

  const pmPriority = r[10] || '';
  const pmNotes = r[11] || '';
  const pmName = r[12] || '';

  const team = [
    { slot: 1, name: r[15] || 'Unassigned', priority: r[13] || '', notes: r[14] || '', dateDisplay: '' },
    { slot: 2, name: r[18] || 'Unassigned', priority: r[16] || '', notes: r[17] || '', dateDisplay: '' },
    { slot: 3, name: r[21] || 'Unassigned', priority: r[19] || '', notes: r[20] || '', dateDisplay: '' }
  ];

  const internalId = r[22] || '';
  const operational = r[23] || '';
  const operationalNotes = r[24] || '';

  return {
    id,
    rowIndex: String(rowIndex || ''),
    projectNumber: String(projectNumber || ''),
    projectName: String(projectName || ''),
    status: String(status || ''),
    createdDate: createdDate || '',
    internalId: String(internalId || ''),
    operational,
    operationalNotes: String(operationalNotes || ''),
    lastModified,
    pmName: String(pmName || ''),
    pm: {
      priority: String(pmPriority || ''),
      notes: String(pmNotes || ''),
      dateDisplay: ''
    },
    team
  };
}

function api_attachMySlot_(uiRow, requesterName) {
  const nm = api_norm_(requesterName);
  const found = uiRow.team.find(t => api_norm_(t.name) === nm);
  if (found) uiRow.my = { slot: found.slot, priority: found.priority, notes: found.notes, dateDisplay: found.dateDisplay || '' };
  return uiRow;
}

function api_findMySlot_(existingRawProject, requesterName) {
  const ui = api_toUiRow_(existingRawProject);
  const nm = api_norm_(requesterName);
  const found = ui.team.find(t => api_norm_(t.name) === nm);
  return found ? found.slot : null;
}

function api_readPeople_() {
  const ss = api_ss_();
  const sheet = ss.getSheetByName(APP_CONFIG.SHEETS.PEOPLE);
  if (!sheet) return [];
  const table = api_readTable_(sheet);

  // People sheet expected columns: Role, Name, Email
  const out = [];
  for (const row of table.rows) {
    const role = row[0];
    const name = row[1];
    const email = row[2];
    if (name && email && role) out.push({ role: String(role), name: String(name), email: String(email) });
  }
  return out;
}

function api_readPhaseColors_() {
  const ss = api_ss_();
  const sheet = ss.getSheetByName(APP_CONFIG.SHEETS.COLORS);
  if (!sheet) return {};
  const table = api_readTable_(sheet);

  // Expected: Color (Hex), Phase
  const colors = {};
  for (const row of table.rows) {
    const hex = row[0];
    const phase = row[1];
    if (hex && phase) colors[String(phase)] = String(hex);
  }
  return colors;
}

function api_readUserSettingsByEmail_(email) {
  if (!email) return null;
  const ss = api_ss_();
  const sheet = ss.getSheetByName(APP_CONFIG.SHEETS.USER_SETTINGS);
  if (!sheet) return null;

  const table = api_readTable_(sheet);
  // columns: email, name, role, customSortOrderJson, updatedAtMs
  for (const row of table.rows) {
    if (api_norm_(row[0]) === api_norm_(email)) {
      return {
        email: row[0] || '',
        name: row[1] || '',
        role: row[2] || '',
        customSortOrderJson: row[3] || '',
        updatedAtMs: row[4] || ''
      };
    }
  }
  return null;
}

function api_rolesFromRoleString_(roleStr) {
  const s = String(roleStr || '').trim();
  if (!s) return [];
  // Accept comma-separated roles or single role
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function api_activeEmail_() {
  try {
    const e = Session.getActiveUser().getEmail();
    return e || '';
  } catch (err) {
    return '';
  }
}

function api_param_(e, key) {
  try {
    return (e && e.parameter && e.parameter[key]) ? String(e.parameter[key]) : '';
  } catch (err) {
    return '';
  }
}

function api_parseBody_(e) {
  try {
    const txt = e && e.postData && e.postData.contents ? e.postData.contents : '';
    return txt ? JSON.parse(txt) : {};
  } catch (err) {
    return {};
  }
}

function api_json_(obj, code) {
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  // Apps Script doesn't really support setting status code in ContentService;
  // we include "ok" and "error" fields instead.
  return out;
}

function api_norm_(s) { return String(s || '').toLowerCase().trim(); }
function api_normHeader_(s) { return api_norm_(s).replace(/\s+/g, '').replace(/[^\w]/g, ''); }

function api_unique_(arr) {
  const seen = new Set();
  const out = [];
  arr.forEach(x => {
    const k = String(x || '');
    if (!k) return;
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  });
  return out;
}
