// Api.gs
// 913
// Server-side API for the dashboard (Apps Script).
// This replaces your old Express endpoints with callable GAS functions.
// Frontend behavior stays the same; we’re just changing the transport layer.
//
// Public  functions the frontend will call (via google.script.run wrapper in Step 6):
//   - apiBootstrap(email)
//   - apiProjects(params)
//   - apiUpdate({ email, mode, payload })
//   - apiSaveCustomOrder({ email, pmName, orderedRowIndexes })
//   - apiGetNotifications({ email, name })
//   - apiAckNotification({ id, email })

/* =========================
   Helpers
========================= */
function syncCompletionCelebrations_() {
  // Rate-limit: don’t rescan the Projects sheet on every single poll.
  const cache = CacheService.getScriptCache();
  if (cache.get("COMPLETION_SYNC_RECENT")) return;
  cache.put("COMPLETION_SYNC_RECENT", "1", 15); // 15s

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    const trackerRaw = props.getProperty("STATUS_TRACKER_JSON");
    const tracker = safeJsonParse_(trackerRaw, null);

    const { sh, map } = getProjectsSheetMap_();
    const values = sh.getDataRange().getValues();
    if (values.length < 2) return;

    const CELEBRATE = new Set([
      "completed - sent to client",
      "approved - construction phase"
    ]);

    const userIndex = buildUserIndex_();
    const current = {};
    const notifs = [];

    for (let r = 1; r < values.length; r++) {
      const row = values[r];

      const projectNumber = String(row[map["Project #"]] || "").trim();
      if (!projectNumber) continue;

      const projectName = String(row[map["Project"]] || "").trim();
      const statusRaw = String(row[map["Status"]] || "").trim();
      const newStatusNorm = normalize_(statusRaw);

      current[projectNumber] = newStatusNorm;

      // Baseline run: don’t spam celebration notifications for historical data.
      if (!tracker || typeof tracker !== "object") continue;

      const oldStatusNorm = String(tracker[projectNumber] || "");

      // Only fire when status CHANGES into one of the celebration statuses.
      if (newStatusNorm === oldStatusNorm) continue;
      if (!CELEBRATE.has(newStatusNorm)) continue;

      // Build team (designer slots + PM), same spirit as your local app.
      const teamNames = [];
      const deliverTo = [];

      // Designers 1–3
      for (let slot = 1; slot <= 3; slot++) {
        const dn = String(row[map[`DESIGNER${slot}`]] || "").trim();
        const de = String(row[map[`Email - DESIGNER${slot}`]] || "").trim();

        if (dn && !isUnassigned_(normalize_(dn))) teamNames.push(dn);

        const email = resolveEmailFrom_(de || dn, userIndex);
        if (email) deliverTo.push(email);
        else if (dn && !isUnassigned_(normalize_(dn))) deliverTo.push(dn);
      }

      // PM
      const pmName = String(row[map["PM"]] || "").trim();
      if (pmName && !isUnassigned_(normalize_(pmName))) teamNames.push(pmName);

      const pmEmail = resolveEmailFrom_(pmName, userIndex);
      if (pmEmail) deliverTo.push(pmEmail);
      else if (pmName && !isUnassigned_(normalize_(pmName))) deliverTo.push(pmName);

      // De-dupe
      const uniqueTeamNames = Array.from(new Set(teamNames.filter(Boolean)));
      const uniqueDeliverTo = Array.from(new Set(deliverTo.filter(Boolean)));

      uniqueDeliverTo.forEach((who) => {
        notifs.push({
          targetRole: "ANY",
          targetName: who,
          title: "Project Celebration! 🎉",
          body: `${hlProj_(projectName)}<br>Status changed to: <strong>${statusRaw}</strong>`,
          projectNumber: projectNumber,

          type: "COMPLETED_MODAL",
          projectName: projectName,
          status: statusRaw,
          team: uniqueTeamNames
        });
      });
    }

    // If tracker is missing/invalid (first ever run), set baseline now and exit.
    if (!trackerRaw) {
      props.setProperty("STATUS_TRACKER_JSON", JSON.stringify(current));
      return;
    }

    // Update tracker to latest snapshot
    props.setProperty("STATUS_TRACKER_JSON", JSON.stringify(current));

    // Append celebration notifications (actorName "SYSTEM" avoids self-filtering)
    if (notifs.length) appendNotifications_(notifs, "SYSTEM");
  } finally {
    lock.releaseLock();
  }
}

function resolveEmailFrom_(nameOrEmail, userIndex) {
  const v = String(nameOrEmail || "").trim();
  if (!v) return "";
  if (v.includes("@")) return v;

  const nm = normalize_(v);
  const u = userIndex && userIndex.byName ? userIndex.byName[nm] : null;
  return u && u.email ? u.email : "";
}

function looksLikeEmail_(v) {
  const s = String(v == null ? "" : v).trim();
  // Simple check: enough to tell an email from a name.
  return s.includes("@") && s.includes(".");
}

function buildUserIndex_() {
  const users = getAllUsers_();
  const byEmail = {};
  const byName = {};
  users.forEach(u => {
    const em = normalize_(u.email);
    const nm = normalize_(u.name);
    if (em) byEmail[em] = u;
    // Keep first match for a name to avoid random overwrites if names collide.
    if (nm && !byName[nm]) byName[nm] = u;
  });
  return { byEmail, byName };
}

function resolveEmailFromDesignerValue_(designerValue, userIndex) {
  const raw = String(designerValue == null ? "" : designerValue).trim();
  if (!raw) return "";

  // If the cell itself is an email, use it.
  if (looksLikeEmail_(raw)) return raw;

  // Otherwise try to map name -> email using "Designer Emails".
  const u = userIndex && userIndex.byName ? userIndex.byName[normalize_(raw)] : null;
  return u ? String(u.email || "").trim() : "";
}

function slotMatchesUser_(teamMember, user) {
  if (!teamMember) return false;

  const userEmail = normalize_(user.email);
  const userName = normalize_(user.name);

  const memberEmail = normalize_(teamMember.email);
  if (memberEmail && userEmail && memberEmail === userEmail) return true;

  const memberName = normalize_(teamMember.name);

  // Fallbacks (keeps behavior close to your local version):
  // - exact name match
  // - cell contains the user's email
  // - cell contains the user's name (covers extra text like "Marvin Qaqos (Lead)")
  if (memberName && userName && memberName === userName) return true;
  if (memberName && userEmail && memberName === userEmail) return true;
  if (memberName && userName && memberName.includes(userName)) return true;

  return false;
}

function setDesignerSlot_(row, map, slot, designerValue, userIndex) {
  const nameHeader = `DESIGNER${slot}`;
  const emailHeader = `Email - DESIGNER${slot}`;

  // Keep display value exactly what the UI expects
  row[map[nameHeader]] = designerValue;

  // Keep email identity synced so renames in "Designer Emails" don't break ownership.
  if (map[emailHeader] !== undefined) {
    const v = String(designerValue == null ? "" : designerValue).trim();
    const email = v ? resolveEmailFromDesignerValue_(v, userIndex) : "";
    row[map[emailHeader]] = email;
  }
}

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

    // Designer display names (what the UI shows)
    "DESIGNER1",
    "DESIGNER2",
    "DESIGNER3",

    // Stable identity (internal use): keeps designer ownership working even if you rename people in "Designer Emails"
    "Email - DESIGNER1",
    "Email - DESIGNER2",
    "Email - DESIGNER3",

    // Designer fields
    "Prioraty - DESIGNER1",
    "Prioraty - DESIGNER2",
    "Prioraty - DESIGNER3",
    "Notes - DESIGNER1",
    "Notes - DESIGNER2",
    "Notes - DESIGNER3",
    "Date - DESIGNER1",
    "Date - DESIGNER2",
    "Date - DESIGNER3",

    // PM + ops timestamps
    "Date - PM to Set Priority",
    "Date - PM notes",
    "Date - Operational"
  ];
  const map = ensureColumns_(sh, required);
  return { sh, map };
}

function buildTeamFromRow_(row, map, userIndex) {
  const team = [];

  const dNames = [
    row[map["DESIGNER1"]],
    row[map["DESIGNER2"]],
    row[map["DESIGNER3"]]
  ];

  const dEmails = [
    map["Email - DESIGNER1"] !== undefined ? row[map["Email - DESIGNER1"]] : "",
    map["Email - DESIGNER2"] !== undefined ? row[map["Email - DESIGNER2"]] : "",
    map["Email - DESIGNER3"] !== undefined ? row[map["Email - DESIGNER3"]] : ""
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
    const rawName = String(dNames[i] || "");
    let email = String(dEmails[i] || "").trim();

    // If email column is empty, infer from the name cell (email typed) or from "Designer Emails".
    if (!email) {
      email = resolveEmailFromDesignerValue_(rawName, userIndex);
    }

    team.push({
      slot: i + 1,
      // Keep UI display exactly as stored in the sheet
      name: rawName,
      // Stable identity used for matching
      email: email,
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
function isUnassigned_(v) {
  const n = normalize_(v);
  return !n || n === "unassigned";
}

function hlUser_(t) {
  const s = String(t || "");
  return `<strong style="color:#fff;background:#475569;padding:0 4px;border-radius:4px;font-size:12px;display:inline-block;">${s}</strong>`;
}

function hlProj_(t) {
  const s = String(t || "");
  return `<strong style="color:#fff;background:#0f172a;padding:0 4px;border-radius:4px;font-size:12px;display:inline-block;">${s}</strong>`;
}

function projectSnapshotFromRow_(row, map) {
  const get = (h) => (h in map ? row[map[h]] : "");

  // Support both naming styles, but your sheet uses "Project #" and "Project"
  const projectNumber = String(get("Project #") || get("Project Number") || "");
  const projectName = String(get("Project") || get("Project Name") || "");

  return {
    projectNumber,
    projectName,
    status: String(get("Status") || ""),
    pm: String(get("PM") || ""),
    pmNotes: String(get("PM notes") || ""),
    designer1: String(get("DESIGNER1") || ""),
    designer2: String(get("DESIGNER2") || ""),
    designer3: String(get("DESIGNER3") || ""),
    priority1: String(get("Prioraty - DESIGNER1") || ""),
    priority2: String(get("Prioraty - DESIGNER2") || ""),
    priority3: String(get("Prioraty - DESIGNER3") || "")
  };
}



function generateNotificationsForPMUpdate_(op, np, editorName) {
  const notifs = [];
  const isTop3 = (v) => ["1", "2", "3"].includes(String(v || "").trim());
  const slots = [1, 2, 3];

  // 1) Assignment changes + teammate alert on replacement
  slots.forEach((slot) => {
    const oldDisp = String(op[`designer${slot}`] || "").trim();
    const newDisp = String(np[`designer${slot}`] || "").trim();
    const oldN = normalize_(oldDisp);
    const newN = normalize_(newDisp);

    // Added
    if (isUnassigned_(oldN) && !isUnassigned_(newN)) {
      notifs.push({
        targetRole: "DESIGNER",
        targetName: newDisp,
        title: "New Assignment",
        body: `You have been assigned to ${hlProj_(np.projectName)} by ${hlUser_(editorName)}. Please prioritize this project.`,
        projectNumber: np.projectNumber
      });
    }

    // Removed
    if (!isUnassigned_(oldN) && isUnassigned_(newN)) {
      notifs.push({
        targetRole: "DESIGNER",
        targetName: oldDisp,
        title: "Assignment Removed",
        body: `You have been removed from ${hlProj_(np.projectName)} by ${hlUser_(editorName)}.`,
        projectNumber: np.projectNumber,
        hideViewButton: true
      });
    }

    // Replaced
    if (!isUnassigned_(oldN) && !isUnassigned_(newN) && oldN !== newN) {
      notifs.push({
        targetRole: "DESIGNER",
        targetName: oldDisp,
        title: "Assignment Changed",
        body: `You have been replaced on ${hlProj_(np.projectName)} by ${hlUser_(newDisp)}.`,
        projectNumber: np.projectNumber,
        hideViewButton: true
      });

      notifs.push({
        targetRole: "DESIGNER",
        targetName: newDisp,
        title: "New Assignment",
        body: `You have been assigned to replace ${hlUser_(oldDisp)} on ${hlProj_(np.projectName)}. Please prioritize this project.`,
        projectNumber: np.projectNumber
      });

      // Teammate alert only if teammate has this project in Top 3
      slots.forEach((mateNum) => {
        if (mateNum === slot) return;
        const mateName = String(np[`designer${mateNum}`] || "").trim();
        const mateN = normalize_(mateName);
        const matePrio = String(np[`priority${mateNum}`] || "").trim();

        if (!isUnassigned_(mateN) && isTop3(matePrio)) {
          notifs.push({
            targetRole: "DESIGNER",
            targetName: mateName,
            title: "Team Update",
            body: `${hlUser_(oldDisp)} was replaced by ${hlUser_(newDisp)} on ${hlProj_(np.projectName)}`,
            projectNumber: np.projectNumber
          });
        }
      });
    }
  });

  // 2) PM Notes -> notify assigned designers
  if (normalize_(op.pmNotes) !== normalize_(np.pmNotes)) {
    slots.forEach((slot) => {
      const d = String(np[`designer${slot}`] || "").trim();
      if (!isUnassigned_(normalize_(d))) {
        const txt = String(np.pmNotes || "");
        const shortNotes = txt.substring(0, 60) + (txt.length > 60 ? "..." : "");
        notifs.push({
          targetRole: "DESIGNER",
          targetName: d,
          title: "PM Note Update",
          body: `${hlProj_(np.projectName)}<br>PM updated notes: "${shortNotes}"`,
          projectNumber: np.projectNumber
        });
      }
    });
  }

  // 3) PM changes designer priority (designer must be same person as before)
  slots.forEach((slot) => {
    const oldPrio = String(op[`priority${slot}`] || "").trim();
    const newPrio = String(np[`priority${slot}`] || "").trim();
    const designerName = String(np[`designer${slot}`] || "").trim();
    const oldDesignerNorm = normalize_(String(op[`designer${slot}`] || ""));

    if (oldPrio !== newPrio && designerName && !isUnassigned_(normalize_(designerName))) {
      if (normalize_(designerName) !== oldDesignerNorm) return; // assignment notif covers it

      notifs.push({
        targetRole: "DESIGNER",
        targetName: designerName,
        title: "Priority Changed by PM",
        body: `${hlProj_(np.projectName)}<br>Priority: <strong>${oldPrio || "None"} → ${newPrio || "None"}</strong><br><span style="opacity:0.8">Changed by ${hlUser_(editorName)}</span>`,
        projectNumber: np.projectNumber
      });
    }
  });

  // 4) PM assignment changes -> notify assigned designers
  if (normalize_(op.pm) !== normalize_(np.pm)) {
    const oldPM = op.pm || "Unassigned";
    const newPM = np.pm || "Unassigned";

    let message = "";
    if (isUnassigned_(oldPM)) {
      message = `${hlProj_(np.projectName)}<br>PM assigned: ${hlUser_(newPM)}`;
    } else if (isUnassigned_(newPM)) {
      message = `${hlProj_(np.projectName)}<br>PM removed: ${hlUser_(oldPM)}`;
    } else {
      message = `${hlProj_(np.projectName)}<br>PM changed: ${hlUser_(oldPM)} → ${hlUser_(newPM)}`;
    }

    slots.forEach((slot) => {
      const d = String(np[`designer${slot}`] || "").trim();
      if (!isUnassigned_(normalize_(d))) {
        notifs.push({
          targetRole: "DESIGNER",
          targetName: d,
          title: "Project Manager Updated",
          body: message,
          projectNumber: np.projectNumber
        });
      }
    });
  }

  return notifs;
}

function generateNotificationsForMineUpdate_(op, np, editorName, mySlot) {
  const notifs = [];
  const isTop3 = (v) => ["1", "2", "3"].includes(String(v || "").trim());

  const oldPrio = String(op[`priority${mySlot}`] || "").trim();
  const newPrio = String(np[`priority${mySlot}`] || "").trim();
  if (oldPrio === newPrio) return notifs;

  // Match local: only notify when the change touches Top 3
  if (!(isTop3(oldPrio) || isTop3(newPrio))) return notifs;

  const proj = hlProj_(np.projectName);

  // Notify PM
  if (np.pm && !isUnassigned_(normalize_(np.pm))) {
    notifs.push({
      targetRole: "PM",
      targetName: np.pm,
      title: "Designer Priority Change",
      body: `${hlUser_(editorName)} updated ${proj}<br>Priority: <strong>${oldPrio || "None"} → ${newPrio || "None"}</strong>`,
      projectNumber: np.projectNumber
    });
  }

  // Notify teammates who also have this project in their Top 3
  [1, 2, 3].forEach((slot) => {
    if (slot === mySlot) return;
    const otherDesigner = String(np[`designer${slot}`] || "").trim();
    const otherPrio = String(np[`priority${slot}`] || "").trim();
    if (!isUnassigned_(normalize_(otherDesigner)) && isTop3(otherPrio)) {
      notifs.push({
        targetRole: "DESIGNER",
        targetName: otherDesigner,
        title: "Shared Project Update",
        body: `${hlUser_(editorName)} updated ${proj}<br><span style="font-size:11px;color:#fff;opacity:0.85;">This project is also in your Top 3</span>`,
        projectNumber: np.projectNumber
      });
    }
  });

  // If a PM changed the designer's priority via remote shift (still Top3-triggered)
  const affectedDesigner = String(np[`designer${mySlot}`] || "").trim();
  if (affectedDesigner && normalize_(affectedDesigner) !== normalize_(editorName)) {
    notifs.push({
      targetRole: "DESIGNER",
      targetName: affectedDesigner,
      title: "PM Priority Change",
      body: `${hlUser_(editorName)} set your priority on ${proj} to <strong>${newPrio || "None"}</strong>`,
      projectNumber: np.projectNumber
    });
  }

  return notifs;
}

function appendNotifications_(notifs, actorName) {
  const list = Array.isArray(notifs) ? notifs : [];
  if (!list.length) return [];

  const { sh, map } = getNotificationsSheetMap_();
  const lastCol = sh.getLastColumn();
  const base = Date.now();

  const rows = [];
  const appended = [];

  list.forEach((n, i) => {
    if (!n) return;

    const targetName = String(n.targetName || "").trim();
    if (normalize_(targetName) === normalize_(actorName)) return; // no self-notifs

    const createdAt = base + i;
    const id = Utilities.getUuid();

    const row = new Array(lastCol).fill("");
    row[map["id"]] = id;
    row[map["createdAt"]] = createdAt;
    row[map["readByJson"]] = JSON.stringify([]);
    row[map["targetRole"]] = String(n.targetRole || "ANY");
    row[map["targetName"]] = targetName;
    row[map["title"]] = String(n.title || "");
    row[map["body"]] = String(n.body || "");
    row[map["projectNumber"]] = String(n.projectNumber || "");

    row[map["type"]] = String(n.type || "");
    row[map["projectName"]] = String(n.projectName || "");
    row[map["status"]] = String(n.status || "");
    row[map["teamJson"]] = JSON.stringify(n.team || []);
    row[map["hideViewButton"]] = n.hideViewButton ? "true" : "";

    rows.push(row);

    // Returned to the frontend (for optional Firebase push)
    appended.push({
      id,
      createdAt,
      readBy: [],
      targetRole: String(n.targetRole || "ANY"),
      targetName,
      title: String(n.title || ""),
      body: String(n.body || ""),
      projectNumber: String(n.projectNumber || ""),
      type: String(n.type || ""),
      projectName: String(n.projectName || ""),
      status: String(n.status || ""),
      team: Array.isArray(n.team) ? n.team : [],
      hideViewButton: !!n.hideViewButton
    });
  });

  if (!rows.length) return [];

  sh.getRange(sh.getLastRow() + 1, 1, rows.length, lastCol).setValues(rows);
  return appended;
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
  const userIndex = buildUserIndex_();

  const { sh, map } = getProjectsSheetMap_();
  const values = sh.getDataRange().getValues();

  const projects = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const projectNumber = row[map["Project #"]];
    const projectName = row[map["Project"]];
    const status = row[map["Status"]];

    if (!projectNumber && !projectName && !status) continue;

    const rowIndex = String(r + 1);

    const team = buildTeamFromRow_(row, map, userIndex);
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
      operational: { user: operationalUser, notes: operationalNotes },
      lastModified: { dateDisplay: "", dateMs: 0, by: "", display: "" },
      missing: []
    };

    if (mode === "mine") {
      const mySlot = team.find(t => slotMatchesUser_(t, user));
      base.my = mySlot
        ? { slot: mySlot.slot, priority: mySlot.priority, notes: mySlot.notes, dateDisplay: mySlot.dateDisplay }
        : { slot: null, priority: "", notes: "", dateDisplay: "" };
    }

    projects.push(base);
  }

  // Build lists for filters
  const pmSet = new Set();
  const statusSet = new Set();

  projects.forEach(p => {
    const pmName = String(p.pmName || "").trim();
    if (pmName) pmSet.add(pmName);
    else pmSet.add("Unassigned");

    const st = String(p.status || "").trim();
    if (st) statusSet.add(st);
  });

  // ✅ Step 5 FIX: Global Unassigned Count (matches local)
  // Excludes archived-type rows based on status and PM priority text.
  const archiveKeywords = ["completed", "cancelled", "on hold", "abandoned"];
  const totalUnassigned = projects.filter(p => {
    const pmName = String(p.pmName || "").trim();
    const isUnassigned = !pmName || normalize_(pmName) === "unassigned";
    if (!isUnassigned) return false;

    const s = String(p.status || "").toLowerCase();
    const pPrio = String((p.pm && p.pm.priority) || "").toLowerCase();

    if (archiveKeywords.some(k => s.includes(k))) return false;
    if (archiveKeywords.some(k => pPrio.includes(k))) return false;

    return true;
  }).length;

  // Filter by mode
  let filtered = projects;

  if (mode === "mine") {
    filtered = projects.filter(p => (p.team || []).some(t => slotMatchesUser_(t, user)));

  } else if (mode === "pm") {
    const pmName = pmQuery || user.name;
    const raw = String(pmName || "").trim();
    const rawUpper = raw.toUpperCase();

    const isAllProjects =
      rawUpper === "__ALL__" ||
      normalize_(raw).replace(/\s+/g, "") === "allprojects";

    if (isAllProjects) {
      filtered = projects;
    } else {
      filtered = projects.filter(p => {
        const pPm = String(p.pmName || "").trim();

        if (normalize_(raw) === "unassigned") {
          return !pPm || normalize_(pPm) === "unassigned";
        }

        if (includeUnassigned) {
          return normalize_(pPm) === normalize_(raw) || !pPm || normalize_(pPm) === "unassigned";
        }

        return normalize_(pPm) === normalize_(raw);
      });
    }

  } else if (mode === "ops") {
    filtered = projects;
  }

  // Active counts per designer across ALL projects (matches local)
  const designerCounts = {};
  if (mode === "pm") {
    const INACTIVE_STATUSES = [
      "Abandoned",
      "Expired",
      "Approved - Construction Phase",
      "Completed - Sent to Client",
      "Paused - Stalled by 3rd Party",
      "Do Not Click - Final Submit for Approval"
    ];
    const norm = (s) => String(s || "").toLowerCase().trim();

    projects.forEach(p => {
      const status = norm(p.status);
      const isInactive = INACTIVE_STATUSES.some(s => status.includes(norm(s)));
      if (isInactive) return;

      (p.team || []).forEach(t => {
        const des = norm(t.name);
        if (des && des !== "unassigned") {
          designerCounts[des] = (designerCounts[des] || 0) + 1;
        }
      });
    });
  }

  const response = {
    projects: filtered,
    people: allUsers
  };

  if (mode === "pm") {
    const pmName = pmQuery || user.name;

    const list = Array.from(pmSet)
      .filter(v => v && String(v).trim() !== "__ALL__")
      .sort((a, b) => a.localeCompare(b));

    response.pmList = ["__ALL__", ...list];
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

    // Who should be credited as the editor (used only for notification text)?
    const actorEmailRaw = payload && payload.realActorEmail;
    const actorEmail = looksLikeEmail_(actorEmailRaw) ? assertDomain_(actorEmailRaw) : email;
    const actorUser = getUserByEmail_(actorEmail) || user;
    const actorName = String(actorUser.name || actorEmail || "Unknown");

    const { sh, map } = getProjectsSheetMap_();
    const userIndex = buildUserIndex_();

    const rowIndex = Number(payload.rowIndex);
    if (!rowIndex) throw new Error("Missing rowIndex.");

    const rowRange = sh.getRange(rowIndex, 1, 1, sh.getLastColumn());
    const row = rowRange.getValues()[0];

    // Snapshot BEFORE changes (for notification rules)
    const oldSnap = projectSnapshotFromRow_(row.slice(), map);

    const nowDate = now_();

    // --- MODE: mine (designer edits their own priority/notes)
    if (mode === "mine") {
      const team = buildTeamFromRow_(row, map, userIndex);
      const mySlot =
        (slotMatchesUser_(team[0], user) && 1) ||
        (slotMatchesUser_(team[1], user) && 2) ||
        (slotMatchesUser_(team[2], user) && 3) ||
        null;

      if (!mySlot) {
        // Don’t hard-fail the UI; just respond ok.
        return { ok: true, savedAtDisplay: fmtTime_(nowDate) };
      }

      const prioHeader = `Prioraty - DESIGNER${mySlot}`;
      const notesHeader = `Notes - DESIGNER${mySlot}`;
      const dateHeader = `Date - DESIGNER${mySlot}`;

      if (payload.priority !== undefined) {
        row[map[prioHeader]] = payload.priority;
        row[map[dateHeader]] = nowDate;
      }

      if (payload.notes !== undefined) {
        row[map[notesHeader]] = payload.notes;
        row[map[dateHeader]] = nowDate;
      }

      rowRange.setValues([row]);

      // Notifications (match local: only for priority changes that touch Top 3)
      let generatedNotifications = [];
      const skip = !!payload.skipNotifications;

      if (!skip && payload.priority !== undefined) {
        const newSnap = projectSnapshotFromRow_(row, map);
        const notifs = generateNotificationsForMineUpdate_(oldSnap, newSnap, actorName, mySlot);
        generatedNotifications = appendNotifications_(notifs, actorName);
      }

      return { ok: true, savedAtDisplay: fmtTime_(nowDate), generatedNotifications };
    }

    // --- MODE: pm (PM edits PM notes + designer assignments/priorities)
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
        const pHeader = `Prioraty - DESIGNER${slot}`;

        const newDesigner = payload[`designer${slot}`];
        const newPrio = payload[`designer${slot}Priority`];

        if (newDesigner !== undefined) {
          setDesignerSlot_(row, map, slot, newDesigner, userIndex);
        }
        if (newPrio !== undefined) {
          row[map[pHeader]] = newPrio;
          row[map[`Date - DESIGNER${slot}`]] = nowDate;
        }
      }

      rowRange.setValues([row]);

      // Notifications (PM-side rules)
      let generatedNotifications = [];
      if (!payload.skipNotifications) {
        const newSnap = projectSnapshotFromRow_(row, map);
        const notifs = generateNotificationsForPMUpdate_(oldSnap, newSnap, actorName);
        generatedNotifications = appendNotifications_(notifs, actorName);
      }

      return { ok: true, savedAtDisplay: fmtTime_(nowDate), generatedNotifications };
    }

    // --- MODE: ops (leave as-is for now, no notif work here yet)
    if (mode === "ops") {
      if (payload.pmName !== undefined) row[map["PM"]] = payload.pmName;

      for (let slot = 1; slot <= 3; slot++) {
        const newDesigner = payload[`designer${slot}`];
        if (newDesigner !== undefined) setDesignerSlot_(row, map, slot, newDesigner, userIndex);
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

  // Matches local notification objects + optional fields used by completed modal.
  const required = [
    "id",
    "createdAt",        // ms
    "readByJson",       // JSON array string
    "targetRole",       // 'PM' | 'DESIGNER' | 'ANY'
    "targetName",       // name/email (can be comma-separated)
    "title",
    "body",             // HTML string
    "projectNumber",

    // Optional local fields
    "type",
    "projectName",
    "status",
    "teamJson",
    "hideViewButton"
  ];

  const map = ensureColumns_(sh, required);
  return { sh, map };
}


function apiGetNotifications(params) {
  // Step 9: before returning unread notifications, detect new completion/approval
  // transitions and create "COMPLETED_MODAL" notifications (confetti flow).
  syncCompletionCelebrations_();

  const email = assertDomain_((params && params.email) || getMyEmail_());
  const name = String((params && params.name) || "").trim();

  const emailNorm = normalize_(email);
  const nameNorm = normalize_(name);

  const { sh, map } = getNotificationsSheetMap_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const out = [];

  const splitTargets = (v) =>
    String(v || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const truthy = (v) => {
    const s = String(v || "").trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  };

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const id = row[map["id"]];
    if (!id) continue;

    const createdAt = Number(row[map["createdAt"]] || 0);
    const readBy = safeJsonParse_(row[map["readByJson"]], []);
    const readArr = Array.isArray(readBy) ? readBy : [];

    // Only return notifications meant for this user AND not already read by them
    if (readArr.map(normalize_).includes(emailNorm)) continue;

    const targetRoleRaw = String(row[map["targetRole"]] || "ANY").trim();
    const targetRole = targetRoleRaw ? targetRoleRaw.toUpperCase() : "ANY";

    const targetName = String(row[map["targetName"]] || "").trim();
    const targets = splitTargets(targetName).map(normalize_);

    const matchesName = targets.length
      ? (targets.includes(nameNorm) || targets.includes(emailNorm))
      : false;

    const matchesTarget =
      (targetRole === "ANY" && (!targetName || matchesName)) ||
      (targetRole === "PM" && matchesName) ||
      (targetRole === "DESIGNER" && matchesName) ||
      (targetRole !== "ANY" && targetRole !== "PM" && targetRole !== "DESIGNER" && matchesName);

    if (!matchesTarget) continue;

    const title = String(row[map["title"]] || "");
    const body = String(row[map["body"]] || "");
    const projectNumber = String(row[map["projectNumber"]] || "");

    const type = String(row[map["type"]] || "");
    const projectName = String(row[map["projectName"]] || "");
    const status = String(row[map["status"]] || "");
    const team = safeJsonParse_(row[map["teamJson"]], []);
    const hideViewButton = truthy(row[map["hideViewButton"]]);

    out.push({
      id: String(id),
      createdAt: createdAt,
      readBy: readArr,
      targetRole: targetRoleRaw || "ANY",
      targetName,
      title,
      body,
      projectNumber,

      // Optional fields used by completed modal
      type,
      projectName,
      status,
      team: Array.isArray(team) ? team : [],
      hideViewButton
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
