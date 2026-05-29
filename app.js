const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQhA5Pgw2DjeL_JLpWHruLvV9bMs5Wk2IFU-FA1C5AFUFWkql48YxoS8fVb1ueuaeeG_PwIrFtTjyhi/pub?output=csv';
let rawData = [];
let isFilterOpen = true;
let currentStatsType = 'group';
let viewMode = 'mobile';
let chartMode = 'meter';
let demandChartInstance = null;
let recChartInstance = null;
let currentRecModalSpecId = null;
let currentChartTimeframe = 'all';
const filterFields = ['Wildth', 'Denia', 'Frequency', 'Pattern'];

const parseNum = (v) => parseFloat(String(v || '0').replace(/,/g, '')) || 0;

// Safe serialiser for onclick attribute arguments — prevents JS/HTML injection
const jsArg = v => JSON.stringify(v).replace(/"/g, '&quot;');

function showToast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

const METERS_PER_MC_PER_DAY = 2500;

function getMinMaxCtrl(jobs) {
    if (!jobs || jobs.length === 0) return { hasMinMaxCtrl: false, minLimit: 0, maxLimit: 0, midPoint: 0 };
    const rawMinStr = String(jobs[0]['Min'] || jobs[0]['min'] || '').trim();
    const rawMaxStr = String(jobs[0]['Max'] || jobs[0]['max'] || '').trim();
    const hasMinMaxCtrl = rawMinStr !== '' || rawMaxStr !== '';
    const minLimit = hasMinMaxCtrl ? parseNum(rawMinStr) : 0;
    const maxLimit = hasMinMaxCtrl ? parseNum(rawMaxStr) : 0;
    return { hasMinMaxCtrl, minLimit, maxLimit, midPoint: (minLimit + maxLimit) / 2 };
}

function getControlStrategyTag({ hasMinMaxCtrl, minLimit, maxLimit }) {
    return hasMinMaxCtrl
        ? `<span class="text-[8px] bg-slate-700 text-white px-2 py-0.5 rounded-full font-bold shadow-inner">Min/Max Ctrl (${minLimit.toLocaleString()}-${maxLimit.toLocaleString()})</span>`
        : `<span class="text-[8px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold shadow-inner">By Order</span>`;
}

function calcLeadTimeDays(jobs) {
    const today = new Date();
    const validJobs = jobs.filter(j => j._dateObj.getFullYear() !== 2099);
    const finalDate = validJobs.length > 0 ? new Date(Math.max(...validJobs.map(j => j._dateObj))) : today;
    return Math.max(1, Math.ceil((finalDate - today) / (1000 * 3600 * 24)));
}

const dateParser = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string' || dateStr.trim() === '' || dateStr === '-') return new Date(2099, 11, 31);
    const cleanStr = dateStr.trim().split(' ')[0];
    const parts = cleanStr.split(/[\/\-\.]/);
    if (parts.length < 3) return new Date(2099, 11, 31);
    let d, m, y;
    if (parts[2].length === 4) { d = parseInt(parts[0]); m = parseInt(parts[1]) - 1; y = parseInt(parts[2]); }
    else if (parts[0].length === 4) { y = parseInt(parts[0]); m = parseInt(parts[1]) - 1; d = parseInt(parts[2]); }
    if (y > 2400) y -= 543;
    const dateObj = new Date(y, m, d);
    return isNaN(dateObj.getTime()) ? new Date(2099, 11, 31) : dateObj;
};

const formatDateDisplay = (dateObj) => {
    if (dateObj.getFullYear() === 2099) return { text: "-", label: "", diff: 999 };
    const d = String(dateObj.getDate()).padStart(2, '0');
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(dateObj); target.setHours(0, 0, 0, 0);
    const diffDays = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
    let label = diffDays === 0 ? "(วันนี้)" : (diffDays > 0 ? `(${diffDays} วัน)` : `(${Math.abs(diffDays)} วันก่อน)`);
    return { text: `${d}/${m}`, label, diff: diffDays };
};

const getBalanceColorClass = (val) => {
    if (val < 0) return 'text-rose-400';
    if (val <= 2500) return 'text-orange-400';
    return 'text-emerald-400';
};

async function refreshData(callback) {
    const menuIcon = document.getElementById('refresh-icon-menu');
    const ledgerIcon = document.getElementById('refresh-icon-ledger');
    [menuIcon, ledgerIcon].forEach(i => i?.classList.add('animate-spin'));

    Papa.parse(CSV_URL, {
        download: true, header: true, skipEmptyLines: true,
        complete: (results) => {
            rawData = results.data.filter(r => r['Weaving Item'] || r['เลขที่ CO']).map(row => {
                const cleanRow = {};
                Object.keys(row).forEach(k => {
                    // Strip zero-width spaces, thin spaces, and trim normal spaces
                    const cleanKey = k.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                    cleanRow[cleanKey] = row[k];
                });
                const dateObj = dateParser(cleanRow['วันขึ้นของ']);
                return { ...cleanRow, _sortDate: dateObj.getTime(), _dateObj: dateObj };
            });

            // Clear caches so they will be rebuilt on the next render
            window.fabricCache = {};
            _fabricSearchIndex = null;

            updateFilters();
            const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            document.getElementById('sync-time-menu').textContent = now;
            const elLedgerTime = document.getElementById('sync-time-ledger');
            if (elLedgerTime) elLedgerTime.textContent = now;
            [menuIcon, ledgerIcon].forEach(i => i?.classList.remove('animate-spin'));
            if (callback) callback();
        }
    });
}

// Yield to the browser so it can repaint the progress bar between steps
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

window.preloadComplete = false; // Guard: must be true before app is usable

async function parseAndCleanRows(results, setProgress) {
    // STEP A: Clean & parse rows
    setProgress(62, 'ทำความสะอาดข้อมูล...');
    await frame();
    rawData = results.data
        .filter(r => r['Weaving Item'] || r['เลขที่ CO'])
        .map(row => {
            const cleanRow = {};
            Object.keys(row).forEach(k => {
                const cleanKey = k.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                cleanRow[cleanKey] = row[k];
            });
            const dateObj = dateParser(cleanRow['วันขึ้นของ']);
            return { ...cleanRow, _sortDate: dateObj.getTime(), _dateObj: dateObj };
        });
    console.log(`[Preload] Step A: ${rawData.length} rows cleaned`);

    // STEP B: Build filters (unique values for dropdowns)
    setProgress(70, `สร้าง Index (${rawData.length.toLocaleString()} แถว)...`);
    await frame();
    updateFilters();
    console.log('[Preload] Step B: Filters built');

    // STEP C: Build fabric index (group rows by Weaving Item)
    setProgress(78, 'จัดกลุ่ม Fabric Spec...');
    await frame();
    window.fabricCache = {};
    rawData.forEach(item => {
        const fid = item['Weaving Item'] || 'Unknown';
        if (!window.fabricCache[fid]) {
            window.fabricCache[fid] = {
                id: fid,
                desc: item['Description'] || '-',
                group: (item['ItemGroup'] || '-').trim(),
                start: parseNum(item['Stock ยกมา']),
                final: 0, jobs: [], maxMc: 0,
                runSim: null, plants: new Set(), salesSet: new Set()
            };
        }
        const f = window.fabricCache[fid];
        f.jobs.push(item);
        const plant = (item['Plant'] || item['plant'] || item[' โรงงาน'] || '-').trim();
        const sales = (item['ฝ่ายขาย'] || item[' ฝ่ายขาย'] || '-').trim();
        if (plant && plant !== '-') f.plants.add(plant);
        if (sales && sales !== '-') f.salesSet.add(sales);
    });
    const fabKeys = Object.keys(window.fabricCache);
    console.log(`[Preload] Step C: ${fabKeys.length} fabric specs indexed`);

    // STEP D: Sort jobs + compute final balance per spec
    setProgress(85, `เรียงลำดับ ${fabKeys.length} สเปก...`);
    await frame();
    fabKeys.forEach(fid => {
        const f = window.fabricCache[fid];
        f.jobs.sort((a, b) => a._sortDate - b._sortDate);
        f.final = parseNum(f.jobs[f.jobs.length - 1]['Stock คงเหลือ']);
        f.maxMc = Math.max(...f.jobs.map(j => parseNum(j['เกิดจริง'])), 0);
        f.plants = Array.from(f.plants);
        f.salesSet = Array.from(f.salesSet);
    });
    console.log('[Preload] Step D: Sort + balance done');

    // STEP E: Running Balance simulation (heaviest step)
    setProgress(91, `คำนวณ Running Balance (${fabKeys.length} สเปก)...`);
    await frame();
    fabKeys.forEach(fid => {
        const f = window.fabricCache[fid];
        f.runSim = calculateDailyRunningBalance(f.jobs, f.start, f.maxMc, null);
    });
    console.log('[Preload] Step E: Running Balance simulation done');

    // STEP F: Sync time display
    setProgress(97, 'เตรียม Dashboard...');
    await frame();
    const now = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    ['sync-time-menu', 'sync-time-ledger'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = now;
    });
    console.log('[Preload] Step F: Dashboard ready');
}

async function initWithLoading(mode) {
    window.preloadComplete = false;

    // Show loading screen, hide all pages
    const allPages = ['page-start', 'page-loading', 'page-menu', 'page-fabric-check',
        'page-usage-stats', 'page-rec-role-select', 'page-stock-recommend', 'page-rec-spec-detail'];
    allPages.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.remove('page-active'); el.classList.add('hidden'); }
    });
    const loadingPage = document.getElementById('page-loading');
    if (loadingPage) {
        loadingPage.classList.remove('hidden');
        loadingPage.classList.add('flex', 'page-active');
    }
    if (mode) { viewMode = mode; document.body.className = `view-${mode}`; }

    const bar = document.getElementById('loading-progress-bar');
    const txt = document.getElementById('loading-status-text');
    const setProgress = (pct, msg) => {
        if (bar) bar.style.width = pct + '%';
        if (txt) txt.textContent = msg;
        console.log(`[Preload] ${pct}% — ${msg}`);
    };

    setProgress(5, 'เริ่มต้นระบบ...');
    await frame();

    const papaFetch = (url) => new Promise((resolve, reject) => {
        Papa.parse(url, {
            download: true, header: true, skipEmptyLines: true,
            complete: resolve, error: reject
        });
    });

    let source = '';
    try {
        setProgress(20, 'เชื่อมต่อ Google Sheets...');
        await frame();
        const results = await papaFetch(CSV_URL);
        setProgress(55, 'ดาวน์โหลดสำเร็จ กำลังตรวจสอบ...');
        await frame();
        if (!results.data || results.data.length < 2) throw new Error('Empty response from Google Sheets');
        await parseAndCleanRows(results, setProgress);
        source = 'Live Sheet';

    } catch (liveErr) {
        console.warn('[Preload] Google Sheets failed, trying local data.csv:', liveErr.message);
        try {
            setProgress(35, 'ใช้ไฟล์สำรอง (data.csv)...');
            await frame();
            const results = await papaFetch('data.csv');
            setProgress(55, 'ไฟล์สำรองโหลดสำเร็จ...');
            await frame();
            if (!results.data || results.data.length < 2) throw new Error('data.csv also empty or missing');
            await parseAndCleanRows(results, setProgress);
            source = 'ไฟล์สำรอง';

        } catch (localErr) {
            console.error('[Preload] Both sources failed:', localErr);
            if (bar) { bar.style.width = '40%'; bar.style.backgroundImage = 'linear-gradient(to right,#f43f5e,#e11d48)'; }
            if (txt) txt.textContent = 'โหลดข้อมูลไม่สำเร็จ — ไม่พบไฟล์ข้อมูล';
            if (!document.getElementById('preload-retry-container')) {
                loadingPage.insertAdjacentHTML('beforeend',
                    `<div id="preload-retry-container" class="mt-8 relative z-10 flex flex-col items-center gap-3">
                        <p class="text-xs text-slate-400">Google Sheets: CORS blocked &bull; data.csv: not found</p>
                        <button onclick="initWithLoading(${jsArg(mode)})" class="px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-white font-bold rounded-xl shadow-lg">
                            ลองใหม่อีกครั้ง
                        </button>
                    </div>`);
            }
            return; // ❌ GUARD: do NOT navigate
        }
    }

    // ✅ All steps verified complete — mark and navigate
    window.preloadComplete = true;
    console.log(`[Preload] ✅ Complete! ${rawData.length} rows, ${Object.keys(window.fabricCache).length} specs — source: ${source}`);
    setProgress(100, `โหลดสำเร็จ ✓  ${rawData.length.toLocaleString()} รายการ • ${source}`);
    await new Promise(r => setTimeout(r, 800));
    navigate('menu');
}


function navigate(pageId, mode) {
    if (mode) { viewMode = mode; document.body.className = `view-${mode}`; }
    const sections = ['page-start', 'page-loading', 'page-menu', 'page-fabric-check', 'page-usage-stats', 'page-rec-role-select', 'page-stock-recommend', 'page-rec-spec-detail'];
    sections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.replace('page-active', 'hidden');
    });
    document.getElementById(`page-${pageId}`).classList.replace('hidden', 'page-active');
    if (pageId === 'menu' && rawData.length === 0) refreshData(); // fallback only if navigated directly
    if (pageId === 'usage-stats') { showStatsMain(); renderUsageStats(); }
    if (pageId === 'stock-recommend') renderStockRecommendations();
    lucide.createIcons();
    window.scrollTo(0, 0);
}

function toggleFilters() {
    const container = document.getElementById('filter-container');
    const text = document.getElementById('filter-status-text');
    isFilterOpen = !isFilterOpen;
    container.style.maxHeight = isFilterOpen ? '600px' : '0px';
    container.style.opacity = isFilterOpen ? '1' : '0';
    text.textContent = isFilterOpen ? 'ซ่อนตัวกรอง' : 'แสดงตัวกรอง';
}

function closeFiltersOnSearch() { if (isFilterOpen) toggleFilters(); }

function updateFilters() {
    const selections = {};
    filterFields.forEach(f => {
        const el = document.getElementById(getFieldId(f));
        if (el) selections[f] = el.value;
    });

    filterFields.forEach(field => {
        const sel = document.getElementById(getFieldId(field));
        if (!sel) return;
        const currentVal = sel.value;
        const filteredSubset = rawData.filter(item => {
            return filterFields.every(f => {
                const el = document.getElementById(getFieldId(f));
                if (!el || f === field || el.value === "" || el.value === "ทั้งหมด") return true;
                return String(item[f]) === el.value;
            });
        });
        const uniqueValues = [...new Set(filteredSubset.map(item => String(item[field] || '').trim()))].filter(v => v !== '').sort((a, b) => parseFloat(a) - parseFloat(b));
        sel.innerHTML = `<option value="ทั้งหมด">-- ${field} --</option>` + uniqueValues.map(v => `<option value="${v}" ${v === currentVal ? 'selected' : ''}>${v}</option>`).join('');
    });
}

function getFieldId(f) {
    return f === 'Wildth' ? 'sel-width' : f === 'Denia' ? 'sel-denia' : f === 'Frequency' ? 'sel-frequency' : 'sel-pattern';
}

function processLedger() {
    const selections = {};
    filterFields.forEach(f => selections[f] = document.getElementById(getFieldId(f)).value);
    const results = rawData.filter(item => {
        return filterFields.every(f => {
            if (selections[f] === "ทั้งหมด" || !selections[f]) return true;
            return String(item[f]) === selections[f];
        });
    });
    results.sort((a, b) => a._sortDate - b._sortDate);
    renderLedger(results);
    document.getElementById('result-view').classList.remove('hidden');
}

function renderLedger(items) {
    const body = document.getElementById('ledger-body');
    if (items.length === 0) {
        body.innerHTML = `<tr><td colspan="5" class="text-center py-20 text-slate-300 italic font-bold">ไม่พบข้อมูลตามเงื่อนไข</td></tr>`;
        return;
    }
    const first = items[0];
    const maxActualMc = Math.max(...items.map(i => parseNum(i['เกิดจริง'])), 0);
    const maxTargetMc = Math.max(...items.map(i => parseNum(i['ต้องการ'])), 0);
    const totalRequired = items.reduce((sum, i) => sum + parseNum(i['ใช้ผ้า']), 0);
    const finalBalance = parseNum(items[items.length - 1]['Stock คงเหลือ']);

    document.getElementById('dash-item-code').textContent = `#${first['Weaving Item'] || 'N/A'}`;
    document.getElementById('dash-total-stock').textContent = parseNum(items[0]['Stock ยกมา']).toLocaleString();
    document.getElementById('dash-actual-mc').textContent = maxActualMc.toLocaleString();
    document.getElementById('dash-target-mc').textContent = maxTargetMc.toLocaleString();
    document.getElementById('dash-capacity').textContent = `${(maxActualMc * METERS_PER_MC_PER_DAY).toLocaleString()} ม.`;
    document.getElementById('dash-required').textContent = totalRequired.toLocaleString();
    document.getElementById('dash-final-balance').textContent = finalBalance.toLocaleString();

    body.innerHTML = items.map(item => {
        const d = formatDateDisplay(item._dateObj);
        const rm = parseNum(item['Stock คงเหลือ']);
        return `
            <tr class="hover:bg-slate-50/50 transition-colors group">
                <td class="py-3 px-2 font-bold text-[10px] align-top whitespace-nowrap">
                    <span class="${d.diff < 0 ? 'text-rose-600 underline' : 'text-emerald-700'}">${d.text}</span>
                    <span class="block text-[8px] text-slate-400 mt-0.5">${d.label}</span>
                </td>
                <td class="py-3 px-2 align-top">
                    <span class="text-[11px] font-black text-slate-700 font-jakarta line-clamp-2 leading-tight">${item['Description'] || '-'}</span>
                    <div class="flex flex-wrap items-center gap-1.5 mt-1 opacity-60 group-hover:opacity-100 transition-opacity">
                        <span class="text-[8px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded leading-none shrink-0">${item['ฝ่ายขาย'] || 'N/A'}</span>
                        <span class="text-[8px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded leading-none shrink-0">${item['Item']}</span>
                        <span class="text-[8px] italic text-slate-400 leading-none shrink-0">${item['Name'] || '-'}</span>
                    </div>
                </td>
                <td class="py-3 text-right px-2 text-slate-400 font-jakarta font-bold text-[10px] align-top">${parseNum(item['Stock ยกมา']).toLocaleString()}</td>
                <td class="py-3 text-right px-2 font-black text-orange-500 font-jakarta text-[10px] align-top">-${parseNum(item['ใช้ผ้า']).toLocaleString()}</td>
                <td class="py-3 text-right px-2 font-black ${getBalanceColorClass(rm)} font-jakarta text-[10px] align-top">${rm.toLocaleString()}</td>
            </tr>
        `;
    }).join('');
    lucide.createIcons();

    // Draw the Running Balance chart for this filtered result
    drawLedgerChart(items);
}

// ============================================================
//  FUZZY SEARCH FOR WEAVING ITEM (page-fabric-check)
// ============================================================

let ledgerChartInstance = null;
let ledgerChartTf = 'all';
let _lastLedgerItems = [];
let _fabricSearchIndex = null;

function getFabricSearchIndex() {
    if (_fabricSearchIndex) return _fabricSearchIndex;
    const items = {};
    rawData.forEach(r => {
        const id = (r['Weaving Item'] || '').trim();
        if (!id) return;
        if (!items[id]) items[id] = { desc: r['Description'] || '', group: r['ItemGroup'] || '' };
    });
    _fabricSearchIndex = Object.entries(items);
    return _fabricSearchIndex;
}

// Simple fuzzy score: boost consecutive matches, penalise gaps
function fuzzyScore(needle, haystack) {
    const n = needle.toLowerCase();
    const h = haystack.toLowerCase();
    if (h.includes(n)) return 200 + (100 - h.length); // exact substring
    let score = 0, hi = 0;
    for (let ni = 0; ni < n.length; ni++) {
        const found = h.indexOf(n[ni], hi);
        if (found === -1) return 0; // required char missing
        score += Math.max(0, 10 - (found - hi)); // reward proximity
        hi = found + 1;
    }
    return score;
}

function handleFabricSearch(val) {
    const sugg = document.getElementById('fabric-search-suggestions');
    const clearBtn = document.getElementById('fabric-search-clear');
    clearBtn.classList.toggle('hidden', !val);
    if (!val || val.length < 1) { sugg.classList.add('hidden'); return; }

    // Score against cached index (built once per data load)
    const scored = getFabricSearchIndex()
        .map(([id, info]) => {
            const s1 = fuzzyScore(val, id);
            const s2 = fuzzyScore(val, info.desc) * 0.6;
            return { id, desc: info.desc, group: info.group, score: Math.max(s1, s2) };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

    if (scored.length === 0) {
        sugg.innerHTML = `<div class="px-4 py-3 text-[11px] text-slate-400 italic">ไม่พบรายการที่ใกล้เคียง "ภาษาไทย ${val}"</div>`;
        sugg.classList.remove('hidden');
        return;
    }

    sugg.innerHTML = scored.map((x, i) => `
        <button onclick="selectFabricItem(${jsArg(x.id)})"
            class="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-emerald-50 transition-colors border-b border-slate-50 last:border-0 group">
            <span class="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-600 text-[9px] font-black flex items-center justify-center shrink-0">${i + 1}</span>
            <div class="min-w-0">
                <span class="block text-[11px] font-black text-slate-800 group-hover:text-emerald-700 truncate">${x.id}</span>
                <span class="block text-[9px] text-slate-400 truncate">${x.desc} ${x.group ? '• ' + x.group : ''}</span>
            </div>
            <i data-lucide="chevron-right" class="w-3 h-3 text-slate-300 group-hover:text-emerald-400 ml-auto shrink-0"></i>
        </button>
    `).join('');
    sugg.classList.remove('hidden');
    lucide.createIcons();
}

function selectFabricItem(itemId) {
    const input = document.getElementById('fabric-search-input');
    const sugg = document.getElementById('fabric-search-suggestions');
    input.value = itemId;
    sugg.classList.add('hidden');
    document.getElementById('fabric-search-clear').classList.remove('hidden');

    // Filter rawData for this specific Weaving Item and render
    const results = rawData.filter(r => (r['Weaving Item'] || '').trim() === itemId);
    results.sort((a, b) => a._sortDate - b._sortDate);
    renderLedger(results);
    document.getElementById('result-view').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearFabricSearch() {
    const input = document.getElementById('fabric-search-input');
    input.value = '';
    document.getElementById('fabric-search-suggestions').classList.add('hidden');
    document.getElementById('fabric-search-clear').classList.add('hidden');
    input.focus();
}

// Close suggestions on outside click
document.addEventListener('click', e => {
    if (!e.target.closest('#fabric-search-wrapper')) {
        document.getElementById('fabric-search-suggestions')?.classList.add('hidden');
    }
});

// ============================================================
//  RUNNING BALANCE CHART for page-fabric-check
// ============================================================

function setLedgerChartTf(tf) {
    ledgerChartTf = tf;
    document.querySelectorAll('.ltf-btn').forEach(b => {
        b.classList.remove('bg-emerald-100', 'text-emerald-700', 'shadow-sm');
        b.classList.add('text-slate-500');
    });
    const active = document.getElementById(`ltf-${tf}`);
    if (active) {
        active.classList.remove('text-slate-500');
        active.classList.add('bg-emerald-100', 'text-emerald-700', 'shadow-sm');
    }
    if (_lastLedgerItems.length > 0) drawLedgerChart(_lastLedgerItems);
}

function drawLedgerChart(items) {
    _lastLedgerItems = items;
    const section = document.getElementById('ledger-chart-section');
    if (!items || items.length === 0) { section.classList.add('hidden'); return; }

    // Reuse calculateDailyRunningBalance from the recommendation engine
    const startBal = parseNum(items[0]['Stock ยกมา']);
    const maxMc = Math.max(...items.map(i => parseNum(i['เกิดจริง'])), 0);
    const sim = calculateDailyRunningBalance(items, startBal, maxMc, null);
    if (!sim || !sim.timeline || sim.timeline.length === 0) { section.classList.add('hidden'); return; }

    section.classList.remove('hidden');

    let timeline = sim.timeline;
    if (ledgerChartTf !== 'all') timeline = timeline.slice(0, ledgerChartTf);

    const labels = timeline.map(t => `${t.date.getDate()}/${t.date.getMonth() + 1}`);
    const data = timeline.map(t => t.bal);

    const bgColors = data.map(v => v < 0 ? 'rgba(244,63,94,0.18)' : 'rgba(16,185,129,0.15)');

    if (ledgerChartInstance) { ledgerChartInstance.destroy(); ledgerChartInstance = null; }
    const ctx = document.getElementById('ledgerChart').getContext('2d');

    ledgerChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Running Balance',
                data,
                borderColor: ctx2 => {
                    const v = ctx2.p1?.parsed?.y;
                    return v !== undefined && v < 0 ? 'rgb(244,63,94)' : 'rgb(16,185,129)';
                },
                backgroundColor: bgColors,
                borderWidth: 2,
                fill: true,
                stepped: true,
                pointRadius: data.map(v => v < 0 ? 3 : 0),
                pointBackgroundColor: data.map(v => v < 0 ? '#f43f5e' : '#10b981'),
                pointHoverRadius: 5,
                segment: {
                    borderColor: ctx2 => data[ctx2.p1DataIndex] < 0 ? 'rgb(244,63,94)' : 'rgb(16,185,129)'
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx2 => `ยอดคงเหลือ: ${ctx2.raw.toLocaleString()} ม.`,
                        afterBody: ctxs => {
                            const idx = ctxs[0].dataIndex;
                            const pt = sim.timeline[idx];
                            const msgs = [];
                            if (pt?.drain > 0) msgs.push(`🚨 ตัดสต็อก: -${pt.drain.toLocaleString()} ม.`);
                            if (pt?.added > 0) msgs.push(`🏭 เติม: +${pt.added.toLocaleString()} ม.`);
                            return msgs;
                        }
                    }
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(0,0,0,0.04)' },
                    ticks: { font: { family: 'Plus Jakarta Sans', size: 9, weight: 'bold' } }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Kanit', size: 9 }, maxTicksLimit: 14 }
                }
            },
            interaction: { intersect: false, mode: 'index' }
        }
    });
}

// --- OVERALL STATS ENGINE ---
function changeStatsType(type) {
    currentStatsType = type;
    document.querySelectorAll('.stats-tab').forEach(btn => {
        btn.classList.replace('bg-slate-900', 'text-slate-500');
        btn.classList.remove('text-white', 'shadow-sm', 'bg-slate-900');
        btn.classList.add('text-slate-500');
    });
    const activeTab = document.getElementById(`tab-${type}`);
    activeTab.classList.remove('text-slate-500');
    activeTab.classList.add('bg-slate-900', 'text-white', 'shadow-sm');
    showStatsMain();
    renderUsageStats();
}

function toggleChartMode(mode) {
    chartMode = mode;
    const meterBtn = document.getElementById('chart-mode-meter');
    const machineBtn = document.getElementById('chart-mode-machine');
    [meterBtn, machineBtn].forEach(b => {
        b.classList.replace('bg-white', 'text-slate-400');
        b.classList.remove('shadow-sm', 'text-slate-900');
    });
    const activeBtn = document.getElementById(`chart-mode-${mode}`);
    activeBtn.classList.replace('text-slate-400', 'bg-white');
    activeBtn.classList.add('shadow-sm', 'text-slate-900');
    renderUsageStats();
}

function renderUsageStats() {
    const container = document.getElementById('stats-view-main');
    const groups = {};
    let headerName = currentStatsType === 'group' ? "ItemGroup" : (currentStatsType === 'sales' ? "ฝ่ายขาย" : "Name");

    const fabricMcMap = {};
    rawData.forEach(item => {
        const key = item[headerName] || 'ไม่ระบุ';
        const demand = parseNum(item['ใช้ผ้า']);
        const fId = item['Weaving Item'];
        const mcVal = parseNum(item['เกิดจริง']);
        if (!groups[key]) groups[key] = { total: 0, items: 0, mc: 0, fabricList: new Set() };
        groups[key].total += demand;
        groups[key].items += 1;
        groups[key].fabricList.add(fId);
        if (!fabricMcMap[fId]) fabricMcMap[fId] = 0;
        fabricMcMap[fId] = Math.max(fabricMcMap[fId], mcVal);
    });

    Object.keys(groups).forEach(key => {
        let keyMcSum = 0;
        groups[key].fabricList.forEach(fid => keyMcSum += fabricMcMap[fid]);
        groups[key].mc = keyMcSum;
    });

    const sorted = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);
    container.innerHTML = sorted.map(([name, data]) => `
        <div onclick="drilldownGroup(${jsArg(name)})" class="glass-card p-6 active:scale-[0.98] transition-all cursor-pointer group hover:bg-white shadow-md flex flex-col h-full ring-1 ring-slate-100">
            <div class="flex justify-between items-start mb-6">
                <h3 class="font-bold text-slate-800 group-hover:text-emerald-600 transition-colors text-lg uppercase font-jakarta line-clamp-1 leading-none tracking-tight">${name}</h3>
                <span class="text-[9px] bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full font-black italic border border-emerald-100 uppercase tracking-tighter shrink-0">${data.items} รายการ</span>
            </div>
            <div class="mt-auto border-t border-slate-50 pt-5 flex justify-between items-end">
                <div><p class="text-[9px] text-slate-400 font-bold uppercase mb-1 italic">Meters Demand</p><p class="text-2xl font-black text-slate-800 font-jakarta leading-none">${data.total.toLocaleString()}</p></div>
                <div class="text-right"><p class="text-[9px] text-emerald-500 font-bold uppercase mb-1 italic leading-none">Machines</p><p class="text-xl font-black text-emerald-600 font-jakarta leading-none">${data.mc.toLocaleString()}</p></div>
            </div>
        </div>
    `).join('');

    updateStatsChart(sorted.slice(0, 10));
    lucide.createIcons();
}

function updateStatsChart(topData) {
    if (demandChartInstance) demandChartInstance.destroy();
    const ctx = document.getElementById('demandChart').getContext('2d');
    const labels = topData.map(d => d[0]);
    const dataValues = topData.map(d => chartMode === 'meter' ? d[1].total : d[1].mc);
    const color = chartMode === 'meter' ? '#10b981' : '#0ea5e9';

    demandChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                data: dataValues,
                backgroundColor: color,
                borderRadius: 8,
                barThickness: viewMode === 'desktop' ? 30 : 20
            }]
        },
        options: {
            indexAxis: viewMode === 'desktop' ? 'x' : 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                datalabels: {
                    anchor: 'end',
                    align: 'top',
                    formatter: (val) => val.toLocaleString(),
                    font: { weight: '800', size: 10, family: 'Kanit' },
                    color: '#475569'
                }
            },
            scales: {
                y: { grid: { display: false }, ticks: { font: { size: 9, family: 'Kanit' } } },
                x: { grid: { display: false }, ticks: { font: { size: 9, family: 'Kanit' } } }
            }
        },
        plugins: [ChartDataLabels]
    });
}

function drilldownGroup(groupName) {
    document.getElementById('stats-view-main').classList.add('hidden');
    document.getElementById('stats-view-detail').classList.remove('hidden');
    document.getElementById('stats-charts-section').classList.add('hidden');
    document.getElementById('drilldown-group-name').textContent = `${groupName}`;

    let hName = currentStatsType === 'group' ? "ItemGroup" : (currentStatsType === 'sales' ? "ฝ่ายขาย" : "Name");
    const filtered = rawData.filter(i => (i[hName] || 'ไม่ระบุ') === groupName);
    filtered.sort((a, b) => a._sortDate - b._sortDate);

    const fabrics = {};
    filtered.forEach(i => {
        const fid = i['Weaving Item'] || 'Unknown';
        if (!fabrics[fid]) fabrics[fid] = { totalUse: 0, desc: i['Description'], jobs: [], maxMc: 0, finalStock: 0, startStock: 0 };
        fabrics[fid].totalUse += parseNum(i['ใช้ผ้า']);
        fabrics[fid].jobs.push(i);
        fabrics[fid].maxMc = Math.max(fabrics[fid].maxMc, parseNum(i['เกิดจริง']));
        fabrics[fid].startStock = parseNum(fabrics[fid].jobs[0]['Stock ยกมา']);
        fabrics[fid].finalStock = parseNum(i['Stock คงเหลือ']);
    });

    const sorted = Object.entries(fabrics).sort((a, b) => b[1].totalUse - a[1].totalUse);
    const drillContent = document.getElementById('drilldown-content');
    drillContent.className = viewMode === 'desktop' ? "grid grid-cols-2 gap-6 pb-20" : "grid grid-cols-1 gap-4 pb-20";

    drillContent.innerHTML = sorted.map(([id, data]) => {
        const safeId = id.replace(/[^a-zA-Z0-9]/g, '');

        // Add the new Unified Machine Recommendation Logic here
        const sim = calculateDailyRunningBalance(data.jobs, data.startStock, data.maxMc, 'ทั้งหมด');

        const leadTimeDays = calcLeadTimeDays(data.jobs);
        const { hasMinMaxCtrl, minLimit, maxLimit, midPoint } = getMinMaxCtrl(data.jobs);

        let recommendationHtml = '';
        const isShort = hasMinMaxCtrl ? (sim.minBalance < minLimit) : sim.isBottleneck;

        if (isShort) {
            let targetStock = hasMinMaxCtrl ? minLimit : 0;
            const deficit = targetStock - sim.minBalance;
            const extraMcNeeded = Math.ceil(deficit / (METERS_PER_MC_PER_DAY * leadTimeDays));
            recommendationHtml = `
            <div class="mb-5 p-3 rounded-xl bg-rose-50 border border-rose-100 flex items-center gap-3">
                 <div class="bg-white p-2 rounded-lg shadow-sm border border-rose-100 shrink-0">
                      <i data-lucide="alert-triangle" class="w-5 h-5 text-rose-500"></i>
                 </div>
                 <div>
                      <h5 class="text-[10px] font-bold text-rose-700 uppercase tracking-widest mb-0.5">สถานะคิวทอ: วิกฤต</h5>
                      <p class="text-[9px] font-bold text-rose-600/80 leading-tight"> เครื่องรันไม่พอส่ง (เปิดอยู่ ${data.maxMc}) ควรเพิ่มอีก +${extraMcNeeded} เครื่อง สำหรับช่วง ${leadTimeDays} วันนี้</p>
                 </div>
            </div>`;
        } else {
            const isSurplus = hasMinMaxCtrl && maxLimit > 0
                ? (sim.minBalance > midPoint && data.maxMc > 0)
                : (sim.minBalance > 50000 && data.maxMc > 0);
            if (isSurplus) {
                const reduceMc = Math.max(1, Math.min(data.maxMc, Math.ceil((sim.minBalance - midPoint) / (METERS_PER_MC_PER_DAY * leadTimeDays))));
                recommendationHtml = `
                <div class="mb-5 p-3 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center gap-3">
                     <div class="bg-white p-2 rounded-lg shadow-sm border border-emerald-100 shrink-0">
                          <i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-500"></i>
                     </div>
                     <div>
                          <h5 class="text-[10px] font-bold text-emerald-700 uppercase tracking-widest mb-0.5">สถานะคิวทอ: สต็อกเหลือเฟือ</h5>
                          <p class="text-[9px] font-bold text-emerald-600/80 leading-tight"> สามารถดึงเครื่องออกได้ แนะนำลดเครื่องทอลง -${reduceMc} เครื่อง</p>
                     </div>
                </div>`;
            } else if (data.maxMc > 0) {
                recommendationHtml = `
                <div class="mb-5 p-3 rounded-xl bg-sky-50 border border-sky-100 flex items-center gap-3">
                     <div class="bg-white p-2 rounded-lg shadow-sm border border-sky-100 shrink-0">
                          <i data-lucide="activity" class="w-5 h-5 text-sky-500"></i>
                     </div>
                     <div>
                          <h5 class="text-[10px] font-bold text-sky-700 uppercase tracking-widest mb-0.5">สถานะคิวทอ: ปลอดภัย / ปกติ</h5>
                          <p class="text-[9px] font-bold text-sky-600/80 leading-tight"> รอบการผลิตครอบคลุมแล้ว ควรรักษาระดับนี้ไว้ (${hasMinMaxCtrl ? 'คุมด้วย Min/Max' : 'คุมตาม Order/Running Balance'})</p>
                     </div>
                </div>`;
            }
        }

        return `
        <div class="glass-card p-6 bg-white shadow-xl flex flex-col h-full border-slate-200">
            <div class="flex justify-between items-start mb-6 pb-4 border-b border-slate-100">
                <div class="max-w-[70%]">
                    <span class="text-[9px] font-black text-emerald-600 uppercase tracking-widest block leading-none italic mb-1">SPEC ID: ${id}</span>
                    <div class="flex items-center gap-2 mb-1">
                        <h4 class="font-bold text-slate-900 leading-tight text-base uppercase font-jakarta line-clamp-1 py-1 leading-none tracking-tight">${data.desc}</h4>
                        ${hasMinMaxCtrl ? `<span class="text-[8px] whitespace-nowrap bg-slate-700 text-white px-2 py-0.5 rounded-full font-bold shadow-inner">Min/Max Ctrl</span>` : `<span class="text-[8px] whitespace-nowrap bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-bold shadow-inner">By Order</span>`}
                    </div>
                </div>
                <div class="text-right">
                     <p class="text-[8px] text-slate-400 font-bold uppercase italic mb-1 tracking-tighter leading-none">Operating</p>
                     <p class="text-sm font-black text-sky-600 leading-none font-jakarta">${data.maxMc} M/C</p>
                </div>
            </div>
            <div class="grid grid-cols-3 gap-3 mb-6">
                <div class="text-center p-3 rounded-2xl bg-slate-50 border border-slate-100 shadow-inner">
                     <span class="text-[8px] text-slate-400 block font-bold uppercase mb-1 italic leading-none tracking-tighter">ยกมา</span>
                     <span class="text-xs font-black text-slate-800 font-jakarta leading-none">${data.startStock.toLocaleString()}</span>
                </div>
                <div class="text-center p-3 rounded-2xl bg-amber-50 border border-amber-100 shadow-inner">
                     <span class="text-[8px] text-amber-500 block font-bold uppercase mb-1 italic leading-none tracking-tighter">ใช้ผ้า</span>
                     <span class="text-xs font-black text-orange-500 font-jakarta leading-none">${data.totalUse.toLocaleString()}</span>
                </div>
                <div class="text-center p-3 rounded-2xl bg-emerald-50 border border-emerald-100 shadow-inner">
                     <span class="text-[8px] text-emerald-600 block font-bold uppercase mb-1 italic leading-none tracking-tighter">สุทธิ</span>
                     <span class="text-xs ${getBalanceColorClass(data.finalStock)} font-jakarta leading-none">${data.finalStock.toLocaleString()}</span>
                </div>
            </div>
            ${recommendationHtml}
            <button onclick="toggleCollapsible('${safeId}')" class="w-full flex items-center justify-between py-3 px-5 bg-slate-900 text-white rounded-2xl text-[9px] font-black uppercase tracking-widest hover:bg-slate-800 transition-all mt-auto shadow-md">
                <span>รายการคิวทอ (${data.jobs.length})</span>
                <i data-lucide="chevron-down" id="icon-${safeId}" class="w-4 h-4 transition-transform duration-300"></i>
            </button>
            <div id="collapse-${safeId}" class="collapsible-content pt-5 px-1">
                <div class="overflow-x-auto hide-scrollbar">
                    <table class="w-full text-[10px] text-left collapsible-table max-w-full">
                        <thead class="text-slate-400 uppercase tracking-tighter border-b border-slate-100 font-black italic">
                            <tr><th class="pb-2 px-1">วันขึ้นของ</th><th class="pb-2 px-1">Description</th><th class="pb-2 text-right">ยกมา</th><th class="pb-2 text-right">ใช้</th><th class="pb-2 text-right">คงเหลือ</th></tr>
                        </thead>
                        <tbody class="divide-y divide-slate-50">
                            ${data.jobs.map(job => `
                                <tr class="hover:bg-slate-50/50">
                                    <td class="py-2.5 px-1 font-bold text-slate-700 whitespace-nowrap">${formatDateDisplay(job._dateObj).text}</td>
                                    <td class="py-2.5 px-1 text-slate-500 font-jakarta line-clamp-2 max-w-[120px] md:max-w-xs break-words">${job['Description'] || '-'}</td>
                                    <td class="py-2.5 text-right text-slate-400 font-jakarta">${parseNum(job['Stock ยกมา']).toLocaleString()}</td>
                                    <td class="py-2.5 text-right font-black text-orange-500 font-jakarta">-${parseNum(job['ใช้ผ้า']).toLocaleString()}</td>
                                    <td class="py-2.5 text-right font-black ${getBalanceColorClass(parseNum(job['Stock คงเหลือ']))} font-jakarta">${parseNum(job['Stock คงเหลือ']).toLocaleString()}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    }).join('');
    lucide.createIcons();
}

function showStatsMain() {
    document.getElementById('stats-view-main').classList.remove('hidden');
    document.getElementById('stats-view-detail').classList.add('hidden');
    document.getElementById('stats-charts-section').classList.remove('hidden');
}

function toggleCollapsible(id) { const c = document.getElementById(`collapse-${id}`); const i = document.getElementById(`icon-${id}`); c.classList.toggle('show'); i.style.transform = c.classList.contains('show') ? 'rotate(180deg)' : 'rotate(0deg)'; }

function openRecommendationSpec(specId) {
    navigate('usage-stats');
    changeStatsType('group');
    setTimeout(() => {
        const groupObj = rawData.find(i => i['Weaving Item'] === specId);
        if (groupObj && groupObj['ItemGroup']) {
            drilldownGroup(groupObj['ItemGroup']);
            setTimeout(() => {
                const safeId = specId.replace(/[^a-zA-Z0-9]/g, '');
                const element = document.getElementById(`collapse-${safeId}`);
                if (element && !element.classList.contains('show')) {
                    toggleCollapsible(safeId);
                    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 300);
        }
    }, 100);
}

let currentRecTab = 'sales';
let recRoleSelection = null; // Store the selected name (e.g. Sales person name or Plant name)
let _recRoleRetryCount = 0;

let activeRecGroup = 'ทั้งหมด';
let activeRecSales = 'ทั้งหมด';
let activeRecPlant = 'ทั้งหมด';

function setRecGroup(val) { activeRecGroup = val; renderStockRecommendations(); }
function setRecSales(val) { activeRecSales = val; renderStockRecommendations(); }
function setRecPlant(val) { activeRecPlant = val; renderStockRecommendations(); }

function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start).toLocaleString();
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}

function openRecRoleSelection() {
    if (!rawData || rawData.length === 0) {
        if (_recRoleRetryCount >= 5) {
            _recRoleRetryCount = 0;
            showToast('โหลดข้อมูลไม่สำเร็จ กรุณา refresh หน้า');
            return;
        }
        _recRoleRetryCount++;
        refreshData();
        setTimeout(openRecRoleSelection, 1000);
        return;
    }
    _recRoleRetryCount = 0;

    navigate('rec-role-select');
    document.getElementById('rec-step-1').classList.remove('hidden');
    document.getElementById('rec-step-2').classList.add('hidden');

    // Generate lists based on available data
    const uniquePlants = new Set();
    const uniqueSales = new Set();

    if (rawData) {
        rawData.forEach(item => {
            // Try to match varying column names from CSV if the main ones are undefined
            const plant = item['Plant'] || item['plant'] || item[' โรงงาน'] || '-';
            const sales = item['ฝ่ายขาย'] || item[' ฝ่ายขาย'] || '-';

            if (plant && plant.trim() !== '-') uniquePlants.add(plant.trim());
            if (sales && sales.trim() !== '-') uniqueSales.add(sales.trim());
        });
    }

    window.availableRecSales = Array.from(uniqueSales).sort();
    window.availableRecPlants = Array.from(uniquePlants).sort();
}

function selectRecRole(roleType) {
    currentRecTab = roleType;
    document.getElementById('rec-step-1').classList.add('hidden');
    document.getElementById('rec-step-2').classList.remove('hidden');

    const titleEl = document.getElementById('rec-step-2-title');
    const listEl = document.getElementById('rec-name-list');

    let names = [];
    if (roleType === 'sales') {
        titleEl.innerHTML = `<i data-lucide="briefcase" class="w-4 h-4 text-sky-500"></i> เลือกพนักงานฝ่ายขาย`;
        names = window.availableRecSales || [];
    } else {
        titleEl.innerHTML = `<i data-lucide="factory" class="w-4 h-4 text-emerald-500"></i> เลือกโรงงานผลิต`;
        names = window.availableRecPlants || [];
    }

    const colorClass = roleType === 'sales'
        ? 'hover:border-sky-400 hover:text-sky-600'
        : 'hover:border-emerald-400 hover:text-emerald-600';

    const btns = [{ n: 'ทั้งหมด', icon: 'globe', cls: 'bg-slate-900 text-white hover:bg-slate-800 uppercase tracking-widest' }, ...names.map(n => ({ n, icon: null, cls: 'bg-white border border-slate-200 text-slate-700 ' + colorClass }))];

    listEl.innerHTML = btns.map(b =>
        `<button data-name="${b.n.replace(/"/g, '&quot;')}" class="rec-name-btn p-4 rounded-xl font-bold text-sm shadow-sm transition-colors line-clamp-1 ${b.cls}">${b.icon ? `<i data-lucide="${b.icon}" class="w-4 h-4 inline-block mr-1"></i>` : ''}${b.n}</button>`
    ).join('');

    // Event delegation — safe against apostrophes/quotes in names
    listEl.querySelectorAll('.rec-name-btn').forEach(btn => {
        btn.addEventListener('click', () => confirmRecRoleSelection(btn.dataset.name));
    });

    lucide.createIcons();
}

function confirmRecRoleSelection(name) {
    recRoleSelection = name;

    // Set up Dashboard UI Titles based on selection
    const titleEl = document.getElementById('rec-dashboard-title');
    const subtitleEl = document.getElementById('rec-dashboard-subtitle');

    if (currentRecTab === 'sales') {
        titleEl.textContent = "หน้าจัดการฝ่ายขาย";
        subtitleEl.innerHTML = `<i data-lucide="briefcase" class="w-3 h-3 text-sky-600"></i> <span class="text-sky-800">${name}</span>`;
        subtitleEl.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-100 text-[10px] font-bold mt-1";
        activeRecSales = name;
    } else {
        titleEl.textContent = "แผงควบคุมการผลิต";
        subtitleEl.innerHTML = `<i data-lucide="factory" class="w-3 h-3 text-emerald-600"></i> <span class="text-emerald-800">${name}</span>`;
        subtitleEl.className = "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-100 text-[10px] font-bold mt-1";
        activeRecPlant = name;
    }

    navigate('stock-recommend');
    renderStockRecommendations();
}

function calculateDailyRunningBalance(jobs, startBalance, currentMachines, activePlant) {
    // Find valid timeframe
    const validJobs = jobs.filter(j => j._dateObj.getFullYear() !== 2099);
    if (validJobs.length === 0) return { minBalance: startBalance, isBottleneck: startBalance < 0, totalDemand: 0, timeline: [] };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const maxDate = new Date(Math.max(...validJobs.map(j => j._dateObj)));

    let currentBalance = startBalance;
    let minBalance = startBalance;
    let totalDemand = 0;
    let simDate = new Date(today);
    let timeline = [];

    // Advance simulation day by day
    while (simDate <= maxDate) {
        // Add daily capacity
        const dailyProduction = currentMachines * METERS_PER_MC_PER_DAY;
        currentBalance += dailyProduction;

        // Subtract orders arriving 5 days from now (production buffer)
        const targetDate = new Date(simDate);
        targetDate.setDate(targetDate.getDate() + 5);

        const jobsForTarget = validJobs.filter(j => j._dateObj.getTime() === targetDate.getTime());
        let dailyDrain = 0;
        jobsForTarget.forEach(j => {
            const reqAmt = parseNum(j['ใช้ผ้า']);
            dailyDrain += reqAmt;
            totalDemand += reqAmt;
        });

        currentBalance -= dailyDrain;
        minBalance = Math.min(minBalance, currentBalance);

        timeline.push({
            date: new Date(simDate),
            bal: currentBalance,
            drain: dailyDrain,
            added: dailyProduction
        });

        simDate.setDate(simDate.getDate() + 1);
    }

    return { minBalance, isBottleneck: minBalance < 0, totalDemand, timeline };
}

function renderStockRecommendations() {
    // Use pre-computed cache from loading phase; fall back to fresh build if missing
    const fabrics = window.fabricCache || {};
    const needsRebuild = Object.keys(fabrics).length === 0;
    if (needsRebuild) {
        // Build on-the-fly (e.g. after manual refreshData)
        rawData.forEach(item => {
            const fid = item['Weaving Item'] || 'Unknown';
            if (!fabrics[fid]) fabrics[fid] = {
                id: fid, desc: item['Description'] || '-',
                group: (item['ItemGroup'] || '-').trim(),
                start: parseNum(item['Stock ยกมา']), final: 0, jobs: [], maxMc: 0,
                runSim: null, plants: [], salesSet: []
            };
            fabrics[fid].jobs.push(item);
        });
        Object.values(fabrics).forEach(f => {
            f.jobs.sort((a, b) => a._sortDate - b._sortDate);
            f.final = parseNum(f.jobs[f.jobs.length - 1]['Stock คงเหลือ']);
            f.maxMc = Math.max(...f.jobs.map(j => parseNum(j['เกิดจริง'])), 0);
            f.runSim = calculateDailyRunningBalance(f.jobs, f.start, f.maxMc, null);
            f.plants = Array.from(new Set(f.jobs.map(j => (j['Plant'] || j['plant'] || '-').trim()).filter(p => p !== '-')));
            f.salesSet = Array.from(new Set(f.jobs.map(j => (j['ฝ่ายขาย'] || '-').trim()).filter(s => s !== '-')));
        });
    }

    const uniqueGroups = new Set();
    const uniquePlants = new Set();
    const uniqueSales = new Set();
    Object.values(fabrics).forEach(f => {
        if (f.group && f.group !== '-') uniqueGroups.add(f.group);
        f.plants.forEach(p => uniquePlants.add(p));
        f.salesSet.forEach(s => uniqueSales.add(s));
    });


    // Populate Filters
    // Create Filter Buttons for Item Group
    let groupFilterHtml = `<button onclick="setRecGroup('ทั้งหมด')" class="px-5 py-2.5 rounded-xl font-bold text-xs whitespace-nowrap transition-all ${activeRecGroup === 'ทั้งหมด' ? 'bg-slate-900 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-100 border border-slate-200'}">ทั้งหมด</button>`;
    Array.from(uniqueGroups).sort().forEach(g => {
        const isActive = activeRecGroup === g;
        groupFilterHtml += `<button onclick="setRecGroup(${jsArg(g)})" class="px-5 py-2.5 rounded-xl font-bold text-xs whitespace-nowrap transition-all ${isActive ? 'bg-slate-900 text-white shadow-md' : 'bg-white text-slate-500 hover:bg-slate-100 border border-slate-200'}">${g}</button>`;
    });
    document.getElementById('filter-rec-group').className = "flex flex-wrap items-center gap-2 max-w-full";
    document.getElementById('filter-rec-group').innerHTML = groupFilterHtml;

    let criticalCount = 0;
    let metricSum = 0;

    const insufficientList = [];
    const abundantList = [];

    // Smart KPI Tracking Variables
    let totalShortageAmount = 0;
    let totalRiskValue = 0;
    let criticalDelayedCount = 0;
    let totalWaitMachines = 0;
    let totalRunningMachines = 0;
    let maxCapacityDeficit = 0;

    const predictiveSignalsList = [];

    Object.values(fabrics).forEach(f => {
        // All values (jobs sorted, final, maxMc, runSim) already pre-computed in fabricCache

        if (activeRecGroup !== 'ทั้งหมด' && f.group !== activeRecGroup) return;

        // --- PREDICITIVE SIGNALS GENERATION ---
        // Filter signals by active Sales / Plant role
        let keepForSignals = true;
        if (currentRecTab === 'sales' && activeRecSales !== 'ทั้งหมด' && !f.salesSet.includes(activeRecSales)) keepForSignals = false;
        if (currentRecTab === 'planner' && activeRecPlant !== 'ทั้งหมด' && !f.plants.includes(activeRecPlant)) keepForSignals = false;

        if (keepForSignals && f.runSim && f.runSim.timeline) {
            let maxDrop = 0;
            let hasDeadStock = false;
            let deadDaysCount = 0;

            for (let i = 0; i < f.runSim.timeline.length; i++) {
                const point = f.runSim.timeline[i];
                if (point.drain > 5000 && point.drain > (point.bal + point.drain) * 0.20) {
                    if (point.drain > maxDrop) maxDrop = point.drain;
                }
                if (point.drain === 0 && point.added === 0 && point.bal > 0) {
                    deadDaysCount++;
                    if (deadDaysCount >= 14) hasDeadStock = true;
                } else {
                    deadDaysCount = 0;
                }
            }

            if (maxDrop > 0) {
                predictiveSignalsList.push({
                    type: 'tsunami',
                    html: `<button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="flex items-center gap-2 bg-rose-50 border border-rose-200 hover:border-rose-400 hover:bg-rose-100 transition-colors rounded-full pl-1.5 pr-4 py-1.5 shadow-sm active:scale-95 group"><div class="w-7 h-7 rounded-full bg-rose-200 text-rose-700 flex items-center justify-center shrink-0 group-hover:bg-rose-600 group-hover:text-white transition-colors"><i data-lucide="triangle" class="w-3.5 h-3.5 fill-current"></i></div><div class="text-left leading-tight"><strong class="text-[11px] text-rose-700 font-jakarta group-hover:text-rose-900">${f.id}</strong><br><span class="text-[9px] text-rose-500 font-bold uppercase tracking-tight group-hover:text-rose-700">ระวังออเดอร์มหาศาลจ่อคิวตัด</span></div></button>`
                });
            }
            if (hasDeadStock) {
                predictiveSignalsList.push({
                    type: 'deadstock',
                    html: `<button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="flex items-center gap-2 bg-slate-50 border border-slate-200 hover:border-slate-400 hover:bg-slate-100 transition-colors rounded-full pl-1.5 pr-4 py-1.5 shadow-sm active:scale-95 group"><div class="w-7 h-7 rounded-full bg-slate-200 text-slate-500 flex items-center justify-center shrink-0 group-hover:bg-slate-700 group-hover:text-white transition-colors"><i data-lucide="skull" class="w-3.5 h-3.5"></i></div><div class="text-left leading-tight"><strong class="text-[11px] text-slate-700 font-jakarta group-hover:text-slate-900">${f.id}</strong><br><span class="text-[9px] text-slate-500 font-bold uppercase tracking-tight group-hover:text-slate-700">สต็อกตายนิ่งสนิท >14 วัน</span></div></button>`
                });
            }
        }
        // --- END PREDICTIVE SIGNALS ---



        if (currentRecTab === 'sales') {
            // SALES VIEW: Filter jobs down to just this sales portfolio
            let portfolioJobs = f.jobs;
            if (activeRecSales !== 'ทั้งหมด') {
                portfolioJobs = f.jobs.filter(j => {
                    const salesVal = (j['ฝ่ายขาย'] || j[' ฝ่ายขาย'] || '-').trim();
                    return salesVal === activeRecSales;
                });
                if (portfolioJobs.length === 0) return;
            }

            // For sales, we care if the pure snapshot ending balance is negative for their jobs
            const myFinalBalance = f.start - portfolioJobs.reduce((sum, j) => sum + parseNum(j['ใช้ผ้า']), 0);

            const { hasMinMaxCtrl, minLimit, maxLimit, midPoint } = getMinMaxCtrl(f.jobs);
            const controlStrategyTag = getControlStrategyTag({ hasMinMaxCtrl, minLimit, maxLimit });

            const isShort = hasMinMaxCtrl ? (myFinalBalance < minLimit) : (myFinalBalance < 0);

            if (isShort) {
                criticalCount++;
                metricSum += Math.abs(myFinalBalance);
                const deficitAmount = Math.abs(hasMinMaxCtrl ? (minLimit - myFinalBalance) : myFinalBalance);
                totalShortageAmount += deficitAmount;

                // Weighted risk based on how much is missing and if machines are running
                let riskMulti = f.maxMc === 0 ? 1.5 : 0.8;
                totalRiskValue += (deficitAmount * riskMulti);
                if (f.maxMc === 0) criticalDelayedCount++;

                const supplyPlants = Array.from(new Set(f.jobs.map(j => {
                    return (j['Plant'] || j['plant'] || j[' โรงงาน'] || '-').trim();
                }).filter(p => p !== '-')));
                const plantStr = supplyPlants.length > 0 ? supplyPlants.join(', ') : 'ส่วนกลาง';

                let uiBadge = f.maxMc > 0
                    ? `<div class="mt-2 flex items-center gap-1.5 text-[9px] font-bold text-sky-600 bg-sky-50 px-2 py-1 rounded-lg border border-sky-100"><i data-lucide="factory" class="w-3 h-3"></i> โรงงานกำลังเปิดรันผ้าให้ (${f.maxMc} เครื่อง)</div>`
                    : `<div class="mt-2 flex items-center gap-1.5 text-[9px] font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded-lg border border-rose-100"><i data-lucide="alert-triangle" class="w-3 h-3"></i> ระวังล่าช้า: ยังไม่มีโรงงานเปิดเครื่องให้</div>`;

                insufficientList.push({
                    sortVal: myFinalBalance, // Keep actual balance for sorting
                    html: `
                    <button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="w-full text-left p-4 rounded-2xl bg-white border border-rose-100 shadow-sm flex flex-col group hover:bg-rose-50 hover:border-rose-300 transition-all active:scale-[0.98]">
                        <div class="flex justify-between items-start w-full mb-2">
                            <div class="w-[65%]">
                                <div class="flex items-center gap-2 mb-1 flex-wrap">
                                    <span class="text-sm font-black text-rose-600 uppercase tracking-widest leading-none font-jakarta group-hover:text-rose-700">${f.id}</span>
                                    ${controlStrategyTag}
                                </div>
                                <p class="text-xs font-bold text-slate-600 line-clamp-1 leading-tight w-full">${f.desc}</p>
                            </div>
                            <div class="text-right flex items-center gap-2">
                                <div>
                                    <span class="text-base font-black text-rose-600 font-jakarta drop-shadow-sm">${myFinalBalance.toLocaleString()}</span>
                                    <span class="text-[8px] block text-rose-400 font-bold tracking-tighter uppercase mt-0.5">เมตร (จบแคมเปญ)</span>
                                </div>
                            </div>
                        </div>
                        <div class="w-full pt-2 border-t border-dashed border-rose-100">
                            <div class="flex items-center gap-1.5 text-[9px] font-bold text-slate-500 uppercase tracking-tighter">
                                <i data-lucide="factory" class="w-3 h-3"></i> ซัพพลายจาก: <span class="text-slate-800">${plantStr}</span>
                            </div>
                            ${uiBadge}
                        </div>
                    </button>
                    `
                });
            } else {
                let isSurplus = false;
                let midPoint = 0;
                if (hasMinMaxCtrl && maxLimit > 0) {
                    midPoint = (minLimit + maxLimit) / 2;
                    isSurplus = myFinalBalance > midPoint;
                } else {
                    isSurplus = myFinalBalance > 50000;
                }

                if (isSurplus) {
                    abundantList.push({
                        sortVal: myFinalBalance,
                        html: `
                        <button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="w-full text-left p-4 rounded-2xl bg-white border border-emerald-100 shadow-sm flex flex-col group hover:bg-emerald-50 hover:border-emerald-300 transition-all active:scale-[0.98]">
                            <div class="flex justify-between items-start w-full">
                                <div class="w-[65%]">
                                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                                        <span class="text-sm font-black text-emerald-600 uppercase tracking-widest leading-none font-jakarta group-hover:text-emerald-700">${f.id}</span>
                                        ${controlStrategyTag}
                                    </div>
                                    <p class="text-xs font-bold text-slate-600 line-clamp-1 leading-tight w-full">${f.desc}</p>
                                </div>
                                <div class="text-right flex items-center gap-2">
                                    <div>
                                        <span class="text-base font-black text-emerald-600 font-jakarta drop-shadow-sm">+${myFinalBalance.toLocaleString()}</span>
                                        <span class="text-[8px] block text-slate-400 font-bold tracking-tighter uppercase mt-0.5">${hasMinMaxCtrl ? 'เมตร (เกินค่ากลาง)' : 'เมตร'}</span>
                                    </div>
                                    <i data-lucide="chevron-right" class="w-4 h-4 text-emerald-200 group-hover:text-emerald-500 transition-colors"></i>
                                </div>
                            </div>
                        </button>
                        `
                    });
                }
            }

        } else {
            // PLANNER VIEW: True Daily Running Balance across filtered plants
            if (activeRecPlant !== 'ทั้งหมด' && !f.jobs.some(j => ((j['Plant'] || j['plant'] || j[' โรงงาน'] || '-').trim()) === activeRecPlant)) return;

            const runningSim = calculateDailyRunningBalance(f.jobs, f.start, f.maxMc, activeRecPlant);

            const leadTimeDays = calcLeadTimeDays(f.jobs);
            const { hasMinMaxCtrl, minLimit, maxLimit, midPoint } = getMinMaxCtrl(f.jobs);
            const controlStrategyTag = getControlStrategyTag({ hasMinMaxCtrl, minLimit, maxLimit });

            totalRunningMachines += f.maxMc;

            // 3. Logic: Is it Short / Critical?
            // By Order -> minBalance < 0
            // Min/Max -> minBalance < minLimit (Even if > 0, if it breaks the safety stock, warn)
            const isShort = hasMinMaxCtrl ? (runningSim.minBalance < minLimit) : runningSim.isBottleneck;

            if (isShort) {
                criticalCount++;
                metricSum += f.maxMc; // Count total active machines trying to fight fires

                // The deficit is either the amount below 0, or the amount below Min. Let's aim to reach Min (or 0)
                let targetStock = hasMinMaxCtrl ? minLimit : 0;
                const deficit = targetStock - runningSim.minBalance;

                const extraMcNeeded = Math.ceil(deficit / (METERS_PER_MC_PER_DAY * leadTimeDays));
                maxCapacityDeficit += extraMcNeeded;

                const impactedNames = Array.from(new Set(f.jobs.map(j => j['Name'] || j['ฝ่ายขาย']).filter(n => n && n !== '-')));
                const impactText = impactedNames.length > 0 ? (impactedNames.length > 2 ? impactedNames.slice(0, 2).join(', ') + ' และอื่นๆ' : impactedNames.join(', ')) : 'หลายฝ่าย';

                insufficientList.push({
                    sortVal: runningSim.minBalance,
                    html: `
                    <button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="w-full text-left p-4 rounded-2xl bg-white border border-rose-100 shadow-sm flex flex-col group hover:bg-rose-50 hover:border-rose-300 transition-all active:scale-[0.98]">
                        <div class="flex justify-between items-start w-full mb-2">
                            <div class="w-[65%]">
                                <div class="flex items-center gap-2 mb-1 flex-wrap">
                                    <span class="text-sm font-black text-rose-600 uppercase tracking-widest leading-none font-jakarta group-hover:text-rose-700">${f.id}</span>
                                    ${controlStrategyTag}
                                </div>
                                <p class="text-xs font-bold text-slate-600 line-clamp-1 leading-tight w-full">${f.desc}</p>
                            </div>
                            <div class="text-right flex items-center gap-2">
                                <div>
                                    <span class="text-base font-black text-rose-600 font-jakarta drop-shadow-sm">${runningSim.minBalance.toLocaleString()}</span>
                                    <span class="text-[8px] block text-rose-400 font-bold tracking-tighter uppercase mt-0.5">เมตร (จุดต่ำสุดคิว)</span>
                                </div>
                            </div>
                        </div>
                        <div class="w-full pt-2 border-t border-dashed border-rose-100">
                            <div class="flex items-center gap-1.5 text-[9px] font-bold text-slate-500 uppercase tracking-tighter">
                                <i data-lucide="users" class="w-3 h-3"></i> กระทบลูกค้า: <span class="text-slate-800">${impactText}</span>
                            </div>
                             <div class="mt-2 flex items-center gap-1.5 text-[9px] font-bold text-rose-600 bg-rose-50 px-2 py-1 rounded-lg border border-rose-100">
                                 <i data-lucide="settings-2" class="w-3 h-3"></i> เครื่องรันไม่พอ (เป้า ${leadTimeDays} วัน) เปิดอยู่ ${f.maxMc} / ควรเพิ่มราว +${extraMcNeeded}
                             </div>
                        </div>
                    </button>
                    `
                });
            } else {
                // 4. Logic: Is it Abundant / Surplus?
                let isSurplus = false;
                let midPoint = 0;
                if (hasMinMaxCtrl && maxLimit > 0) {
                    midPoint = (minLimit + maxLimit) / 2;
                    isSurplus = (runningSim.minBalance > midPoint && f.maxMc > 0);
                } else {
                    isSurplus = (runningSim.minBalance > 50000 && f.maxMc > 0);
                }

                // If it's between Min/Max, and machines are running, it's considered "Normal/Safe", we don't list it in Abundant unless it breaks Max.

                if (isSurplus) {
                    abundantList.push({
                        sortVal: runningSim.minBalance,
                        html: `
                        <button onclick="openRecommendationSpecPopup(${jsArg(f.id)})" class="w-full text-left p-4 rounded-2xl bg-white border border-emerald-100 shadow-sm flex flex-col group hover:bg-emerald-50 hover:border-emerald-300 transition-all active:scale-[0.98]">
                            <div class="flex justify-between items-start w-full">
                                <div class="w-[65%]">
                                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                                        <span class="text-sm font-black text-emerald-600 uppercase tracking-widest leading-none font-jakarta group-hover:text-emerald-700">${f.id}</span>
                                        ${controlStrategyTag}
                                    </div>
                                    <p class="text-xs font-bold text-slate-600 line-clamp-1 leading-tight w-full">${f.desc}</p>
                                </div>
                                <div class="text-right flex items-center gap-2">
                                    <div>
                                        <span class="text-base font-black text-emerald-600 font-jakarta drop-shadow-sm">+${runningSim.minBalance.toLocaleString()}</span>
                                        <span class="text-[8px] block text-emerald-400 font-bold tracking-tighter uppercase mt-0.5">${hasMinMaxCtrl ? 'เมตร (เกินค่ากลาง)' : 'เมตร (จุดต่ำสุดคิว)'}</span>
                                    </div>
                                </div>
                            </div>
                            <div class="w-full pt-2 mt-2 border-t border-dashed border-emerald-100">
                                <div class="flex items-center gap-1.5 text-[9px] font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg border border-emerald-100">
                                    <i data-lucide="power-off" class="w-3 h-3"></i> เกินเป้าหมาย! แนะนำลดเครื่องทอลง -${f.maxMc} เครื่อง
                                </div>
                            </div>
                        </button>
                        `
                    });
                }
            }
        }
    });

    // Process Smart Dashboards based on Role View
    const smartCard = document.getElementById('dash-smart-card');
    const smartTitle = document.getElementById('smart-insight-title');
    const smartBadge = document.getElementById('smart-health-badge');
    const smartVal = document.getElementById('smart-insight-value');
    const smartDesc = document.getElementById('smart-insight-desc');

    animateValue("dash-rec-critical", 0, criticalCount, 300);

    if (currentRecTab === 'sales') {
        // Calculate Risk Score 0-100
        const maxRisk = 500000;
        const riskScore = Math.min(100, Math.round((totalRiskValue / maxRisk) * 100));
        document.getElementById('dash-rec-metric-val').textContent = riskScore + '/100';
        document.getElementById('dash-rec-metric-lbl').innerHTML = 'คะแนนความเสี่ยงรวม';

        // Risk Algorithm for Sales
        if (criticalCount === 0) {
            smartCard.className = "flex-[2] bg-gradient-to-br from-emerald-500 to-emerald-400 p-4 rounded-2xl shadow-md border border-emerald-400 min-w-[260px] text-white overflow-hidden relative group";
            smartBadge.className = "px-2 py-0.5 rounded-full bg-white/20 text-white border border-white/30 text-[8px] font-bold uppercase tracking-widest";
            smartBadge.textContent = "Safe Zone";
            smartVal.textContent = "ไม่มีรายการจัดส่งล่าช้า";
            smartDesc.textContent = "ยอดเยี่ยม! สต็อกของคุณเพียงพอต่อการจัดส่งลูกค้าทั้งหมด";
        } else {
            let riskLevel = riskScore > 60 ? 'High Risk' : (riskScore > 30 ? 'Warning' : 'Low Risk');
            let colorProfile = riskScore > 60 ? "from-rose-600 to-rose-500 border-rose-500" : "from-amber-600 to-amber-500 border-amber-500";
            smartCard.className = `flex-[2] bg-gradient-to-br ${colorProfile} p-4 rounded-2xl shadow-md border min-w-[260px] text-white overflow-hidden relative group`;
            smartBadge.className = "px-2 py-0.5 rounded-full bg-white/20 text-white border border-white/30 text-[8px] font-bold uppercase tracking-widest";
            smartBadge.textContent = riskLevel;

            if (criticalDelayedCount > 0) {
                smartVal.textContent = `${criticalDelayedCount} สเปกค้างส่ง และไม่มีเครื่องทอ!`;
                smartDesc.textContent = `กรุณาเร่งประสานฝ่ายวางแผนเพื่อขอเครื่องทอด่วน`;
            } else {
                smartVal.textContent = `ลูกค้ามีความเสี่ยงรอผ้า ${criticalCount} รายการ`;
                smartDesc.textContent = `โรงงานเปิดเครื่องให้แล้วแต่ยอดทอผลิตอาจจะไม่ทันส่ง`;
            }
        }
    } else {
        const capacityStressRaw = (maxCapacityDeficit / (totalRunningMachines || 1)) * 100;
        const capacityStress = Math.min(Math.round(capacityStressRaw), 100);
        document.getElementById('dash-rec-metric-val').textContent = capacityStress + '%';
        document.getElementById('dash-rec-metric-lbl').textContent = 'ความเครียด Capacity';

        // Stress Algorithm for Planner
        if (capacityStress > 50) {
            smartCard.className = "flex-[2] bg-gradient-to-br from-rose-600 to-orange-500 p-4 rounded-2xl shadow-md border border-rose-500 min-w-[260px] text-white overflow-hidden relative group";
            smartBadge.className = "px-2 py-0.5 rounded-full bg-white/20 text-white border border-white/30 text-[8px] font-bold uppercase tracking-widest";
            smartBadge.textContent = `Stress: ${capacityStress}%`;
            smartVal.textContent = `ทอไม่ทัน ต้องการ +${maxCapacityDeficit} เครื่องด่วน`;
            if (abundantList.length > 0) {
                smartDesc.textContent = `พบสเปกที่สต็อกอุดมสมบูรณ์ ปลดออกได้ ${abundantList.length} รายการ`;
            } else {
                smartDesc.textContent = `เครื่องทอไม่พออย่างรุนแรง จำเป็นต้องเจรจาเลื่อนส่ง`;
            }
        } else if (abundantList.length > 0) {
            smartCard.className = "flex-[2] bg-gradient-to-br from-sky-500 to-sky-400 p-4 rounded-2xl shadow-md border border-sky-400 min-w-[260px] text-white overflow-hidden relative group";
            smartBadge.className = "px-2 py-0.5 rounded-full bg-white/20 text-white border border-white/30 text-[8px] font-bold uppercase tracking-widest";
            smartBadge.textContent = "Optimization";
            smartVal.textContent = `พบ ${abundantList.length} สเปกที่ปลดเครื่องได้`;
            smartDesc.textContent = `ประหยัดต้นทุนโดยลดการทอผ้าที่สต็อกเหลือล้น > 50,000m`;
        } else {
            smartCard.className = "flex-[2] bg-gradient-to-br from-slate-900 to-slate-800 p-4 rounded-2xl shadow-md border border-slate-700 min-w-[260px] text-white overflow-hidden relative group";
            smartBadge.className = "px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[8px] font-bold uppercase tracking-widest";
            smartBadge.textContent = `Stress: ${capacityStress}%`;
            smartVal.textContent = "ภาระเครื่องอยู่ในระดับควบคุมได้";
            smartDesc.textContent = `ปัจจุบันเปิดเครื่องรองรับงานอยู่ทั้งหมด ${totalRunningMachines} เครื่อง`;
        }
    }

    // Render Lists
    const insContainer = document.getElementById('rec-insufficient-list');
    insufficientList.sort((a, b) => a.sortVal - b.sortVal);
    if (insufficientList.length === 0) {
        insContainer.innerHTML = `<div class="p-8 text-center text-slate-300 font-bold italic border-2 border-dashed border-slate-100 rounded-2xl">อุ่นใจได้ ไม่มีสเปกผ้าติดปัญหาเลย 🎉</div>`;
    } else {
        insContainer.innerHTML = insufficientList.slice(0, 10).map(i => i.html).join('');
    }

    const abnContainer = document.getElementById('rec-abundant-list');
    abundantList.sort((a, b) => b.sortVal - a.sortVal);
    if (abundantList.length === 0) {
        const emptyMsg = currentRecTab === 'planner' ? 'ยังไม่พบเครื่องทอที่ว่างสลับไปตัวอื่นได้' : 'ไม่มีข้อมูลสต็อกเหลือ';
        abnContainer.innerHTML = `<div class="p-8 text-center text-slate-300 font-bold italic border-2 border-dashed border-slate-100 rounded-2xl">${emptyMsg}</div>`;
    } else {
        abnContainer.innerHTML = abundantList.slice(0, 10).map(i => i.html).join('');
    }

    // Render Predictive Signals
    const signalsWrapper = document.getElementById('dash-predictive-signals-wrapper');
    const signalsContainer = document.getElementById('dash-predictive-signals');
    const signalsCount = document.getElementById('dash-predictive-count');

    if (predictiveSignalsList.length > 0) {
        const groupedHTML = [];
        const groups = { 'tsunami': [], 'deadstock': [] };

        predictiveSignalsList.forEach(s => {
            if (!groups[s.type].includes(s.html)) {
                groups[s.type].push(s.html);
            }
        });

        let totalUnique = 0;
        Object.keys(groups).forEach(type => {
            if (groups[type].length > 0) {
                const title = type === 'tsunami' ? '🌊 สึนามิออเดอร์ (ระวังยอดตัดกะทันหัน)' : '🐢 สต็อกนิ่งสนิท (>14 วัน)';
                const items = groups[type];
                totalUnique += items.length;

                groupedHTML.push(`<div class="w-full mt-4 mb-2"><h4 class="text-xs font-bold text-slate-500 uppercase tracking-widest">${title} <span class="bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded-md text-[10px]">${items.length}</span></h4></div>`);
                groupedHTML.push(`<div class="flex flex-wrap gap-2 w-full">`);

                const visible = items.slice(0, 5);
                const hidden = items.slice(5);
                groupedHTML.push(visible.join(''));

                if (hidden.length > 0) {
                    groupedHTML.push(`<div id="group-${type}-hidden" class="hidden flex flex-wrap gap-2 w-full mt-2">${hidden.join('')}</div>`);
                    groupedHTML.push(`<button onclick="document.getElementById('group-${type}-hidden').classList.remove('hidden'); this.classList.add('hidden')" class="text-[10px] font-bold text-sky-600 bg-sky-50 px-4 py-2 rounded-full hover:bg-sky-100 transition-colors border border-sky-100 shadow-sm">+ See more (${hidden.length})</button>`);
                }
                groupedHTML.push(`</div>`);
            }
        });

        signalsContainer.innerHTML = groupedHTML.join('');
        signalsCount.textContent = totalUnique;
        signalsWrapper.classList.remove('hidden');
    } else {
        signalsWrapper.classList.add('hidden');
    }

    // Rename Headers dynamically
    if (currentRecTab === 'sales') {
        document.getElementById('rec-left-title').textContent = "ออเดอร์เสี่ยงล่าช้า";
        document.getElementById('rec-left-desc').textContent = "โควตาผ้ามีแนวโน้มไม่พอจัดส่ง (Top 10)";
        document.getElementById('rec-right-title').textContent = "Available to Promise";
        document.getElementById('rec-right-desc').textContent = "ผ้าพร้อมขาย นำเสนอขายเพิ่มได้ (Top 10)";
    } else {
        document.getElementById('rec-left-title').textContent = "ระดมเครื่องทอด่วน";
        document.getElementById('rec-left-desc').textContent = "สเปกที่ต้องการ Capacity ถักทอ (Top 10)";
        document.getElementById('rec-right-title').textContent = "ปลด/ลดเครื่องทอ";
        document.getElementById('rec-right-desc').textContent = "ประหยัดต้นทุน ทอเผื่อไว้พอแล้ว (Top 10)";
    }

    lucide.createIcons();
}

function openRecommendationSpecPopup(f_id) {
    currentRecModalSpecId = f_id;
    const fjobs = rawData.filter(i => i['Weaving Item'] === f_id);
    if (fjobs.length === 0) return;

    const group = fjobs[0]['ItemGroup'] || '-';
    const desc = fjobs[0]['Description'] || '-';
    const startStr = fjobs[0]['Stock ยกมา'];
    const startBal = parseNum(startStr);

    // Re-sort jobs
    fjobs.forEach(j => j._dateObj = dateParser(j['วันขึ้นของ']));
    fjobs.sort((a, b) => a._dateObj - b._dateObj);

    const maxMc = Math.max(...fjobs.map(j => parseNum(j['เกิดจริง'])), 0);
    const finalBal = parseNum(fjobs[fjobs.length - 1]['Stock คงเหลือ']);

    document.getElementById('rm-title').textContent = f_id;
    document.getElementById('rm-group').textContent = group;
    document.getElementById('rm-desc').textContent = desc;

    const sim = calculateDailyRunningBalance(fjobs, startBal, maxMc, activeRecPlant);

    const leadTimeDays = calcLeadTimeDays(fjobs);

    let statsHtml = '';
    if (currentRecTab === 'sales') {
        const totalOrder = fjobs.reduce((s, j) => s + parseNum(j['ใช้ผ้า']), 0);
        const shortage = Math.abs(Math.min(finalBal, 0));

        statsHtml = `
        <div class="grid grid-cols-2 gap-4 w-full mb-4">
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">สต็อกพร้อมขาย</span>
                <span class="text-lg font-black font-jakarta text-slate-700">${startBal.toLocaleString()}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border ${finalBal < 0 ? 'border-rose-200 bg-rose-50' : 'border-emerald-200 bg-emerald-50'} shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold ${finalBal < 0 ? 'text-rose-500' : 'text-emerald-500'} uppercase tracking-widest mb-1">สถานะจบคิว (เมตร)</span>
                <span class="text-lg font-black font-jakarta ${finalBal < 0 ? 'text-rose-600' : 'text-emerald-600'}">${finalBal.toLocaleString()}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">ยอดสั่งตัดรวม</span>
                <span class="text-lg font-black font-jakarta text-sky-600">${totalOrder.toLocaleString()}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">ยอดขาดส่ง</span>
                <span class="text-lg font-black font-jakarta ${shortage > 0 ? 'text-rose-600' : 'text-slate-300'}">${shortage.toLocaleString()}</span>
            </div>
        </div>
        `;
    } else {
        statsHtml = `
        <div class="grid grid-cols-2 gap-4 w-full mb-4">
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">สต็อกตั้งต้น</span>
                <span class="text-lg font-black font-jakarta text-slate-700">${startBal.toLocaleString()}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border ${sim.minBalance < 0 ? 'border-orange-200 bg-orange-50' : 'border-emerald-200 bg-emerald-50'} shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold ${sim.minBalance < 0 ? 'text-orange-500' : 'text-emerald-500'} uppercase tracking-widest mb-1">จุดต่ำสุดคิว (เมตร)</span>
                <span class="text-lg font-black font-jakarta ${sim.minBalance < 0 ? 'text-orange-600' : 'text-emerald-600'}">${sim.minBalance.toLocaleString()}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Lead Time (วัน)</span>
                <span class="text-lg font-black font-jakarta text-purple-600">${leadTimeDays}</span>
            </div>
            <div class="bg-white p-3 rounded-2xl border border-slate-100 shadow-sm flex flex-col justify-center items-center">
                <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">เครื่องเตรียมทอ</span>
                <span class="text-lg font-black font-jakarta text-amber-600">${maxMc} M/C</span>
            </div>
        </div>
        `;
    }
    document.getElementById('rm-stats').innerHTML = statsHtml;

    const chartCont = document.getElementById('rm-chart-container');
    chartCont.classList.remove('hidden');
    chartCont.classList.add('flex');

    window.currentChartTimelineFull = sim.timeline;
    window.currentChartJobsFull = fjobs;
    drawRecChart(sim.timeline, fjobs); // Passed fjobs

    const ledgerCont = document.getElementById('rm-ledger-container');
    if (ledgerCont) {
        // Store jobs globally for interactive clicking
        window.currentModalJobs = fjobs;
        window.renderLedgerList(fjobs, 'รายการออเดอร์ทั้งหมด');
    }

    // Navigate to the detail page instead of showing a modal
    navigate('rec-spec-detail');
    window.scrollTo(0, 0);
}

// ---- Ledger Pagination state ----
let _ledgerAllJobs = [];
let _ledgerPage = 0;
const LEDGER_PAGE_SIZE = 25;

window.renderLedgerList = function (jobsToShow, title, page) {
    _ledgerAllJobs = jobsToShow;
    _ledgerPage = page || 0;
    const ledgerCont = document.getElementById('rm-ledger-container');
    if (!ledgerCont) return;

    const total = jobsToShow.length;
    const totalPages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
    const curPage = Math.min(_ledgerPage, totalPages - 1);
    const start = curPage * LEDGER_PAGE_SIZE;
    const pageJobs = jobsToShow.slice(start, start + LEDGER_PAGE_SIZE);

    const rowsHtml = pageJobs.length > 0 ? pageJobs.map(job => `
        <tr class="hover:bg-slate-50 transition-colors">
            <td class="py-2.5 px-2 text-slate-600 font-bold whitespace-nowrap">${(() => { const d = new Date(job._dateObj.getTime() - 5 * 24 * 3600 * 1000); return d.getFullYear() === 2099 ? '-' : (String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0')); })()}</td>
            <td class="py-2.5 px-2 font-bold whitespace-nowrap">
                <span class="${formatDateDisplay(job._dateObj).diff < 0 ? 'text-rose-600' : 'text-emerald-700'}">${formatDateDisplay(job._dateObj).text}</span>
                <span class="block text-[8px] text-slate-400 mt-0.5">${formatDateDisplay(job._dateObj).label}</span>
            </td>
            <td class="py-2.5 px-2 font-jakarta whitespace-nowrap">
                <span class="block text-[10px] font-bold text-sky-700">${job['เลขที่ CO'] || '-'}</span>
                <span class="block text-[9px] text-slate-400">${job['Line'] || job['Item'] || '-'}</span>
            </td>
            <td class="py-2.5 px-2 whitespace-nowrap">
                <span class="block text-[10px] font-bold text-slate-700 leading-tight">${job['Description'] || '-'}</span>
                <span class="block text-[9px] text-slate-400 font-jakarta mt-0.5">${job['Item'] || ''}</span>
            </td>
            <td class="py-2.5 px-2 whitespace-nowrap">
                <span class="block text-[10px] font-bold text-slate-700">${job['Name'] || '-'}</span>
                <span class="block text-[9px] text-slate-400 font-jakarta">${job['ฝ่ายขาย'] || '-'}</span>
            </td>
            <td class="py-2.5 px-2 text-[10px] font-bold text-slate-500 whitespace-nowrap">${job['ItemGroup'] || '-'}</td>
            <td class="py-2.5 px-2 text-[10px] font-bold text-indigo-600 whitespace-nowrap">${(job['Plant'] || job['plant'] || job[' โรงงาน'] || '-').trim()}</td>
            <td class="py-2.5 px-2 text-right font-black text-rose-500 font-jakarta whitespace-nowrap">-${parseNum(job['ใช้ผ้า']).toLocaleString()}</td>
        </tr>
    `).join('') : `<tr><td colspan="8" class="text-center py-6 text-slate-400 italic">ไม่มีรายการ</td></tr>`;

    const paginationHtml = totalPages > 1 ? `
        <div class="px-4 py-2.5 border-t border-slate-100 bg-slate-50 flex items-center justify-between shrink-0">
            <button onclick="goLedgerPage(${curPage - 1})" ${curPage === 0 ? 'disabled' : ''}
                class="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all
                ${curPage === 0 ? 'text-slate-300 cursor-not-allowed' : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-100 shadow-sm'}">
                <i data-lucide="chevron-left" class="w-3 h-3"></i> ก่อนหน้า
            </button>
            <span class="text-[10px] font-bold text-slate-500">
                หน้า <span class="text-emerald-600">${curPage + 1}</span> / ${totalPages}
                <span class="text-slate-400 ml-1">(${start + 1}–${Math.min(start + LEDGER_PAGE_SIZE, total)} จาก ${total})</span>
            </span>
            <button onclick="goLedgerPage(${curPage + 1})" ${curPage >= totalPages - 1 ? 'disabled' : ''}
                class="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[10px] font-bold transition-all
                ${curPage >= totalPages - 1 ? 'text-slate-300 cursor-not-allowed' : 'text-slate-600 bg-white border border-slate-200 hover:bg-slate-100 shadow-sm'}">
                หน้าถัดไป <i data-lucide="chevron-right" class="w-3 h-3"></i>
            </button>
        </div>` : '';

    ledgerCont.innerHTML = `
        <div class="flex flex-col border border-slate-100 rounded-2xl overflow-hidden shadow-sm bg-white">
            <div class="bg-slate-50 border-b border-slate-100 px-4 py-3 flex items-center justify-between shrink-0">
                <h4 class="text-[11px] font-bold text-slate-600 uppercase tracking-widest flex items-center gap-1.5">
                    <i data-lucide="list" class="w-3 h-3"></i> รายการออเดอร์ทั้งหมด
                </h4>
                <span class="text-[9px] bg-slate-200 text-slate-500 px-2 py-0.5 rounded-md font-bold">${total} รายการ</span>
            </div>
            <div class="overflow-x-auto hide-scrollbar">
                <table class="min-w-max w-full text-[10px] text-left">
                    <thead class="text-slate-400 uppercase tracking-tighter bg-white sticky top-0 z-10 shadow-sm border-b border-slate-50 font-black italic">
                        <tr>
                            <th class="py-2 px-2 whitespace-nowrap">วันที่ใช้</th>
                            <th class="py-2 px-2 whitespace-nowrap">วันขึ้นของ</th>
                            <th class="py-2 px-2 whitespace-nowrap">เลขที่ CO/Line</th>
                            <th class="py-2 px-2">Description/Item</th>
                            <th class="py-2 px-2 whitespace-nowrap">ลูกค้า/ฝ่ายขาย</th>
                            <th class="py-2 px-2 whitespace-nowrap">Item Group</th>
                            <th class="py-2 px-2 whitespace-nowrap">Plant</th>
                            <th class="py-2 px-2 text-right whitespace-nowrap">ตัดสต็อก</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-50">${rowsHtml}</tbody>
                </table>
            </div>
            ${paginationHtml}
        </div>`;
    lucide.createIcons();
};

function goLedgerPage(page) {
    window.renderLedgerList(_ledgerAllJobs, 'รายการออเดอร์ทั้งหมด', page);
}


function closeRecModal() {
    if (recChartInstance) {
        recChartInstance.destroy();
        recChartInstance = null;
    }
    // Navigate back to stock-recommend page
    navigate('stock-recommend');
}

function gotoUsageStatsFromModal() {
    if (!currentRecModalSpecId) return;
    closeRecModal();
    setTimeout(() => {
        openRecommendationSpec(currentRecModalSpecId);
    }, 300);
}

function setChartTimeframe(days) {
    currentChartTimeframe = days;
    [14, 30, 60, 'all'].forEach(val => {
        let btn = document.getElementById(`tf-${val}`);
        if (!btn) return;
        if (val === days) {
            btn.classList.add('bg-sky-100', 'text-sky-600', 'shadow-sm');
            btn.classList.remove('text-slate-500', 'hover:bg-slate-100');
        } else {
            btn.classList.remove('bg-sky-100', 'text-sky-600', 'shadow-sm');
            btn.classList.add('text-slate-500', 'hover:bg-slate-100');
        }
    });
    if (window.currentChartTimelineFull && window.currentChartJobsFull) {
        drawRecChart(window.currentChartTimelineFull, window.currentChartJobsFull);
    }
}

function drawRecChart(fullTimeline, fjobs) {
    if (recChartInstance) recChartInstance.destroy();
    const ctx = document.getElementById('recChart').getContext('2d');

    let timeline = fullTimeline;
    if (currentChartTimeframe !== 'all') {
        timeline = fullTimeline.slice(0, currentChartTimeframe);
    }

    const { hasMinMaxCtrl, minLimit, maxLimit, midPoint } = getMinMaxCtrl(fjobs || []);
    const leadTimeDays = fjobs && fjobs.length > 0 ? calcLeadTimeDays(fjobs) : 1;

    const labels = timeline.map(t => `${t.date.getDate()}/${t.date.getMonth() + 1}`);
    const data = timeline.map(t => t.bal);

    const bgColors = data.map(v => v < 0 ? 'rgba(244, 63, 94, 0.2)' : 'rgba(16, 185, 129, 0.2)');

    // --- Advanced Signals Computation --- 
    // 2. Tsunami Detection: Drain > 5000 and > 20% of starting balance that day
    const isTsunami = (i) => timeline[i].drain > 5000 && timeline[i].drain > ((data[i] + timeline[i].drain) * 0.2);
    // 3. Catch-up Point: Crosses from negative to positive
    const isCatchUp = (i) => i > 0 && data[i - 1] < 0 && data[i] >= 0;
    // 4. Machine Drop Warning (Predictive Risk): High stock now, but dropping machine kills stock in 5 days
    const isMachineDropWarning = (i) => {
        if (!hasMinMaxCtrl || data[i] <= midPoint) return false;
        let futureBal = data[i];
        for (let j = 1; j <= 5; j++) if (i + j < timeline.length) futureBal -= timeline[i + j].drain;
        return futureBal < minLimit;
    };
    // 5. Batch Switch Window: > midPoint and no drains > 1000m for next 5 days
    const isSafeToSwitch = (i) => {
        if (!hasMinMaxCtrl || data[i] <= midPoint) return false;
        for (let j = 1; j <= 5; j++) if (i + j < timeline.length && timeline[i + j].drain > 1000) return false;
        return true;
    };

    const pointStyles = data.map((v, i) => {
        if (isCatchUp(i)) return 'rectRounded';
        if (isTsunami(i)) return 'triangle';
        if (isMachineDropWarning(i)) return 'star'; // Warning shape
        if (isSafeToSwitch(i)) return 'rect'; // Safe shape
        return 'circle';
    });

    const pointBgColors = data.map((v, i) => {
        if (isCatchUp(i)) return '#10b981'; // Green Catch-up
        if (isTsunami(i)) return '#f97316'; // Orange Tsunami
        if (isMachineDropWarning(i)) return '#eab308'; // Yellow Warning
        if (isSafeToSwitch(i)) return '#84cc16'; // Lime Safe
        if (v < (hasMinMaxCtrl ? minLimit : 0)) return '#f43f5e'; // Danger
        if (hasMinMaxCtrl && v > maxLimit) return '#9f1239'; // Dark Red Overcap
        if (hasMinMaxCtrl && v > midPoint) return '#3b82f6'; // Action: Reduce MC
        return 'transparent';
    });

    const pointRadii = data.map((v, i) => {
        if (isCatchUp(i) || isTsunami(i) || isMachineDropWarning(i)) return 6; // Important shapes are larger
        if (isSafeToSwitch(i)) return 5;
        if (v < (hasMinMaxCtrl ? minLimit : 0)) return 4;
        if (hasMinMaxCtrl && v > maxLimit) return 5;
        if (hasMinMaxCtrl && v > midPoint) return 4;
        return 0;
    });

    // Annotations Setup
    const annotations = {};

    // Burn Rate Indicator Label
    const totalDrain = fjobs ? fjobs.reduce((s, j) => s + parseNum(j['ใช้ผ้า']), 0) : 0;
    const weeklyBurn = timeline.length > 0 ? (totalDrain / timeline.length) * 7 : 0;
    if (weeklyBurn > 0) {
        annotations.burnRateLabel = {
            type: 'label',
            xValue: labels[Math.floor(labels.length / 2)] || labels[0],
            yValue: Math.max(...data) * 1.05 + 5000,
            content: `🔥 Burn Rate: ~${weeklyBurn.toLocaleString(undefined, { maximumFractionDigits: 0 })} m/wk`,
            color: '#ef4444', font: { size: 10, weight: 'bold' },
            backgroundColor: 'rgba(254, 242, 242, 0.9)', borderRadius: 4, position: 'center'
        };
    }

    // A. Thresholds
    if (hasMinMaxCtrl) {
        annotations.minLine = {
            type: 'line', yMin: minLimit, yMax: minLimit,
            borderColor: 'rgba(249, 115, 22, 0.6)', borderWidth: 1, borderDash: [4, 4],
            label: { display: true, content: 'MIN', position: 'start', backgroundColor: 'rgba(249, 115, 22, 0.8)', color: '#fff', font: { size: 8, weight: 'bold' }, padding: 2 }
        };
        annotations.midLine = {
            type: 'line', yMin: midPoint, yMax: midPoint,
            borderColor: 'rgba(56, 189, 248, 0.6)', borderWidth: 1, borderDash: [4, 4],
            label: { display: true, content: 'AVG', position: 'start', backgroundColor: 'rgba(56, 189, 248, 0.8)', color: '#fff', font: { size: 8, weight: 'bold' }, padding: 2 }
        };
        annotations.maxLine = {
            type: 'line', yMin: maxLimit, yMax: maxLimit,
            borderColor: 'rgba(16, 185, 129, 0.6)', borderWidth: 1, borderDash: [4, 4],
            label: { display: true, content: 'MAX', position: 'start', backgroundColor: 'rgba(16, 185, 129, 0.8)', color: '#fff', font: { size: 8, weight: 'bold' }, padding: 2 }
        };
        // B. Overcap Zone (Red Zone above Max)
        if (maxLimit > 0) {
            annotations.overcapZone = {
                type: 'box', yMin: maxLimit,
                backgroundColor: 'rgba(244, 63, 94, 0.05)', borderWidth: 0, drawTime: 'beforeDraw'
            };
        }
    }

    // C. Target Completion Day (Last drain event)
    let lastDrainIdx = -1;
    timeline.forEach((t, i) => { if (t.drain > 0) lastDrainIdx = i; });
    if (lastDrainIdx > 0 && lastDrainIdx < timeline.length - 1) {
        annotations.completionLine = {
            type: 'line', xMin: labels[lastDrainIdx], xMax: labels[lastDrainIdx],
            borderColor: 'rgba(148, 163, 184, 0.8)', borderWidth: 1, borderDash: [2, 2],
            label: { display: true, content: '🏁 จบแคมเปญออเดอร์', position: 'end', backgroundColor: 'rgba(148, 163, 184, 0.9)', color: '#fff', font: { size: 8, weight: 'bold' }, padding: 3, yAdjust: 10 }
        };
    }

    // D. Lead Time Safe Buffer
    let bufferEndIdx = Math.min(leadTimeDays, timeline.length - 1);
    if (bufferEndIdx > 0) {
        annotations.safeBufferZone = {
            type: 'box', xMin: labels[0], xMax: labels[bufferEndIdx],
            backgroundColor: 'rgba(253, 224, 71, 0.15)', borderWidth: 0, drawTime: 'beforeDraw',
            label: { display: true, content: '🕒 กรอบเวลา Safe Buffer (Lead Time)', position: 'start', color: '#ca8a04', font: { size: 8, weight: 'bold' }, yAdjust: -15 }
        };
    }

    // E. Idle Zone classification (> 14 days of no movement)
    let idleStartIdx = -1;
    let idleCount = 0;
    let idleNum = 0;
    for (let i = 0; i < timeline.length; i++) {
        if (timeline[i].drain === 0 && timeline[i].added === 0 && data[i] > 0) {
            if (idleCount === 0) idleStartIdx = i;
            idleCount++;
        } else {
            if (idleCount >= 14) {
                annotations[`idleZone${idleNum++}`] = {
                    type: 'box', xMin: labels[idleStartIdx], xMax: labels[i - 1],
                    backgroundColor: 'rgba(203, 213, 225, 0.25)', borderWidth: 0, drawTime: 'beforeDraw',
                    label: { display: true, content: '🐢 สต็อกนิ่งยาว (Dead Stock)', position: 'center', color: '#64748b', font: { size: 8, weight: 'bold' } }
                };
            }
            idleCount = 0;
        }
    }
    if (idleCount >= 14 && idleStartIdx >= 0) {
        annotations[`idleZone${idleNum}`] = {
            type: 'box', xMin: labels[idleStartIdx], xMax: labels[timeline.length - 1],
            backgroundColor: 'rgba(203, 213, 225, 0.25)', borderWidth: 0, drawTime: 'beforeDraw',
            label: { display: true, content: '🐢 สต็อกนิ่งยาว (Dead Stock)', position: 'center', color: '#64748b', font: { size: 8, weight: 'bold' } }
        };
    }

    // F. Point Icon Annotations (Emojis on the timeline)
    let annoCount = 0;
    for (let i = 0; i < timeline.length; i++) {
        let iconContent = null;
        let borderColor = '';
        if (isTsunami(i)) { iconContent = '🌊 สึนามิ'; borderColor = 'rgba(249, 115, 22, 0.5)'; }
        else if (isCatchUp(i)) { iconContent = '🚀 พ้นแดนลบ'; borderColor = 'rgba(16, 185, 129, 0.5)'; }
        else if (isMachineDropWarning(i)) { iconContent = '⚠️ เสี่ยงช็อต'; borderColor = 'rgba(234, 179, 8, 0.5)'; }

        if (iconContent) {
            annotations[`pointIcon${annoCount++}`] = {
                type: 'label',
                xValue: labels[i],
                yValue: data[i],
                content: iconContent,
                backgroundColor: 'rgba(255,255,255,0.95)',
                color: '#334155',
                font: { size: 9, weight: 'bold' },
                borderRadius: 6,
                padding: { top: 3, bottom: 3, left: 6, right: 6 },
                yAdjust: -25,
                borderWidth: 1,
                borderColor: borderColor,
                callout: { display: true, position: 'bottom', borderColor: borderColor, margin: 2 }
            };
        }
    }

    recChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Running Balance',
                data: data,
                borderColor: 'rgb(203, 213, 225)', // Smooth line default
                backgroundColor: bgColors,
                borderWidth: 2,
                fill: true,
                stepped: true,
                pointStyle: pointStyles,
                pointBackgroundColor: pointBgColors,
                pointBorderColor: pointBgColors,
                pointRadius: pointRadii,
                pointHoverRadius: 6,
                segment: {
                    borderColor: ctx => ctx.p1DataIndex >= 0 && data[ctx.p1DataIndex] < (hasMinMaxCtrl ? minLimit : 0) ? 'rgb(244, 63, 94)' : 'rgb(16, 185, 129)',
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                annotation: { annotations: annotations },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const idx = ctx.dataIndex;
                            let msg = `ยอดคงเหลือ: ${ctx.raw.toLocaleString()} m`;
                            if (isCatchUp(idx)) msg += ' 🚀 (จุดฟื้นตัว)';
                            if (isTsunami(idx)) msg += ' ⚡ (สต็อกลดฮวบ)';
                            if (isMachineDropWarning(idx)) msg += ' ⚠️ (ห้ามปิดเครื่อง! เดี๋ยวติดลบ)';
                            if (isSafeToSwitch(idx)) msg += ' 🟢 (ปลอดภัย สลับเบอร์ถักได้)';
                            if (hasMinMaxCtrl && ctx.raw > maxLimit) msg += ' 💸 (Overcap ทุนจม)';
                            return msg;
                        },
                        afterBody: (ctxs) => {
                            const idx = ctxs[0].dataIndex;
                            const point = timeline[idx];
                            let msgs = [];
                            if (point && point.drain > 0) msgs.push(`🚨 ออเดอร์เข้าตัด: -${point.drain.toLocaleString()}m`);
                            if (point && point.added > 0) msgs.push(`🏭 เติมผ้าเข้าคลัง: +${point.added.toLocaleString()}m`);
                            return msgs;
                        }
                    }
                },
                datalabels: { display: false }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(0,0,0,0.05)' },
                    border: { dash: [4, 4] },
                    ticks: { font: { family: 'Plus Jakarta Sans', size: 10, weight: 'bold' } }
                },
                x: {
                    grid: { display: false },
                    ticks: {
                        font: { family: 'Kanit', size: 10 },
                        maxTicksLimit: window.innerWidth < 768 ? 6 : 14
                    }
                }
            },
            interaction: {
                intersect: false,
                mode: 'index',
            }
        }
    });
}

window.onload = () => { lucide.createIcons(); changeStatsType('group'); };

function openManualModal() {
    const modal = document.getElementById('manualModal');
    const content = document.getElementById('manualModalContent');
    modal.classList.remove('hidden');
    // Allow display change to render
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        content.classList.remove('translate-y-10', 'sm:translate-y-10');
    }, 10);
}

function closeManualModal() {
    const modal = document.getElementById('manualModal');
    const content = document.getElementById('manualModalContent');
    modal.classList.add('opacity-0');
    content.classList.add('translate-y-10', 'sm:translate-y-10');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300); // Wait for transition
}
