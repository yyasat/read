/* ═══════════════════════════════════════════════════════════
   epub.js — EPUB 解析（ZIP + inflate + XHTML→受控 HTML + 图片/字体/CSS + 章节）
   对外只暴露 window.EpubKit = { isEpub, parse }
   parse(file, onProgress) -> {
     html, isHTML, textLength, chapters, images, css, title, author, cover
   }
   图片写成 <img data-eimg="e1">，images[key] = {u:dataURL, w, h}
   css 已作用域化到 #reader-content .epub-body，并内联 @font-face
   ═══════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    /* ── 常量 ── */

    const SCOPE = '#reader-content .epub-body';
    const PAGE_W = 600;                    // EPUB 排版假定页宽，px→% 换算基准
    const BASE_FS = 16;                    // px→em 换算基准
    const MAX_BLOCK = 24000;
    const IMG_MAX_W = 1400;
    const IMG_BUDGET = 14 * 1024 * 1024;
    const FONT_BUDGET = 8 * 1024 * 1024;
    const CSS_BUDGET = 500000;

    const nextTick = () => new Promise(r => setTimeout(r, 0));

    let currentFonts = null;               // 本次解析成功嵌入的字体家族（小写）

    function readFileBuffer(file) {
        if (file.arrayBuffer) return file.arrayBuffer();
        return new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = e => res(e.target.result);
            fr.onerror = () => rej(fr.error);
            fr.readAsArrayBuffer(file);
        });
    }

    const utf8Decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;

    function decodeUTF8(bytes) {
        if (utf8Decoder) return utf8Decoder.decode(bytes);
        let s = '', i = 0;
        while (i < bytes.length) {
            const c = bytes[i++];
            if (c < 0x80) s += String.fromCharCode(c);
            else if (c < 0xE0) s += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
            else if (c < 0xF0) s += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
            else {
                let cp = ((c & 7) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
                cp -= 0x10000;
                s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
            }
        }
        return s;
    }

    function decodeMaybe(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

    function dirOf(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }

    function resolvePath(base, href) {
        href = String(href || '').split('#')[0].replace(/^\.\//, '');
        if (!href) return '';
        if (/^(https?:|data:|mailto:)/i.test(href)) return '';
        href = decodeMaybe(href);
        const full = /^\//.test(href) ? href.slice(1) : dirOf(base) + href;
        const parts = full.split('/'), out = [];
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i];
            if (seg === '' || seg === '.') continue;
            if (seg === '..') { if (out.length) out.pop(); continue; }
            out.push(seg);
        }
        return out.join('/');
    }

    function escapeHTML(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function escapeAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /* ── inflate（raw deflate，RFC1951）── */

    const LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LEXT  = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DEXT  = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    const CLORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

    let fixedLitTree = null, fixedDistTree = null;

    function buildTree(lengths, n) {
        const counts = new Int32Array(16);
        for (let i = 0; i < n; i++) counts[lengths[i]]++;
        counts[0] = 0;
        const offs = new Int32Array(16);
        let total = 0;
        for (let l = 1; l < 16; l++) { offs[l] = total; total += counts[l]; }
        const symbols = new Int32Array(total);
        for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
        return { counts, symbols };
    }

    function inflateRaw(src) {
        let dst = new Uint8Array(Math.max(1024, src.length * 4)), dlen = 0;
        let pos = 0, bitbuf = 0, bitcnt = 0;

        function ensure(n) {
            if (dlen + n <= dst.length) return;
            let cap = dst.length;
            while (cap < dlen + n) cap *= 2;
            const nd = new Uint8Array(cap);
            nd.set(dst.subarray(0, dlen));
            dst = nd;
        }
        function bits(n) {
            while (bitcnt < n) {
                if (pos >= src.length) throw new Error('压缩流意外结束');
                bitbuf |= src[pos++] << bitcnt;
                bitcnt += 8;
            }
            const v = bitbuf & ((1 << n) - 1);
            bitbuf >>>= n; bitcnt -= n;
            return v;
        }
        function decode(t) {
            let code = 0, first = 0, index = 0;
            for (let len = 1; len < 16; len++) {
                code |= bits(1);
                const count = t.counts[len];
                if (code - first < count) return t.symbols[index + (code - first)];
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            throw new Error('霍夫曼码非法');
        }
        function initFixed() {
            if (fixedLitTree) return;
            const l = new Uint8Array(288);
            let i = 0;
            for (; i < 144; i++) l[i] = 8;
            for (; i < 256; i++) l[i] = 9;
            for (; i < 280; i++) l[i] = 7;
            for (; i < 288; i++) l[i] = 8;
            fixedLitTree = buildTree(l, 288);
            const d = new Uint8Array(30);
            for (i = 0; i < 30; i++) d[i] = 5;
            fixedDistTree = buildTree(d, 30);
        }

        let last = 0;
        do {
            last = bits(1);
            const type = bits(2);

            if (type === 0) {
                bitbuf = 0; bitcnt = 0;
                if (pos + 4 > src.length) throw new Error('stored 块头截断');
                const len = src[pos] | (src[pos + 1] << 8);
                const nlen = src[pos + 2] | (src[pos + 3] << 8);
                pos += 4;
                if ((len ^ 0xFFFF) !== nlen) throw new Error('stored 块长度校验失败');
                if (pos + len > src.length) throw new Error('stored 块数据截断');
                ensure(len);
                dst.set(src.subarray(pos, pos + len), dlen);
                dlen += len; pos += len;
            } else if (type === 1 || type === 2) {
                let tl, td;
                if (type === 1) { initFixed(); tl = fixedLitTree; td = fixedDistTree; }
                else {
                    const nlit = bits(5) + 257, ndist = bits(5) + 1, ncl = bits(4) + 4;
                    const cl = new Uint8Array(19);
                    for (let i = 0; i < ncl; i++) cl[CLORDER[i]] = bits(3);
                    const tcl = buildTree(cl, 19);
                    const lens = new Uint8Array(nlit + ndist);
                    let k = 0;
                    while (k < nlit + ndist) {
                        const sym = decode(tcl);
                        let rep, val;
                        if (sym < 16) lens[k++] = sym;
                        else if (sym === 16) {
                            if (k === 0) throw new Error('码长重复无前值');
                            val = lens[k - 1]; rep = 3 + bits(2);
                            while (rep-- > 0 && k < lens.length) lens[k++] = val;
                        } else if (sym === 17) {
                            rep = 3 + bits(3);
                            while (rep-- > 0 && k < lens.length) lens[k++] = 0;
                        } else {
                            rep = 11 + bits(7);
                            while (rep-- > 0 && k < lens.length) lens[k++] = 0;
                        }
                    }
                    tl = buildTree(lens.subarray(0, nlit), nlit);
                    td = buildTree(lens.subarray(nlit), ndist);
                }
                for (;;) {
                    let s = decode(tl);
                    if (s < 256) { ensure(1); dst[dlen++] = s; }
                    else if (s === 256) break;
                    else {
                        s -= 257;
                        if (s >= 29) throw new Error('长度码越界');
                        const length = LBASE[s] + bits(LEXT[s]);
                        const ds = decode(td);
                        if (ds >= 30) throw new Error('距离码越界');
                        const dist = DBASE[ds] + bits(DEXT[ds]);
                        if (dist > dlen) throw new Error('回溯距离超出已解数据');
                        ensure(length);
                        const from = dlen - dist;
                        for (let j = 0; j < length; j++) dst[dlen++] = dst[from + j];
                    }
                }
            } else throw new Error('未知 deflate 块类型');
        } while (!last);

        return dst.subarray(0, dlen);
    }

    let nativeInflate = null;
    async function detectNative() {
        if (nativeInflate !== null) return nativeInflate;
        nativeInflate = false;
        if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return false;
        try {
            const probe = new Uint8Array([0x4B, 0x04, 0x00]);
            const ds = new DecompressionStream('deflate-raw');
            const w = ds.writable.getWriter();
            w.write(probe); w.close();
            const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
            if (out.length === 1 && out[0] === 97) nativeInflate = true;
        } catch (e) { nativeInflate = false; }
        return nativeInflate;
    }

    async function inflate(bytes) {
        if (await detectNative()) {
            try {
                const ds = new DecompressionStream('deflate-raw');
                const w = ds.writable.getWriter();
                w.write(bytes); w.close();
                return new Uint8Array(await new Response(ds.readable).arrayBuffer());
            } catch (e) { /* 落回 JS 实现 */ }
        }
        return inflateRaw(bytes);
    }

    /* ── ZIP 中央目录 ── */

    function openZip(buffer) {
        const u8 = new Uint8Array(buffer);
        const dv = new DataView(buffer);
        if (u8.length < 22) throw new Error('文件过小，不是有效的 EPUB');

        let eocd = -1;
        const minPos = Math.max(0, u8.length - 66000);
        for (let i = u8.length - 22; i >= minPos; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('找不到 ZIP 目录，文件可能损坏或不是 EPUB');

        let count = dv.getUint16(eocd + 10, true);
        let cdOffset = dv.getUint32(eocd + 16, true);
        const cdSize = dv.getUint32(eocd + 12, true);

        if (count === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
            const loc = eocd - 20;
            if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50 && typeof dv.getBigUint64 === 'function') {
                const z64 = Number(dv.getBigUint64(loc + 8, true));
                if (z64 >= 0 && z64 + 56 <= u8.length && dv.getUint32(z64, true) === 0x06064b50) {
                    count = Number(dv.getBigUint64(z64 + 32, true));
                    cdOffset = Number(dv.getBigUint64(z64 + 48, true));
                }
            }
        }

        const entries = Object.create(null);
        const lower = Object.create(null);
        let p = cdOffset;

        for (let n = 0; n < count; n++) {
            if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
            let csize = dv.getUint32(p + 20, true);
            let usize = dv.getUint32(p + 24, true);
            let lho = dv.getUint32(p + 42, true);
            const method = dv.getUint16(p + 10, true);
            const nameLen = dv.getUint16(p + 28, true);
            const extraLen = dv.getUint16(p + 30, true);
            const cmtLen = dv.getUint16(p + 32, true);
            const name = decodeUTF8(u8.subarray(p + 46, p + 46 + nameLen));

            if ((csize === 0xFFFFFFFF || usize === 0xFFFFFFFF || lho === 0xFFFFFFFF)
                && typeof dv.getBigUint64 === 'function') {
                let ep = p + 46 + nameLen;
                const epEnd = ep + extraLen;
                while (ep + 4 <= epEnd) {
                    const hid = dv.getUint16(ep, true), hsz = dv.getUint16(ep + 2, true);
                    let q = ep + 4;
                    if (hid === 0x0001) {
                        if (usize === 0xFFFFFFFF) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
                        if (csize === 0xFFFFFFFF) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
                        if (lho === 0xFFFFFFFF) { lho = Number(dv.getBigUint64(q, true)); }
                        break;
                    }
                    ep += 4 + hsz;
                }
            }

            const entry = { name, method, csize, usize, lho };
            entries[name] = entry;
            lower[name.toLowerCase()] = entry;
            const dec = decodeMaybe(name);
            if (dec !== name && !entries[dec]) { entries[dec] = entry; lower[dec.toLowerCase()] = entry; }

            p += 46 + nameLen + extraLen + cmtLen;
        }

        function find(path) {
            if (!path) return null;
            if (entries[path]) return entries[path];
            const dec = decodeMaybe(path);
            if (entries[dec]) return entries[dec];
            return lower[String(path).toLowerCase()] || lower[String(dec).toLowerCase()] || null;
        }

        async function bytes(pathOrEntry) {
            const e = typeof pathOrEntry === 'string' ? find(pathOrEntry) : pathOrEntry;
            if (!e) return null;
            if (dv.getUint32(e.lho, true) !== 0x04034b50) throw new Error('局部文件头损坏：' + e.name);
            const nl = dv.getUint16(e.lho + 26, true);
            const el = dv.getUint16(e.lho + 28, true);
            const start = e.lho + 30 + nl + el;
            const raw = u8.subarray(start, start + e.csize);
            if (e.method === 0) return raw;
            if (e.method === 8) return await inflate(raw);
            throw new Error('不支持的压缩方式 ' + e.method + '（' + e.name + '）');
        }

        async function textOf(path) {
            const b = await bytes(path);
            return b ? decodeUTF8(b) : null;
        }

        return { entries, find, bytes, textOf, names: Object.keys(entries) };
    }

    /* ── XML 辅助 ── */

    function parseXML(str, preferXHTML) {
        const dp = new DOMParser();
        const types = preferXHTML ? ['application/xhtml+xml', 'text/html'] : ['text/xml', 'text/html'];
        for (let i = 0; i < types.length; i++) {
            try {
                const doc = dp.parseFromString(str, types[i]);
                if (doc && !doc.querySelector('parsererror')) return doc;
                if (i === types.length - 1 && doc) return doc;
            } catch (e) { /* 试下一个 */ }
        }
        return null;
    }

    function localTags(root, name) {
        const want = name.toLowerCase();
        const out = [];
        if (!root) return out;
        const all = root.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            const ln = (el.localName || el.nodeName || '').toLowerCase();
            if (ln === want || ln.split(':').pop() === want) out.push(el);
        }
        return out;
    }

    function firstLocal(root, name) { const l = localTags(root, name); return l.length ? l[0] : null; }
    function textOfEl(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

    /* ══════════ 颜色 ══════════ */

    const NAMED_COLORS = {
        black:[0,0,0,1], white:[255,255,255,1], silver:[192,192,192,1], gray:[128,128,128,1],
        grey:[128,128,128,1], red:[255,0,0,1], maroon:[128,0,0,1], yellow:[255,255,0,1],
        olive:[128,128,0,1], lime:[0,255,0,1], green:[0,128,0,1], aqua:[0,255,255,1],
        cyan:[0,255,255,1], teal:[0,128,128,1], blue:[0,0,255,1], navy:[0,0,128,1],
        fuchsia:[255,0,255,1], magenta:[255,0,255,1], purple:[128,0,128,1],
        orange:[255,165,0,1], brown:[165,42,42,1], pink:[255,192,203,1],
        transparent:[0,0,0,0]
    };

    function parseColor(v) {
        v = String(v || '').trim().toLowerCase();
        if (NAMED_COLORS[v]) return NAMED_COLORS[v].slice();
        let m = v.match(/^#([0-9a-f]{3})$/);
        if (m) return [parseInt(m[1][0]+m[1][0],16), parseInt(m[1][1]+m[1][1],16), parseInt(m[1][2]+m[1][2],16), 1];
        m = v.match(/^#([0-9a-f]{6})$/);
        if (m) return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16), 1];
        m = v.match(/^#([0-9a-f]{8})$/);
        if (m) return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16), parseInt(m[1].slice(6,8),16)/255];
        m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?/);
        if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        return null;
    }

    function luminance(c) { return (0.299*c[0] + 0.587*c[1] + 0.114*c[2]) / 255; }

    /* ══════════ CSS 净化 ══════════ */

    /* 直接丢弃：会脱离文档流、依赖包内资源、或与阅读器自身机制冲突 */
    const DROP_PROPS = /^(font|src|writing-mode|-epub-writing-mode|direction|unicode-bidi|list-style-image|background-image|background-attachment|background-blend-mode|page-break-.*|break-.*|column.*|-webkit-column.*|transform.*|animation.*|transition.*|will-change|filter|backdrop-filter|mix-blend-mode|content-visibility|contain|cursor|pointer-events|user-select|-webkit-user-select|-webkit-text-size-adjust|zoom)$/i;

    /* px→em：字号与间距类，跟随用户字号缩放 */
    const EM_PROPS = /^(font-size|line-height|text-indent|letter-spacing|word-spacing|margin|margin-.*|padding|padding-.*|top|right|bottom|left|border-radius|border-.*-radius|border-width|border-.*-width|gap|row-gap|column-gap|text-underline-offset|outline-offset|outline-width)$/i;

    /* px→%：宽度类，按 600px 页宽折算 */
    const PCT_PROPS = /^(width|min-width|max-width|flex-basis)$/i;

    /* 高度只接受相对单位，px 高度会在窄屏上裁掉内容 */
    const HEIGHT_PROPS = /^(height|min-height|max-height)$/i;

    function splitDecls(t) {
        const out = [];
        let depth = 0, cur = '';
        for (let i = 0; i < t.length; i++) {
            const c = t.charAt(i);
            if (c === '(') depth++;
            else if (c === ')') depth--;
            if (c === ';' && depth === 0) { out.push(cur); cur = ''; }
            else cur += c;
        }
        if (cur.trim()) out.push(cur);
        return out;
    }

    function trimNum(n) {
        let s = n.toFixed(3);
        if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
        return s;
    }

    function pxToEm(v) {
        return v.replace(/(-?[\d.]+)px/gi, (m, n) => trimNum(parseFloat(n) / BASE_FS) + 'em');
    }
    function pxToPct(v) {
        return v.replace(/(-?[\d.]+)px/gi, (m, n) => {
            const pct = parseFloat(n) / PAGE_W * 100;
            return trimNum(Math.max(0, Math.min(100, pct))) + '%';
        });
    }
    const hasRelUnit = v => /(em|rem|%|vh|vw|ex|ch)\s*$/i.test(v) || /^(auto|inherit|initial|unset|fit-content|min-content|max-content)$/i.test(v);

    function keepFontFamily(val) {
        if (!currentFonts || !currentFonts.size) return null;
        const names = String(val).split(',').map(s => s.trim().replace(/^["']|["']$/g, '').toLowerCase());
        for (let i = 0; i < names.length; i++) {
            if (currentFonts.has(names[i])) return val;
        }
        return null;   // 字体没嵌进来就别指定，免得掉到 Times New Roman
    }

    /* 前景/背景成对判断：
       - 同一规则里前景 + 背景都在 → 原样保留，对比关系是作者定的
       - 只有前景且是极端色 → 一个主题留原值，另一个主题发覆盖规则
       - 只有不透明背景 → 按背景亮度补一个前景色 */
    function processDecls(text, isInline) {
        const pairs = [];
        splitDecls(text).forEach(one => {
            const idx = one.indexOf(':');
            if (idx <= 0) return;
            const prop = one.slice(0, idx).trim().toLowerCase();
            const val = one.slice(idx + 1).replace(/!\s*important/gi, '').trim();
            if (prop && val && !/[{}]/.test(prop) && !/[{}]/.test(val)) pairs.push([prop, val]);
        });

        let bgLum = -1;
        pairs.forEach(([prop, val]) => {
            if (prop !== 'background' && prop !== 'background-color') return;
            const raw = val.replace(/url\([^)]*\)/gi, '').trim();
            if (!raw || /^(none|transparent)$/i.test(raw)) return;
            const c = parseColor(raw.split(/\s+/)[0]) || parseColor(raw);
            if (c && c[3] >= 0.6) bgLum = luminance(c);
        });
        const hasBG = bgLum >= 0;

        const main = [], dark = [], light = [];
        let sawColor = false;

        for (let i = 0; i < pairs.length; i++) {
            let prop = pairs[i][0], val = pairs[i][1];

            if (DROP_PROPS.test(prop)) continue;
            if (/expression\s*\(|javascript:/i.test(val)) continue;
            if (/url\s*\(/i.test(val) && prop !== 'content') continue;

            if (prop === 'font-family') {
                const kept = keepFontFamily(val);
                if (!kept) continue;
                main.push(prop + ':' + kept);
                continue;
            }

            if (prop === 'position') {
                if (!/^(relative|static)$/i.test(val)) continue;   // absolute/fixed 会脱流盖住正文
                main.push(prop + ':' + val);
                continue;
            }

            if (prop === 'color') {
                sawColor = true;
                const c = parseColor(val);
                if (!c || c[3] < 0.5 || hasBG) { main.push(prop + ':' + val); continue; }
                const L = luminance(c);
                if (L < 0.28) {
                    main.push(prop + ':' + val);                       // 浅色主题下正常
                    if (!isInline) dark.push('color:var(--text-color)');
                } else if (L > 0.82) {
                    main.push(prop + ':' + val);                       // 深色主题下正常
                    if (!isInline) light.push('color:var(--text-color)');
                } else {
                    main.push(prop + ':' + val);                       // 中间色调两边都能看
                }
                continue;
            }

            if (HEIGHT_PROPS.test(prop)) {
                if (!hasRelUnit(val)) continue;
                main.push(prop + ':' + val);
                continue;
            }
            if (PCT_PROPS.test(prop)) {
                main.push(prop + ':' + pxToPct(val));
                continue;
            }
            if (EM_PROPS.test(prop)) {
                main.push(prop + ':' + pxToEm(val));
                continue;
            }
            if (/^border/.test(prop) || prop === 'outline') {
                main.push(prop + ':' + pxToEm(val));
                continue;
            }
            if (prop === 'z-index') {
                if (!/^-?\d{1,3}$/.test(val)) continue;
                main.push(prop + ':' + val);
                continue;
            }

            main.push(prop + ':' + val);
        }

        // 背景有色但没写前景色：补一个对比色，否则换主题时字会埋进背景
        if (hasBG && !sawColor) {
            main.push('color:' + (bgLum > 0.55 ? '#1a1a1a' : '#f2f2f2'));
        }

        return {
            main: main.join(';'),
            dark: dark.join(';'),
            light: light.join(';')
        };
    }

    function sanitizeInline(text) { return processDecls(text, true).main; }

    function scopeSelector(sel) {
        const out = [];
        sel.split(',').forEach(one => {
            let s = one.replace(/\s+/g, ' ').trim();
            if (!s || /[{}@]/.test(s)) return;
            s = s.replace(/^(?:html|:root)\b\s*/i, '').trim();
            s = s.replace(/^body\b/i, '').trim().replace(/^>\s*/, '').trim();
            out.push(s ? SCOPE + ' ' + s : SCOPE);
        });
        return out.join(',');
    }

    function themeScope(scoped, theme) {
        return scoped.split(',').map(s => 'html[data-theme="' + theme + '"] ' + s.trim()).join(',');
    }

    function scopeCSS(src) {
        src = String(src || '').replace(/\/\*[\s\S]*?\*\//g, '');
        const n = src.length;
        let out = '', i = 0;

        function blockEnd(start) {
            let depth = 0;
            for (let j = start; j < n; j++) {
                const c = src.charAt(j);
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) return j; }
            }
            return n - 1;
        }

        while (i < n) {
            while (i < n && /\s/.test(src.charAt(i))) i++;
            if (i >= n) break;

            if (src.charAt(i) === '@') {
                let j = i;
                while (j < n && src.charAt(j) !== '{' && src.charAt(j) !== ';') j++;
                const prelude = src.slice(i, j).trim();
                const name = (prelude.match(/^@([\w-]+)/) || ['', ''])[1].toLowerCase();
                if (j < n && src.charAt(j) === '{') {
                    const end = blockEnd(j);
                    if (name === 'media' || name === 'supports') {
                        const inner = scopeCSS(src.slice(j + 1, end));
                        if (inner.trim()) out += prelude + '{' + inner + '}';
                    }
                    // @font-face 已在第一遍单独收集并内联，这里跳过
                    i = end + 1;
                } else i = j + 1;
                continue;
            }

            let j = i;
            while (j < n && src.charAt(j) !== '{') j++;
            if (j >= n) break;
            const sel = src.slice(i, j);
            const end = blockEnd(j);
            const r = processDecls(src.slice(j + 1, end), false);
            i = end + 1;
            if (!r.main && !r.dark && !r.light) continue;
            const scoped = scopeSelector(sel);
            if (!scoped) continue;
            if (r.main) out += scoped + '{' + r.main + '}';
            if (r.dark) out += themeScope(scoped, 'dark') + '{' + r.dark + '}';
            if (r.light) out += themeScope(scoped, 'light') + '{' + r.light + '}';
        }
        return out;
    }

    /* ══════════ 内嵌字体 ══════════ */

    const FONT_MIME = { woff2:'font/woff2', woff:'font/woff', ttf:'font/ttf', otf:'font/otf', ttc:'font/collection' };
    const FONT_FMT  = { woff2:'woff2', woff:'woff', ttf:'truetype', otf:'opentype', ttc:'collection' };

    function collectFontFaces(cssText, cssPath) {
        const faces = [];
        const re = /@font-face\s*\{([^}]*)\}/gi;
        let m;
        while ((m = re.exec(cssText)) !== null) {
            const body = m[1];
            let family = '', weight = '', style = '', stretch = '';
            const srcs = [];
            splitDecls(body).forEach(one => {
                const idx = one.indexOf(':');
                if (idx <= 0) return;
                const p = one.slice(0, idx).trim().toLowerCase();
                const v = one.slice(idx + 1).trim();
                if (p === 'font-family') family = v.replace(/^["']|["']$/g, '');
                else if (p === 'font-weight') weight = v;
                else if (p === 'font-style') style = v;
                else if (p === 'font-stretch') stretch = v;
                else if (p === 'src') {
                    const ur = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
                    let um;
                    while ((um = ur.exec(v)) !== null) {
                        const rp = resolvePath(cssPath, um[1]);
                        if (rp) srcs.push(rp);
                    }
                }
            });
            if (family && srcs.length) faces.push({ family, srcs, weight, style, stretch });
        }
        return faces;
    }

    async function encryptedPaths(zip) {
        const set = new Set();
        try {
            const s = await zip.textOf('META-INF/encryption.xml');
            if (!s) return set;
            const re = /URI\s*=\s*"([^"]+)"/gi;
            let m;
            while ((m = re.exec(s)) !== null) set.add(resolvePath('', m[1]));
        } catch (e) { /* 没有就算了 */ }
        return set;
    }

    async function buildFontCSS(zip, faces, encrypted) {
        const families = new Set();
        let css = '', total = 0;
        const seen = Object.create(null);

        for (let i = 0; i < faces.length; i++) {
            if (total > FONT_BUDGET) break;
            const f = faces[i];
            let picked = '', ext = '';
            for (let k = 0; k < f.srcs.length; k++) {
                const p = f.srcs[k];
                const e = (p.split('.').pop() || '').toLowerCase();
                if (!FONT_MIME[e]) continue;
                if (encrypted.has(p)) continue;          // 混淆字体解不出来，跳过
                if (!zip.find(p)) continue;
                picked = p; ext = e;
                if (e === 'woff2' || e === 'woff') break;   // 优先小体积
            }
            if (!picked) continue;

            const dedupKey = f.family.toLowerCase() + '|' + (f.weight || '') + '|' + (f.style || '') + '|' + picked;
            if (seen[dedupKey]) continue;
            seen[dedupKey] = 1;

            try {
                const bytes = await zip.bytes(picked);
                if (!bytes || !bytes.length || bytes.length > 6 * 1024 * 1024) continue;
                const url = await bytesToDataURL(bytes, FONT_MIME[ext]);
                if (!url) continue;
                total += url.length;
                if (total > FONT_BUDGET) break;
                css += '@font-face{font-family:"' + f.family.replace(/["\\]/g, '') + '";'
                    + 'src:url(' + url + ') format("' + FONT_FMT[ext] + '");'
                    + (f.weight ? 'font-weight:' + f.weight + ';' : '')
                    + (f.style ? 'font-style:' + f.style + ';' : '')
                    + (f.stretch ? 'font-stretch:' + f.stretch + ';' : '')
                    + 'font-display:swap;}';
                families.add(f.family.toLowerCase());
            } catch (e) { /* 单个字体失败不影响其他 */ }
        }
        return { css, families };
    }

    /* ══════════ XHTML → 受控 HTML ══════════ */

    const DROP_TAGS = { script:1, style:1, head:1, title:1, meta:1, link:1, base:1, noscript:1,
        iframe:1, object:1, embed:1, param:1, audio:1, video:1, source:1, track:1, canvas:1,
        form:1, input:1, button:1, select:1, option:1, textarea:1, label:1, map:1, area:1 };

    const TAG_MAP = { a:'span', font:'span', big:'span', tt:'code', strike:'s', nav:'div',
        body:'div', html:'div', main:'div', form:'div' };

    const ALLOW_TAGS = { p:1, div:1, span:1, section:1, article:1, aside:1, header:1, footer:1,
        blockquote:1, pre:1, code:1, kbd:1, samp:1, var:1, em:1, strong:1, i:1, b:1, u:1, s:1,
        del:1, ins:1, sub:1, sup:1, small:1, mark:1, cite:1, q:1, abbr:1, dfn:1, time:1, bdi:1,
        bdo:1, ruby:1, rt:1, rp:1, rb:1, rtc:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, ul:1, ol:1,
        li:1, dl:1, dt:1, dd:1, table:1, thead:1, tbody:1, tfoot:1, tr:1, td:1, th:1, caption:1,
        colgroup:1, col:1, figure:1, figcaption:1, center:1, br:1, hr:1, wbr:1 };

    const VOID_TAGS = { br:1, hr:1, wbr:1, col:1, img:1 };

    const CUT_TAGS = { p:1, div:1, section:1, article:1, blockquote:1, pre:1, ul:1, ol:1, li:1,
        dl:1, dd:1, dt:1, table:1, figure:1, figcaption:1, hr:1, center:1, header:1, footer:1,
        aside:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1 };

    const HEAD_TAGS = { h1:1, h2:1, h3:1, h4:1, h5:1, h6:1 };

    function makeStackTable() {
        const table = [{ pre: '', post: '' }];
        const keyOf = [''];
        const index = Object.create(null);
        return {
            table,
            cur: 0,
            hist: [],
            push(openStr, closeStr) {
                const key = keyOf[this.cur] + '\u0001' + openStr;
                let id = index[key];
                if (id === undefined) {
                    id = table.length;
                    table.push({
                        pre: table[this.cur].pre + openStr,
                        post: closeStr + table[this.cur].post
                    });
                    keyOf[id] = key;
                    index[key] = id;
                }
                this.hist.push(this.cur);
                this.cur = id;
            },
            pop() { this.cur = this.hist.length ? this.hist.pop() : 0; }
        };
    }

    function attrsOf(node, tag) {
        let out = '';
        const cls = node.getAttribute ? node.getAttribute('class') : '';
        if (cls) out += ' class="' + escapeAttr(String(cls).slice(0, 240)) + '"';
        const st = sanitizeInline(node.getAttribute ? (node.getAttribute('style') || '') : '');
        if (st) out += ' style="' + escapeAttr(st.slice(0, 500)) + '"';
        if (tag === 'td' || tag === 'th') {
            const cs = node.getAttribute('colspan'), rs = node.getAttribute('rowspan');
            if (/^\d{1,3}$/.test(cs || '')) out += ' colspan="' + cs + '"';
            if (/^\d{1,3}$/.test(rs || '')) out += ' rowspan="' + rs + '"';
        }
        if (tag === 'ol') {
            const s = node.getAttribute('start');
            if (/^\d{1,6}$/.test(s || '')) out += ' start="' + s + '"';
        }
        return out;
    }

    function svgImageHref(node) {
        const imgs = localTags(node, 'image');
        for (let i = 0; i < imgs.length; i++) {
            const h = imgs[i].getAttribute('xlink:href') || imgs[i].getAttribute('href');
            if (h) return h;
        }
        return '';
    }

    function serializeDoc(ctx, root, docPath, fragIds, baseOffset) {
        const parts = [];
        let len = 0, textLen = 0, preDepth = 0, heading = '', headBuf = null;
        const anchors = Object.create(null);
        const imgs = [];
        const st = ctx.stack;
        st.cur = 0; st.hist.length = 0;

        function push(s) { if (s) { parts.push(s); len += s.length; } }
        function markCut() { ctx.cuts.push({ p: baseOffset + len, s: st.cur }); }

        function emitImg(href, alt) {
            const path = resolvePath(docPath, href);
            const key = path ? ctx.imgKey(path) : '';
            if (!key) {
                if (alt) push('<span class="epub-imgalt">' + escapeHTML(alt) + '</span>');
                return;
            }
            if (imgs.indexOf(path) < 0) imgs.push(path);
            push('<img data-eimg="' + key + '" alt="' + escapeAttr(alt || '') + '">');
        }

        function walk(node) {
            const nt = node.nodeType;

            if (nt === 3) {
                const raw = node.nodeValue || '';
                const s = preDepth > 0 ? raw : raw.replace(/\s+/g, ' ');
                if (!s) return;
                if (preDepth === 0 && !s.trim() && !len) return;
                textLen += s.replace(/\s/g, '').length;
                if (headBuf !== null) headBuf += s;
                push(escapeHTML(s));
                return;
            }
            if (nt !== 1) return;

            let tag = (node.localName || node.tagName || '').toLowerCase().split(':').pop();
            if (DROP_TAGS[tag]) return;

            const id = node.getAttribute ? node.getAttribute('id') : null;
            if (id && fragIds[id] && anchors[id] === undefined) {
                anchors[id] = { p: baseOffset + len, s: st.cur };
            }

            if (tag === 'img') {
                markCut();
                emitImg(node.getAttribute('src') || '', node.getAttribute('alt') || '');
                return;
            }
            if (tag === 'svg') {
                markCut();
                const href = svgImageHref(node);
                const ti = firstLocal(node, 'title');
                if (href) emitImg(href, ti ? textOfEl(ti) : '');
                return;
            }
            if (tag === 'image') {
                markCut();
                emitImg(node.getAttribute('xlink:href') || node.getAttribute('href') || '', '');
                return;
            }

            const mapped = TAG_MAP[tag] || (ALLOW_TAGS[tag] ? tag : (CUT_TAGS[tag] ? 'div' : 'span'));
            if (CUT_TAGS[mapped] || CUT_TAGS[tag]) markCut();

            if (VOID_TAGS[mapped]) { push('<' + mapped + attrsOf(node, mapped) + '>'); return; }

            const extra = (tag === 'a') ? ' data-a="1"' : '';
            const open = '<' + mapped + attrsOf(node, mapped) + extra + '>';
            const close = '</' + mapped + '>';
            push(open);
            st.push(open, close);

            if (mapped === 'pre') preDepth++;
            if (HEAD_TAGS[mapped] && headBuf === null) headBuf = '';

            const kids = node.childNodes;
            for (let i = 0; i < kids.length; i++) walk(kids[i]);

            if (HEAD_TAGS[mapped] && headBuf !== null) {
                if (!heading) heading = headBuf.replace(/\s+/g, ' ').trim();
                headBuf = null;
            }
            if (mapped === 'pre') preDepth--;

            st.pop();
            push(close);
        }

        markCut();
        const kids = root.childNodes;
        for (let i = 0; i < kids.length; i++) walk(kids[i]);

        return { html: parts.join(''), anchors, heading, textLen, imgs };
    }

    /* ══════════ 章节切分 ══════════ */

    function fileTitle(path) {
        return String(path).split('/').pop().replace(/\.x?html?$/i, '');
    }

    function splitLong(ctx, list) {
        const cuts = ctx.cuts;
        const out = [];
        let ci = 0;
        for (let n = 0; n < list.length; n++) {
            const c = list[n];
            if (c.to - c.from <= MAX_BLOCK) { out.push(c); continue; }

            let from = c.from, fromS = c.fromS, part = 1;
            while (c.to - from > MAX_BLOCK) {
                const limit = from + MAX_BLOCK;
                while (ci < cuts.length && cuts[ci].p <= from) ci++;
                let j = ci, best = -1, bestS = 0;
                while (j < cuts.length && cuts[j].p <= limit) { best = cuts[j].p; bestS = cuts[j].s; j++; }
                if (best <= from || best >= c.to) break;
                out.push({
                    title: part === 1 ? c.title : c.title + ' (' + part + ')',
                    from, to: best, fromS, toS: bestS
                });
                from = best; fromS = bestS; part++;
                ci = j;
            }
            out.push({
                title: part === 1 ? c.title : c.title + ' (' + part + ')',
                from, to: c.to, fromS, toS: c.toS
            });
        }
        return out;
    }

    function buildChapters(ctx, htmlLen, docs, toc) {
        const byPath = Object.create(null);
        docs.forEach(d => { byPath[d.path] = d; });

        let marks = [];
        toc.forEach(e => {
            const d = byPath[e.path];
            if (!d) return;
            let at = { p: d.offset, s: 0 };
            if (e.frag && d.anchors[e.frag]) at = d.anchors[e.frag];
            let title = (e.title || '').replace(/\s+/g, ' ').trim();
            if (!title) title = d.heading || fileTitle(d.path);
            marks.push({ title, p: at.p, s: at.s });
        });

        if (!marks.length) {
            docs.forEach(d => {
                if (d.length < 1) return;
                marks.push({ title: d.heading || fileTitle(d.path), p: d.offset, s: 0 });
            });
        }

        marks.sort((a, b) => a.p - b.p);

        const dedup = [];
        for (let i = 0; i < marks.length; i++) {
            if (dedup.length && marks[i].p === dedup[dedup.length - 1].p) continue;
            dedup.push(marks[i]);
        }
        if (!dedup.length) dedup.push({ title: '正文', p: 0, s: 0 });
        else if (dedup[0].p > 40) dedup.unshift({ title: '卷首', p: 0, s: 0 });

        const raw = [];
        for (let i = 0; i < dedup.length; i++) {
            const from = dedup[i].p;
            const to = (i + 1 < dedup.length) ? dedup[i + 1].p : htmlLen;
            const toS = (i + 1 < dedup.length) ? dedup[i + 1].s : 0;
            if (to - from < 2) continue;
            raw.push({ title: dedup[i].title, from, to, fromS: dedup[i].s, toS });
        }
        if (!raw.length) raw.push({ title: '正文', from: 0, to: htmlLen, fromS: 0, toS: 0 });

        return splitLong(ctx, raw).map(c => ({
            title: c.title,
            from: c.from,
            to: c.to,
            pre: ctx.stack.table[c.fromS] ? ctx.stack.table[c.fromS].pre : '',
            post: ctx.stack.table[c.toS] ? ctx.stack.table[c.toS].post : ''
        }));
    }

    /* ══════════ 目录 ══════════ */

    function parseNav(navDoc, navPath) {
        const out = [];
        if (!navDoc) return out;
        let container = null;
        const navs = localTags(navDoc, 'nav');
        for (let i = 0; i < navs.length; i++) {
            const ty = navs[i].getAttribute('epub:type') || navs[i].getAttribute('type') || '';
            if (ty.indexOf('toc') >= 0) { container = navs[i]; break; }
        }
        if (!container && navs.length) container = navs[0];
        if (!container) container = navDoc.body || navDoc.documentElement;

        const links = localTags(container, 'a');
        for (let i = 0; i < links.length; i++) {
            const href = links[i].getAttribute('href');
            if (!href) continue;
            const hash = href.indexOf('#');
            out.push({
                path: resolvePath(navPath, href),
                frag: hash >= 0 ? decodeMaybe(href.slice(hash + 1)) : '',
                title: textOfEl(links[i])
            });
        }
        return out;
    }

    function parseNCX(ncxDoc, ncxPath) {
        const out = [];
        if (!ncxDoc) return out;
        const points = localTags(ncxDoc, 'navPoint');
        for (let i = 0; i < points.length; i++) {
            const content = firstLocal(points[i], 'content');
            if (!content) continue;
            const href = content.getAttribute('src');
            if (!href) continue;
            const label = firstLocal(points[i], 'navLabel');
            const hash = href.indexOf('#');
            out.push({
                path: resolvePath(ncxPath, href),
                frag: hash >= 0 ? decodeMaybe(href.slice(hash + 1)) : '',
                title: label ? textOfEl(label) : ''
            });
        }
        return out;
    }

    /* ══════════ 图片 ══════════ */

    function guessMime(path) {
        const ext = (String(path).split('.').pop() || '').toLowerCase();
        if (ext === 'png') return 'image/png';
        if (ext === 'gif') return 'image/gif';
        if (ext === 'webp') return 'image/webp';
        if (ext === 'svg') return 'image/svg+xml';
        if (ext === 'bmp') return 'image/bmp';
        return 'image/jpeg';
    }

    function bytesToDataURL(bytes, mime) {
        return new Promise(res => {
            try {
                const fr = new FileReader();
                fr.onload = e => res(e.target.result);
                fr.onerror = () => res('');
                fr.readAsDataURL(new Blob([bytes], { type: mime }));
            } catch (e) { res(''); }
        });
    }

    function loadImage(dataURL) {
        return new Promise(res => {
            let done = false;
            const finish = v => { if (!done) { done = true; res(v); } };
            const timer = setTimeout(() => finish(null), 5000);
            try {
                const img = new Image();
                img.onload = () => { clearTimeout(timer); finish({ img, w: img.naturalWidth || 0, h: img.naturalHeight || 0 }); };
                img.onerror = () => { clearTimeout(timer); finish(null); };
                img.src = dataURL;
            } catch (e) { clearTimeout(timer); finish(null); }
        });
    }

    function drawScaled(img, w, h, mime, quality, fillWhite) {
        try {
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, w); cv.height = Math.max(1, h);
            const cx = cv.getContext('2d');
            if (fillWhite) { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cv.width, cv.height); }
            cx.drawImage(img, 0, 0, cv.width, cv.height);
            return cv.toDataURL(mime, quality);
        } catch (e) { return ''; }
    }

    /* 返回原始宽高，交给 app.js 按容器宽度折算显示尺寸 */
    async function packImage(bytes, path) {
        const mime = guessMime(path);
        const raw = await bytesToDataURL(bytes, mime);
        if (!raw) return null;
        if (mime === 'image/svg+xml') return { u: raw, w: 0, h: 0 };

        const info = await loadImage(raw);
        if (!info) return { u: raw, w: 0, h: 0 };

        const w = info.w, h = info.h;
        if (w <= IMG_MAX_W && raw.length <= 500000) return { u: raw, w, h };

        const scale = Math.min(1, IMG_MAX_W / (w || IMG_MAX_W));
        const nw = Math.max(1, Math.round(w * scale));
        const nh = Math.max(1, Math.round(h * scale));
        const keepAlpha = (mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp');
        const out = keepAlpha
            ? drawScaled(info.img, nw, nh, 'image/png', undefined, false)
            : drawScaled(info.img, nw, nh, 'image/jpeg', 0.84, false);
        // 缩放后仍按原始宽高上报，版面比例才不会走形
        if (out && out.length < raw.length) return { u: out, w, h };
        return { u: raw, w, h };
    }

    async function packCover(bytes, path) {
        const mime = guessMime(path);
        const raw = await bytesToDataURL(bytes, mime);
        if (!raw) return '';
        if (mime === 'image/svg+xml') return raw;
        const info = await loadImage(raw);
        if (!info || !info.w) return raw;
        const scale = Math.min(1, 420 / info.w);
        const nw = Math.max(1, Math.round(info.w * scale));
        const nh = Math.max(1, Math.round(info.h * scale));
        const out = drawScaled(info.img, nw, nh, 'image/jpeg', 0.82, true);
        return (out && out.length < raw.length) ? out : raw;
    }

    /* ══════════ 封面探测 ══════════ */

    async function firstImageInDoc(zip, path) {
        try {
            const s = await zip.textOf(path);
            if (!s) return '';
            const doc = parseXML(s, true);
            if (!doc) return '';
            const imgs = localTags(doc, 'img');
            for (let i = 0; i < imgs.length; i++) {
                const p = resolvePath(path, imgs[i].getAttribute('src') || '');
                if (p && zip.find(p)) return p;
            }
            const svgImgs = localTags(doc, 'image');
            for (let i = 0; i < svgImgs.length; i++) {
                const h = svgImgs[i].getAttribute('xlink:href') || svgImgs[i].getAttribute('href') || '';
                const p = resolvePath(path, h);
                if (p && zip.find(p)) return p;
            }
        } catch (e) { /* 忽略 */ }
        return '';
    }

    async function findCover(zip, opf, opfPath, manifest, metaEl, docs) {
        const isImg = it => it && (it.type.indexOf('image') === 0 || /\.(jpe?g|png|gif|webp|bmp)$/i.test(it.path));
        const keys = Object.keys(manifest);

        for (let i = 0; i < keys.length; i++) {
            const m = manifest[keys[i]];
            if (/cover-image/.test(m.props) && zip.find(m.path)) return m.path;
        }

        const metas = localTags(metaEl, 'meta');
        for (let i = 0; i < metas.length; i++) {
            if ((metas[i].getAttribute('name') || '').toLowerCase() !== 'cover') continue;
            const it = manifest[metas[i].getAttribute('content') || ''];
            if (!it) break;
            if (isImg(it) && zip.find(it.path)) return it.path;
            const p = await firstImageInDoc(zip, it.path);
            if (p) return p;
            break;
        }

        const refs = localTags(firstLocal(opf, 'guide'), 'reference');
        for (let i = 0; i < refs.length; i++) {
            if ((refs[i].getAttribute('type') || '').toLowerCase().indexOf('cover') < 0) continue;
            const p0 = resolvePath(opfPath, refs[i].getAttribute('href') || '');
            if (!p0) continue;
            if (/\.(jpe?g|png|gif|webp)$/i.test(p0) && zip.find(p0)) return p0;
            const p = await firstImageInDoc(zip, p0);
            if (p) return p;
        }

        for (let i = 0; i < Math.min(docs.length, 3); i++) {
            const d = docs[i];
            if (d.imgs && d.imgs.length && d.textLen < 60) return d.imgs[0];
        }

        for (let i = 0; i < keys.length; i++) {
            const m = manifest[keys[i]];
            if (isImg(m) && /cover/i.test(m.path) && zip.find(m.path)) return m.path;
        }

        for (let i = 0; i < Math.min(docs.length, 3); i++) {
            if (docs[i].imgs && docs[i].imgs.length) return docs[i].imgs[0];
        }
        return '';
    }

    /* ══════════ 主流程 ══════════ */

    function isEpub(file) {
        if (!file) return false;
        if (/\.epub$/i.test(file.name || '')) return true;
        return (file.type || '') === 'application/epub+zip';
    }

    async function parse(file, onProgress) {
        const report = (p, stage) => { if (onProgress) onProgress(Math.max(0, Math.min(1, p)), stage); };

        report(0.02, '读取文件');
        const buffer = await readFileBuffer(file);

        report(0.05, '打开压缩包');
        const zip = openZip(buffer);

        report(0.08, '解析结构');

        let opfPath = '';
        const containerXML = await zip.textOf('META-INF/container.xml');
        if (containerXML) {
            const cdoc = parseXML(containerXML, false);
            const rf = firstLocal(cdoc, 'rootfile');
            if (rf) opfPath = resolvePath('', rf.getAttribute('full-path') || '');
        }
        if (!opfPath || !zip.find(opfPath)) {
            const guess = zip.names.filter(n => /\.opf$/i.test(n));
            if (!guess.length) throw new Error('EPUB 缺少 OPF 描述文件');
            opfPath = guess[0];
        }

        const opfText = await zip.textOf(opfPath);
        if (!opfText) throw new Error('无法读取 OPF：' + opfPath);
        const opf = parseXML(opfText, false);
        if (!opf) throw new Error('OPF 解析失败');

        const metaEl = firstLocal(opf, 'metadata');
        const title = textOfEl(firstLocal(metaEl, 'title'));
        const author = textOfEl(firstLocal(metaEl, 'creator'));

        const manifest = Object.create(null);
        localTags(firstLocal(opf, 'manifest'), 'item').forEach(it => {
            const id = it.getAttribute('id');
            if (!id) return;
            manifest[id] = {
                id,
                path: resolvePath(opfPath, it.getAttribute('href') || ''),
                type: (it.getAttribute('media-type') || '').toLowerCase(),
                props: (it.getAttribute('properties') || '')
            };
        });

        const spineEl = firstLocal(opf, 'spine');
        const spine = [];
        localTags(spineEl, 'itemref').forEach(ir => {
            const item = manifest[ir.getAttribute('idref') || ''];
            if (!item || !item.path) return;
            if (/nav/.test(item.props)) return;
            if (item.type && item.type.indexOf('image') === 0) return;
            spine.push(item);
        });
        if (!spine.length) {
            Object.keys(manifest).forEach(k => {
                if (/x?html?$/i.test(manifest[k].path)) spine.push(manifest[k]);
            });
        }
        if (!spine.length) throw new Error('EPUB 里找不到正文文档');

        let toc = [];
        let navItem = null;
        Object.keys(manifest).forEach(k => { if (/nav/.test(manifest[k].props)) navItem = manifest[k]; });
        if (navItem) {
            const s = await zip.textOf(navItem.path);
            toc = parseNav(parseXML(s, true), navItem.path);
        }
        if (!toc.length) {
            const tocId = spineEl && spineEl.getAttribute('toc');
            let ncxPath = tocId && manifest[tocId] ? manifest[tocId].path : '';
            if (!ncxPath) {
                const g = zip.names.filter(n => /\.ncx$/i.test(n));
                if (g.length) ncxPath = g[0];
            }
            if (ncxPath) {
                const s = await zip.textOf(ncxPath);
                toc = parseNCX(parseXML(s, false), ncxPath);
            }
        }

        const fragsByPath = Object.create(null);
        toc.forEach(e => {
            if (!e.frag) return;
            (fragsByPath[e.path] || (fragsByPath[e.path] = Object.create(null)))[e.frag] = 1;
        });

        /* ── 样式第一遍：读全部 CSS，收 @font-face，把字体内联进来 ── */
        report(0.10, '提取字体');
        const cssKeys = Object.keys(manifest).filter(k =>
            manifest[k].type.indexOf('text/css') >= 0 || /\.css$/i.test(manifest[k].path));
        const cssTexts = [];
        let faces = [];
        for (let i = 0; i < cssKeys.length; i++) {
            try {
                const p = manifest[cssKeys[i]].path;
                const s = await zip.textOf(p);
                if (!s) continue;
                cssTexts.push({ path: p, text: s });
                faces = faces.concat(collectFontFaces(s, p));
            } catch (e) { /* 单表失败跳过 */ }
        }
        const encrypted = await encryptedPaths(zip);
        const fontPack = await buildFontCSS(zip, faces, encrypted);
        currentFonts = fontPack.families;

        /* ── 样式第二遍：作用域化 + 净化 ── */
        report(0.16, '提取样式');
        let css = fontPack.css;
        for (let i = 0; i < cssTexts.length && css.length < CSS_BUDGET; i++) {
            css += scopeCSS(cssTexts[i].text);
            if (i % 4 === 0) await nextTick();
        }
        if (css.length > CSS_BUDGET) css = css.slice(0, CSS_BUDGET);

        /* ── 正文 ── */
        const ctx = {
            cuts: [],
            stack: makeStackTable(),
            imgPaths: [],
            imgKeys: Object.create(null),
            imgKey(path) {
                if (!zip.find(path)) return '';
                let k = this.imgKeys[path];
                if (!k) {
                    k = 'e' + (this.imgPaths.length + 1);
                    this.imgKeys[path] = k;
                    this.imgPaths.push(path);
                }
                return k;
            }
        };

        const pieces = [];
        const docs = [];
        let offset = 0, textLength = 0;

        for (let i = 0; i < spine.length; i++) {
            const item = spine[i];
            report(0.20 + 0.45 * (i / spine.length), '转换正文 ' + (i + 1) + '/' + spine.length);
            if (i % 6 === 0) await nextTick();

            let str = null;
            try { str = await zip.textOf(item.path); } catch (e) { str = null; }
            if (str === null) continue;

            const doc = parseXML(str, true);
            const root = doc ? (doc.body || doc.documentElement) : null;
            if (!root) continue;

            const r = serializeDoc(ctx, root, item.path, fragsByPath[item.path] || Object.create(null), offset);
            docs.push({
                path: item.path, offset, length: r.html.length,
                anchors: r.anchors, heading: r.heading, textLen: r.textLen, imgs: r.imgs
            });
            pieces.push(r.html);
            offset += r.html.length;
            textLength += r.textLen;
        }

        const html = pieces.join('');
        if (!textLength && !ctx.imgPaths.length) throw new Error('EPUB 正文为空，可能带 DRM 加密');

        /* ── 插图 ── */
        report(0.68, '提取插图');
        const images = Object.create(null);
        let imgTotal = 0;
        const imgCount = ctx.imgPaths.length;
        for (let i = 0; i < imgCount; i++) {
            const p = ctx.imgPaths[i];
            report(0.68 + 0.24 * (i / imgCount), '提取插图 ' + (i + 1) + '/' + imgCount);
            if (i % 4 === 0) await nextTick();
            if (imgTotal > IMG_BUDGET) break;
            try {
                const bytes = await zip.bytes(p);
                if (!bytes || !bytes.length || bytes.length > 12 * 1024 * 1024) continue;
                const packed = await packImage(bytes, p);
                if (!packed || !packed.u) continue;
                images[ctx.imgKeys[p]] = packed;
                imgTotal += packed.u.length;
            } catch (e) { /* 单张失败跳过 */ }
        }

        /* ── 封面 ── */
        report(0.94, '提取封面');
        let cover = '';
        try {
            const coverPath = await findCover(zip, opf, opfPath, manifest, metaEl, docs);
            if (coverPath) {
                const bytes = await zip.bytes(coverPath);
                if (bytes && bytes.length && bytes.length < 20 * 1024 * 1024) {
                    cover = await packCover(bytes, coverPath);
                }
            }
        } catch (e) { cover = ''; }
        report(0.97, '构建目录');
        const chapters = buildChapters(ctx, html.length, docs, toc);

        currentFonts = null;
        report(1, '完成');
        return {
            html,
            isHTML: true,
            textLength,
            chapters,
            images,
            css,
            title: (title || '').trim(),
            author: (author || '').trim(),
            cover
        };
    }

    global.EpubKit = { isEpub, parse };
})(window);