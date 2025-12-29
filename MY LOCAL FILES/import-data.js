const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const EXCEL_FILE = 'Project List - Designers.xlsx'; // Ensure this matches renamed file
const DB_FILE = path.join(__dirname, 'database', 'db.json');
const DATA_DIR = path.join(__dirname, 'database');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

// Logic extracted from GAS getProjectColumnIndexes_
// We need to map dynamic headers to keys
function getColumnIndexes(headers) {
  const find = (regexList) => {
    for (let i = 0; i < headers.length; i++) {
        const h = String(headers[i] || '').trim();
        if (regexList.some(rx => rx.test(h))) return i;
    }
    return -1;
  };

  const map = {
    projectNumber: find([/^project\s*#$/i, /^project\s*no\.?$/i]),
    projectName: find([/^project$/i, /^project\s*name$/i]),
    status: find([/^status$/i]),
    internalId: find([/^internal\s*id$/i]),
    pm: find([/^pm$/i, /^project\s*manager$/i]),
    pmPriority: find([/^pm\s*to\s*set\s*priority$/i, /^pm\s*priority$/i]),
    pmNotes: find([/^pm\s*notes$/i]),
    operational: find([/^operational$/i]),
    operationalNotes: find([/^operational\s*notes$/i]),
    designer1: find([/^designer\s*1$/i, /^designer1$/i]),
    designer2: find([/^designer\s*2$/i, /^designer2$/i]),
    designer3: find([/^designer\s*3$/i, /^designer3$/i]),
    // We can add more date fields if needed, but for MVP this covers core logic
  };
  
  // Specific designer columns
  [1, 2, 3].forEach(s => {
      map[`priority${s}`] = find([new RegExp(`^(prioraty|priority)\\s*-\\s*designer\\s*${s}$`, 'i')]);
      map[`notes${s}`] = find([new RegExp(`^notes\\s*-\\s*designer\\s*${s}$`, 'i')]);
  });
  
  return map;
}

function importData() {
  console.log('Reading Excel file...');
  const workbook = xlsx.readFile(EXCEL_FILE, { cellDates: true });
  
  // 1. Parse Project List
  const projectSheetName = "Project List - Designers";
  const projectSheet = workbook.Sheets[projectSheetName];
  if (!projectSheet) throw new Error(`Sheet "${projectSheetName}" not found`);
  
  const rawData = xlsx.utils.sheet_to_json(projectSheet, { header: 1 });
  const headers = rawData[0];
  const idx = getColumnIndexes(headers);
  
  const projects = [];
  // Scrape first 30 rows (index 1 to 30)
  for (let i = 1; i <= Math.min(rawData.length - 1, 30); i++) {
    const row = rawData[i];
    if (!row || row.length === 0) continue;
    
    // helper to get val safely
    const val = (index) => String(row[index] ?? '').trim();
    
    // We map to a clean object structure similar to what GAS `getPMProjects` returns
    // But mostly simulation of the "Source of Truth" DB rows.
    projects.push({
      id: i, // distinct ID for local db
      rowIndex: i + 1, // mapping back to excel row
      projectNumber: val(idx.projectNumber),
      projectName: val(idx.projectName),
      status: val(idx.status),
      internalId: val(idx.internalId),
      pm: val(idx.pm),
      
      pmPriority: val(idx.pmPriority),
      pmNotes: val(idx.pmNotes),
      
      operational: val(idx.operational),
      operationalNotes: val(idx.operationalNotes),
      
      designer1: val(idx.designer1),
      priority1: val(idx.priority1),
      notes1: val(idx.notes1),
      
      designer2: val(idx.designer2),
      priority2: val(idx.priority2),
      notes2: val(idx.notes2),
      
      designer3: val(idx.designer3),
      priority3: val(idx.priority3),
      notes3: val(idx.notes3),
      
      // Timestamps (mocked for now or parsed if column exists)
      lastModified: Date.now()
    });
  }
  
  // 2. Parse Emails / Users
  const emailSheetName = "Designer Emails";
  const emailSheet = workbook.Sheets[emailSheetName];
  let users = [];
  if (emailSheet) {
    const emailData = xlsx.utils.sheet_to_json(emailSheet);
    // Assuming headers: Name, Email, Role
    // Normalize keys
    users = emailData.map(r => {
        // loose matching for keys
        const keys = Object.keys(r);
        const getK = (k) => keys.find(key => key.toLowerCase().includes(k)) || '';
        return {
            name: String(r[getK('name')] || '').trim(),
            email: String(r[getK('email')] || '').trim(),
            role: String(r[getK('role')] || '').trim()
        };
    }).filter(u => u.email);
  }

  // 3. Parse Phase Colors
  const colorSheetName = "Phase Colors";
  const colorSheet = workbook.Sheets[colorSheetName];
  let colors = {};
  if (colorSheet) {
      const colorData = xlsx.utils.sheet_to_json(colorSheet, {header:1});
      colorData.forEach(row => {
          if (row[0] && row[1]) colors[normalize(row[1])] = row[0];
      });
  }

  const db = {
    projects,
    users,
    colors,
    config: {
        priorityOptions: ['', 'Low', 'Medium', 'High', 'Urgent', 'On Hold', 'Completed', 'Abandoned']
    }
  };
  
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log(`Database seeded to ${DB_FILE}`);
  console.log(`Imported ${projects.length} projects and ${users.length} users.`);
}

importData();
