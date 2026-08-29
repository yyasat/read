document.addEventListener('contextmenu', function(e) { e.preventDefault(); });

let db;
const DB_NAME = "YanYeDB_Precision_V22";
const STORE_NAME = "books";
let books = [];
let categories = JSON.parse(localStorage.getItem('yy_cats_v22')) || ['文学', '随笔', '其他'];
let currentBookId = null;
let currentFilter = '全部';
let tempCoverData = "";
let menuStartX = 0;
let currentMenuIdx = 0;
let searchClickTimer = null;
let loadingTimer = null;
let searchReturnTimeout = null;
let recordTouchY = 0;
let recordTouchTime = 0;
let recordPageIndex = 0;

/* ═══════════ 阅读器状态 ═══════════
   chapters 只存 {title, from, to} 偏移量，正文按需从 bookContent 切片，
   避免把整本书再复制一份。DOM 里只保留 loadedStart..loadedEnd 这一段章节。
   ══════════════════════════════════ */
let bookContent = "";
let chapters = [];
let currentChapterIdx = 0;
let loadedStart = 0;
let loadedEnd = -1;
let tocRendered = false;
let progressSaveTimer = null;
let seekTimer = null;
let isAdjusting = false;

const WINDOW_MAX = 7;      // DOM 中最多保留的章节数
const EDGE_PX = 1200;      // 距上/下边缘多少像素开始续载
const HEADER_OFFSET = 80;  // 顶栏遮挡高度，判定「当前章」用

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

/* 数据库版本 2：rawFile 存原始字节，用于随时切换编码重新解码 */
const request = indexedDB.open(DB_NAME, 2);
request.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
};
request.onsuccess = (e) => { db = e.target.result; loadBooksFromDB(); };
request.onerror = () => { alert('数据库打开失败，请检查浏览器是否允许本地存储。'); };

function loadBooksFromDB() {
    const store = db.transaction([STORE_NAME], "readonly").objectStore(STORE_NAME);
    const getAll = store.getAll();
    getAll.onsuccess = () => { books = getAll.result; init(); };
}

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
    if (document.getElementById(`opt-${mode}`)) document.getElementById(`opt-${mode}`).classList.add('active');
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

    const navs = document.querySelectorAll('.nav-btn');
    navs.forEach((n, idx) => {
        const isMatch = (tab === 'archive' && idx === 0) || (tab === 'discover' && idx === 1) || (tab === 'about' && idx === 2);
        n.classList.toggle('active', isMatch);
    });
}

function renderCategoryBar() {
    const bar = document.getElementById('category-bar');
    let html = `<span class="cat-item ${currentFilter === '全部' ? 'active' : ''}" onclick="filterCategory('全部')">全部</span>`;
    categories.forEach(cat => html += `<span class="cat-item ${currentFilter === cat ? 'active' : ''}" onclick="filterCategory('${cat}')">${cat}</span>`);
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
            if (diffTime > 400 && diffY > 40) {
                openRecordCard(book.id);
            }
        }, { passive: true });

        card.onclick = () => {
            const now = Date.now();
            if (now - lastClick < 300) {
                clearTimeout(card.clickTimer);
                openEditModal(book.id);
            } else {
                card.clickTimer = setTimeout(() => {
                    openReader(book.id);
                }, 300);
            }
            lastClick = now;
        };

        card.oncontextmenu = (e) => { e.preventDefault(); };
        const showTitle = book.showTitleOnCover !== false;
        const lastRead = book.lastReadChapterTitle ? `上次读到：${book.lastReadChapterTitle}` : '从未读过';
        const garbledFlag = isGarbled(book.content) ? `<div class="book-garbled-tip" onclick="event.stopPropagation(); showGarbledHelp(${book.id})">编码异常</div>` : '';
        card.innerHTML = `
            <div class="book-cover-wrap">
                <div class="book-index">${idx}</div>
                ${garbledFlag}
                <div class="book-cover">${book.cover ? `<img src="${book.cover}" class="book-cover-img">` : ''}${showTitle ? `<div class="book-cover-text">${escapeHTML(book.name.substring(0, 12))}</div>` : ''}</div>
            </div>
            <div class="book-info">
                <h3>${escapeHTML(book.name)}</h3>
                <div class="book-last-read">${escapeHTML(lastRead)}</div>
                <div class="book-meta"><span class="book-tag">${escapeHTML(book.category)}</span><span>${Math.round((book.content || '').length / 1000)}k 字</span></div>
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
    const book = books.find(b => b.id === id);
    if (book && book.rawFile) {
        if (confirm('检测到这本书解码有误。\n\n原始文件已保存，可以直接用 GBK 重新解码，不用删书重导。要现在试一下吗？')) {
            reDecodeBook(id, 'gb18030');
        }
        return;
    }
    alert('这本书是旧版本导入的，没有保存原始文件字节，无法就地修复。\n\n请双击此书 → 移除此书，然后重新导入同一个 TXT。新版本会自动识别 GBK。');
}

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

    if (searchReturnTimeout) {
        clearTimeout(searchReturnTimeout);
        searchReturnTimeout = null;
    }

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

        setTimeout(() => {
            panel.classList.add('open');
        }, 800);
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
                        ${b.cover ? `<img src="${b.cover}" style="width:100%; height:100%; object-fit:cover;">` : ''}
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
        }, 300);
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
    if (currentFilter !== '全部' && book.category !== currentFilter) {
        filterCategory('全部');
    }
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
   FileReader.readAsText(file, '编码名') 走浏览器传统解码路径，
   兼容性比 TextDecoder 好，老版 Android WebView 上更可靠。
   TextDecoder 只负责 BOM 和严格 UTF-8 校验。
   ═══════════════════════════════════════════ */

const ENCODING_LABELS = {
    'gb18030': '简体中文 GBK / GB18030',
    'gbk': '简体中文 GBK',
    'big5': '繁体中文 BIG5',
    'utf-8': 'UTF-8',
    'utf-16le': 'UTF-16 LE',
    'utf-16be': 'UTF-16 BE'
};

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
        reader.        onerror = () => resolve(null);
        try {
            reader.readAsText(blob, encoding);
        } catch (err) {
            resolve(null);
        }
    });
}

// 有没有 BOM，顺便判断是不是合法 UTF-8
function inspectBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        return { bom: 'utf-8' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return { bom: 'utf-16le' };
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return { bom: 'utf-16be' };
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return { bom: null, strictUtf8: true };
    } catch (e) {
        return { bom: null, strictUtf8: false };
    }
}

async function detectAndDecode(blob) {
    const buffer = await readFileAsBuffer(blob);
    const info = inspectBytes(buffer);

    if (info.bom) {
        const text = await readBlobAsText(blob, info.bom);
        if (text !== null) {
            return { text: text.replace(/^\uFEFF/, ''), encoding: info.bom };
        }
    }

    if (info.strictUtf8) {
        const text = await readBlobAsText(blob, 'utf-8');
        if (text !== null) return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
    }

    const candidates = ['gb18030', 'gbk', 'big5', 'utf-8'];
    const results = [];
    for (const enc of candidates) {
        const text = await readBlobAsText(blob, enc);
        if (text === null || text === '') continue;
        const s = scoreDecoded(text);
        results.push({ encoding: enc, text, bad: s.bad, cjk: s.cjk });
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
    return { text: best.text, encoding: best.encoding };
}

/* 用指定编码重新解码已入库的书 */
async function reDecodeBook(id, encoding) {
    const book = books.find(b => b.id === id);
    if (!book) return;
    if (!book.rawFile) {
        alert('这本书没有保存原始文件，无法重新解码。请移除后重新导入。');
        return;
    }
    try {
        let text;
        if (encoding === 'auto') {
            const r = await detectAndDecode(book.rawFile);
            text = r.text;
            book.encoding = r.encoding;
        } else {
            text = await readBlobAsText(book.rawFile, encoding);
            if (text === null) throw new Error('该编码不被当前浏览器支持');
            book.encoding = encoding;
        }
        book.content = text.replace(/^\uFEFF/, '');
        book.lastReadChapterIdx = 0;
        book.lastReadChapterTitle = '';
        book.lastReadChapterRatio = 0;
        book.lastReadOffset = 0;
        updateBookInDB(book);
        renderBookshelf();
        syncEncodingUI(book);
        toast(isGarbled(book.content) ? `${book.encoding} 解码后仍有乱码，换一个试试` : `✓ 已用 ${book.encoding} 重新解码`);
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

function syncEncodingUI(book) {
    const sel = document.getElementById('edit-encoding');
    const hint = document.getElementById('encoding-hint');
    if (!sel || !hint) return;
    const cur = (book.encoding || '').toLowerCase();
    sel.value = ['gb18030', 'big5', 'utf-8', 'utf-16le'].includes(cur) ? cur : 'auto';
    if (!book.rawFile) {
        hint.textContent = '这本书导入时没有保存原始文件，无法重新解码。移除后重新导入即可获得此功能。';
        sel.disabled = true;
    } else {
        sel.disabled = false;
        hint.textContent = `当前编码：${book.encoding || '未知'}。若正文是乱码，换一个编码重新解码（阅读进度会重置）。`;
    }
}

async function importFiles(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    const report = [];
    for (const file of files) {
        try {
            const { text, encoding } = await detectAndDecode(file);
            const newBook = {
                id: Date.now() + Math.random(),
                name: file.name.replace(/\.[^/.]+$/, ""),
                author: "",
                content: text,
                encoding: encoding,
                rawFile: file,
                category: categories[0] || '其他',
                cover: '',
                showTitleOnCover: true,
                annotations: [],
                lastReadChapterIdx: 0,
                lastReadChapterTitle: "",
                lastReadChapterRatio: 0,
                lastReadOffset: 0,
                notes: "",
                recordCards: []
            };
            books.push(newBook);
            db.transaction([STORE_NAME], "readwrite").objectStore(STORE_NAME).add(newBook);
            report.push({ name: newBook.name, encoding, garbled: isGarbled(text) });
        } catch (err) {
            report.push({ name: file.name, encoding: '读取失败', garbled: true });
        }
    }
    renderBookshelf();
    event.target.value = '';

    if (report.length) {
        const bad = report.filter(r => r.garbled);
        if (bad.length) {
            toast(`导入 ${report.length} 本，${bad.length} 本仍有乱码，双击该书手动选编码`);
        } else {
            toast(`✓ 已导入 ${report.length} 本 · 编码 ${report[0].encoding}`);
        }
    }
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════
   阅读器：章节窗口化渲染
   一次只把当前章前后各一章放进 DOM，滚到边缘再续接，
   超过 WINDOW_MAX 章就从另一头卸掉并补偿 scrollTop。
   ═══════════════════════════════════════════ */

// 只扫一遍全文，记录每章在 content 里的起止下标，不复制字符串
function parseChapters(text) {
    const re = /第[零一二三四五六七八九十百千万两\d]{1,12}[章节回部集卷篇]|Chapter\s*\d+/gi;
    const marks = [];
    let m;
    while ((m = re.exec(text)) !== null) {
        marks.push(m.index);
        if (re.lastIndex === m.index) re.lastIndex++;
    }

    const list = [];
    const firstStart = marks.length ? marks[0] : text.length;
    if (text.slice(0, Math.min(firstStart, 4000)).trim().length > 0) {
        list.push({ title: '正文开始', from: 0, to: firstStart });
    }
    for (let i = 0; i < marks.length; i++) {
        const from = marks[i];
        const to = (i + 1 < marks.length) ? marks[i + 1] : text.length;
        if (to - from < 2) continue;
        list.push({ title: '', from, to });
    }
    if (list.length === 0) list.push({ title: '正文', from: 0, to: text.length });

    list.forEach((c, i) => {
        if (!c.title) {
            const head = text.slice(c.from, Math.min(c.to, c.from + 120));
            const line = head.split(/\r?\n/)[0].trim();
            c.title = line ? line.slice(0, 40) : `第 ${i} 节`;
        }
    });
    return list;
}

function chapterHTML(i) {
    const ch = chapters[i];
    return `<div class="chapter-wrapper" data-index="${i}">`
        + `<div class="chapter-title-divider">${escapeHTML(ch.title)}</div>`
        + `<div class="chapter-body">${escapeHTML(bookContent.slice(ch.from, ch.to))}</div>`
        + `</div>`;
}

// 以 centerIdx 为中心重建窗口（前后各一章）
function renderWindow(centerIdx) {
    const container = document.getElementById('reader-content');
    loadedStart = Math.max(0, centerIdx - 1);
    loadedEnd = Math.min(chapters.length - 1, centerIdx + 1);
    let html = '';
    for (let i = loadedStart; i <= loadedEnd; i++) html += chapterHTML(i);
    container.innerHTML = html;
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

// 章节太短时补足，保证内容高过一屏，否则没法滚动去触发续载
function fillViewport() {
    const area = document.getElementById('reader-scroll-area');
    let guard = 0;
    while (area.scrollHeight < area.clientHeight * 2 && guard < WINDOW_MAX) {
        if (!appendNext()) break;
        guard++;
    }
}

function openReader(id) {
    const loader = document.getElementById('loading-overlay');
    const quoteText = document.getElementById('loading-quote-text');
    loader.style.display = 'flex';
    loader.style.opacity = '1';
    quoteText.innerText = quotes[Math.floor(Math.random() * quotes.length)];

    // 先让转圈画出来，再做重活
    loadingTimer = setTimeout(() => {
        const book = books.find(b => b.id === id);
        if (!book) { abortLoading(); return; }
        currentBookId = id;

        document.getElementById('reader-book-title').innerText = book.name;
        document.getElementById('reader-notes-display').innerText = book.notes || '无备注';
        document.getElementById('side-title').innerText = book.name;
        const sAuthor = document.getElementById('side-author');
        if (book.author) { sAuthor.innerText = book.author; sAuthor.style.display = 'block'; }
        else { sAuthor.style.display = 'none'; }

        bookContent = book.content || '';
        chapters = parseChapters(bookContent);
        tocRendered = false;
        document.getElementById('toc-list').innerHTML =
            '<div style="padding:20px 25px; opacity:0.4; font-size:0.85rem;">目录准备中…</div>';

        const startIdx = Math.min(Math.max(book.lastReadChapterIdx || 0, 0), chapters.length - 1);
        const startRatio = typeof book.lastReadChapterRatio === 'number' ? book.lastReadChapterRatio : 0;

        renderWindow(startIdx);

        document.getElementById('home-view').style.display = 'none';
        document.getElementById('reader-view').style.display = 'block';

        requestAnimationFrame(() => {
            const area = document.getElementById('reader-scroll-area');
            const w = getWrapper(startIdx);
            if (w) {
                area.scrollTop = Math.max(0, w.offsetTop + startRatio * w.offsetHeight - HEADER_OFFSET);
            }
            fillViewport();
            updateActiveChapterUI(startIdx, false);
            updateProgressBars();

            loader.style.opacity = '0';
            setTimeout(() => {
                if (loader.style.opacity === '0') {
                    loader.style.display = 'none';
                    loader.style.opacity = '1';
                }
            }, 200);
        });
    }, 16);
}

function abortLoading() {
    if (loadingTimer) clearTimeout(loadingTimer);
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

// 进度写库限流，避免滚动时高频事务
function scheduleProgressSave() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(saveProgressNow, 600);
}

function saveProgressNow() {
    const book = books.find(b => b.id === currentBookId);
    if (!book || !chapters.length) return;
    book.lastReadChapterIdx = currentChapterIdx;
    book.lastReadChapterTitle = chapters[currentChapterIdx].title;
    book.lastReadChapterRatio = currentChapterRatio();
    updateBookInDB(book);
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

// 跳章：目标不在窗口内就重建窗口
function goToChapter(idx, ratio = 0) {
    idx = Math.min(Math.max(idx, 0), chapters.length - 1);
    const area = document.getElementById('reader-scroll-area');

    if (idx < loadedStart || idx > loadedEnd) {
        renderWindow(idx);
    }
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
    // 拖动时不每帧重建 DOM，松手前的抖动全部合并成一次跳转
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

function jumpToChapter(idx) {
    goToChapter(idx, 0);
    closePanels();
}

// 目录可能上万条，等第一次打开侧栏再建
function renderTOC() {
    if (tocRendered) return;
    const list = document.getElementById('toc-list');
    const total = chapters.length;
    let html = '';
    for (let i = 0; i < total; i++) {
        html += `<div class="chapter-item${i === currentChapterIdx ? ' active' : ''}" data-toc="${i}" onclick="jumpToChapter(${i})">`
            + `<span>${escapeHTML(chapters[i].title)}</span>`
            + `<span style="font-size:0.7rem; opacity:0.5;">${Math.round((i + 1) / total * 100)}%</span>`
            + `</div>`;
    }
    list.innerHTML = html;
    tocRendered = true;
}

function closeReader() {
    clearTimeout(progressSaveTimer);
    saveProgressNow();

    const root = document.documentElement;
    localStorage.setItem('yy_font_size_v22', getComputedStyle(root).getPropertyValue('--font-size'));
    localStorage.setItem('yy_line_height_v22', getComputedStyle(root).getPropertyValue('--line-height'));

    document.getElementById('home-view').style.display = 'block';
    document.getElementById('reader-view').style.display = 'none';

    // 放掉正文和 DOM，别让整本书一直挂在内存里
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
    if (open) {
        updateProgressBars();
        switchReaderMenu(0);
    }
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
    const book = books.find(b => b.id === id);
    if (!book) return;
    const bookCard = document.getElementById('book-card-' + id);
    const rect = bookCard ? bookCard.getBoundingClientRect() : null;

    if (!book.recordCards) book.recordCards = [];

    let currentChapter = "";
    if (document.getElementById('reader-view').style.display === 'block' && chapters[currentChapterIdx]) {
        currentChapter = chapters[currentChapterIdx].title;
    }

    if (book.recordCards.length === 0) {
        book.recordCards.push({ title: "阅读记录", time: new Date().toLocaleDateString(), content: "", chapter: currentChapter });
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
    const book = books.find(b => b.id === currentBookId);
    if (!book) return;
    const card = book.recordCards[recordPageIndex];
    document.getElementById('record-title').value = card.title;
    document.getElementById('record-time').innerText = card.time;
    document.getElementById('record-content').value = card.content;
    document.getElementById('record-chapter').value = card.chapter || "";
    document.getElementById('record-page-info').innerText = `${recordPageIndex + 1} / ${book.recordCards.length}`;
}

function saveRecordData() {
    const book = books.find(b => b.id === currentBookId);
    if (!book || !book.recordCards || !book.recordCards[recordPageIndex]) return;
    book.recordCards[recordPageIndex].title = document.getElementById('record-title').value;
    book.recordCards[recordPageIndex].content = document.getElementById('record-content').value;
    book.recordCards[recordPageIndex].chapter = document.getElementById('record-chapter').value;
    updateBookInDB(book);
}

function addRecordPage() {
    const book = books.find(b => b.id === currentBookId);
    if (!book) return;
    let currentChapter = "";
    if (document.getElementById('reader-view').style.display === 'block' && chapters[currentChapterIdx]) {
        currentChapter = chapters[currentChapterIdx].title;
    }
    book.recordCards.push({ title: "新记录", time: new Date().toLocaleDateString(), content: "", chapter: currentChapter });
    recordPageIndex = book.recordCards.length - 1;
    updateRecordCardUI();
    updateBookInDB(book);
}

function prevRecordPage() {
    if (recordPageIndex > 0) { recordPageIndex--; updateRecordCardUI(); }
}

function nextRecordPage() {
    const book = books.find(b => b.id === currentBookId);
    if (book && recordPageIndex < book.recordCards.length - 1) { recordPageIndex++; updateRecordCardUI(); }
}

function deleteRecordPage() {
    const book = books.find(b => b.id === currentBookId);
    if (!book || !book.recordCards || book.recordCards.length === 0) return;
    if (confirm('确定要删除这一页记录吗？此操作不可撤销。')) {
        book.recordCards.splice(recordPageIndex, 1);
        if (book.recordCards.length === 0) {
            book.recordCards.push({ title: "阅读记录", time: new Date().toLocaleDateString(), content: "", chapter: "" });
        }
        if (recordPageIndex >= book.recordCards.length) recordPageIndex = book.recordCards.length - 1;
        updateRecordCardUI();
        updateBookInDB(book);
    }
}

function closeRecordCard() {
    saveRecordData();
    const card = document.getElementById('record-card');
    card.classList.remove('active');
    setTimeout(() => { document.getElementById('record-card-overlay').style.display = 'none'; }, 500);
}

function openNotesEditCard() {
    const book = books.find(b => b.id === currentBookId);
    if (!book) return;
    document.getElementById('notes-edit-content').value = book.notes || '';
    document.getElementById('notes-edit-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('notes-edit-card').classList.add('active'), 10);
}

function saveNotesEditCard() {
    const book = books.find(b => b.id === currentBookId);
    if (!book) return;
    book.notes = document.getElementById('notes-edit-content').value;
    updateBookInDB(book);
    document.getElementById('reader-notes-display').innerText = book.notes || '无备注';
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
    document.getElementById('reader-content').style.color = text;
    document.getElementById('reader-nav').style.color = text;
    // 章节标题颜色交给 CSS 变量，新增章节也能跟上
    document.getElementById('reader-content').style.setProperty('--accent-color', text);
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

function updateBookInDB(book) { db.transaction([STORE_NAME], "readwrite").objectStore(STORE_NAME).put(book); }
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
    books.forEach(b => { if (b.category === d) { b.category = categories[0] || '其他'; updateBookInDB(b); } });
    saveCats(); openCatModal(); renderCategoryBar(); renderBookshelf();
}

function openEditModal(id) {
    currentBookId = id;
    const b = books.find(x => x.id === id);
    if (!b) return;
    document.getElementById('edit-category').innerHTML = categories.map(c => `<option value="${c}" ${c === b.category ? 'selected' : ''}>${c}</option>`).join('');
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
    b.name = document.getElementById('edit-name').value;
    b.author = document.getElementById('edit-author').value;
    b.cover = tempCoverData;
    b.category = document.getElementById('edit-category').value;
    b.showTitleOnCover = document.getElementById('edit-show-title').checked;
    b.notes = document.getElementById('edit-notes').value;
    updateBookInDB(b);
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
        db.transaction([STORE_NAME], "readwrite").objectStore(STORE_NAME).delete(currentBookId);
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

/* 标注只做视觉效果，不再回写 book.content。
   窗口化渲染下 DOM 里只有几章，用 innerText 覆盖会把整本书截断。 */
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

// ── 发现页：搜索笔记 ──
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

// ── 关于页：导出备份 ──
async function exportBackup() {
    const toastEl = document.getElementById('backup-toast');
    toastEl.style.display = 'block';
    toastEl.textContent = '正在打包备份…';
    try {
        const allBooks = await new Promise((res, rej) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = rej;
        });
        const plainBooks = allBooks.map(b => {
            const copy = Object.assign({}, b);
            delete copy.rawFile;   // File 对象没法 JSON 序列化
            return copy;
        });
        const backup = {
            version: '2.4',
            exportTime: new Date().toISOString(),
            categories: JSON.parse(localStorage.getItem('yy_cats_v22') || '[]'),
            books: plainBooks
        };
        const blob = new Blob(['\uFEFF' + JSON.stringify(backup)], { type: 'application/json;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '藏书馆备份_' + new Date().toLocaleDateString('zh-CN').replace(/\//g, '-') + '.cangshuguan';
        a.click();
        URL.revokeObjectURL(a.href);
        toastEl.textContent = '✓ 备份已导出';
    } catch (e) {
        toastEl.textContent = '导出失败：' + e.message;
    }
    setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
}

// ── 关于页：导入备份 ──
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
            localStorage.setItem('yy_cats_v22', JSON.stringify(categories));
        }

        const existingIds = new Set(books.map(b => b.id));
        let added = 0;
        const tx = db.transaction([STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const book of backup.books) {
            if (!existingIds.has(book.id)) {
                store.add(book);
                books.push(book);
                added++;
            }
        }
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });

        renderCategoryBar();
        renderBookshelf();
        toastEl.textContent = `✓ 已导入 ${added} 本书籍`;
    } catch (e) {
        toastEl.textContent = '导入失败：' + e.message;
    }
    event.target.value = '';
    setTimeout(() => { toastEl.style.display = 'none'; }, 3000);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem('yy_theme_v22') === 'auto') applyTheme('auto');
});