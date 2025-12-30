// Api.gs
// 
// Server-side API for the dashboard (Apps Script).
// This replaces your old Express endpoints with callable GAS functions.
// Frontend behavior stays the same; we’re just changing the transport layer.
//
// Public functions the frontend will call (via google.script.run wrapper in Step 6):
//   - apiBootstrap(email)
//   - apiProjects(params)
//   - apiUpdate({ email, mode, payload })
//   - apiSaveCustomOrder({ email, pmName, orderedRowIndexes })
//   - apiGetNotifications({ email, name })
//   - apiAckNotification({ id, email })

/* =========================
   Helpers
========================= */
function apiAdminListUsers() {
  const actorEmail = getSessionEmail_();
  if (!isAdminEmail_(actorEmail)) throw new Error('Not authorized');

  const sh = getSheet_(CFG.SHEET_USERS); // "Designer Emails"
  const values = sh.getDataRange().getValues();
  if (!values || values.length === 0) return [];

  // Detect header vs no-header
  // Expected either:
  //  - Header row: Role | Name | Email
  //  - or raw data rows: role,name,email
  let startRow = 1;

  const firstRow = values[0].map(v => String(v || '').trim());
  const looksLikeHeader =
    firstRow.some(x => x.toLowerCase() === 'email') ||
    firstRow.some(x => x.toLowerCase() === 'role') ||
    firstRow.some(x => x.toLowerCase() === 'name');

  if (!looksLikeHeader) startRow = 0;

  // If header exists, map indices; otherwise default Role/Name/Email order
  let iRole = 0, iName = 1, iEmail = 2;
  if (looksLikeHeader) {
    const hdr = firstRow.map(x => x.toLowerCase());
    iRole = Math.max(0, hdr.indexOf('role'));
    iName = Math.max(1, hdr.indexOf('name'));
    iEmail = Math.max(2, hdr.indexOf('email'));
  }

  const out = [];
  for (let r = startRow; r < values.length; r++) {
    const role = String(values[r][iRole] || '').trim();
    const name = String(values[r][iName] || '').trim();
    const email = String(values[r][iEmail] || '').trim().toLowerCase();
    if (!email) continue;
    if (!email.endsWith('@pacsands.com')) continue;

    out.push({
      role,
      name: name || email,
      email
    });
  }

  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

function normalize_(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

function assertDomain_(email) {
  email = normalizeEmailParam_(email);
  if (!email) throw new Error('Missing email');
  if (!email.endsWith('@pacsands.com')) throw new Error('Access denied');
  return email;
}


function now_() {
  return new Date();
}

function fmtTime_(d) {
  // Matches the feel of `new Date().toLocaleTimeString()`
  // (Apps Script locale can vary; this is consistent.)
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "h:mm:ss a");
}

function fmtDate_(d) {
  if (!d) return "";
  if (Object.prototype.toString.call(d) === "[object Date]" && !isNaN(d.getTime())) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MM/dd/yyyy");
  }
  // If already a string in the sheet
  return String(d);
}

function safeJsonParse_(s, fallback) {
  try {
    if (!s) return fallback;
    return JSON.parse(String(s));
  } catch (e) {
    return fallback;
  }
}

/**
 * Ensures a sheet has certain header columns (row 1).
 * If any are missing, append them to the end.
 * Returns a map: headerName -> 0-based index in the row array.
 */
function ensureColumns_(sheet, requiredHeaders) {
  const headerRange = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1));
  let headerVals = headerRange.getValues()[0].map(h => String(h || "").trim());

  // If the sheet is brand new and has 0 columns, headerVals may be [""].
  // We'll treat empty headers as missing.
  const existing = new Set(headerVals.filter(Boolean));

  let lastCol = headerVals.length;
  let mutated = false;

  requiredHeaders.forEach(h => {
    if (!existing.has(h)) {
      // append
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(h);
      headerVals.push(h);
      existing.add(h);
      mutated = true;
    }
  });

  // Re-read if we mutated to be safe
  if (mutated) {
    const newHeaderRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
    headerVals = newHeaderRange.getValues()[0].map(h => String(h || "").trim());
  }

  const map = {};
  headerVals.forEach((h, idx) => {
    if (h) map[h] = idx;
  });
  return map;
}

function getUserByEmail_(email) {
  const usersSh = getSheet_(CFG.SHEET_USERS);
  const values = usersSh.getDataRange().getValues();
  if (values.length < 2) return null;

  // Headers: Role | Name | Email
  for (let r = 1; r < values.length; r++) {
    const role = values[r][0];
    const name = values[r][1];
    const em = values[r][2];
    if (normalize_(em) === normalize_(email)) {
      return {
        role: String(role || ""),
        name: String(name || ""),
        email: String(em || "")
      };
    }
  }
  return null;
}

function getAllUsers_() {
  const usersSh = getSheet_(CFG.SHEET_USERS);
  const values = usersSh.getDataRange().getValues();
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const role = values[r][0];
    const name = values[r][1];
    const email = values[r][2];
    if (!email && !name) continue;
    out.push({
      role: String(role || ""),
      name: String(name || ""),
      email: String(email || "")
    });
  }
  return out;
}

function getPhaseColors_() {
  const sh = getSheet_(CFG.SHEET_COLORS);
  const values = sh.getDataRange().getValues();
  const colors = {};
  for (let r = 1; r < values.length; r++) {
    const hex = values[r][0];
    const phase = values[r][1];
    if (!hex || !phase) continue;
    colors[normalize_(phase)] = String(hex).trim();
  }
  return colors;
}

function getProjectsSheetMap_() {
  const sh = getSheet_(CFG.SHEET_PROJECTS);
  const required = [
    "Project #",
    "Project",
    "Status",
    "Internal ID",
    "PM",
    "Operational",
    "PM to Set Priority",
    "PM notes",
    "Operational notes",
    "DESIGNER1",
    "DESIGNER2",
    "DESIGNER3",
    "Prioraty - DESIGNER1",
    "Prioraty - DESIGNER2",
    "Prioraty - DESIGNER3",
    "Notes - DESIGNER1",
    "Notes - DESIGNER2",
    "Notes - DESIGNER3",
    "Date - DESIGNER1",
    "Date - DESIGNER2",
    "Date - DESIGNER3",
    "Date - PM to Set Priority",
    "Date - PM notes",
    "Date - Operational"
  ];
  const map = ensureColumns_(sh, required);
  return { sh, map };
}

function buildTeamFromRow_(row, map) {
  const team = [];
  const dNames = [
    row[map["DESIGNER1"]],
    row[map["DESIGNER2"]],
    row[map["DESIGNER3"]]
  ];
  const prios = [
    row[map["Prioraty - DESIGNER1"]],
    row[map["Prioraty - DESIGNER2"]],
    row[map["Prioraty - DESIGNER3"]]
  ];
  const notes = [
    row[map["Notes - DESIGNER1"]],
    row[map["Notes - DESIGNER2"]],
    row[map["Notes - DESIGNER3"]]
  ];
  const dates = [
    row[map["Date - DESIGNER1"]],
    row[map["Date - DESIGNER2"]],
    row[map["Date - DESIGNER3"]]
  ];

  for (let i = 0; i < 3; i++) {
    team.push({
      slot: i + 1,
      name: String(dNames[i] || ""),
      priority: String(prios[i] == null ? "" : prios[i]),
      notes: String(notes[i] || ""),
      dateDisplay: fmtDate_(dates[i])
    });
  }
  return team;
}

function buildPMFieldsFromRow_(row, map) {
  return {
    priority: String(row[map["PM to Set Priority"]] == null ? "" : row[map["PM to Set Priority"]]),
    notes: String(row[map["PM notes"]] || ""),
    datePriorityDisplay: fmtDate_(row[map["Date - PM to Set Priority"]]),
    dateNotesDisplay: fmtDate_(row[map["Date - PM notes"]])
  };
}

function getCustomSortOrder_(email, pmName) {
  const sh = getSheet_(CFG.SHEET_USER_SETTINGS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  // Headers: email | name | role | customSortOrderJson | updatedAtMs
  for (let r = 1; r < values.length; r++) {
    const em = values[r][0];
    if (normalize_(em) !== normalize_(email)) continue;

    const jsonStr = values[r][3];
    const obj = safeJsonParse_(jsonStr, {});
    const arr = obj && obj[pmName] ? obj[pmName] : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  }
  return [];
}

function setCustomSortOrder_(email, name, role, pmName, orderedRowIndexes) {
  const sh = getSheet_(CFG.SHEET_USER_SETTINGS);
  const values = sh.getDataRange().getValues();

  let rowIndex = -1;
  for (let r = 1; r < values.length; r++) {
    if (normalize_(values[r][0]) === normalize_(email)) {
      rowIndex = r + 1; // sheet row
      break;
    }
  }

  const nowMs = Date.now();
  const orderObj = {};
  if (rowIndex !== -1) {
    const existingJson = sh.getRange(rowIndex, 4).getValue();
    const existingObj = safeJsonParse_(existingJson, {});
    Object.assign(orderObj, existingObj || {});
  }

  orderObj[pmName] = (orderedRowIndexes || []).map(String);

  if (rowIndex === -1) {
    sh.appendRow([email, name || "", role || "", JSON.stringify(orderObj), nowMs]);
  } else {
    sh.getRange(rowIndex, 1, 1, 5).setValues([[
      email,
      name || sh.getRange(rowIndex, 2).getValue() || "",
      role || sh.getRange(rowIndex, 3).getValue() || "",
      JSON.stringify(orderObj),
      nowMs
    ]]);
  }

  return { success: true };
}

/* =========================
   Public API
========================= */

function apiBootstrap(email) {
  const e = assertDomain_(email || getMyEmail_());
  const user = getUserByEmail_(e);

  if (!user) {
    // Don’t break the UI: return something usable even if they’re missing from the list.
    return {
      email: e,
      name: e.split("@")[0],
      roles: ["DESIGNER"],
      isPM: false,
      isOps: false,
      priorityOptions: ["", "Low", "Medium", "High", "Urgent", "On Hold", "Completed", "Abandoned"],
      phaseColors: getPhaseColors_(),
      logoUrl: ""
    };
  }

  const roleStr = String(user.role || "");
  const roles = roleStr
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.toUpperCase());

  return {
    email: user.email,
    name: user.name,
    roles: roles,
    isPM: roles.includes("PM"),
    isOps: roles.includes("OPERATIONAL"),
    priorityOptions: ["", "Low", "Medium", "High", "Urgent", "On Hold", "Completed", "Abandoned"],
    phaseColors: getPhaseColors_(),
    // Keep empty for now (your old Node version hardcoded a GitHub URL).
    // We can re-add your logoUrl later once the UI wiring is stable.
    logoUrl: ""
  };
}

/**
 * params:
 *   {
 *     email: string,
 *     mode: 'mine' | 'pm' | 'ops',
 *     pmQuery?: string,              // for PM view filtering
 *     includeUnassigned?: boolean    // PM view toggle
 *   }
 *
 * returns:
 *   {
 *     projects: [...],
 *     people: [...],
 *     pmList?: [...],
 *     statusList?: [...],
 *     totalUnassigned?: number,
 *     designerCounts?: {...},
 *     customSortOrder?: [...]
 *   }
 */
function apiProjects(params) {
  const email = assertDomain_((params && params.email) || getMyEmail_());
  const mode = (params && params.mode) || "mine";
  const pmQuery = (params && params.pmQuery) || "";
  const includeUnassigned = !!(params && params.includeUnassigned);

  const user = getUserByEmail_(email);
  if (!user) throw new Error("Access denied (user not found in Designer Emails).");

  const allUsers = getAllUsers_();
  const { sh, map } = getProjectsSheetMap_();
  const values = sh.getDataRange().getValues();

  const projects = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const projectNumber = row[map["Project #"]];
    const projectName = row[map["Project"]];
    const status = row[map["Status"]];

    // skip empty rows
    if (!projectNumber && !projectName && !status) continue;

    const rowIndex = String(r + 1); // sheet row number as string (matches existing frontend expectations)

    const team = buildTeamFromRow_(row, map);
    const pmName = String(row[map["PM"]] || "");
    const pm = buildPMFieldsFromRow_(row, map);

    const operationalUser = String(row[map["Operational"]] || "");
    const operationalNotes = String(row[map["Operational notes"]] || "");

    const base = {
      rowIndex,
      projectNumber: String(projectNumber || ""),
      projectName: String(projectName || ""),
      status: String(status || ""),
      internalId: String(row[map["Internal ID"]] || ""),
      pmName: pmName,
      pm: pm,
      team: team,
      operational: {
        user: operationalUser,
        notes: operationalNotes
      },
      // Optional (used for sorting in a few places); safe if missing.
      lastModified: {
        dateDisplay: "",
        dateMs: 0,
        by: "",
        display: ""
      },
      missing: []
    };

    // For Designer tab, the UI expects `my` (the current user's slot).
    if (mode === "mine") {
      const mySlot = team.find(t => normalize_(t.name) === normalize_(user.name));
      base.my = mySlot
        ? { slot: mySlot.slot, priority: mySlot.priority, notes: mySlot.notes, dateDisplay: mySlot.dateDisplay }
        : { slot: null, priority: "", notes: "", dateDisplay: "" };
    }

    projects.push(base);
  }

  // Build lists for filters
  const pmSet = new Set();
  const statusSet = new Set();
  let totalUnassigned = 0;

  projects.forEach(p => {
    const pmName = String(p.pmName || "").trim();
    if (pmName) pmSet.add(pmName);
    else pmSet.add("Unassigned");

    const st = String(p.status || "").trim();
    if (st) statusSet.add(st);

    if (!pmName || normalize_(pmName) === "unassigned") totalUnassigned += 1;
  });

  // Filter by mode
  let filtered = projects;

  if (mode === "mine") {
    filtered = projects.filter(p => {
      const names = (p.team || []).map(t => normalize_(t.name));
      return names.includes(normalize_(user.name));
    });
  } else if (mode === "pm") {
    const pmName = pmQuery || user.name;
    filtered = projects.filter(p => {
      const pPm = String(p.pmName || "").trim();
      if (normalize_(pmName) === "unassigned") {
        return !pPm || normalize_(pPm) === "unassigned";
      }
      if (includeUnassigned) {
        return normalize_(pPm) === normalize_(pmName) || !pPm || normalize_(pPm) === "unassigned";
      }
      return normalize_(pPm) === normalize_(pmName);
    });
  } else if (mode === "ops") {
    filtered = projects;
  }

  // Designer counts (simple, used for PM diagnostics)
  const designerCounts = {};
  filtered.forEach(p => {
    (p.team || []).forEach(t => {
      const n = String(t.name || "").trim();
      if (!n) return;
      if (!designerCounts[n]) designerCounts[n] = 0;
      designerCounts[n] += 1;
    });
  });

  const response = {
    projects: filtered,
    people: allUsers
  };

  if (mode === "pm") {
    const pmName = pmQuery || user.name;
    response.pmList = Array.from(pmSet).sort((a, b) => a.localeCompare(b));
    if (!response.pmList.includes("Unassigned")) response.pmList.unshift("Unassigned");
    response.statusList = Array.from(statusSet).sort((a, b) => a.localeCompare(b));
    response.totalUnassigned = totalUnassigned;
    response.designerCounts = designerCounts;
    response.customSortOrder = getCustomSortOrder_(email, pmName);
  }

  return response;
}

/**
 * Mirrors your old /api/update body:
 * {
 *   email,
 *   mode: 'mine' | 'pm' | 'ops',
 *   payload: { rowIndex, ... }
 * }
 */
function apiUpdate(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const email = assertDomain_((body && body.email) || getMyEmail_());
    const mode = (body && body.mode) || "mine";
    const payload = (body && body.payload) || {};

    const user = getUserByEmail_(email);
    if (!user) throw new Error("Access denied (user not found in Designer Emails).");

    const { sh, map } = getProjectsSheetMap_();

    const rowIndex = Number(payload.rowIndex);
    if (!rowIndex || rowIndex < 2) throw new Error("Invalid rowIndex.");

    // Read current row to detect designer slot, and to avoid overwriting unrelated columns.
    const rowRange = sh.getRange(rowIndex, 1, 1, sh.getLastColumn());
    const row = rowRange.getValues()[0];

    const team = buildTeamFromRow_(row, map);

    const d1Name = normalize_(team[0].name);
    const d2Name = normalize_(team[1].name);
    const d3Name = normalize_(team[2].name);
    const meName = normalize_(user.name);

    const nowDate = now_();

    // --- MODE: mine (designer edits their priority/notes for their assigned slot)
    if (mode === "mine") {
      const mySlot =
        (d1Name === meName && 1) ||
        (d2Name === meName && 2) ||
        (d3Name === meName && 3) ||
        null;

      if (!mySlot) {
        // Don’t hard-fail the UI; just respond ok.
        return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
      }

      const prioHeader = `Prioraty - DESIGNER${mySlot}`;
      const notesHeader = `Notes - DESIGNER${mySlot}`;
      const dateHeader = `Date - DESIGNER${mySlot}`;

      if (payload.priority !== undefined) row[map[prioHeader]] = payload.priority;
      if (payload.notes !== undefined) row[map[notesHeader]] = payload.notes;
      row[map[dateHeader]] = nowDate;

      rowRange.setValues([row]);
      return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
    }

    // --- MODE: pm (PM edits assignments + PM notes)
    if (mode === "pm") {
      // PM notes
      if (payload.pmNotes !== undefined) {
        row[map["PM notes"]] = payload.pmNotes;
        row[map["Date - PM notes"]] = nowDate;
      }

      // PM assignment
      if (payload.pmName !== undefined) {
        row[map["PM"]] = payload.pmName;
      }

      // Designers + their priorities
      for (let slot = 1; slot <= 3; slot++) {
        const dHeader = `DESIGNER${slot}`;
        const pHeader = `Prioraty - DESIGNER${slot}`;
        const nHeader = `Notes - DESIGNER${slot}`;
        const dtHeader = `Date - DESIGNER${slot}`;

        const newDesigner = payload[`designer${slot}`];
        const newPrio = payload[`designer${slot}Priority`];

        if (newDesigner !== undefined) {
          const oldDesigner = String(row[map[dHeader]] || "");
          if (String(newDesigner || "") !== oldDesigner) {
            // When a designer changes, clear their priority/notes/date for clean handoff (matches your local behavior).
            row[map[pHeader]] = "";
            row[map[nHeader]] = "";
            row[map[dtHeader]] = "";
          }
          row[map[dHeader]] = newDesigner;
        }

        if (newPrio !== undefined) {
          row[map[pHeader]] = newPrio;
          row[map[dtHeader]] = nowDate;
        }
      }

      rowRange.setValues([row]);
      return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
    }

    // --- MODE: ops (ops edits PM/designer assignments + operational notes)
    if (mode === "ops") {
      if (payload.pmName !== undefined) row[map["PM"]] = payload.pmName;

      for (let slot = 1; slot <= 3; slot++) {
        const dHeader = `DESIGNER${slot}`;
        const newDesigner = payload[`designer${slot}`];
        if (newDesigner !== undefined) row[map[dHeader]] = newDesigner;
      }

      if (payload.operationalNotes !== undefined) {
        row[map["Operational notes"]] = payload.operationalNotes;
        row[map["Date - Operational"]] = nowDate;
      }

      rowRange.setValues([row]);
      return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
    }

    return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
  } finally {
    lock.releaseLock();
  }
}

function apiSaveCustomOrder(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const email = assertDomain_((body && body.email) || getMyEmail_());
    const pmName = String((body && body.pmName) || "").trim();
    const orderedRowIndexes = (body && body.orderedRowIndexes) || [];

    const user = getUserByEmail_(email);
    if (!user) throw new Error("User not found");

    if (!pmName) throw new Error("Missing pmName");

    return setCustomSortOrder_(email, user.name, user.role, pmName, orderedRowIndexes);
  } finally {
    lock.releaseLock();
  }
}

/* =========================
   Notifications (basic wiring)
   (We keep it minimal for now; we can expand later without changing UI.)
========================= */

function getNotificationsSheetMap_() {
  const sh = getSheet_(CFG.SHEET_NOTIFICATIONS);

  // We’ll store notifications in a schema compatible with your old db.json objects.
  const required = [
    "id",
    "createdAt",      // ms
    "readByJson",     // JSON array string
    "targetRole",     // 'PM' | 'DESIGNER' | 'ANY'
    "targetName",     // name or email (optional if ANY)
    "title",
    "body",           // HTML string
    "projectNumber"
  ];

  const map = ensureColumns_(sh, required);
  return { sh, map };
}

function apiGetNotifications(params) {
  const email = assertDomain_((params && params.email) || getMyEmail_());
  const name = String((params && params.name) || "").trim();

  const { sh, map } = getNotificationsSheetMap_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const out = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const id = row[map["id"]];
    if (!id) continue;

    const createdAt = Number(row[map["createdAt"]] || 0);
    const readBy = safeJsonParse_(row[map["readByJson"]], []);
    const targetRole = String(row[map["targetRole"]] || "ANY").toUpperCase();
    const targetName = String(row[map["targetName"]] || "");
    const title = String(row[map["title"]] || "");
    const body = String(row[map["body"]] || "");
    const projectNumber = String(row[map["projectNumber"]] || "");

    // unread?
    if (Array.isArray(readBy) && readBy.includes(email)) continue;

    const tNorm = normalize_(targetName);
    const matchesName = tNorm && (tNorm === normalize_(name) || tNorm === normalize_(email));
    const roleOk =
      (targetRole === "ANY" && (!targetName || matchesName)) ||
      (targetRole === "PM" && matchesName) ||
      (targetRole === "DESIGNER" && matchesName);

    if (!roleOk) continue;

    out.push({
      id: String(id),
      createdAt: createdAt,
      readBy: Array.isArray(readBy) ? readBy : [],
      targetRole,
      targetName,
      title,
      body,
      projectNumber
    });
  }

  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function apiAckNotification(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const email = assertDomain_((body && body.email) || getMyEmail_());
    const id = String((body && body.id) || "");
    if (!id) return { success: true };

    const { sh, map } = getNotificationsSheetMap_();
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return { success: true };

    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (String(row[map["id"]]) !== id) continue;

      const readBy = safeJsonParse_(row[map["readByJson"]], []);
      const arr = Array.isArray(readBy) ? readBy : [];
      if (!arr.includes(email)) arr.push(email);

      // write back just that cell
      sh.getRange(r + 1, map["readByJson"] + 1).setValue(JSON.stringify(arr));
      break;
    }

    return { success: true };
  } finally {
    lock.releaseLock();
  }
}
