document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

/* ═══════════════════════════════════════════════════════════
   数据分层：
   - books 存储：{ id, name, content, rawFile, encoding }  ← 重，只按 id 单条取
   - meta  存储：书架/搜索/进度需要的全部轻量字段          ← 启动只读这个
   内存里的 books[] 数组从此只装 meta，不再驻留任何正文。
   ═══════════════════════════════════════════════════════════ */

let db;
const DB_NAME = "YanYeDB_Precision_V22";
const STORE_NAME = "books";
const META_STORE = "meta";
const DB_VERSION = 3;

let books = [];   // 只含 meta
let categories = JSON.parse(localStorage.getItem('yy_cats_v22')) || ['文学', '随笔', '其他'];
let currentBookId = null;
let currentFilter = '全部';
let tempCoverData = "";
let menuStartX = 0;
let currentMenuIdx = 0;
let searchClickTimer = null;
let searchReturnTimeout = null;
let recordTouchY = 0;
let recordTouchTime = 0;
let recordPageIndex = 0;

/* ═══════════ 阅读器状态 ═══════════ */
let bookContent = "";
let chapters = [];
let currentChapterIdx = 0;
let loadedStart = 0;
let loadedEnd = -1;
let tocRendered = false;
let progressSaveTimer = null;
let seekTimer = null;
let isAdjusting = false;
let loadingAborted = false;

const WINDOW_MAX = 7;      // DOM 中最多保留的章节块数
const EDGE_PX = 1200;      // 距上/下边缘多少像素开始续载
const HEADER_OFFSET = 80;  // 顶栏遮挡高度
const MAX_BLOCK = 20000;   // 单个渲染块最大字数，超长章节按此切块
const DOUBLE_TAP_MS = 200; // 双击判定窗口，直接决定单击打开的延迟

const quotes = [
    "马上到达书籍世界...",
    "书是灵魂的避难所。",
    "在文字里，遇见另一个自己。",
    "阅读是一场说走就走的旅行。",
    "读书不是为了雄辩，而是为了权衡。",
    "暂别喧嚣，进入文字的秘境。",
    "每一本书都是一个独立的世界。"
];

const themeIcons = {
    light: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`,
    dark: `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`,
    auto: `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`
};

/* ═══════════ IndexedDB 基础设施 ═══════════ */

function txStore(name, mode) {
    return db.transaction([name], mode).objectStore(name);
}

function idbReq(req) {
    return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

let needMigrate = false;

const request = indexedDB.open(DB_NAME, DB_VERSION);
request.onupgradeneeded = (e) => {
    const _db = e.target.result;
    if (!_db.objectStoreNames.contains(STORE_NAME)) _db.createObjectStore(STORE_NAME, { keyPath: "id" });
    if (!_db.objectStoreNames.contains(META_STORE)) {
        _db.createObjectStore(META_STORE, { keyPath: "id" });
        needMigrate = e.oldVersion > 0;   // 老库才需要迁移，全新安装不用
    }
};
request.onsuccess = async (e) => {
    db = e.target.result;
    try {
        if (needMigrate) await migrateToMeta();
        books = await idbReq(txStore(META_STORE, 'readonly').getAll());
    } catch (err) {
        books = [];
    }
    init();
};
request.onerror = () => { alert('数据库打开失败，请检查浏览器是否允许本地存储。'); };

/* 老版本一次性迁移：用游标逐本读，避免一次把整库拉进内存 */
function migrateToMeta() {
    return new Promise((resolve) => {
        const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
        const metaStore = tx.objectStore(META_STORE);
        const cursorReq = tx.objectStore(STORE_NAME).openCursor();
        cursorReq.onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) return;
            metaStore.put(buildMeta(cur.value));
            cur.continue();
        };
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
    });
}

/* 从完整记录里抽出 meta */
function buildMeta(book) {
    const content = book.content || '';
    return {
        id: book.id,
        name: book.name || '未命名',
        author: book.author || '',
        category: book.category || (categories[0] || '其他'),
        cover: book.cover || '',
        showTitleOnCover: book.showTitleOnCover !== false,
        notes: book.notes || '',
        recordCards: book.recordCards || [],
        lastReadChapterIdx: book.lastReadChapterIdx || 0,
        lastReadChapterTitle: book.lastReadChapterTitle || '',
        lastReadChapterRatio: book.lastReadChapterRatio || 0,
        encoding: book.encoding || '',
        hasRaw: !!book.rawFile,
        charCount: content.length,
        garbled: isGarbled(content)
    };
}

function saveMeta(meta) {
    if (!db || !meta) return;
    txStore(META_STORE, 'readwrite').put(meta);
}

// 兼容旧调用名
function updateBookInDB(meta) { saveMeta(meta); }

function getBookRecord(id) {
    return idbReq(txStore(STORE_NAME, 'readonly').get(id));
}

/* ═══════════ 初始化 / 主题 ═══════════ */

function init() {
    const sz = localStorage.getItem('yy_font_size_v22');
    if (sz) document.documentElement.style.setProperty('--font-size', sz);
    const lh = localStorage.getItem('yy_line_height_v22');
    if (lh) document.documentElement.style.setProperty('--line-height', lh);
    renderCategoryBar();
    renderBookshelf();
    applyTheme(localStorage.getItem('yy_theme_v22') || 'auto');
}

function setTheme(mode) { localStorage.setItem('yy_theme_v22', mode); applyTheme(mode); }

function applyTheme(mode) {
    const root = document.documentElement;
    document.querySelectorAll('.theme-opt').forEach(opt => opt.classList.remove('active'));
    const optEl = document.getElementById(`opt-${mode}`);
    if (optEl) optEl.classList.add('active');
    document.getElementById('theme-trigger').innerHTML = themeIcons[mode];
    if (mode === 'auto') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        root.setAttribute('data-theme', isDark ? 'dark' : 'light');
    } else root.setAttribute('data-theme', mode);
}

function switchTab(tab) {
    document.getElementById('tab-archive').style.display = tab === 'archive' ? 'block' : 'none';
    document.getElementById('tab-discover').style.display = tab === 'discover' ? 'block' : 'none';
    document.getElementById('tab-about').style.display = tab === 'about' ? 'block' : 'none';

    document.querySelectorAll('.nav-btn').forEach((n, idx) => {
        const isMatch = (tab === 'archive' && idx === 0) || (tab === 'discover' && idx === 1) || (tab === 'about' && idx === 2);
        n.classList.toggle('active', isMatch);
    });
}

function renderCategoryBar() {
    const bar = document.getElementById('category-bar');
    let html = `<span class="cat-item ${currentFilter === '全部' ? 'active' : ''}" onclick="filterCategory('全部')">全部</span>`;
    categories.forEach(cat => html += `<span class="cat-item ${currentFilter === cat ? 'active' : ''}" onclick="filterCategory('${cat}')">${escapeHTML(cat)}</span>`);
    bar.innerHTML = html;
}

function filterCategory(cat) { currentFilter = cat; renderCategoryBar(); renderBookshelf(); }

function renderBookshelf() {
    const shelf = document.getElementById('bookshelf');
    shelf.innerHTML = '';
    const filtered = currentFilter === '全部' ? books : books.filter(b => b.category === currentFilter);
    if (filtered.length === 0) {
        shelf.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 100px 20px; opacity: 0.3; font-size: 0.9rem;">书架空空如也</div>`;
        return;
    }
    const frag = document.createDocumentFragment();
    filtered.forEach((book, i) => {
        const idx = (i + 1).toString().padStart(2, '0');
        const card = document.createElement('div');
        card.className = 'book-card';
        card.id = 'book-card-' + book.id;

        let lastClick = 0;

        card.addEventListener('touchstart', (e) => {
            recordTouchY = e.touches[0].clientY;
            recordTouchTime = Date.now();
        }, { passive: true });

        card.addEventListener('touchend', (e) => {
            const diffY = recordTouchY - e.changedTouches[0].clientY;
            const diffTime = Date.now() - recordTouchTime;
            if (diffTime > 400 && diffY > 40) openRecordCard(book.id);
        }, { passive: true });

        card.onclick = () => {
            const now = Date.now();
            if (now - lastClick < DOUBLE_TAP_MS) {
                clearTimeout(card.clickTimer);
                openEditModal(book.id);
            } else {
                card.clickTimer = setTimeout(() => openReader(book.id), DOUBLE_TAP_MS);
            }
            lastClick = now;
        };

        card.oncontextmenu = (e) => { e.preventDefault(); };

        const showTitle = book.showTitleOnCover !== false;
        const lastRead = book.lastReadChapterTitle ? `上次读到：${book.lastReadChapterTitle}` : '从未读过';
        const garbledFlag = book.garbled ? `<div class="book-garbled-tip" onclick="event.stopPropagation(); showGarbledHelp(${book.id})">编码异常</div>` : '';
        card.innerHTML = `
            <div class="book-cover-wrap">
                <div class="book-index">${idx}</div>
                ${garbledFlag}
                <div class="book-cover">${book.cover ? `<img src="${book.cover}" class="book-cover-img" loading="lazy" decoding="async">` : ''}${showTitle ? `<div class="book-cover-text">${escapeHTML(book.name.substring(0, 12))}</div>` : ''}</div>
            </div>
            <div class="book-info">
                <h3>${escapeHTML(book.name)}</h3>
                <div class="book-last-read">${escapeHTML(lastRead)}</div>
                <div class="book-meta"><span class="book-tag">${escapeHTML(book.category)}</span><span>${Math.round((book.charCount || 0) / 1000)}k 字</span></div>
            </div>
        `;
        frag.appendChild(card);
    });
    shelf.appendChild(frag);
}

/* ── 乱码检测：U+FFFD 替换字符占比过高即判定为编码异常 ── */
function isGarbled(text) {
    if (!text) return false;
    const sample = text.slice(0, 3000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
        if (sample.charCodeAt(i) === 0xFFFD) bad++;
    }
    return bad / sample.length > 0.05;
}

function showGarbledHelp(id) {
    const meta = books.find(b => b.id === id);
    if (meta && meta.hasRaw) {
        if (confirm('检测到这本书解码有误。\n\n原始文件已保存，可以直接用 GBK 重新解码，不用删书重导。要现在试一下吗？')) {
            reDecodeBook(id, 'gb18030');
        }
        return;
    }
    alert('这本书是旧版本导入的，没有保存原始文件字节，无法就地修复。\n\n请双击此书 → 移除此书，然后重新导入同一个 TXT。新版本会自动识别 GBK。');
}

/* ═══════════ 书架搜索 ═══════════ */

function handleSearch(query) {
    const panel = document.getElementById('search-panel');
    const resultsDiv = document.getElementById('search-results');
    const searchContainer = document.querySelector('.search-container');
    const placeholder = document.getElementById('search-placeholder');

    if (!query.trim()) {
        panel.classList.remove('open');
        closeSearch(false);
        return;
    }

    if (searchReturnTimeout) { clearTimeout(searchReturnTimeout); searchReturnTimeout = null; }

    if (!searchContainer.classList.contains('searching')) {
        const rect = searchContainer.getBoundingClientRect();
        placeholder.style.display = 'block';
        searchContainer.style.top = rect.top + 'px';
        searchContainer.classList.add('searching');

        requestAnimationFrame(() => {
            searchContainer.style.top = '0px';
            searchContainer.style.padding = '15px 20px';
            searchContainer.style.backgroundColor = 'var(--bg-color)';
        });

        setTimeout(() => panel.classList.add('open'), 800);
    }

    const matched = books.filter(b => b.name.toLowerCase().includes(query.toLowerCase()));
    if (matched.length > 0) {
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        resultsDiv.innerHTML = matched.map(b => {
            const highlightedName = escapeHTML(b.name).replace(regex, '<span class="search-highlight">$1</span>');
            const lastRead = b.lastReadChapterTitle ? `上次读到：${b.lastReadChapterTitle}` : '从未读过';
            return `
                <div class="search-result-item" onclick="handleSearchResultClick(${b.id})">
                    <div style="width:35px; height:45px; background:var(--panel-bg); flex-shrink:0; border:1px solid var(--border-color); overflow:hidden;">
                        ${b.cover ? `<img src="${b.cover}" style="width:100%; height:100%; object-fit:cover;" loading="lazy">` : ''}
                    </div>
                    <div>
                        <div style="font-weight:bold; font-size:0.95rem;">${highlightedName}</div>
                        <div style="font-size:0.75rem; opacity:0.6;">${escapeHTML(b.author || '未知作者')}</div>
                        <div style="font-size:0.65rem; color:var(--accent-color); opacity:0.8; margin-top:2px;">${escapeHTML(lastRead)}</div>
                    </div>
                </div>
            `;
        }).join('');
    } else {
        resultsDiv.innerHTML = '<div style="text-align:center; padding:40px; opacity:0.5;">未发现馆藏</div>';
    }
}

function handleSearchResultClick(id) {
    if (searchClickTimer == null) {
        searchClickTimer = setTimeout(() => {
            jumpToBook(id);
            searchClickTimer = null;
        }, DOUBLE_TAP_MS);
    } else {
        clearTimeout(searchClickTimer);
        searchClickTimer = null;
        openReader(id);
        closeSearch();
    }
}

function jumpToBook(id) {
    const book = books.find(b => b.id === id);
    if (!book) return;
    if (currentFilter !== '全部' && book.category !== currentFilter) filterCategory('全部');
    closeSearch();
    setTimeout(() => {
        const card = document.getElementById('book-card-' + id);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('highlight-focus');
            setTimeout(() => card.classList.remove('highlight-focus'), 2000);
        }
    }, 100);
}

function closeSearch(clearInput = true) {
    const searchContainer = document.querySelector('.search-container');
    const placeholder = document.getElementById('search-placeholder');
    const panel = document.getElementById('search-panel');

    if (clearInput) document.getElementById('shelf-search').value = '';
    panel.classList.remove('open');

    if (searchContainer.classList.contains('searching')) {
        const rect = placeholder.getBoundingClientRect();
        searchContainer.style.top = rect.top + 'px';
        searchContainer.style.padding = '0px';
        searchContainer.style.backgroundColor = 'transparent';

        searchReturnTimeout = setTimeout(() => {
            if (!document.getElementById('shelf-search').value.trim() || clearInput) {
                searchContainer.classList.remove('searching');
                searchContainer.style.top = '';
                searchContainer.style.padding = '';
                searchContainer.style.backgroundColor = '';
                placeholder.style.display = 'none';
            }
            searchReturnTimeout = null;
        }, 800);
    }
}

/* ═══════════════════════════════════════════
   编码识别
   ═══════════════════════════════════════════ */

function scoreDecoded(text) {
    let bad = 0, cjk = 0, ctrl = 0;
    const sample = text.length > 30000 ? text.slice(0, 30000) : text;
    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if (c === 0xFFFD) bad++;
        else if (c >= 0x4E00 && c <= 0x9FFF) cjk++;
        else if (c >= 0x3400 && c <= 0x4DBF) cjk++;
        else if (c < 0x09 || (c > 0x0D && c < 0x20)) ctrl++;
    }
    return { bad: bad + ctrl, cjk, len: sample.length };
}

function readFileAsBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function readBlobAsText(blob, encoding) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => resolve(null);
        try {
            reader.readAsText(blob, encoding);
        } catch (err) {
            resolve(null);
        }
    });
}

// 探测 BOM，顺便判断是不是合法 UTF-8
function inspectBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return { bom: 'utf-8' };
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return { bom: 'utf-16le' };
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return { bom: 'utf-16be' };
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return { bom: null, strictUtf8: true };
    } catch (e) {
        return { bom: null, strictUtf8: false };
    }
}

/* 候选编码只在前 256KB 上试解码，大文件不用整本跑一遍 */
async function detectAndDecode(blob) {
    const probe = blob.size > 262144 ? blob.slice(0, 262144) : blob;
    const buffer = await readFileAsBuffer(probe);
    const info = inspectBytes(buffer);

    if (info.bom) {
        const text = await readBlobAsText(blob, info.bom);
        if (text !== null) return { text: text.replace(/^\uFEFF/, ''), encoding: info.bom };
    }

    if (info.strictUtf8) {
        const text = await readBlobAsText(blob, 'utf-8');
        if (text !== null) return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
    }

    const candidates = ['gb18030', 'gbk', 'big5', 'utf-8'];
    const results = [];
    for (const enc of candidates) {
        const t = await readBlobAsText(probe, enc);
        if (t === null || t === '') continue;
        const s = scoreDecoded(t);
        results.push({ encoding: enc, bad: s.bad, cjk: s.cjk });
    }

    if (results.length === 0) {
        const fallback = await readBlobAsText(blob, 'utf-8');
        return { text: fallback || '', encoding: 'utf-8' };
    }

    let best = results[0];
    for (let i = 1; i < results.length; i++) {
        const c = results[i];
        if (c.bad < best.bad) best = c;
        else if (c.bad === best.bad && c.cjk > best.cjk) best = c;
    }
    const full = await readBlobAsText(blob, best.encoding);
    return { text: (full || '').replace(/^\uFEFF/, ''), encoding: best.encoding };
}

/* 用指定编码重新解码已入库的书 */
async function reDecodeBook(id, encoding) {
    const meta = books.find(b => b.id === id);
    if (!meta) return;
    const record = await getBookRecord(id);
    if (!record || !record.rawFile) {
        alert('这本书没有保存原始文件，无法重新解码。请移除后重新导入。');
        return;
    }
    try {
        let text;
        if (encoding === 'auto') {
            const r = await detectAndDecode(record.rawFile);
            text = r.text;
            record.encoding = r.encoding;
        } else {
            text = await readBlobAsText(record.rawFile, encoding);
            if (text === null) throw new Error('该编码不被当前浏览器支持');
            record.encoding = encoding;
        }
        record.content = text.replace(/^\uFEFF/, '');
        txStore(STORE_NAME, 'readwrite').put(record);

        meta.encoding = record.encoding;
        meta.charCount = record.content.length;
        meta.garbled = isGarbled(record.content);
        meta.lastReadChapterIdx = 0;
        meta.lastReadChapterTitle = '';
        meta.lastReadChapterRatio = 0;
        saveMeta(meta);

        renderBookshelf();
        syncEncodingUI(meta);
        toast(meta.garbled ? `${meta.encoding} 解码后仍有乱码，换一个试试` : `✓ 已用 ${meta.encoding} 重新解码`);
    } catch (e) {
        toast('重新解码失败：' + e.message);
    }
}

function toast(msg) {
    let el = document.getElementById('yy-toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'yy-toast';
        el.style.cssText = 'position:fixed; left:50%; bottom:90px; transform:translateX(-50%); background:var(--text-color); color:var(--bg-color); padding:10px 18px; border-radius:20px; font-size:0.8rem; z-index:9999; max-width:80%; text-align:center; transition:opacity 0.3s;';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el.hideTimer);
    el.hideTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}

/* 在「书籍详情」弹窗里动态插入编码选择区 */
function ensureEncodingUI() {
    if (document.getElementById('encoding-section')) return;
    const categoryGroup = document.getElementById('edit-category');
    if (!categoryGroup) return;
    const anchor = categoryGroup.closest('.input-group');
    if (!anchor) return;

    const section = document.createElement('div');
    section.id = 'encoding-section';
    section.className = 'input-group';
    section.innerHTML = `
        <label>文本编码</label>
        <select id="edit-encoding" style="margin-bottom:8px;">
            <option value="auto">自动识别</option>
            <option value="gb18030">简体中文 GBK / GB18030</option>
            <option value="big5">繁体中文 BIG5</option>
            <option value="utf-8">UTF-8</option>
            <option value="utf-16le">UTF-16 LE</option>
        </select>
        <button class="btn" style="width:100%; padding:8px; font-size:0.8rem;" onclick="reDecodeBook(currentBookId, document.getElementById('edit-encoding').value)">用此编码重新解码</button>
        <div id="encoding-hint" style="font-size:0.68rem; color:var(--accent-color); opacity:0.7; margin-top:6px; line-height:1.5;"></div>
    `;
    anchor.parentNode.insertBefore(section, anchor.nextSibling);
}

function syncEncodingUI(meta) {
    const sel = document.getElementById('edit-encoding');
    const hint = document.getElementById('encoding-hint');
    if (!sel || !hint) return;
    const cur = (meta.encoding || '').toLowerCase();
    sel.value = ['gb18030', 'big5', 'utf-8', 'utf-16le'].includes(cur) ? cur : 'auto';
    if (!meta.hasRaw) {
        hint.textContent = '这本书导入时没有保存原始文件，无法重新解码。移除后重新导入即可获得此功能。';
        sel.disabled = true;
    } else {
        sel.disabled = false;
        hint.textContent = `当前编码：${meta.encoding || '未知'}。若正文是乱码，换一个编码重新解码（阅读进度会重置）。`;
    }
}

async function importFiles(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    const report = [];
    for (const file of files) {
        try {
            const { text, encoding } = await detectAndDecode(file);
            const id = Date.now() + Math.random();
            const record = {
                id,
                name: file.name.replace(/\.[^/.]+$/, ""),
                content: text,
                encoding,
                rawFile: file
            };
            const meta = {
                id,
                name: record.name,
                author: "",
                category: categories[0] || '其他',
                cover: '',
                showTitleOnCover: true,
                notes: "",
                recordCards: [],
                lastReadChapterIdx: 0,
                lastReadChapterTitle: "",
                lastReadChapterRatio: 0,
                encoding,
                hasRaw: true,
                charCount: text.length,
                garbled: isGarbled(text)
            };
            const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
            tx.objectStore(STORE_NAME).add(record);
            tx.objectStore(META_STORE).add(meta);
            books.push(meta);
            report.push({ name: meta.name, encoding, garbled: meta.garbled });
        } catch (err) {
            report.push({ name: file.name, encoding: '读取失败', garbled: true });
        }
    }
    renderBookshelf();
    if (event.target && 'value' in event.target) event.target.value = '';

    if (report.length) {
        const bad = report.filter(r => r.garbled);
        if (bad.length) toast(`导入 ${report.length} 本，${bad.length} 本仍有乱码，双击该书手动选编码`);
        else toast(`✓ 已导入 ${report.length} 本 · 编码 ${report[0].encoding}`);
    }
}

function escapeHTML(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════
   阅读器：章节窗口化渲染
   parseChapters 产出的每个块都保证不超过 MAX_BLOCK 字，
   没有章节标记的整本书也会被切成可分批渲染的小块。
   ═══════════════════════════════════════════ */

function parseChapters(text) {
    const re = /第[零一二三四五六七八九十百千万两\d]{1,12}[章节回部集卷篇]|Chapter\s*\d+/gi;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        marks.push(m.index);
        if (re.lastIndex === m.index) re.lastIndex++;
    }

    const raw = [];
    const firstStart = marks.length ? marks[0] : text.length;
    if (text.slice(0, Math.min(firstStart, 4000)).trim().length > 0) {
        raw.push({ title: '正文开始', from: 0, to: firstStart });
    }
    for (let i = 0; i < marks.length; i++) {
        const from = marks[i];
        const to = (i + 1 < marks.length) ? marks[i + 1] : text.length;
        if (to - from < 2) continue;
        raw.push({ title: '', from, to });
    }
    if (raw.length === 0) raw.push({ title: '正文', from: 0, to: text.length });

    raw.forEach((c, i) => {
        if (!c.title) {
            const head = text.slice(c.from, Math.min(c.to, c.from + 120));
            const line = head.split(/\r?\n/)[0].trim();
            c.title = line ? line.slice(0, 40) : `第 ${i} 节`;
        }
    });

    // 超长块二次切分，切点尽量落在换行处
    const list = [];
    for (const c of raw) {
        const len = c.to - c.from;
        if (len <= MAX_BLOCK) { list.push(c); continue; }
        const parts = Math.ceil(len / MAX_BLOCK);
        let cursor = c.from;
        for (let p = 0; p < parts && cursor < c.to; p++) {
            let end = Math.min(c.to, cursor + MAX_BLOCK);
            if (end < c.to) {
                const nl = text.lastIndexOf('\n', end);
                if (nl > cursor + MAX_BLOCK * 0.5) end = nl + 1;
            }
            list.push({
                title: p === 0 ? c.title : `${c.title} (${p + 1})`,
                from: cursor,
                to: end
            });
            cursor = end;
        }
    }
    return list;
}

function chapterHTML(i) {
    const ch = chapters[i];
    return `<div class="chapter-wrapper" data-index="${i}">`
        + `<div class="chapter-title-divider">${escapeHTML(ch.title)}</div>`
        + `<div class="chapter-body">${escapeHTML(bookContent.slice(ch.from, ch.to))}</div>`
        + `</div>`;
}

function renderWindow(centerIdx) {
    const container = document.getElementById('reader-content');
    loadedStart = Math.max(0, centerIdx - 1);
    loadedEnd = Math.min(chapters.length - 1, centerIdx + 1);
    let html = '';
    for (let i = loadedStart; i <= loadedEnd; i++) html += chapterHTML(i);
    container.innerHTML = html;
    currentChapterIdx = centerIdx;
}

// 首屏只渲染当前块，前一块延后补，首帧更快
function renderFirstBlock(centerIdx) {
    const container = document.getElementById('reader-content');
    loadedStart = centerIdx;
    loadedEnd = centerIdx;
    container.innerHTML = chapterHTML(centerIdx);
    currentChapterIdx = centerIdx;
}

function getWrapper(idx) {
    return document.querySelector(`.chapter-wrapper[data-index="${idx}"]`);
}

function appendNext() {
    if (loadedEnd >= chapters.length - 1) return false;
    const container = document.getElementById('reader-content');
    loadedEnd++;
    container.insertAdjacentHTML('beforeend', chapterHTML(loadedEnd));
    trimTop();
    return true;
}

function prependPrev() {
    if (loadedStart <= 0) return false;
    const area = document.getElementById('reader-scroll-area');
    const container = document.getElementById('reader-content');
    const before = container.scrollHeight;
    loadedStart--;
    container.insertAdjacentHTML('afterbegin', chapterHTML(loadedStart));
    const after = container.scrollHeight;
    isAdjusting = true;
    area.scrollTop += (after - before);   // 顶部插入后补偿，视觉上不跳
    isAdjusting = false;
    trimBottom();
    return true;
}

function trimTop() {
    const area = document.getElementById('reader-scroll-area');
    const container = document.getElementById('reader-content');
    while ((loadedEnd - loadedStart + 1) > WINDOW_MAX && loadedStart < currentChapterIdx - 1) {
        const before = container.scrollHeight;
        container.removeChild(container.firstElementChild);
        loadedStart++;
        const after = container.scrollHeight;
        isAdjusting = true;
        area.scrollTop -= (before - after);
        isAdjusting = false;
    }
}

function trimBottom() {
    const container = document.getElementById('reader-content');
    while ((loadedEnd - loadedStart + 1) > WINDOW_MAX && loadedEnd > currentChapterIdx + 1) {
        container.removeChild(container.lastElementChild);
        loadedEnd--;
    }
}

function fillViewport() {
    const area = document.getElementById('reader-scroll-area');
    let guard = 0;
    while (area.scrollHeight < area.clientHeight * 2 && guard < WINDOW_MAX) {
        if (!appendNext()) break;
        guard++;
    }
}

/* 点开一本书：只按 id 取这一条记录，正文不进 books[] */
async function openReader(id) {
    const loader = document.getElementById('loading-overlay');
    const quoteText = document.getElementById('loading-quote-text');
    loadingAborted = false;
    loader.style.display = 'flex';
    loader.style.opacity = '1';
    quoteText.innerText = quotes[Math.floor(Math.random() * quotes.length)];

    const meta = books.find(b => b.id === id);
    if (!meta) { abortLoading(); return; }
    currentBookId = id;

    let record;
    try {
        record = await getBookRecord(id);
    } catch (e) {
        toast('读取书籍失败');
        abortLoading();
        return;
    }
    if (loadingAborted) return;
    if (!record) { toast('书籍内容丢失'); abortLoading(); return; }

    document.getElementById('reader-book-title').innerText = meta.name;
    document.getElementById('reader-notes-display').innerText = meta.notes || '无备注';
    document.getElementById('side-title').innerText = meta.name;
    const sAuthor = document.getElementById('side-author');
    if (meta.author) { sAuthor.innerText = meta.author; sAuthor.style.display = 'block'; }
    else { sAuthor.style.display = 'none'; }

    bookContent = record.content || '';
    chapters = parseChapters(bookContent);
    tocRendered = false;
    document.getElementById('toc-list').innerHTML =
        '<div style="padding:20px 25px; opacity:0.4; font-size:0.85rem;">目录准备中…</div>';

    const startIdx = Math.min(Math.max(meta.lastReadChapterIdx || 0, 0), chapters.length - 1);
    const startRatio = typeof meta.lastReadChapterRatio === 'number' ? meta.lastReadChapterRatio : 0;

    renderFirstBlock(startIdx);

    document.getElementById('home-view').style.display = 'none';
    document.getElementById('reader-view').style.display = 'block';

    requestAnimationFrame(() => {
        const area = document.getElementById('reader-scroll-area');
        const w = getWrapper(startIdx);
        if (w) area.scrollTop = Math.max(0, w.offsetTop + startRatio * w.offsetHeight - HEADER_OFFSET);
        updateActiveChapterUI(startIdx, false);
        updateProgressBars();

        loader.style.opacity = '0';
        setTimeout(() => {
            if (loader.style.opacity === '0') {
                loader.style.display = 'none';
                loader.style.opacity = '1';
            }
        }, 200);

        // 首屏已可读，剩下的窗口在空闲时补齐
        setTimeout(() => {
            if (document.getElementById('reader-view').style.display !== 'block') return;
            prependPrev();
            fillViewport();
            updateProgressBars();
        }, 60);
    });
}

function abortLoading() {
    loadingAborted = true;
    const loader = document.getElementById('loading-overlay');
    loader.style.display = 'none';
    loader.style.opacity = '1';
    document.getElementById('home-view').style.display = 'block';
    document.getElementById('reader-view').style.display = 'none';
}

function handleSeamlessScroll(el) {
    if (isAdjusting) return;

    const nearBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) < EDGE_PX;
    const nearTop = el.scrollTop < EDGE_PX;

    if (nearBottom) {
        appendNext();
        if (el.scrollHeight - (el.scrollTop + el.clientHeight) < EDGE_PX) appendNext();
    } else if (nearTop) {
        prependPrev();
    }

    detectActiveChapter();
    updateProgressBars();
    scheduleProgressSave();
}

function detectActiveChapter() {
    const area = document.getElementById('reader-scroll-area');
    const wrappers = document.getElementById('reader-content').children;
    const line = area.scrollTop + HEADER_OFFSET;
    let idx = loadedStart;
    for (let i = 0; i < wrappers.length; i++) {
        if (wrappers[i].offsetTop <= line) idx = parseInt(wrappers[i].dataset.index, 10);
        else break;
    }
    if (idx !== currentChapterIdx) updateActiveChapterUI(idx, false);
}

function updateActiveChapterUI(idx, save = true) {
    currentChapterIdx = idx;
    const ch = chapters[idx];
    if (!ch) return;
    document.getElementById('reader-chapter-title').innerText = ch.title + ` (${idx + 1}/${chapters.length})`;

    if (tocRendered) {
        const prev = document.querySelector('.chapter-item.active');
        if (prev) prev.classList.remove('active');
        const cur = document.querySelector(`.chapter-item[data-toc="${idx}"]`);
        if (cur) cur.classList.add('active');
    }
    if (save) scheduleProgressSave();
}

function currentChapterRatio() {
    const area = document.getElementById('reader-scroll-area');
    const w = getWrapper(currentChapterIdx);
    if (!w || !w.offsetHeight) return 0;
    const r = (area.scrollTop + HEADER_OFFSET - w.offsetTop) / w.offsetHeight;
    return Math.max(0, Math.min(1, r));
}

function scheduleProgressSave() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(saveProgressNow, 600);
}

function saveProgressNow() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta || !chapters.length) return;
    meta.lastReadChapterIdx = currentChapterIdx;
    meta.lastReadChapterTitle = chapters[currentChapterIdx].title;
    meta.lastReadChapterRatio = currentChapterRatio();
    saveMeta(meta);   // 只写轻量 meta，不碰正文
}

function updateProgressBars() {
    if (!chapters.length) return;
    const intra = currentChapterRatio();
    const full = (currentChapterIdx + intra) / chapters.length;

    const fullBar = document.getElementById('full-progress-bar');
    const fullText = document.getElementById('full-progress-text');
    if (fullBar) fullBar.value = full * 1000;
    if (fullText) fullText.innerText = (full * 100).toFixed(1) + '%';

    const chapBar = document.getElementById('chapter-progress-bar');
    const chapText = document.getElementById('chapter-progress-text');
    if (chapBar) chapBar.value = intra * 1000;
    if (chapText) chapText.innerText = (intra * 100).toFixed(1) + '%';
}

function goToChapter(idx, ratio = 0) {
    idx = Math.min(Math.max(idx, 0), chapters.length - 1);
    const area = document.getElementById('reader-scroll-area');

    if (idx < loadedStart || idx > loadedEnd) renderWindow(idx);
    currentChapterIdx = idx;

    requestAnimationFrame(() => {
        const w = getWrapper(idx);
        if (w) {
            isAdjusting = true;
            area.scrollTop = Math.max(0, w.offsetTop + ratio * w.offsetHeight - HEADER_OFFSET);
            isAdjusting = false;
        }
        fillViewport();
        updateActiveChapterUI(idx);
        updateProgressBars();
    });
}

function seekFullBook(val) {
    const target = Math.min(chapters.length - 1, Math.floor((val / 1000) * chapters.length));
    const text = document.getElementById('full-progress-text');
    if (text) text.innerText = ((val / 1000) * 100).toFixed(1) + '%';
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => goToChapter(target, 0), 90);
}

function seekChapter(val) {
    const w = getWrapper(currentChapterIdx);
    if (!w) return;
    const area = document.getElementById('reader-scroll-area');
    isAdjusting = true;
    area.scrollTop = Math.max(0, w.offsetTop + (val / 1000) * w.offsetHeight - HEADER_OFFSET);
    isAdjusting = false;
    updateProgressBars();
    scheduleProgressSave();
}

function prevChapter() { if (currentChapterIdx > 0) goToChapter(currentChapterIdx - 1, 0); }
function nextChapter() { if (currentChapterIdx < chapters.length - 1) goToChapter(currentChapterIdx + 1, 0); }

function jumpToChapter(idx) { goToChapter(idx, 0); closePanels(); }

/* 目录分批插入，上万条也不卡住主线程 */
function renderTOC() {
    if (tocRendered) return;
    const list = document.getElementById('toc-list');
    const total = chapters.length;
    list.innerHTML = '';
    tocRendered = true;

    let i = 0;
    const CHUNK = 300;
    function step() {
        const end = Math.min(total, i + CHUNK);
        let html = '';
        for (; i < end; i++) {
            html += `<div class="chapter-item${i === currentChapterIdx ? ' active' : ''}" data-toc="${i}" onclick="jumpToChapter(${i})">`
                + `<span>${escapeHTML(chapters[i].title)}</span>`
                + `<span style="font-size:0.7rem; opacity:0.5;">${Math.round((i + 1) / total * 100)}%</span>`
                + `</div>`;
        }
        list.insertAdjacentHTML('beforeend', html);
        if (i < total) setTimeout(step, 0);
    }
    step();
}

function closeReader() {
    clearTimeout(progressSaveTimer);
    saveProgressNow();

    const root = document.documentElement;
    localStorage.setItem('yy_font_size_v22', getComputedStyle(root).getPropertyValue('--font-size'));
    localStorage.setItem('yy_line_height_v22', getComputedStyle(root).getPropertyValue('--line-height'));

    document.getElementById('home-view').style.display = 'block';
    document.getElementById('reader-view').style.display = 'none';

    document.getElementById('reader-content').innerHTML = '';
    document.getElementById('toc-list').innerHTML = '';
    bookContent = '';
    chapters = [];
    loadedStart = 0;
    loadedEnd = -1;
    tocRendered = false;

    renderBookshelf();
    closePanels();
}

function handleReaderClick(e) {
    const y = e.clientY, h = window.innerHeight;
    if (y > h * 0.3 && y < h * 0.7) toggleMenu();
    else closePanels();
}

function toggleMenu() {
    const menu = document.getElementById('bottom-menu'), nav = document.getElementById('reader-nav');
    const open = menu.classList.toggle('open');
    nav.classList.toggle('hidden', !open);
    if (open) { updateProgressBars(); switchReaderMenu(0); }
}

function toggleSidebar() {
    renderTOC();
    document.getElementById('side-panel').classList.add('open');
    document.getElementById('overlay').style.display = 'block';
    setTimeout(() => {
        const activeItem = document.querySelector('.chapter-item.active');
        if (activeItem) activeItem.scrollIntoView({ block: 'center' });
    }, 120);
}

function closePanels() {
    document.getElementById('side-panel').classList.remove('open');
    document.getElementById('bottom-menu').classList.remove('open');
    document.getElementById('reader-nav').classList.remove('hidden');
    document.getElementById('overlay').style.display = 'none';
}

function adjustFont(d) {
    const ratio = currentChapterRatio();
    let s = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--font-size'));
    let newVal = Math.max(12, Math.min(32, s + d)) + 'px';
    document.documentElement.style.setProperty('--font-size', newVal);
    localStorage.setItem('yy_font_size_v22', newVal);
    requestAnimationFrame(() => {
        const area = document.getElementById('reader-scroll-area');
        const w = getWrapper(currentChapterIdx);
        if (w) {
            isAdjusting = true;
            area.scrollTop = Math.max(0, w.offsetTop + ratio * w.offsetHeight - HEADER_OFFSET);
            isAdjusting = false;
        }
        updateProgressBars();
    });
}

function adjustSpacing(d) {
    const ratio = currentChapterRatio();
    let s = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--line-height'));
    let newVal = Math.max(1.2, Math.min(2.8, s + d));
    document.documentElement.style.setProperty('--line-height', newVal);
    localStorage.setItem('yy_line_height_v22', newVal);
    requestAnimationFrame(() => {
        const area = document.getElementById('reader-scroll-area');
        const w = getWrapper(currentChapterIdx);
        if (w) {
            isAdjusting = true;
            area.scrollTop = Math.max(0, w.offsetTop + ratio * w.offsetHeight - HEADER_OFFSET);
            isAdjusting = false;
        }
        updateProgressBars();
    });
}

function switchReaderMenu(idx) {
    currentMenuIdx = idx;
    document.getElementById('reader-menu-slider').style.transform = `translateX(-${idx * 33.333}%)`;
}

/* ═══════════ 记录卡 / 备注 ═══════════ */

function openRecordCard(id) {
    currentBookId = id;
    const meta = books.find(b => b.id === id);
    if (!meta) return;
    const bookCard = document.getElementById('book-card-' + id);
    const rect = bookCard ? bookCard.getBoundingClientRect() : null;

    if (!meta.recordCards) meta.recordCards = [];

    let currentChapter = "";
    if (document.getElementById('reader-view').style.display === 'block' && chapters[currentChapterIdx]) {
        currentChapter = chapters[currentChapterIdx].title;
    }

    if (meta.recordCards.length === 0) {
        meta.recordCards.push({ title: "阅读记录", time: new Date().toLocaleDateString(), content: "", chapter: currentChapter });
    }
    recordPageIndex = 0;
    updateRecordCardUI();

    const overlay = document.getElementById('record-card-overlay');
    const card = document.getElementById('record-card');

    if (rect) {
        const cardWidth = Math.min(window.innerWidth * 0.85, 340);
        const viewCenterX = window.innerWidth / 2;
        const viewCenterY = window.innerHeight / 2;
        const bookCenterX = rect.left + rect.width / 2;
        const bookCenterY = rect.top + rect.height / 2;
        card.style.transformOrigin = `${bookCenterX - (viewCenterX - cardWidth / 2)}px ${bookCenterY - (viewCenterY - 150)}px`;
    } else {
        card.style.transformOrigin = 'center center';
    }

    overlay.style.display = 'flex';
    setTimeout(() => card.classList.add('active'), 10);
}

function updateRecordCardUI() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta) return;
    const card = meta.recordCards[recordPageIndex];
    document.getElementById('record-title').value = card.title;
    document.getElementById('record-time').innerText = card.time;
    document.getElementById('record-content').value = card.content;
    document.getElementById('record-chapter').value = card.chapter || "";
    document.getElementById('record-page-info').innerText = `${recordPageIndex + 1} / ${meta.recordCards.length}`;
}

function saveRecordData() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta || !meta.recordCards || !meta.recordCards[recordPageIndex]) return;
    meta.recordCards[recordPageIndex].title = document.getElementById('record-title').value;
    meta.recordCards[recordPageIndex].content = document.getElementById('record-content').value;
    meta.recordCards[recordPageIndex].chapter = document.getElementById('record-chapter').value;
    saveMeta(meta);
}

function addRecordPage() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta) return;
    let currentChapter = "";
    if (document.getElementById('reader-view').style.display === 'block' && chapters[currentChapterIdx]) {
        currentChapter = chapters[currentChapterIdx].title;
    }
    meta.recordCards.push({ title: "新记录", time: new Date().toLocaleDateString(), content: "", chapter: currentChapter });
    recordPageIndex = meta.recordCards.length - 1;
    updateRecordCardUI();
    saveMeta(meta);
}

function prevRecordPage() {
    if (recordPageIndex > 0) { recordPageIndex--; updateRecordCardUI(); }
}

function nextRecordPage() {
    const meta = books.find(b => b.id === currentBookId);
    if (meta && recordPageIndex < meta.recordCards.length - 1) { recordPageIndex++; updateRecordCardUI(); }
}

function deleteRecordPage() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta || !meta.recordCards || meta.recordCards.length === 0) return;
    if (confirm('确定要删除这一页记录吗？此操作不可撤销。')) {
        meta.recordCards.splice(recordPageIndex, 1);
        if (meta.recordCards.length === 0) {
            meta.recordCards.push({ title: "阅读记录", time: new Date().toLocaleDateString(), content: "", chapter: "" });
        }
        if (recordPageIndex >= meta.recordCards.length) recordPageIndex = meta.recordCards.length - 1;
        updateRecordCardUI();
        saveMeta(meta);
    }
}

function closeRecordCard() {
    saveRecordData();
    const card = document.getElementById('record-card');
    card.classList.remove('active');
    setTimeout(() => { document.getElementById('record-card-overlay').style.display = 'none'; }, 500);
}

function openNotesEditCard() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta) return;
    document.getElementById('notes-edit-content').value = meta.notes || '';
    document.getElementById('notes-edit-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('notes-edit-card').classList.add('active'), 10);
}

function saveNotesEditCard() {
    const meta = books.find(b => b.id === currentBookId);
    if (!meta) return;
    meta.notes = document.getElementById('notes-edit-content').value;
    saveMeta(meta);
    document.getElementById('reader-notes-display').innerText = meta.notes || '无备注';
    closeNotesEditCard();
}

function closeNotesEditCard() {
    const card = document.getElementById('notes-edit-card');
    card.classList.remove('active');
    setTimeout(() => { document.getElementById('notes-edit-overlay').style.display = 'none'; }, 500);
}

/* ═══════════ 手势 ═══════════ */

function setupMenuSwipe() {
    const menu = document.getElementById('bottom-menu');
    menu.addEventListener('touchstart', (e) => { menuStartX = e.touches[0].clientX; }, { passive: true });
    menu.addEventListener('touchend', (e) => {
        const diff = menuStartX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) {
            if (diff > 0 && currentMenuIdx < 2) switchReaderMenu(currentMenuIdx + 1);
            else if (diff < 0 && currentMenuIdx > 0) switchReaderMenu(currentMenuIdx - 1);
        }
    }, { passive: true });
}

function setupSwipeInteractions() {
    setupMenuSwipe();
    const editSlider = document.getElementById('edit-slider');
    let editStartX = 0;
    editSlider.addEventListener('touchstart', e => editStartX = e.touches[0].clientX, { passive: true });
    editSlider.addEventListener('touchend', e => {
        let diff = editStartX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) switchEditPage(diff > 0 ? 1 : 0);
    }, { passive: true });

    const recordCard = document.getElementById('record-card');
    let recStartX = 0;
    recordCard.addEventListener('touchstart', e => recStartX = e.touches[0].clientX, { passive: true });
    recordCard.addEventListener('touchend', e => {
        let diff = recStartX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) { if (diff > 0) nextRecordPage(); else prevRecordPage(); }
    }, { passive: true });
}

/* ═══════════ 字体 / 背景 ═══════════ */

function applyFontURL() {
    const url = document.getElementById('font-url-input').value.trim();
    if (!url) return;
    const style = document.createElement('style');
    style.innerHTML = `@font-face { font-family: 'CustomFont'; src: url('${url}'); }`;
    document.head.appendChild(style);
    document.getElementById('reader-content').style.fontFamily = "'CustomFont', serif";
}

function applyFontFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        const style = document.createElement('style');
        style.innerHTML = `@font-face { font-family: 'CustomFont'; src: url('${event.target.result}'); }`;
        document.head.appendChild(style);
        document.getElementById('reader-content').style.fontFamily = "'CustomFont', serif";
    };
    reader.readAsDataURL(file);
}

function setReaderBG(bg, text) {
    const rv = document.getElementById('reader-view');
    rv.style.backgroundImage = 'none';
    rv.style.backgroundColor = bg;
    const rc = document.getElementById('reader-content');
    rc.style.color = text;
    document.getElementById('reader-nav').style.color = text;
    rc.style.setProperty('--accent-color', text);
}

function applyBGURL() {
    const url = document.getElementById('bg-url-input').value.trim();
    if (!url) return;
    document.getElementById('reader-view').style.backgroundImage = `url('${url}')`;
}

function applyBGFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        document.getElementById('reader-view').style.backgroundImage = `url('${event.target.result}')`;
    };
    reader.readAsDataURL(file);
}

/* ═══════════ 书籍 / 分类 ═══════════ */

function saveCats() { localStorage.setItem('yy_cats_v22', JSON.stringify(categories)); }
function closeModal(id) { document.getElementById(id).style.display = 'none'; tempCoverData = ""; }

function openCatModal() {
    document.getElementById('cat-manager-list').innerHTML = categories.map((c, i) =>
        `<li style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border-color); font-size: 0.9rem;">${escapeHTML(c)} <span style="color:#ff4444; font-weight:bold; cursor:pointer;" onclick="deleteCategory(${i})">删除</span></li>`).join('');
    document.getElementById('cat-modal').style.display = 'flex';
}

function addCategory() {
    const n = document.getElementById('new-cat-name').value.trim();
    if (n && !categories.includes(n)) { categories.push(n); saveCats(); openCatModal(); renderCategoryBar(); }
}

function deleteCategory(i) {
    const d = categories.splice(i, 1)[0];
    books.forEach(b => { if (b.category === d) { b.category = categories[0] || '其他'; saveMeta(b); } });
    saveCats(); openCatModal(); renderCategoryBar(); renderBookshelf();
}

function openEditModal(id) {
    currentBookId = id;
    const b = books.find(x => x.id === id);
    if (!b) return;
    document.getElementById('edit-category').innerHTML = categories.map(c => `<option value="${escapeHTML(c)}" ${c === b.category ? 'selected' : ''}>${escapeHTML(c)}</option>`).join('');
    document.getElementById('edit-name').value = b.name;
    document.getElementById('edit-author').value = b.author || '';
    document.getElementById('edit-show-title').checked = b.showTitleOnCover !== false;
    document.getElementById('edit-notes').value = b.notes || '';
    tempCoverData = b.cover;
    updatePreview(b.cover, b.name, b.showTitleOnCover !== false);
    ensureEncodingUI();
    syncEncodingUI(b);
    switchEditPage(0);
    document.getElementById('edit-modal').style.display = 'flex';
}

function switchEditPage(idx) {
    document.getElementById('edit-slider').style.transform = `translateX(-${idx * 50}%)`;
    document.getElementById('dot-0').classList.toggle('active', idx === 0);
    document.getElementById('dot-1').classList.toggle('active', idx === 1);
}

function handleCoverUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        tempCoverData = e.target.result;
        updatePreview(tempCoverData, document.getElementById('edit-name').value, document.getElementById('edit-show-title').checked);
    };
    reader.readAsDataURL(file);
}

function syncPreviewTitle(val) { updatePreview(tempCoverData, val, document.getElementById('edit-show-title').checked); }

function updatePreview(src, title, show) {
    const preview = document.getElementById('edit-cover-preview');
    preview.innerHTML = (src ? `<img src="${src}">` : "") + (show ? `<div class="cover-preview-text">${escapeHTML((title || '').substring(0, 10))}</div>` : "");
}

function openEditModalFromReader() { openEditModal(currentBookId); }

function saveBookDetails() {
    const b = books.find(x => x.id === currentBookId);
    if (!b) return;
    const newName = document.getElementById('edit-name').value;
    b.name = newName;
    b.author = document.getElementById('edit-author').value;
    b.cover = tempCoverData;
    b.category = document.getElementById('edit-category').value;
    b.showTitleOnCover = document.getElementById('edit-show-title').checked;
    b.notes = document.getElementById('edit-notes').value;
    saveMeta(b);

    // books 存储里的 name 同步一份，导出备份时用得到
    getBookRecord(b.id).then(rec => {
        if (rec && rec.name !== newName) {
            rec.name = newName;
            txStore(STORE_NAME, 'readwrite').put(rec);
        }
    }).catch(() => {});

    renderBookshelf();
    if (document.getElementById('reader-view').style.display === 'block') {
        document.getElementById('reader-book-title').innerText = b.name;
        document.getElementById('reader-notes-display').innerText = b.notes || '无备注';
        document.getElementById('side-title').innerText = b.name;
        const sAuthor = document.getElementById('side-author');
        if (b.author) { sAuthor.innerText = b.author; sAuthor.style.display = 'block'; }
        else { sAuthor.style.display = 'none'; }
    }
    closeModal('edit-modal');
}

function deleteBook() {
    if (confirm('确定移除此书吗？')) {
        const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
        tx.objectStore(STORE_NAME).delete(currentBookId);
        tx.objectStore(META_STORE).delete(currentBookId);
        books = books.filter(x => x.id !== currentBookId);
        renderBookshelf();
        closeModal('edit-modal');
        closeReader();
    }
}

function handleSelection(e) {
    const s = window.getSelection(), m = document.getElementById('selection-menu');
    if (s.toString().length > 0) {
        const r = s.getRangeAt(0).getBoundingClientRect();
        m.style.display = 'block';
        m.style.top = `${r.top + window.scrollY - 50}px`;
        m.style.left = `${r.left + r.width / 2 - 60}px`;
    } else m.style.display = 'none';
}

/* 标注只做视觉效果，不回写正文 */
function annotate(c) {
    const s = window.getSelection();
    if (!s.rangeCount) return;
    try {
        const n = document.createElement('span');
        n.className = c;
        s.getRangeAt(0).surroundContents(n);
    } catch (err) {
        toast('这段跨了段落，选小一点再试');
    }
    s.removeAllRanges();
    document.getElementById('selection-menu').style.display = 'none';
}

function openThemeModal() { document.getElementById('theme-modal').style.display = 'flex'; }

// ── 发现页：拖拽导入 ──
function handleDiscoverDrop(e) {
    e.preventDefault();
    importFiles({ target: { files: Array.from(e.dataTransfer.files), value: '' } });
}

// ── 发现页：搜索笔记（只查 meta，不触碰正文）──
function searchNotes(query) {
    const resultsDiv = document.getElementById('note-search-results');
    if (!query.trim()) { resultsDiv.innerHTML = ''; return; }
    const q = query.toLowerCase();
    const hits = [];
    books.forEach(b => {
        if (b.notes && b.notes.toLowerCase().includes(q)) {
            const idx = b.notes.toLowerCase().indexOf(q);
            const snippet = b.notes.substring(Math.max(0, idx - 30), idx + 60).replace(/\n/g, ' ');
            hits.push({ bookName: b.name, bookId: b.id, type: '备注', snippet });
        }
        if (b.recordCards && b.recordCards.length) {
            b.recordCards.forEach(card => {
                const haystack = ((card.title || '') + ' ' + (card.content || '')).toLowerCase();
                if (haystack.includes(q)) {
                    const full = (card.title ? card.title + '：' : '') + (card.content || '');
                    const idx2 = full.toLowerCase().indexOf(q);
                    const snippet = full.substring(Math.max(0, idx2 - 20), idx2 + 60).replace(/\n/g, ' ');
                    hits.push({ bookName: b.name, bookId: b.id, type: '记录卡', snippet });
                }
            });
        }
    });

    if (!hits.length) {
        resultsDiv.innerHTML = '<div style="text-align:center; padding:30px 0; opacity:0.4; font-size:0.85rem;">未找到相关笔记</div>';
        return;
    }

    const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    resultsDiv.innerHTML = hits.map(h => {
        const highlighted = escapeHTML(h.snippet).replace(regex, '<span style="background:var(--highlight-color); border-radius:2px;">$1</span>');
        return `<div onclick="openReader(${h.bookId})" style="background:var(--card-bg); border:1px solid var(--border-color); border-radius:10px; padding:14px 16px; margin-bottom:10px; cursor:pointer;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span style="font-size:0.85rem; font-weight:bold; color:var(--text-color);">${escapeHTML(h.bookName)}</span>
                <span style="font-size:0.65rem; color:var(--accent-color); opacity:0.8; letter-spacing:1px;">${h.type}</span>
            </div>
            <div style="font-size:0.78rem; opacity:0.65; line-height:1.6;">…${highlighted}…</div>
        </div>`;
    }).join('');
}

/* ── 关于页：导出备份（游标逐本拼装，避免一次性全量入内存）── */
async function exportBackup() {
    const toastEl = document.getElementById('backup-toast');
    toastEl.style.display = 'block';
    toastEl.textContent = '正在打包备份…';
    try {
        const metaById = new Map(books.map(m => [m.id, m]));
        const parts = ['\uFEFF{"version":"2.5","exportTime":"' + new Date().toISOString() + '","categories":'
            + JSON.stringify(categories) + ',"books":['];

        await new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const cursorReq = tx.objectStore(STORE_NAME).openCursor();
            let first = true;
            cursorReq.onsuccess = (ev) => {
                const cur = ev.target.result;
                if (!cur) return;
                const rec = cur.value;
                const meta = metaById.get(rec.id) || {};
                const out = Object.assign({}, meta, {
                    id: rec.id,
                    name: meta.name || rec.name,
                    content: rec.content || '',
                    encoding: rec.encoding || meta.encoding || ''
                });
                delete out.hasRaw;
                delete out.charCount;
                delete out.garbled;
                parts.push((first ? '' : ',') + JSON.stringify(out));
                first = false;
                cur.continue();
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });

        parts.push(']}');
        const blob = new Blob(parts, { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '藏书馆备份_' + new Date().toLocaleDateString('zh-CN').replace(/\//g, '-') + '.cangshuguan';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toastEl.textContent = '✓ 备份已导出';
    } catch (e) {
        toastEl.textContent = '导出失败：' + (e && e.message ? e.message : '未知错误');
    }
    setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
}

/* ── 关于页：导入备份 ── */
async function importBackup(event) {
    const toastEl = document.getElementById('backup-toast');
    const file = event.target.files[0];
    if (!file) return;
    toastEl.style.display = 'block';
    toastEl.textContent = '正在读取备份…';
    try {
        const { text } = await detectAndDecode(file);
        const backup = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!backup.books || !Array.isArray(backup.books)) throw new Error('备份文件格式错误');

        if (backup.categories && Array.isArray(backup.categories)) {
            backup.categories.forEach(c => { if (!categories.includes(c)) categories.push(c); });
            saveCats();
        }

        const existingIds = new Set(books.map(b => b.id));
        let added = 0;
        const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
        const bookStore = tx.objectStore(STORE_NAME);
        const metaStore = tx.objectStore(META_STORE);
        for (const item of backup.books) {
            if (existingIds.has(item.id)) continue;
            bookStore.put({
                id: item.id,
                name: item.name || '未命名',
                content: item.content || '',
                encoding: item.encoding || ''
            });
            const meta = buildMeta(item);
            meta.hasRaw = false;   // 备份不含原始字节
            metaStore.put(meta);
            books.push(meta);
            added++;
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });

        renderCategoryBar();
        renderBookshelf();
        toastEl.textContent = `✓ 已导入 ${added} 本书籍`;
    } catch (e) {
        toastEl.textContent = '导入失败：' + (e && e.message ? e.message : '未知错误');
    }
    event.target.value = '';
    setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem('yy_theme_v22') === 'auto') applyTheme('auto');
});