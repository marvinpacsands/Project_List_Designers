const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Database Setup
const adapter = new FileSync('database/db.json');
const db = low(adapter);

// Helper to normalize strings
const normalize = (s) => String(s || '').toLowerCase().trim();

// Configuration
const CONFIG = {
    // New Numeric Priority System (1-10)
    priorityOptions: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    port: 3000,
    dbPath: path.join(__dirname, 'database', 'db.json'),
    excelPath: path.join(__dirname, 'Project List - Designers.xlsx')
};

// --- NOTIFICATION HELPER ---
function generateNotifications(op, np, editorName) {
    const notifs = [];
    const hlUser = (t) => `<strong style="color:#fff !important;background:rgba(0,0,0,0.2) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;
    const hlProj = (t) => `<strong style="color:#fff !important;background:rgba(59,130,246,0.5) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;
    const slots = ['designer1', 'designer2', 'designer3'];

    // 1. Assignment Changes
    slots.forEach(slot => {
        const oldD = normalize(op[slot]);
        const newD = normalize(np[slot]);

        // Added
        if ((!oldD || oldD === 'unassigned') && (newD && newD !== 'unassigned')) {
            console.log(`[NOTIF] New Assignment: ${newD} on ${np.projectName}`);
            notifs.push({
                targetRole: 'DESIGNER',
                targetName: newD,
                title: 'New Assignment',
                body: `You have been assigned to ${hlProj(np.projectName)} by ${hlUser(editorName)}. Please prioritize this project.`,
                projectNumber: np.projectNumber
            });
        }
        // Removed
        if ((oldD && oldD !== 'unassigned') && (!newD || newD === 'unassigned')) {
            console.log(`[NOTIF] Removed: ${oldD} from ${np.projectName}`);
            notifs.push({
                targetRole: 'DESIGNER',
                targetName: oldD,
                title: 'Assignment Removed',
                body: `You have been removed from ${hlProj(np.projectName)} by ${hlUser(editorName)}.`,
                projectNumber: np.projectNumber,
                hideViewButton: true
            });
        }
        // Replaced
        if (oldD && newD && oldD !== 'unassigned' && newD !== 'unassigned' && oldD !== newD) {
            console.log(`[NOTIF] Replaced: ${oldD} -> ${newD}`);
            notifs.push({
                targetRole: 'DESIGNER',
                targetName: oldD,
                title: 'Assignment Changed',
                body: `You have been replaced on ${hlProj(np.projectName)} by ${hlUser(newD)}.`,
                projectNumber: np.projectNumber,
                hideViewButton: true
            });
            notifs.push({
                targetRole: 'DESIGNER',
                targetName: newD,
                title: 'New Assignment',
                body: `You have been assigned to replace ${hlUser(oldD)} on ${hlProj(np.projectName)}. Please prioritize this project.`,
                projectNumber: np.projectNumber
            });

            // Notify Teammates (Event 4)
            // Condition: Project must be in teammate's Top 3
            const currentSlotNum = parseInt(slot.replace('designer', '')) || 0; // Safe fallback
            [1, 2, 3].forEach(mateNum => {
                if (mateNum === currentSlotNum) return; // Skip self
                const mateName = normalize(np[`designer${mateNum}`]);
                const matePrio = String(np[`priority${mateNum}`] || '').trim();

                // Helper check
                const isMateTop3 = ['1', '2', '3'].includes(matePrio);

                if (mateName && mateName !== 'unassigned' && isMateTop3) {
                    console.log(`[NOTIF] Teammate Alert: ${mateName} about replacement`);
                    notifs.push({
                        targetRole: 'DESIGNER',
                        targetName: np[`designer${mateNum}`], // Use original case name
                        title: 'Team Update',
                        body: `${hlUser(oldD)} was replaced by ${hlUser(newD)} on ${hlProj(np.projectName)}`,
                        projectNumber: np.projectNumber
                    });
                }
            });
        }
    });

    // 2. PM Notes
    if (normalize(op.pmNotes) !== normalize(np.pmNotes)) {
        const currentDesigners = slots.map(s => normalize(np[s])).filter(d => d && d !== 'unassigned');
        currentDesigners.forEach(d => {
            notifs.push({
                targetRole: 'DESIGNER',
                targetName: d,
                title: 'PM Note Update',
                body: `${hlProj(np.projectName)}<br>PM updated notes: "${(np.pmNotes || '').substring(0, 60)}${(np.pmNotes || '').length > 60 ? '...' : ''}"`,
                projectNumber: np.projectNumber
            });
        });
    }

    // 3. PM Changes Designer Priority
    [1, 2, 3].forEach(slot => {
        const oldPrio = String(op[`priority${slot}`] || '').trim();
        const newPrio = String(np[`priority${slot}`] || '').trim();
        const designerName = np[`designer${slot}`];
        const oldDesigner = normalize(op[`designer${slot}`]);

        // If designer changed, we skip this notification (covered by New Assignment)
        if (oldPrio !== newPrio && designerName && designerName !== 'Unassigned') {
            if (normalize(designerName) !== oldDesigner) return;

            notifs.push({
                targetRole: 'DESIGNER',
                targetName: designerName,
                title: 'Priority Changed by PM',
                body: `${hlProj(np.projectName)}<br>Priority: ${oldPrio || 'None'} → ${newPrio || 'None'}<br><span style="opacity:0.8">Changed by ${hlUser(editorName)}</span>`,
                projectNumber: np.projectNumber
            });
        }
    });

    // 4. PM Assignment Changes
    if (normalize(op.pm) !== normalize(np.pm)) {
        const oldPM = op.pm || 'Unassigned';
        const newPM = np.pm || 'Unassigned';

        // Notify all assigned designers about PM change
        const currentDesigners = slots.map(s => normalize(np[s])).filter(d => d && d !== 'unassigned');
        currentDesigners.forEach(d => {
            let message;
            if (oldPM === 'Unassigned' || !oldPM) {
                message = `${hlProj(np.projectName)}<br>PM assigned: ${hlUser(newPM)}`;
            } else if (newPM === 'Unassigned' || !newPM) {
                message = `${hlProj(np.projectName)}<br>PM removed: ${hlUser(oldPM)}`;
            } else {
                message = `${hlProj(np.projectName)}<br>PM changed: ${hlUser(oldPM)} → ${hlUser(newPM)}`;
            }

            notifs.push({
                targetRole: 'DESIGNER',
                targetName: d,
                title: 'PM Assignment Update',
                body: message,
                projectNumber: np.projectNumber
            });
        });
    }

    // 5. Project Completion (Confetti)
    // Debug logging for status change
    if (op.status !== np.status) {
        console.log(`[DEBUG] Status Change Detected: ${op.status} -> ${np.status}`);
    }

    const normalizedStatus = normalize(np.status);
    if (normalize(op.status) !== normalizedStatus && (normalizedStatus === 'completed - sent to client' || normalizedStatus === 'approved - construction phase')) {
        console.log('[DEBUG] Completion/Approval Triggered! Generating Confetti Notification...');
        const assignedTeam = slots.map(s => normalize(np[s])).filter(d => d && d !== 'unassigned');
        if (np.pm && np.pm !== 'Unassigned') assignedTeam.push(normalize(np.pm));

        // Use a set to remove duplicates
        const uniqueTeam = [...new Set(assignedTeam)];

        uniqueTeam.forEach(user => {
            notifs.push({
                targetRole: 'ANY',
                targetName: user,
                title: 'Project Celebration! 🎉',
                body: `${hlProj(np.projectName)}<br>Status changed to: <strong>${np.status}</strong>`,
                projectNumber: np.projectNumber,
                projectName: np.projectName,
                status: np.status, // Pass status for dynamic header
                type: 'COMPLETED_MODAL',
                team: uniqueTeam
            });
        });
    }

    return notifs;
}

// --- ROUTING VIEWS ---
// We serve the same index.html but with injected identity
function serveApp(req, res, role, email) {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (!fs.existsSync(indexPath)) return res.send('Public folder empty. Please wait for frontend generation.');

    let html = fs.readFileSync(indexPath, 'utf8');

    // Identity Injection Script
    // We pick a valid user from the DB for the requested role
    const users = db.get('users').value();
    let user = users.find(u => (u.role || '').toUpperCase().includes(role));

    // Fallback or specific override
    if (email) {
        user = users.find(u => u.email === email);
    }

    if (!user && role === 'PM') user = { name: 'Mock PM', email: 'pm@pacsands.com', role: 'PM' };
    if (!user && role === 'DESIGNER') user = { name: 'Mock Designer', email: 'designer@pacsands.com', role: 'DESIGNER' };
    if (!user && role === 'OPERATIONAL') user = { name: 'Mock Ops', email: 'ops@pacsands.com', role: 'OPERATIONAL' };

    const injection = `
    <script>
      window.currentUser = ${JSON.stringify(user)};
      console.log('Logged in as:', window.currentUser);
    </script>
    `;

    // Inject before </head>
    html = html.replace('</head>', `${injection}\n</head>`);
    res.send(html);
}

app.get('/pm', (req, res) => serveApp(req, res, 'PM', req.query.email));
app.get('/designer', (req, res) => serveApp(req, res, 'DESIGNER', req.query.email || 'marvsppam0@gmail.com'));
app.get('/ops', (req, res) => serveApp(req, res, 'OPERATIONAL', req.query.email));

// Data Editor Route
app.get('/data', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'data.html'));
});

// --- API ENDPOINTS (Converting GAS Functions) ---

const INACTIVE_STATUSES = [
    "Abandoned",
    "Expired",
    "Approved - Construction Phase",
    "Completed - Sent to Client",
    "Paused - Stalled by 3rd Party",
    "Do Not Click - Final Submit for Approval"
];

// Raw Data Access
app.get('/api/raw-data', (req, res) => {
    const data = db.value(); // Get entire DB state
    res.json(data);
});

app.post('/api/raw-data', (req, res) => {
    try {
        const newData = req.body;
        if (!newData || !Array.isArray(newData.projects)) {
            return res.status(400).json({ error: 'Invalid DB structure' });
        }

        const oldData = db.value().projects || [];
        const newProjects = newData.projects;
        const generatedNotifs = [];
        const hlUser = (t) => `<strong style="color:#fff !important;background:rgba(0,0,0,0.2) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;
        const hlProj = (t) => `<strong style="color:#fff !important;background:rgba(59,130,246,0.5) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;

        // -------------------------------------------------------------
        // NOTIFICATION LOGIC
        // -------------------------------------------------------------
        // We need to identify WHO is saving.
        // Assuming the client puts their name/email in the first modified project's lastModified.by
        // or we check the first changed item.
        // For robustness, let's map projects and compare.

        const oldMap = new Map(oldData.map(p => [p.internalId || String(p.id), p]));

        newProjects.forEach(np => {
            const op = oldMap.get(np.internalId || String(np.id));
            if (!op) return; // New project, skip diff for now or handle as "New Assignment"

            const editor = np.lastModified?.by || 'System';
            const editorEmail = np.lastModified?.email || ''; // Ideally we have email, but name works for simple checks

            // Helper: Check if string is 1, 2, or 3
            const isTop3 = (v) => ['1', '2', '3'].includes(String(v).trim());

            // --- CHECK 1: Designer Changes (Top 3) ---
            [1, 2, 3].forEach(slot => {
                const oldPrio = String(op[`priority${slot}`] || '').trim();
                const newPrio = String(np[`priority${slot}`] || '').trim();
                const oldNotes = String(op[`notes${slot}`] || '').trim();
                const newNotes = String(np[`notes${slot}`] || '').trim();
                const designerName = np[`designer${slot}`];

                // Logic: If Priority Changed (and involves Top 3)
                if (oldPrio !== newPrio) {
                    // Only trigger if it WAS Top 3 or IS NOW Top 3
                    if (isTop3(oldPrio) || isTop3(newPrio)) {
                        const msg = `Priority changed for ${np.projectName} (Slot ${slot}): ${oldPrio || 'None'} → ${newPrio || 'None'}`;

                        // Notify PM
                        generatedNotifs.push({
                            targetRole: 'PM',
                            targetName: np.pm,
                            title: 'Designer Priority Change',
                            body: `${hlUser(designerName || 'A designer')} changed priority on ${hlProj(np.projectName)}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span>`,
                            projectNumber: np.projectNumber
                        });

                        // Notify OTHER Top 3 Designers
                        // Find who else has this card as Prio 1, 2, or 3 in THIS project?
                        // "send the notification to all the designers who also happen to have that card as either 1,2,3 priority"
                        [1, 2, 3].forEach(otherSlot => {
                            if (otherSlot === slot) return; // Skip self
                            const otherPrio = String(np[`priority${otherSlot}`] || '').trim();
                            const otherDesigner = np[`designer${otherSlot}`];
                            if (isTop3(otherPrio) && otherDesigner) {
                                generatedNotifs.push({
                                    targetRole: 'DESIGNER',
                                    targetName: otherDesigner,
                                    title: 'Shared Project Update',
                                    body: `${hlUser(editor)} changed priority on ${hlProj(np.projectName)}${normalize(editor) !== normalize(designerName) ? ` for ${hlUser(designerName)}` : ''}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span><br><span style="opacity:0.9;font-size:11px;color:#fff;">This project is also in your Top 3</span>`,
                                    projectNumber: np.projectNumber
                                });
                            }
                        });

                        // Notify Affected Designer
                        if (designerName && normalize(designerName) !== normalize(editor)) {
                            generatedNotifs.push({
                                targetRole: 'DESIGNER',
                                targetName: designerName,
                                title: 'PM Priority Change',
                                body: `${hlUser(editor)} has changed priority on ${hlProj(np.projectName)}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span>`,
                                projectNumber: np.projectNumber
                            });
                        }
                    }
                }

                // Logic: Designer Notes Changed (Suppress Notification)
                // "when the designer changes their notes... it should not trigger any notification"
                // So we do NOTHING here.
            });

            // --- CHECK 2: Assignment Changes (PM adds/removes designer) ---
            [1, 2, 3].forEach(slot => {
                const oldDesigner = op[`designer${slot}`];
                const newDesigner = np[`designer${slot}`];

                if (oldDesigner !== newDesigner) {
                    // Added
                    if (newDesigner && (!oldDesigner || oldDesigner === 'Unassigned')) {
                        generatedNotifs.push({
                            targetRole: 'DESIGNER',
                            targetName: newDesigner,
                            title: 'New Assignment',
                            body: `You have been assigned to ${hlProj(np.projectName)} (Slot ${slot}) by ${hlUser(editor)}. Please prioritize this project.`,
                            projectNumber: np.projectNumber
                        });
                    }
                    // Removed
                    if (oldDesigner && oldDesigner !== 'Unassigned' && (!newDesigner || newDesigner === 'Unassigned')) {
                        generatedNotifs.push({
                            targetRole: 'DESIGNER',
                            targetName: oldDesigner,
                            title: 'Unassigned',
                            body: `You have been removed from ${hlProj(np.projectName)} (Slot ${slot}) by ${hlUser(editor)}.`,
                            projectNumber: np.projectNumber
                        });
                    }
                    // Replaced
                    if (oldDesigner && newDesigner && oldDesigner !== 'Unassigned' && newDesigner !== 'Unassigned') {
                        generatedNotifs.push({
                            targetRole: 'DESIGNER',
                            targetName: oldDesigner,
                            title: 'Unassigned',
                            body: `You have been replaced on ${hlProj(np.projectName)} by ${hlUser(newDesigner)}.`,
                            projectNumber: np.projectNumber,
                            hideViewButton: true
                        });
                        generatedNotifs.push({
                            targetRole: 'DESIGNER',
                            targetName: newDesigner,
                            title: 'New Assignment',
                            body: `You have been assigned to replace ${hlUser(oldDesigner)} on ${hlProj(np.projectName)}. Please prioritize this project.`,
                            projectNumber: np.projectNumber
                        });

                        // Notify Teammates (Event 4) - For Data Editor / Raw Updates
                        [1, 2, 3].forEach(mateNum => {
                            if (mateNum === slot) return; // 'slot' is number here [1,2,3]
                            const mateName = np[`designer${mateNum}`];
                            const matePrio = String(np[`priority${mateNum}`] || '').trim();
                            const isMateTop3 = ['1', '2', '3'].includes(matePrio);

                            if (mateName && mateName !== 'Unassigned' && isMateTop3) {
                                generatedNotifs.push({
                                    targetRole: 'DESIGNER',
                                    targetName: mateName,
                                    title: 'Team Update',
                                    body: `${hlUser(oldDesigner)} was replaced by ${hlUser(newDesigner)} on ${hlProj(np.projectName)}`,
                                    projectNumber: np.projectNumber
                                });
                            }
                        });
                    }
                }
            });

            // --- CHECK 3: PM Note Changes ---
            if (op.pmNotes !== np.pmNotes) {
                // "if a pm edited or added a note... designers... get notified"
                // We assume if pmNotes changed, it was likely the PM. 
                // Checks can be added if we trust 'editor'.

                const msg = `${hlProj(np.projectName)}<br>PM Notes updated: "${(np.pmNotes || '').substring(0, 60)}${(np.pmNotes || '').length > 60 ? '...' : ''}"`;

                // Notify ALL assigned designers
                [1, 2, 3].forEach(slot => {
                    if (np[`designer${slot}`]) {
                        generatedNotifs.push({
                            targetRole: 'DESIGNER',
                            targetName: np[`designer${slot}`],
                            title: 'PM Note Update',
                            body: msg,
                            projectNumber: np.projectNumber
                        });
                    }
                });
            }

            // --- CHECK 5: Project Completion/Approval (Confetti) ---
            const normalizedStatus = normalize(np.status);
            if (op.status !== np.status) console.log(`[DEBUG-RAW] Status Diff: "${op.status}" -> "${np.status}"`);
            if (op.status !== np.status && (normalizedStatus === 'completed - sent to client' || normalizedStatus === 'approved - construction phase')) {
                console.log('[DEBUG-RAW] Confetti Condition MET!');
                const assignedTeam = [1, 2, 3].map(s => normalize(np[`designer${s}`])).filter(d => d && d !== 'unassigned');
                if (np.pm && np.pm !== 'Unassigned') assignedTeam.push(normalize(np.pm));

                // Deduplicate team (e.g. if PM is also Designer)
                const uniqueTeam = [...new Set(assignedTeam)];

                uniqueTeam.forEach(user => {
                    generatedNotifs.push({
                        targetRole: 'ANY',
                        targetName: user,
                        title: 'Project Celebration! 🎉',
                        body: `${hlProj(np.projectName)}<br>Status changed to: <strong>${np.status}</strong>`,
                        projectNumber: np.projectNumber,
                        projectName: np.projectName,
                        status: np.status, // Pass status
                        type: 'COMPLETED_MODAL',
                        team: uniqueTeam
                    });
                });
            }
        });

        // Save Notifications
        if (generatedNotifs.length > 0) {
            let finalNotifs = [...generatedNotifs];

            // Filter: Prioritize Confetti. If a user gets a Confetti, remove generic status/priority updates for SAME project.
            const confettiEvents = finalNotifs.filter(n => n.type === 'CONFETTI');
            if (confettiEvents.length > 0) {
                // Create a set of "Confetti Targets" (User + Project)
                const covered = new Set(confettiEvents.map(c => c.targetName + '|' + c.projectNumber));

                finalNotifs = finalNotifs.filter(n => {
                    if (n.type === 'CONFETTI') return true; // Keep confetti
                    // If this is a generic notif, check if it's already covered by confetti
                    const key = n.targetName + '|' + n.projectNumber;
                    if (covered.has(key)) return false; // Remove generic
                    return true;
                });
            }

            const allNotifs = db.get('notifications').value() || [];
            const timestamp = Date.now();

            finalNotifs.forEach(n => {
                allNotifs.push({
                    id: String(timestamp + Math.random()),
                    createdAt: timestamp,
                    readBy: [],
                    ...n
                });
            });
            db.set('notifications', allNotifs).write();
        }

        // -------------------------------------------------------------
        // PRIORITY REBALANCING LOGIC (Existing)
        // -------------------------------------------------------------
        const projects = newData.projects;
        // 1. Clear priorities for Inactive projects
        projects.forEach(p => {
            const status = String(p.status || '').trim();
            const isInactive = INACTIVE_STATUSES.some(s => status.includes(s) || s === status);
            if (isInactive) { p.priority1 = ""; p.priority2 = ""; p.priority3 = ""; }
        });
        // 2. Group Active Projects by Designer
        const designerMap = {};
        const addToMap = (designerName, project, prioKey) => {
            const name = normalize(designerName);
            if (!name) return;
            if (!designerMap[name]) designerMap[name] = [];
            designerMap[name].push({ project, prioKey });
        };
        projects.forEach(p => {
            const status = String(p.status || '').trim();
            const isInactive = INACTIVE_STATUSES.some(s => status.includes(s));
            if (isInactive) return;
            if (p.designer1) addToMap(p.designer1, p, 'priority1');
            if (p.designer2) addToMap(p.designer2, p, 'priority2');
            if (p.designer3) addToMap(p.designer3, p, 'priority3');
        });
        // 3. Re-sequence Priorities
        Object.keys(designerMap).forEach(dKey => {
            const list = designerMap[dKey];
            const ranked = list.filter(item => {
                const val = parseInt(item.project[item.prioKey]);
                return !isNaN(val) && val > 0;
            });
            ranked.sort((a, b) => parseInt(a.project[a.prioKey]) - parseInt(b.project[b.prioKey]));
            ranked.forEach((item, index) => {
                item.project[item.prioKey] = String(index + 1);
            });
        });



        // Write the full state
        // CRITICAL FIX: Ensure we don't overwrite notifications with stale client data
        // 1. Get current DB notifications
        const currentDbNotifs = db.get('notifications').value() || [];
        // 2. Add generated ones
        const timestamp = Date.now();
        const newNotifs = generatedNotifs.map(n => ({
            id: String(timestamp + Math.random()),
            createdAt: timestamp,
            readBy: [],
            ...n
        }));

        // 3. Merge: If client sent notifications, we might want to respect deletions? 
        // But for Data Editor, we likely just want valid state. 
        // Safer: Use currentDB + new, ignoring Client's stale notification list.
        newData.notifications = [...currentDbNotifs, ...newNotifs];

        // 4. Save
        db.setState(newData).write();
        console.log(`[DEBUG-RAW] Persisted ${newNotifs.length} new notifications. Total: ${newData.notifications.length}`);

        res.json({ success: true, count: newData.projects.length, notifsGenerated: generatedNotifs.length });
    } catch (e) {
        console.error('Save Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Notification Endpoints
app.get('/api/notifications', (req, res) => {
    const email = normalize(req.query.email);
    const name = normalize(req.query.name); // Using name matching for local sim
    const notifs = db.get('notifications').value() || [];

    // Filter logic
    const mine = notifs.filter(n => {
        const targetName = normalize(n.targetName);
        const matchesName = targetName === name || targetName === email;
        const matchesTarget = (n.targetRole === 'ANY' && (!n.targetName || matchesName)) ||
            (n.targetRole === 'PM' && matchesName) ||
            (n.targetRole === 'DESIGNER' && matchesName);

        // Also include broadcast/role based if needed, but for now strict matching
        // For PM, they generally see everything relevant?
        // But for Confetti, we targeted specific users.

        return matchesTarget && !(n.readBy || []).includes(email);
    });

    // Sort Newest First
    mine.sort((a, b) => b.createdAt - a.createdAt);
    res.json(mine);
});

app.post('/api/notifications/ack', (req, res) => {
    const { id, email } = req.body;
    const notifs = db.get('notifications').value() || [];
    // Robust comparison (String vs Number)
    const n = notifs.find(x => String(x.id) === String(id));
    if (n) {
        n.readBy = n.readBy || [];
        if (!n.readBy.includes(email)) n.readBy.push(email);
        db.write();
    }
    res.json({ success: true });
});


// 1. Bootstrap
app.get('/api/bootstrap', (req, res) => {
    // Determine user from "session" (here passed via query or assumed from context?)
    // In a real local app, we can pass email as a query param or use the injected global.
    // Frontend `fetch` needs to send the email.

    const email = req.query.email;
    const user = db.get('users').find({ email }).value();

    if (!user) return res.status(404).json({ error: 'User not found' });

    const config = db.get('config').value();
    const colors = db.get('colors').value();

    const roleStr = String(user.role || '');
    const roles = roleStr.split(',').map(r => r.trim()).filter(Boolean).map(r => r.toUpperCase());

    res.json({
        email: user.email,
        name: user.name,
        roles: roles,
        isPM: roles.includes('PM'),
        isOps: roles.includes('OPERATIONAL'),
        priorityOptions: config.priorityOptions,
        phaseColors: colors,
        logoUrl: 'https://raw.githubusercontent.com/marvinpacsands/base64-image/refs/heads/main/logo.png' // hardcoded as per GAS
    });
});

// Helper: Build Team Object (replicated from GAS)
function buildTeam(row) {
    const team = [];
    [1, 2, 3].forEach(s => {
        team.push({
            slot: s,
            name: row[`designer${s}`],
            priority: row[`priority${s}`],
            notes: row[`notes${s}`],
            // For local sim, we might not have dates unless we added them to DB. Mocking for now.
            dateDisplay: ''
        });
    });
    return team;
}

// Helper: Build PM Fields
function buildPMFields(row) {
    return {
        priority: row.pmPriority,
        notes: row.pmNotes,
        datePriorityDisplay: '',
        dateNotesDisplay: ''
    };
}

// 2. GET Projects (Merged Logic)
app.get('/api/projects', (req, res) => {
    const email = req.query.email;
    const mode = req.query.mode; // 'mine', 'pm', 'ops'

    const user = db.get('users').find({ email }).value();
    if (!user) return res.status(403).json({ error: 'Access Denied' });

    let projects = db.get('projects').value();

    // Auto-Fix Missing rowIndex
    let fixed = false;
    // Find max rowIndex safely
    let maxRowIndex = projects.reduce((max, p) => {
        const val = Number(p.rowIndex);
        return !isNaN(val) ? Math.max(max, val) : max;
    }, 0);

    projects.forEach(p => {
        if (p.rowIndex === undefined || p.rowIndex === null || p.rowIndex === '') {
            maxRowIndex++;
            p.rowIndex = maxRowIndex;
            fixed = true;
            console.log(`[AUTO-FIX] Assigned rowIndex ${maxRowIndex} to project "${p.projectName}"`);
        }
    });

    if (fixed) {
        db.write(); // projects is a reference, so simple write persists changes
    }
    const response = {};

    // Logic split by mode
    if (mode === 'pm') {
        const pmName = req.query.pmName || user.name;
        // Filter logic...
        const showAll = pmName === '__ALL__';
        const showUnassigned = pmName === 'Unassigned';

        projects = projects.filter(p => {
            if (showAll) return true;
            if (showUnassigned) return !p.pm || p.pm === 'Unassigned' || p.pm === '';
            // Simplified match:
            return (p.pm || '').toLowerCase().includes(pmName.toLowerCase());
        }).map(p => ({
            rowIndex: p.rowIndex,
            projectNumber: p.projectNumber,
            projectName: p.projectName,
            status: p.status,
            internalId: p.internalId,
            pmName: p.pm,
            pm: buildPMFields(p),
            team: buildTeam(p),
            missing: [], // Todo: implement missing logic if strictly needed
            lastModified: p.lastModified
        }));

        // Return dropdown lists
        const allPMs = [...new Set(db.get('projects').map(p => p.pm).value())].sort();
        const allStatus = [...new Set(db.get('projects').map(p => p.status).value())].sort();
        const allUsers = db.get('users').value();

        // Calculate Global Unassigned Count (regardless of filter)
        // Calculate Global Unassigned Count (regardless of filter)
        // EXCLUDE Archive Statuses: Completed, Cancelled, On Hold, Abandoned
        const archiveStatuses = ['completed', 'cancelled', 'on hold', 'abandoned'];
        const allProjects = db.get('projects').value();
        const totalUnassigned = allProjects.filter(p => {
            const isUnassigned = !p.pm || p.pm === 'Unassigned';
            if (!isUnassigned) return false;

            // Check Status
            const s = (p.status || '').toLowerCase();
            const pPrio = (p.pmPriority || '').toLowerCase();

            if (archiveStatuses.some(k => s.includes(k))) return false;
            if (archiveStatuses.some(k => pPrio.includes(k))) return false;

            return true;
        }).length;

        response.projects = projects;
        response.pmList = ['__ALL__', ...allPMs];
        response.statusList = allStatus;
        response.people = allUsers; // For dropdowns
        response.totalUnassigned = totalUnassigned; // New Field

        // Calculate Active Counts per Designer
        const designerCounts = {};
        const normalize = (s) => String(s || '').toLowerCase().trim();

        allProjects.forEach(p => {
            const status = normalize(p.status);
            const isInactive = INACTIVE_STATUSES.some(s => status.includes(normalize(s)));

            if (!isInactive) {
                [1, 2, 3].forEach(slot => {
                    const des = normalize(p[`designer${slot}`]);
                    if (des && des !== 'unassigned') {
                        designerCounts[des] = (designerCounts[des] || 0) + 1;
                    }
                });
            }
        });
        response.designerCounts = designerCounts;

        // Custom Sort Order (for drag-drop manual ordering)
        const customSortOrder = (user.customSortOrder && user.customSortOrder[pmName]) || [];
        response.customSortOrder = customSortOrder;


    } else if (mode === 'mine') {
        // Filter where user is designer 1, 2, or 3
        const normName = normalize(user.name);
        const normEmail = normalize(user.email);

        const check = (val) => {
            const v = normalize(val);
            return v === normName || v === normEmail || (v && v.includes(normName)); // simplistic
        };

        projects = projects.filter(p => {
            return check(p.designer1) || check(p.designer2) || check(p.designer3);
        }).map(p => {
            // Find slot
            let slot = 0;
            if (check(p.designer1)) slot = 1;
            else if (check(p.designer2)) slot = 2;
            else if (check(p.designer3)) slot = 3;
            // ... (full slot logic skipped for brevity, assuming standard names)

            return {
                rowIndex: p.rowIndex,
                projectNumber: p.projectNumber,
                projectName: p.projectName,
                status: p.status,
                pmName: p.pm,
                pm: buildPMFields(p),
                team: buildTeam(p),
                my: {
                    priority: p[`priority${slot}`],
                    notes: p[`notes${slot}`]
                }
            };
        });
        response.projects = projects;
        response.people = db.get('users').value();

    } else if (mode === 'ops') {
        projects = projects.map(p => ({
            rowIndex: p.rowIndex,
            projectNumber: p.projectNumber,
            projectName: p.projectName,
            status: p.status,
            pmName: p.pm,
            pm: buildPMFields(p),
            team: buildTeam(p),
            operational: {
                user: p.operational,
                notes: p.operationalNotes
            }
        }));
        response.projects = projects;
        response.people = db.get('users').value();
    }

    res.json(response);
});

// Custom Sort Order Endpoint
app.post('/api/custom-order', (req, res) => {
    const { email, pmName, orderedRowIndexes } = req.body;

    const user = db.get('users').find({ email }).value();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Initialize customSortOrder if it doesn't exist
    if (!user.customSortOrder) user.customSortOrder = {};

    // Save the custom order for this PM
    user.customSortOrder[pmName] = orderedRowIndexes;

    // Persist to database
    db.write();

    res.json({ success: true, message: 'Custom order saved' });
});

// 3. UPDATE Endpoint
app.post('/api/update', (req, res) => {
    const { email, mode, payload } = req.body;
    // mode: 'mine', 'pm', 'ops'
    // payload: data specific to update

    // Find project
    // Use String comparison for robustness (DB has mixed types)
    const project = db.get('projects').find(p => String(p.rowIndex) === String(payload.rowIndex)).value();
    if (!project) {
        console.error(`[UPDATE ERROR] Project not found for rowIndex: ${payload.rowIndex}`);
        return res.status(404).json({ error: 'Project not found' });
    }

    const oldProject = JSON.parse(JSON.stringify(project)); // Deep copy for comparison

    // Update logic based on mode
    try {
        const users = db.get('users').value();
        // Check for realActor override (PM impersonation)
        const effectiveEmail = payload.realActorEmail || email;
        const actor = users.find(u => u.email === effectiveEmail);
        const actorName = actor ? actor.name : (effectiveEmail || 'Unknown');
        const modInfo = {
            dateDisplay: new Date().toLocaleDateString(),
            dateMs: Date.now(),
            by: actorName,
            display: new Date().toLocaleDateString()
        };
        project.lastModified = modInfo;

        if (mode === 'pm') {
            project.pmPriority = payload.pmPriority;
            project.pmNotes = payload.pmNotes;
            if (payload.pmName !== undefined) project.pm = payload.pmName;
            if (payload.designer1 !== undefined) {
                if (project.designer1 !== payload.designer1) {
                    project.priority1 = '-';
                    project.notes1 = '';
                }
                project.designer1 = payload.designer1;
            }
            if (payload.designer2 !== undefined) {
                if (project.designer2 !== payload.designer2) {
                    project.priority2 = '-';
                    project.notes2 = '';
                }
                project.designer2 = payload.designer2;
            }
            if (payload.designer3 !== undefined) {
                if (project.designer3 !== payload.designer3) {
                    project.priority3 = '-';
                    project.notes3 = '';
                }
                project.designer3 = payload.designer3;
            }

            if (payload.designer1Priority !== undefined) project.priority1 = payload.designer1Priority;
            if (payload.designer2Priority !== undefined) project.priority2 = payload.designer2Priority;
            if (payload.designer3Priority !== undefined) project.priority3 = payload.designer3Priority;

            db.get('projects').find(p => String(p.rowIndex) === String(payload.rowIndex)).assign(project).write();

            // Notifications (skip if this is a shift-induced change)
            if (!payload.skipNotifications) {
                const notifs = generateNotifications(oldProject, project, actorName);
                if (notifs.length > 0) {
                    const allNotifs = db.get('notifications').value() || [];
                    notifs.forEach(n => {
                        // Filter out self-notifications: don't notify the person who made the change
                        const isSelNotif = normalize(n.targetName) === normalize(actorName);
                        if (!isSelNotif) {
                            allNotifs.push({
                                id: String(Date.now() + Math.random()),
                                createdAt: Date.now(),
                                readBy: [],
                                ...n
                            });
                        }
                    });
                    db.set('notifications', allNotifs).write();
                }
            }

        } else if (mode === 'mine') {
            const users = db.get('users').value();
            const user = users.find(u => u.email === email);
            const normName = normalize(user.name);

            const normEmail = normalize(user.email);
            const hlUser = (t) => `<strong style="color:#fff !important;background:rgba(0,0,0,0.2) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;
            const hlProj = (t) => `<strong style="color:#fff !important;background:rgba(59,130,246,0.5) !important;padding:2px 6px !important;border-radius:3px !important;font-size:12px !important;display:inline-block !important;">${t}</strong>`;
            const check = (val) => {
                const v = normalize(val);
                return v === normName || v === normEmail || (v && v.includes(normName));
            };

            let slot = 0;
            if (check(project.designer1)) slot = 1;
            else if (check(project.designer2)) slot = 2;
            else if (check(project.designer3)) slot = 3;

            if (slot > 0) {
                const oldPrio = project[`priority${slot}`];
                const newPrio = payload.priority;

                project[`priority${slot}`] = payload.priority;
                project[`notes${slot}`] = payload.notes;
                db.get('projects').find(p => String(p.rowIndex) === String(payload.rowIndex)).assign(project).write();

                // Generate notifications for priority changes (≤3 threshold)
                // Skip if this is a shift-induced change
                if (!payload.skipNotifications) {
                    const isTop3 = (v) => ['1', '2', '3'].includes(String(v).trim());

                    if (oldPrio !== newPrio && (isTop3(oldPrio) || isTop3(newPrio))) {
                        const allNotifs = db.get('notifications').value() || [];
                        const timestamp = Date.now();

                        // Notify PM
                        if (project.pm && project.pm !== 'Unassigned') {
                            const isSelNotif = normalize(project.pm) === normalize(actorName);
                            if (!isSelNotif) {
                                allNotifs.push({
                                    id: String(timestamp + Math.random()),
                                    createdAt: timestamp,
                                    readBy: [],
                                    targetRole: 'PM',
                                    targetName: project.pm,
                                    title: 'Designer Priority Change',
                                    body: `${hlUser(actorName)} changed priority on ${hlProj(project.projectName)}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span>`,
                                    projectNumber: project.projectNumber
                                });
                            }
                        }

                        // Notify other designers with ≤3 priority on this project
                        [1, 2, 3].forEach(otherSlot => {
                            if (otherSlot === slot) return; // Skip self
                            const otherPrio = String(project[`priority${otherSlot}`] || '').trim();
                            const otherDesigner = project[`designer${otherSlot}`];

                            if (isTop3(otherPrio) && otherDesigner && otherDesigner !== 'Unassigned') {
                                const isSelNotif = normalize(otherDesigner) === normalize(actorName);
                                if (!isSelNotif) {
                                    allNotifs.push({
                                        id: String(timestamp + Math.random()),
                                        createdAt: timestamp,
                                        readBy: [],
                                        targetRole: 'DESIGNER',
                                        targetName: otherDesigner,
                                        title: 'Shared Project Update',
                                        body: `${hlUser(actorName)} changed priority on ${hlProj(project.projectName)}${normalize(actorName) !== normalize(project[`designer${slot}`]) ? ` for ${hlUser(project[`designer${slot}`])}` : ''}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span><br><span style="opacity:0.9;font-size:11px;color:#fff;">This project is also in your Top 3</span>`,
                                        projectNumber: project.projectNumber
                                    });
                                }
                            }
                        });

                        // Notify Affected Designer (if actor is NOT the designer, e.g. PM Override)
                        const affectedDesigner = project[`designer${slot}`];
                        // The outer condition is: oldPrio!=newPrio AND (isTop3(old) || isTop3(new))
                        if (affectedDesigner && normalize(affectedDesigner) !== normalize(actorName)) {
                            allNotifs.push({
                                id: String(timestamp + Math.random()),
                                createdAt: timestamp,
                                readBy: [],
                                targetRole: 'DESIGNER',
                                targetName: affectedDesigner,
                                title: 'PM Priority Change',
                                body: `${hlUser(actorName)} has changed priority on ${hlProj(project.projectName)}<br>Priority: <span style="background:#f59e0b;color:#000;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${oldPrio || 'None'}</span> → <span style="background:#10b981;color:#fff;padding:2px 5px;border-radius:3px;font-size:11px;font-weight:600;margin:0 2px;display:inline-block;">${newPrio || 'None'}</span>`,
                                projectNumber: project.projectNumber
                            });
                        }

                        db.set('notifications', allNotifs).write();
                    }
                }
            }
        } else if (mode === 'ops') {
            if (payload.pmName !== undefined) project.pm = payload.pmName;
            if (payload.operationalNotes !== undefined) project.operationalNotes = payload.operationalNotes;
            // Designers too
            if (payload.designer1 !== undefined) project.designer1 = payload.designer1;
            // ...

            db.get('projects').find(p => String(p.rowIndex) === String(payload.rowIndex)).assign(project).write();
        }

        res.json({ ok: true, savedAtDisplay: new Date().toLocaleTimeString() });
    } catch (err) {
        console.error('[UPDATE CRASH]', err);
        res.status(500).json({ error: 'Server Error', details: err.message });
    }
});


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`PM View: http://localhost:${PORT}/pm`);
    console.log(`Designer View: http://localhost:${PORT}/designer`);
    console.log(`Ops View: http://localhost:${PORT}/ops`);
});
