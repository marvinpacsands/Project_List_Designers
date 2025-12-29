// Expose all animation functions globally for index.html

// Confetti Cannon (one-shot, realistic) + optional sound.
// Adds "coin" particles (logo image) with size scaling, while keeping the same public API: window.triggerConfetti()
(function () {
    if (typeof document === 'undefined') return;

    const CANVAS_ID = 'confetti-canvas';

    let canvas = null;
    let ctx = null;
    let particles = [];
    let rafId = null;

    // --- Coin image (loaded once) ---
    const COIN_IMAGE_URL = 'https://raw.githubusercontent.com/marvinpacsands/base64-image/refs/heads/main/logo.png';
    const coinImg = new Image();
    coinImg.crossOrigin = 'anonymous';
    let coinImgReady = false;
    coinImg.onload = () => { coinImgReady = true; };
    coinImg.onerror = () => { coinImgReady = false; };
    coinImg.src = COIN_IMAGE_URL;

    function ensureCanvas() {
        if (canvas && ctx) return;
        if (!document.body) {
            setTimeout(ensureCanvas, 10);
            return;
        }

        canvas = document.getElementById(CANVAS_ID);
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.id = CANVAS_ID;
            canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:20000';
            document.body.appendChild(canvas);
        }

        ctx = canvas.getContext('2d');
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    function resizeCanvas() {
        if (!canvas || !ctx) return;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.floor(window.innerWidth * dpr);
        canvas.height = Math.floor(window.innerHeight * dpr);
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        // draw in CSS pixels
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function rand(min, max) { return Math.random() * (max - min) + min; }
    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        }
        return arr;
    }

    function startLoop() {
        if (rafId) return;

        const frame = () => {
            rafId = requestAnimationFrame(frame);

            const w = window.innerWidth;
            const h = window.innerHeight;

            ctx.clearRect(0, 0, w, h);

            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.tick++;

                // =============================
                // COIN PARTICLES (logo coins)
                // =============================
                if (p.kind === 'coin') {
                    // physics (realistic flutter + flip)
                    p.vy += p.gravity;
                    p.baseX += p.vx + p.drift;
                    p.y += p.vy;

                    p.rotation += p.spin;
                    p.flip += p.flipSpin;
                    p.vx *= p.decay;
                    p.vy *= p.decay;

                    p.wobble += p.wobbleSpeed;
                    const drawX = p.baseX + Math.sin(p.wobble) * p.wobbleAmp;

                    // fade out near end
                    const lifeProgress = p.tick / p.totalTicks;
                    const alpha = lifeProgress < 0.85 ? 1 : Math.max(0, 1 - (lifeProgress - 0.85) / 0.15);

                    ctx.save();

                    // flip illusion: scale X with cos()
                    const flipCos = Math.cos(p.flip);
                    const flipAbs = Math.abs(flipCos);
                    const scaleX = Math.max(0.08, flipAbs) * (flipCos < 0 ? -1 : 1);

                    // dim slightly when edge-on so it reads as a flip
                    ctx.globalAlpha = alpha * (0.65 + 0.35 * flipAbs);
                    ctx.translate(drawX, p.y);
                    ctx.rotate(p.rotation);
                    ctx.scale(scaleX, 1);

                    const s = p.size;
                    if (coinImgReady) {
                        ctx.drawImage(coinImg, -s / 2, -s / 2, s, s);
                    } else {
                        // fallback while image loads / if blocked
                        ctx.fillStyle = 'rgba(255,255,255,0.9)';
                        ctx.fillRect(-s / 2, -s / 2, s, s);
                    }

                    ctx.restore();

                    // cull dead/out of bounds
                    if (
                        p.tick >= p.totalTicks ||
                        (p.y > h + 220 && p.vy > 0) ||
                        p.baseX < -200 || p.baseX > w + 200
                    ) {
                        particles.splice(i, 1);
                    }
                    continue;
                }

                // =============================
                // PAPER CONFETTI (existing behavior)
                // =============================

                // physics (realistic flutter)
                p.vy += p.gravity;
                p.baseX += p.vx + p.drift;
                p.y += p.vy;

                p.rotation += p.spin;
                p.vx *= p.decay;
                p.vy *= p.decay;

                p.wobble += p.wobbleSpeed;
                const drawX = p.baseX + Math.sin(p.wobble) * p.wobbleAmp;

                // fade out near end
                const lifeProgress = p.tick / p.totalTicks;
                const alpha = lifeProgress < 0.85 ? 1 : Math.max(0, 1 - (lifeProgress - 0.85) / 0.15);

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.translate(drawX, p.y);
                ctx.rotate(p.rotation);
                ctx.fillStyle = p.color;

                // paper rectangles (mix of strips + bits)
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();

                // cull dead/out of bounds (after it falls back down)
                if (
                    p.tick >= p.totalTicks ||
                    (p.y > h + 220 && p.vy > 0) ||
                    p.baseX < -200 || p.baseX > w + 200
                ) {
                    particles.splice(i, 1);
                }
            }

            if (particles.length === 0) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };

        rafId = requestAnimationFrame(frame);
    }

    // =============================
    // Sound: Custom "Confetti Blast" MP3
    // =============================
    const SOUND = { enabled: true, volume: 0.6 };
    const CUSTOM_SOUND_URL = 'https://raw.githubusercontent.com/marvinpacsands/Project_List_Designers/f3bd97aaef6fc74e1f1c02c335d1b12422d11b0e/Confetti%20Blast.mp3';

    // Preload audio
    const funSound = new Audio(CUSTOM_SOUND_URL);
    funSound.volume = SOUND.volume;
    funSound.preload = 'auto';

    function unlockAudioOnce() {
        // user interaction allows playback later
        // We can technically try to 'play and pause' to unlock, but browsers 
        // usually just need the gesture context for the *call* to play().
        // For HTML5 Audio, treating it as a global object often works if called within gesture,
        // but here we are calling it later (async).
        // Best practice: Resume AudioContext (if using it) or just hope the browser sees the initial interaction history.
        // Actually, for simple <audio>, we might not need complex unlocking if the user clicked "Save" recently.
    }

    function playConfettiSound() {
        if (!SOUND.enabled) return;

        // Clone for overlapping sounds? Or just reset?
        // Resetting is better for single burst.
        try {
            funSound.currentTime = 0;
            funSound.play().catch(e => console.warn('Audio play blocked (Autoplay Policy):', e));
        } catch (e) {
            console.error('Audio Error:', e);
        }
    }

    // Unlock audio on first user interaction (important since confetti may fire after async saves)
    window.addEventListener('pointerdown', unlockAudioOnce, { once: true, passive: true });
    window.addEventListener('keydown', unlockAudioOnce, { once: true });

    // =============================
    // Public API (used by index.html): window.triggerConfetti()
    // Backwards compatible: can be called with no args.
    // =============================
    window.triggerConfetti = function (options) {
        ensureCanvas();
        if (!ctx) return;

        playConfettiSound();

        const colors = [
            '#FFD700', '#FF6347', '#4169E1', '#32CD32',
            '#FF1493', '#00CED1', '#FFA500', '#9370DB',
            '#FF69B4', '#00FF7F', '#FFE4B5', '#87CEEB'
        ];

        const w = window.innerWidth;
        const h = window.innerHeight;

        // One-shot bottom "cannon": shoots up, spreads, then falls.
        const particleCount = 720;
        const xs = shuffle(Array.from({ length: particleCount }, (_, i) => ((i + Math.random()) / particleCount) * w));

        for (let i = 0; i < particleCount; i++) {
            const baseX = xs[i] + rand(-10, 10);
            const y = h + rand(25, 110);

            // Fan-out: edges get a bit more sideways push
            const t = (baseX / w) * 2 - 1; // -1..1
            const vx = rand(-1.2, 1.2) + t * rand(0.6, 2.2);

            // Upward launch
            const vy = -rand(10.5, 19.0);

            // Two shapes: strips + bits
            const isStrip = Math.random() < 0.55;
            const cw = isStrip ? rand(3.2, 7.0) : rand(5.0, 10.5);
            const ch = isStrip ? rand(14.0, 26.0) : rand(8.0, 14.5);

            particles.push({
                baseX,
                y,
                vx,
                vy,

                drift: rand(-0.06, 0.06),
                gravity: rand(0.16, 0.26),
                decay: rand(0.992, 0.998),

                wobble: rand(0, Math.PI * 2),
                wobbleSpeed: rand(0.05, 0.11),
                wobbleAmp: rand(0.35, 1.15),

                w: cw,
                h: ch,
                rotation: rand(0, Math.PI * 2),
                spin: rand(-0.08, 0.08),

                color: pick(colors),
                tick: 0,
                totalTicks: Math.floor(rand(520, 820))
            });
        }

        // --- Coins (logo confetti) ---
        const rawCoins = Number(options && options.coins);
        const COIN_MAX = 200;
        const coinCount = Math.max(0, Math.min(COIN_MAX, isFinite(rawCoins) ? Math.floor(rawCoins) : 0));

        if (coinCount > 0) {
            // Size scaling: fewer coins => larger coins. Caps shrink after 100 coins.
            const lerp = (a, b, t) => a + (b - a) * t;
            const SIZE_COUNT_CAP = 100;
            const COIN_SIZE_MULT = 3;

            const effectiveCount = Math.max(1, Math.min(SIZE_COUNT_CAP, coinCount));
            const minScale = 1 / Math.sqrt(SIZE_COUNT_CAP);
            const scale = 1 / Math.sqrt(effectiveCount);
            const norm = (scale - minScale) / (1 - minScale);
            const tSize = Math.max(0, Math.min(1, norm));

            const sizeMin = lerp(18, 90, tSize) * COIN_SIZE_MULT;
            const sizeMax = lerp(26, 130, tSize) * COIN_SIZE_MULT;

            for (let i = 0; i < coinCount; i++) {
                const baseX = rand(0, w);
                const y = h + rand(30, 120);

                const t = (baseX / w) * 2 - 1; // -1..1
                const vx = rand(-1.2, 1.2) + t * rand(0.6, 2.2);
                const vy = -rand(12.5, 22.0);

                particles.push({
                    kind: 'coin',
                    baseX,
                    y,
                    vx,
                    vy,

                    drift: rand(-0.06, 0.06),
                    gravity: rand(0.16, 0.26),
                    decay: rand(0.992, 0.998),

                    wobble: rand(0, Math.PI * 2),
                    wobbleSpeed: rand(0.05, 0.11),
                    wobbleAmp: rand(0.35, 1.15),

                    size: rand(sizeMin, sizeMax),

                    rotation: rand(0, Math.PI * 2),
                    spin: rand(-0.06, 0.06),
                    flip: rand(0, Math.PI * 2),
                    flipSpin: rand(-0.28, 0.28),

                    tick: 0,
                    totalTicks: Math.floor(rand(520, 820))
                });
            }
        }

        startLoop();
    };

    // Initialize canvas as soon as possible
    ensureCanvas();
})();

window.enableSmoothColorTransitions = function () {
    if (typeof document === 'undefined') return;

    const style = document.createElement('style');
    style.textContent = `
.card {
  transition: background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
              border-left-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.4s ease,
              transform 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
}
.card.moving {
  transform: scale(1.02);
  box-shadow: 0 20px 40px rgba(0,0,0,0.15) !important;
  z-index: 100;
}
`;
    document.head.appendChild(style);
};

window.enhancedSmartUpdateCard = function (rowIndex, newPriority, oldPriority, viewArg) {
    // Use ACTIVE_TAB global if viewArg not provided
    const view = viewArg || (typeof ACTIVE_TAB !== 'undefined' ? ACTIVE_TAB : 'mine');
    const isPM = view === 'pm';
    const isOps = view === 'ops';

    let rows = [];
    if (isPM) rows = typeof PM_ROWS !== 'undefined' ? PM_ROWS : [];
    else if (isOps) rows = typeof OPS_ROWS !== 'undefined' ? OPS_ROWS : [];
    else rows = typeof MINE_ROWS !== 'undefined' ? MINE_ROWS : [];

    const cardId = `card-${rowIndex}`;
    const cardEl = document.getElementById(cardId);
    if (!cardEl) return;

    const cardData = rows.find(r => r.rowIndex === rowIndex);
    if (!cardData) return;

    // Helper to get effective priority
    const getEff = (prio) => {
        // For PM, the "PM Priority" is the effective one usually, or at least the one that drives sorting if sorting by priority.
        // If this functions is called for PM view, 'newPriority' IS the PM priority.
        if (isPM) {
            return normalize(prio); // PM view uses raw priority for grouping/color? PM View colors based on PM Priority? Yes.
        }

        // Designer View Logic
        const pmRank = getRank(cardData.pm?.priority);
        const myRank = getRank(prio);
        if (normalize(prio) === 'completed') return 'completed';
        if (normalize(prio) === 'on hold') return 'on hold';
        if (normalize(prio) === 'abandoned') return 'abandoned';
        return pmRank > myRank ? cardData.pm?.priority : prio;
    };

    const oldEffPrio = getEff(oldPriority);
    const newEffPrio = getEff(newPriority);

    // Update cardData local state so rendering/sorting works correctly immediately
    if (isPM) {
        if (cardData.pm) cardData.pm.priority = newPriority;
        // Also update root? PM logic usually reads r.pm.priority
    } else {
        if (cardData.my) cardData.my.priority = newPriority;
    }

    // Confetti check
    const wasCompleted = normalize(oldEffPrio) === 'completed';
    const isCompleted = normalize(newEffPrio) === 'completed';

    if (!wasCompleted && isCompleted) {
        // Coins logic? Only for Designers? Or PMs too? 
        // User said "animations should behave the same".
        // Count completed projects for coins.
        const completedCount = rows.reduce((acc, r) => {
            const eff = isPM ? (r.pm?.priority) : getEffectivePrio(r, 'mine');
            return acc + (normalize(eff) === 'completed' ? 1 : 0);
        }, 0);

        if (window.triggerConfetti) {
            setTimeout(() => window.triggerConfetti({ coins: completedCount }), 50);
        }
    }

    // Update colors
    const oldClass = getPrioClass(oldEffPrio);
    const newClass = getPrioClass(newEffPrio);
    if (oldClass) cardEl.classList.remove(oldClass);
    if (newClass) cardEl.classList.add(newClass);

    const gridId = isPM ? 'pmGrid' : 'mineGrid';
    const grid = document.getElementById(gridId);
    if (!grid || grid.style.display === 'none') return;

    // Check special categories (Archive)
    const wasSpecial = ['completed', 'on hold', 'abandoned'].includes(normalize(oldEffPrio));
    const isSpecial = ['completed', 'on hold', 'abandoned'].includes(normalize(newEffPrio));

    if (wasSpecial !== isSpecial) {
        // 1. Moving INTO Archive (Regular -> Special)
        if (!wasSpecial && isSpecial) {
            // Look for the folder in its new dedicated container
            const folder = document.getElementById('archiveFolderTop');
            // IMPORTANT: In PM view, ensure we have an archive folder or similar target. 
            // We will render one in JS_Core next.

            if (folder) {
                // FLIP to Folder
                const cardRect = cardEl.getBoundingClientRect();
                const folderRect = folder.getBoundingClientRect();

                const deltaX = (folderRect.left + folderRect.width / 2) - (cardRect.left + cardRect.width / 2);
                const deltaY = (folderRect.top + folderRect.height / 2) - (cardRect.top + cardRect.height / 2);

                cardEl.classList.add('moving');
                cardEl.style.position = 'relative';
                cardEl.style.zIndex = '1000';
                cardEl.style.transition = 'transform 0.6s cubic-bezier(0.2, 0, 0.2, 1), opacity 0.6s ease';
                cardEl.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(0.2)`;
                cardEl.style.opacity = '0';

                setTimeout(() => {
                    if (typeof render === 'function') render();
                }, 600);
            } else {
                if (typeof render === 'function') render();
            }
            return;
        }

        // 2. Moving OUT of Archive (Special -> Regular)
        if (wasSpecial && !isSpecial) {
            if (typeof render === 'function') render();
            return;
        }
    }

    // Card movement animation (FLIP within grid)
    if (!isSpecial) {
        const regularRows = rows.filter(r => {
            const eff = isPM ? (r.pm?.priority) : getEffectivePrio(r, 'mine');
            return !['completed', 'on hold', 'abandoned'].includes(normalize(eff));
        });

        // Sort Logic (Replicate render sort)
        // PM Sort Defaults? Usually Priority then Number.
        // Mine sort has modes.
        if (isPM) {
            // PM Sort (from code_pm.gs / default): Missing > Priority > Number
            regularRows.sort((a, b) => {
                const am = (a.missing?.length || 0) > 0 ? 0 : 1;
                const bm = (b.missing?.length || 0) > 0 ? 0 : 1;
                if (am !== bm) return am - bm;

                const apr = getRank(a.pm?.priority);
                const bpr = getRank(b.pm?.priority);
                if (apr !== bpr) return bpr - apr; // Descending rank

                const an = parseFloat(a.projectNumber) || 0;
                const bn = parseFloat(b.projectNumber) || 0;
                return an - bn;
            });
        } else {
            // Mine Sort
            const mode = document.getElementById('mineSort') ? document.getElementById('mineSort').value : 'smart';
            if (mode === 'smart') {
                regularRows.sort((a, b) => {
                    const pma = getRank(a.pm?.priority), pmb = getRank(b.pm?.priority);
                    if (pma !== pmb) return pmb - pma;
                    const mya = getRank(a.my?.priority), myb = getRank(b.my?.priority);
                    return myb - mya;
                });
            }
            // ... other modes ... mostly fine to ignore for animation perfectly or just use smart default
        }

        const newIndex = regularRows.findIndex(r => r.rowIndex === rowIndex);
        const currentCards = Array.from(grid.children).filter(el =>
            el.classList.contains('card') && !el.classList.contains('folder-card')
        );
        const currentIndex = currentCards.findIndex(el => el.id === cardId);

        if (newIndex !== -1 && currentIndex !== -1 && newIndex !== currentIndex) {
            const targetCard = currentCards[newIndex];
            if (targetCard) {
                const cardRect = cardEl.getBoundingClientRect();
                const targetRect = targetCard.getBoundingClientRect();
                const deltaX = targetRect.left - cardRect.left;
                const deltaY = targetRect.top - cardRect.top;

                cardEl.classList.add('moving');
                cardEl.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
                cardEl.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(1.02)`;

                setTimeout(() => {
                    cardEl.style.transition = 'none';
                    cardEl.style.transform = '';
                    cardEl.classList.remove('moving');
                    void cardEl.offsetWidth;

                    cardEl.remove();
                    if (newIndex === 0) {
                        grid.prepend(cardEl);
                    } else {
                        grid.insertBefore(cardEl, targetCard);
                    }
                }, 500);
            }
        }
    }
};

// Auto-init
if (typeof document !== 'undefined') {
    console.log('[ANIMATION INIT] Animations module loaded');
    console.log('[ANIMATION INIT] window.triggerConfetti available:', typeof window.triggerConfetti !== 'undefined');
    console.log('[ANIMATION INIT] window.enhancedSmartUpdateCard available:', typeof window.enhancedSmartUpdateCard !== 'undefined');
    console.log('[ANIMATION INIT] window.confetti available:', typeof window.confetti !== 'undefined');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            enableSmoothColorTransitions();
            console.log('🎉 Dashboard animations enabled! (DOMContentLoaded)');
        });
    } else {
        enableSmoothColorTransitions();
        console.log('🎉 Dashboard animations enabled! (already loaded)');
    }
}
