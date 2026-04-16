/* =======================================================
   Allocation Checker — app.js
   APIs (all public, no key required):
   1. hub.pinata.cloud/v1/userNameProofByName  → resolve ENS/username → FID
   2. fnames.farcaster.xyz/transfers           → resolve plain fname → FID
   3. hub.pinata.cloud/v1/userDataByFid        → profile (name, pfp, username)
   4. airdrop.onchain.cooking/snap/airdrop     → allocation amount
   ======================================================= */

const $ = id => document.getElementById(id);

/* ── Token estimation constants ─────────────────────────── */
const TOTAL_SUPPLY = 2_000_000_000; // 2 Billion HSNAP
const FDV_LEVELS = [
  { label: '$100K', fdv: 100_000, highlight: false },
  { label: '$1M', fdv: 1_000_000, highlight: false },
  { label: '$5M', fdv: 5_000_000, highlight: false },
  { label: '$10M', fdv: 10_000_000, highlight: false },
  { label: '$50M', fdv: 50_000_000, highlight: false },
  { label: '$100M', fdv: 100_000_000, highlight: true }, // highlighted row
  { label: '$1B', fdv: 1_000_000_000, highlight: false },
];

/* ── CORS-aware fetch ───────────────────────────────────── */
async function cfetch(url) {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (res.ok) return res;
    throw new Error('not ok');
  } catch {
    const proxy = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    const res = await fetch(proxy);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
}

/* ── DOM refs ───────────────────────────────────────────── */
const inputEl = $('lookup-input');
const checkBtn = $('check-btn');
const clearBtn = $('clear-btn');
const errorCard = $('error-card');
const errorMsg = $('error-msg');
const resultCard = $('result-card');
const shareBtn = $('share-btn');

let lastResult = null;

/* ── Input events ───────────────────────────────────────── */
inputEl.addEventListener('input', () => {
  clearBtn.style.display = inputEl.value.length > 0 ? 'flex' : 'none';
});
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') handleCheck(); });
clearBtn.addEventListener('click', () => {
  inputEl.value = ''; clearBtn.style.display = 'none';
  inputEl.focus(); hideError(); hideResult(); resetEstimator();
});
checkBtn.addEventListener('click', handleCheck);

/* ── Main handler ───────────────────────────────────────── */
async function handleCheck() {
  const raw = inputEl.value.trim();
  if (!raw) { showError('Please enter a FID or @username.'); return; }

  setLoading(true); hideError(); hideResult();

  try {
    const fid = await resolveFID(raw);
    if (!fid) {
      showError('User not found. Check the FID or username and try again.');
      setLoading(false); return;
    }

    const [profile, allocation] = await Promise.all([
      fetchProfile(fid),
      fetchAllocation(fid),
    ]);

    if (!allocation) {
      showError('Could not retrieve allocation data. Try again in a moment.');
      setLoading(false); return;
    }

    renderResult({ fid, profile, allocation });
    updateEstimator(allocation);
    lastResult = { fid, profile, allocation };

  } catch (err) {
    console.error(err);
    showError('Something went wrong. Please try again.');
  }

  setLoading(false);
}

/* ── FID resolver — 3-strategy ──────────────────────────── */
async function resolveFID(input) {
  const cleaned = input.replace(/^@/, '').trim();
  if (/^\d+$/.test(cleaned)) return parseInt(cleaned, 10);

  const candidates = new Set([cleaned]);
  const stripped = cleaned.replace(/\.(eth|xyz|id|cast|fc)$/i, '');
  if (stripped !== cleaned) candidates.add(stripped);
  if (!cleaned.includes('.')) candidates.add(cleaned + '.eth');

  for (const name of candidates) {
    const fid1 = await hubProofLookup(name);
    if (fid1) return fid1;
    const fid2 = await fnamesLookup(name);
    if (fid2) return fid2;
  }
  return null;
}

async function hubProofLookup(username) {
  try {
    const res = await cfetch(`https://hub.pinata.cloud/v1/userNameProofByName?name=${encodeURIComponent(username)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.fid || null;
  } catch { return null; }
}

async function fnamesLookup(username) {
  try {
    const res = await cfetch(`https://fnames.farcaster.xyz/transfers?name=${encodeURIComponent(username)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const t = data.transfers;
    if (!t || t.length === 0) return null;
    const mint = t.find(x => x.from === 0);
    return mint ? mint.to : (t[t.length - 1].to || null);
  } catch { return null; }
}

/* ── Profile fetcher ────────────────────────────────────── */
async function fetchProfile(fid) {
  const p = { displayName: '', username: '', pfp: '', bio: '' };
  try {
    const res = await cfetch(`https://hub.pinata.cloud/v1/userDataByFid?fid=${fid}`);
    if (!res.ok) return p;
    const data = await res.json();
    for (const msg of (data.messages || [])) {
      const body = msg.data?.userDataBody;
      if (!body) continue;
      switch (body.type) {
        case 'USER_DATA_TYPE_DISPLAY': p.displayName = body.value; break;
        case 'USER_DATA_TYPE_USERNAME': p.username = body.value; break;
        case 'USER_DATA_TYPE_PFP': p.pfp = body.value; break;
        case 'USER_DATA_TYPE_BIO': p.bio = body.value; break;
      }
    }
    if (!p.username) {
      const r2 = await cfetch(`https://fnames.farcaster.xyz/transfers?fid=${fid}`);
      if (r2.ok) {
        const d2 = await r2.json();
        const mint = (d2.transfers || []).find(x => x.from === 0);
        if (mint) p.username = mint.username;
      }
    }
  } catch { /* show what we have */ }
  return p;
}

/* ── Allocation fetcher ─────────────────────────────────── */
async function fetchAllocation(fid) {
  const res = await cfetch(`https://airdrop.onchain.cooking/snap/airdrop?fid=${fid}`);
  if (!res.ok) return null;
  const data = await res.json();
  const elements = data?.ui?.elements;
  if (!elements) return null;
  return elements['allocation-value']?.props?.content || null;
}

/* ── Render result card ─────────────────────────────────── */
function renderResult({ fid, profile, allocation }) {
  const pfpEl = $('result-pfp');
  const pfpHolder = $('result-pfp-placeholder');
  const displayEl = $('result-display');
  const usernameEl = $('result-username');
  const fidEl = $('result-fid');
  const amountEl = $('amount-number');
  const warpLink = $('farcaster-link');

  if (profile.pfp) {
    pfpEl.src = profile.pfp;
    pfpEl.style.display = 'block';
    pfpHolder.style.display = 'none';
    pfpEl.onerror = () => { pfpEl.style.display = 'none'; pfpHolder.style.display = 'flex'; };
  } else {
    pfpEl.style.display = 'none';
    pfpHolder.style.display = 'flex';
  }

  displayEl.textContent = profile.displayName || profile.username || `FID ${fid}`;
  usernameEl.textContent = profile.username ? `@${profile.username}` : '';
  fidEl.textContent = `FID: ${fid}`;

  amountEl.textContent = '';
  animateNumber(amountEl, allocation);

  const handle = profile.username || '';
  warpLink.href = handle
    ? `https://farcaster.xyz/${handle}`
    : `https://farcaster.xyz/~/profiles/${fid}`;

  showResult();
}

/* ── Token Value Estimator ──────────────────────────────── */
function updateEstimator(allocationStr) {
  const amount = parseFloat(allocationStr.replace(/,/g, ''));
  if (isNaN(amount)) return;

  $('est-alloc-num').textContent = `${allocationStr} HSNAP`;

  const rowsEl = $('est-rows');
  rowsEl.innerHTML = '';

  for (const { label, fdv, highlight } of FDV_LEVELS) {
    const tokenPrice = fdv / TOTAL_SUPPLY;
    const value = amount * tokenPrice;

    const tierMap = { '$50M': 'tier-silver', '$100M': 'tier-gold', '$1B': 'tier-diamond' };
    const tierClass = tierMap[label] || '';
    const row = document.createElement('div');
    row.className = 'est-row' + (highlight ? ' highlight' : '') + (tierClass ? ' ' + tierClass : '');
    row.innerHTML = `
      <span class="est-fdv">${label}</span>
      <span class="est-price">${fmtTokenPrice(tokenPrice)}</span>
      <span class="est-value-cell">${fmtUSD(value)}</span>
    `;
    rowsEl.appendChild(row);
  }

  $('est-empty').style.display = 'none';
  $('est-content').style.display = 'flex';
}

function resetEstimator() {
  $('est-empty').style.display = 'flex';
  $('est-content').style.display = 'none';
  $('est-rows').innerHTML = '';
}

/* ── Formatters ─────────────────────────────────────────── */
function fmtTokenPrice(price) {
  if (price < 0.000001) return `$${price.toExponential(2)}`;
  if (price < 0.0001) return `$${price.toFixed(7)}`;
  if (price < 0.01) return `$${price.toFixed(5)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function fmtUSD(value) {
  if (value < 0.01) return '< $0.01';
  if (value < 1000) return `$${value.toFixed(2)}`;
  if (value < 1_000_000) return `$${(value / 1000).toFixed(2)}K`;
  return `$${(value / 1_000_000).toFixed(2)}M`;
}

/* ── Animated number counter ────────────────────────────── */
function animateNumber(el, formattedStr) {
  const raw = parseFloat(formattedStr.replace(/,/g, ''));
  if (isNaN(raw)) { el.textContent = formattedStr; return; }
  const duration = 900;
  const start = performance.now();
  const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  function step(now) {
    const p = Math.min((now - start) / duration, 1);
    el.textContent = fmt.format(easeOutExpo(p) * raw);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = formattedStr;
  }
  requestAnimationFrame(step);
}
function easeOutExpo(t) { return t === 1 ? 1 : 1 - Math.pow(2, -10 * t); }

/* ── Share / Copy ───────────────────────────────────────── */
shareBtn.addEventListener('click', () => {
  if (!lastResult) return;
  const { fid, profile, allocation } = lastResult;
  const name = profile.displayName || profile.username || `FID ${fid}`;
  const text = `${name}'s estimated Farcaster Protocol retro rewards: ${allocation} HSNAP tokens 🎉\n\nCheck yours 👇\nhttps://airdrop.onchain.cooking/snap/airdrop?fid=${fid}`;
  navigator.clipboard.writeText(text)
    .then(() => showToast('✓ Copied to clipboard!'))
    .catch(() => showToast('Copy failed — please copy manually.'));
});

/* ── UI helpers ─────────────────────────────────────────── */
function setLoading(on) {
  checkBtn.disabled = on;
  $('btn-text').style.display = on ? 'none' : 'inline';
  $('btn-icon').style.display = on ? 'none' : 'inline';
  $('btn-loader').style.display = on ? 'inline-flex' : 'none';
}
function showError(msg) { errorMsg.textContent = msg; errorCard.style.display = 'flex'; }
function hideError() { errorCard.style.display = 'none'; }
function showResult() {
  resultCard.style.display = 'flex';
  const filler = $('left-filler');
  if (filler) filler.style.display = 'none'; // hide when result fills the space
}
function hideResult() {
  resultCard.style.display = 'none';
  const filler = $('left-filler');
  if (filler) filler.style.display = 'flex'; // restore filler
}
function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add('hide');
    t.addEventListener('animationend', () => t.remove());
  }, 2800);
}

/* ================================================================
   PARTICLE CANVAS — ambient flow + click burst + ripple rings
   ================================================================ */
(function initParticles() {
  // Create & mount canvas
  const canvas = document.createElement('canvas');
  canvas.id = 'particle-canvas';
  document.body.insertBefore(canvas, document.body.firstChild);
  const ctx = canvas.getContext('2d');

  let W, H;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  // Palette (matches CSS vars)
  const COLS = [
    [124, 92, 252],   // accent purple
    [167, 139, 250],   // light purple
    [34, 211, 165],   // green
    [245, 194, 66],    // gold
    [14, 165, 233],   // sky blue
  ];
  const rndCol = () => COLS[Math.floor(Math.random() * COLS.length)];

  /* ── Particle ───────────────────────────────── */
  class Particle {
    constructor(x, y, mode) {
      this.x = x; this.y = y; this.mode = mode;
      this.col = rndCol();

      if (mode === 'click') {
        const angle = Math.random() * Math.PI * 2;
        const spd = Math.random() * 4 + 1.5;
        this.vx = Math.cos(angle) * spd;
        this.vy = Math.sin(angle) * spd;
        this.r = Math.random() * 3.5 + 1.5;
        this.life = 1;
        this.decay = Math.random() * 0.022 + 0.014;
      } else {
        // ambient — gentle drift
        this.vx = (Math.random() - 0.5) * 0.5;
        this.vy = -(Math.random() * 0.4 + 0.05); // drift upward
        this.r = Math.random() * 1.8 + 0.4;
        this.life = Math.random();                // stagger starts
        this.decay = Math.random() * 0.0025 + 0.001;
      }
      this.initLife = this.life;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.life -= this.decay;
      if (this.mode === 'click') {
        this.vx *= 0.965;
        this.vy *= 0.965;
      }
    }

    draw() {
      const a = Math.max(0, this.life / this.initLife);
      const [r, g, b] = this.col;

      // Core dot
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${a * 0.85})`;
      ctx.fill();

      // Soft glow halo (click particles only)
      if (this.mode === 'click') {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${a * 0.12})`;
        ctx.fill();
      }
    }

    dead() {
      return this.life <= 0 ||
        this.x < -60 || this.x > W + 60 ||
        this.y < -60 || this.y > H + 60;
    }
  }

  /* ── Ripple ring ─────────────────────────────── */
  class Ripple {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.radius = 4;
      this.maxR = 90 + Math.random() * 40;
      this.col = rndCol();
      this.alpha = 0.9;
    }
    update() {
      this.radius += 2.8;
      this.alpha = Math.max(0, 1 - this.radius / this.maxR);
    }
    draw() {
      if (this.alpha <= 0.01) return;
      const [r, g, b] = this.col;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},${this.alpha * 0.65})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    dead() { return this.alpha <= 0.01; }
  }

  /* ── State ──────────────────────────────────── */
  let particles = [];
  let ripples = [];
  const AMBIENT_COUNT = 55;

  // Seed initial ambient particles across the whole screen
  for (let i = 0; i < AMBIENT_COUNT; i++) {
    const p = new Particle(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 'ambient');
    p.life = Math.random() * p.initLife; // random phase
    particles.push(p);
  }

  /* ── Click handler ──────────────────────────── */
  document.addEventListener('click', e => {
    // Burst particles
    for (let i = 0; i < 28; i++) {
      particles.push(new Particle(e.clientX, e.clientY, 'click'));
    }
    // Two concentric ripple rings with slight delay
    ripples.push(new Ripple(e.clientX, e.clientY));
    setTimeout(() => ripples.push(new Ripple(e.clientX, e.clientY)), 120);
  });

  /* ── Main loop ──────────────────────────────── */
  function loop() {
    ctx.clearRect(0, 0, W, H);

    // Replenish ambient particles from random screen edges
    const ambientAlive = particles.filter(p => p.mode === 'ambient').length;
    for (let i = ambientAlive; i < AMBIENT_COUNT; i++) {
      const edge = Math.floor(Math.random() * 4);
      let x, y;
      if (edge === 0) { x = Math.random() * W; y = H + 8; }
      else if (edge === 1) { x = -8; y = Math.random() * H; }
      else if (edge === 2) { x = W + 8; y = Math.random() * H; }
      else { x = Math.random() * W; y = -8; }
      particles.push(new Particle(x, y, 'ambient'));
    }

    // Update + draw ripples
    ripples = ripples.filter(r => !r.dead());
    ripples.forEach(r => { r.update(); r.draw(); });

    // Update + draw particles
    particles = particles.filter(p => !p.dead());
    particles.forEach(p => { p.update(); p.draw(); });

    requestAnimationFrame(loop);
  }

  loop();
})();

