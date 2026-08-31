/* ═══════════════════════════════════════════════════════════
   epub.js — EPUB 解析（ZIP + inflate + XHTML→纯文本 + 章节）
   对外只暴露 window.EpubKit = { isEpub, parse }
   parse(file, onProgress) -> { text, chapters, title, author, cover }
   ═══════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    /* ── 工具 ── */

    const nextTick = () => new Promise(r => setTimeout(r, 0));

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

    // href 相对 base 归一化；'..' 到根即停，不再上溯
    function resolvePath(base, href) {
        href = String(href || '').split('#')[0].replace(/^\.\//, '');
        if (!href) return '';
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
                bitbuf = 0; bitcnt = 0;                       // 对齐到字节边界
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

    /* 原生解压优先。用 3 字节探针确认 'deflate-raw' 真的可用 */
    let nativeInflate = null;
    async function detectNative() {
        if (nativeInflate !== null) return nativeInflate;
        nativeInflate = false;
        if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return false;
        try {
            const probe = new Uint8Array([0x4B, 0x04, 0x00]);   // fixed-huffman，解出 "a"
            const ds = new DecompressionStream('deflate-raw');
            const w = ds.writable.getWriter();
            w.write(probe); w.close();
            const buf = await new Response(ds.readable).arrayBuffer();
            const out = new Uint8Array(buf);
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

        // ZIP64
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

        // 路径查找：原名 → 解码名 → 忽略大小写
        function find(path) {
            if (!path) return null;
            if (entries[path]) return entries[path];
            const dec = decodeMaybe(path);
            if (entries[dec]) return entries[dec];
            return lower[path.toLowerCase()] || lower[dec.toLowerCase()] || null;
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

    /* ── XML 辅助（绕开命名空间前缀） ── */

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

    /* ── XHTML → 纯文本 ── */

    const BLOCK_TAGS = { p:1, div:1, li:1, blockquote:1, tr:1, section:1, article:1, figure:1,
        figcaption:1, h1:1, h2:1, h3:1, h4:1, h5:1, h6:1, ul:1, ol:1, table:1, hr:1, pre:1,
        center:1, dd:1, dt:1, dl:1, header:1, footer:1, aside:1, main:1, nav:1, body:1 };
    const HEAD_TAGS = { h1:1, h2:1, h3:1, h4:1, h5:1, h6:1 };
    const SKIP_TAGS = { script:1, style:1, head:1, link:1, meta:1, title:1, noscript:1,
        iframe:1, audio:1, video:1, source:1, track:1 };
    const INDENT = '\u3000\u3000';

    /* 关键：换行抑制在推送时完成，保证 anchors 偏移与最终文本严格一致 */
    function htmlToText(root, fragIds, baseOffset) {
        const parts = [];
        let len = 0, trailingNL = 1, pendingIndent = false, preDepth = 0;
        const anchors = Object.create(null);
        let firstHeading = '', headBuf = null;

        function push(str) {
            if (!str) return;
            parts.push(str);
            len += str.length;
            if (headBuf !== null) headBuf += str;
            let i = str.length - 1, n = 0;
            while (i >= 0 && str.charAt(i) === '\n') { n++; i--; }
            trailingNL = (i < 0) ? trailingNL + n : n;
        }
        const atLineStart = () => trailingNL > 0;
        function newline() { if (trailingNL < 1) push('\n'); }

        function text(raw) {
            const s = preDepth > 0 ? raw : raw.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ');
            if (!s || (preDepth === 0 && !s.trim())) {
                if (preDepth === 0 && s === ' ' && !atLineStart()) push(' ');
                return;
            }
            if (pendingIndent) {
                pendingIndent = false;
                if (atLineStart() && s.charAt(0) !== '\u3000' && s.charAt(0) !== ' ') push(INDENT);
            }
            push(s);
        }

        function imgPlaceholder(alt) {
            newline();
            push('［图片' + (alt ? '：' + alt.replace(/\s+/g, ' ').trim() : '') + '］');
            newline();
        }

        function walk(node) {
            const nt = node.nodeType;
            if (nt === 3) { text(node.nodeValue || ''); return; }
            if (nt !== 1) return;

            const tag = (node.localName || node.tagName || '').toLowerCase();
            if (SKIP_TAGS[tag]) return;

            const id = node.getAttribute ? node.getAttribute('id') : null;
            if (id && fragIds[id] && anchors[id] === undefined) {
                newline();
                anchors[id] = baseOffset + len;
            }

            if (tag === 'br') { newline(); return; }
            if (tag === 'img') {
                imgPlaceholder((node.getAttribute && node.getAttribute('alt')) || '');
                return;
            }
            if (tag === 'image' || tag === 'svg') {
                let alt = '';
                const ti = firstLocal(node, 'title');
                if (ti) alt = textOfEl(ti);
                imgPlaceholder(alt);
                return;
            }

            const isBlock = !!BLOCK_TAGS[tag];
            const isHead = !!HEAD_TAGS[tag];

            if (isBlock) newline();
            if (tag === 'pre') preDepth++;
            if (isHead && headBuf === null) headBuf = '';
            if (tag === 'p' || tag === 'dd') pendingIndent = true;

            const kids = node.childNodes;
            for (let i = 0; i < kids.length; i++) walk(kids[i]);

            if (isHead && headBuf !== null) {
                if (!firstHeading) firstHeading = headBuf.replace(/\s+/g, ' ').trim();
                headBuf = null;
            }
            if (tag === 'pre') preDepth--;
            if (isBlock) { pendingIndent = false; newline(); }
        }

        walk(root);
        return { text: parts.join(''), anchors, heading: firstHeading };
    }

    /* ── 章节切分 ── */

    const MAX_BLOCK = 20000;

    function splitLongBlocks(text, list) {
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const c = list[i], len = c.to - c.from;
            if (len <= MAX_BLOCK) { out.push(c); continue; }
            const parts = Math.ceil(len / MAX_BLOCK);
            let cursor = c.from;
            for (let p = 0; p < parts && cursor < c.to; p++) {
                let end = Math.min(c.to, cursor + MAX_BLOCK);
                if (end < c.to) {
                    const nl = text.lastIndexOf('\n', end);
                    if (nl > cursor + MAX_BLOCK * 0.5) end = nl + 1;
                }
                out.push({ title: p === 0 ? c.title : c.title + ' (' + (p + 1) + ')', from: cursor, to: end });
                cursor = end;
            }
        }
        return out;
    }

    function buildChapters(fullText, docs, tocEntries) {
        const byPath = Object.create(null);
        docs.forEach(d => { byPath[d.path] = d; });

        let marks = [];
        tocEntries.forEach(e => {
            const d = byPath[e.path];
            if (!d) return;
            let off = d.offset;
            if (e.frag && d.anchors[e.frag] !== undefined) off = d.anchors[e.frag];
            let title = (e.title || '').replace(/\s+/g, ' ').trim();
            if (!title) title = d.heading || d.path.split('/').pop().replace(/\.x?html?$/i, '');
            marks.push({ title, from: off });
        });

        if (!marks.length) {
            docs.forEach(d => {
                if (d.length < 1) return;
                marks.push({
                    title: d.heading || d.path.split('/').pop().replace(/\.x?html?$/i, ''),
                    from: d.offset
                });
            });
        }

        marks.sort((a, b) => a.from - b.from);

        const dedup = [];
        for (let i = 0; i < marks.length; i++) {
            if (dedup.length && marks[i].from === dedup[dedup.length - 1].from) continue;
            dedup.push(marks[i]);
        }
        if (!dedup.length) dedup.push({ title: '正文', from: 0 });
        else if (dedup[0].from > 20) dedup.unshift({ title: '卷首', from: 0 });

        const chapters = [];
        for (let i = 0; i < dedup.length; i++) {
            const from = dedup[i].from;
            const to = (i + 1 < dedup.length) ? dedup[i + 1].from : fullText.length;
            if (to - from < 2) continue;
            chapters.push({ title: dedup[i].title, from, to });
        }
        if (!chapters.length) chapters.push({ title: '正文', from: 0, to: fullText.length });
        return splitLongBlocks(fullText, chapters);
    }

    /* ── 目录：EPUB3 nav / EPUB2 NCX ── */

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

    /* ── 封面缩放 ── */

    function guessMime(path) {
        const ext = (path.split('.').pop() || '').toLowerCase();
        if (ext === 'png') return 'image/png';
        if (ext === 'gif') return 'image/gif';
        if (ext === 'webp') return 'image/webp';
        if (ext === 'svg') return 'image/svg+xml';
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

    // 封面压到 420px 宽以内，避免整张原图塞进 IndexedDB
    function downscaleCover(dataURL) {
        return new Promise(res => {
            if (!dataURL || dataURL.indexOf('image/svg') >= 0) return res(dataURL);
            let done = false;
            const finish = v => { if (!done) { done = true; res(v); } };
            const timer = setTimeout(() => finish(dataURL), 4000);
            try {
                const img = new Image();
                img.onload = () => {
                    clearTimeout(timer);
                    try {
                        const MAXW = 420;
                        const scale = Math.min(1, MAXW / (img.naturalWidth || MAXW));
                        const w = Math.max(1, Math.round((img.naturalWidth || MAXW) * scale));
                        const h = Math.max(1, Math.round((img.naturalHeight || MAXW) * scale));
                        const cv = document.createElement('canvas');
                        cv.width = w; cv.height = h;
                        cv.getContext('2d').drawImage(img, 0, 0, w, h);
                        const out = cv.toDataURL('image/jpeg', 0.82);
                        finish(out && out.length < dataURL.length ? out : dataURL);
                    } catch (e) { finish(dataURL); }
                };
                img.onerror = () => { clearTimeout(timer); finish(dataURL); };
                img.src = dataURL;
            } catch (e) { clearTimeout(timer); finish(dataURL); }
        });
    }

    /* ── 主流程 ── */

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

        // 1) 找 OPF
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

        // 2) 元数据
        const metaEl = firstLocal(opf, 'metadata');
        const title = textOfEl(firstLocal(metaEl, 'title'));
        const author = textOfEl(firstLocal(metaEl, 'creator'));

        // 3) manifest
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

        // 4) spine
        const spineEl = firstLocal(opf, 'spine');
        const spine = [];
        localTags(spineEl, 'itemref').forEach(ir => {
            const idref = ir.getAttribute('idref');
            const item = idref && manifest[idref];
            if (!item || !item.path) return;
            if (/nav/.test(item.props)) return;                       // 跳过导航文档本身
            if (item.type && item.type.indexOf('image') === 0) return;
            spine.push(item);
        });
        if (!spine.length) {
            Object.keys(manifest).forEach(k => {
                if (/x?html?$/i.test(manifest[k].path)) spine.push(manifest[k]);
            });
        }
        if (!spine.length) throw new Error('EPUB 里找不到正文文档');

        // 5) 目录
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

        // 目录里每个文件用到的片段 id，供 htmlToText 记录偏移
        const fragsByPath = Object.create(null);
        toc.forEach(e => {
            if (!e.frag) return;
            (fragsByPath[e.path] || (fragsByPath[e.path] = Object.create(null)))[e.frag] = 1;
        });

        // 6) 逐篇转文本
        const pieces = [];
        const docs = [];
        let offset = 0;

        for (let i = 0; i < spine.length; i++) {
            const item = spine[i];
            report(0.10 + 0.75 * (i / spine.length), '转换正文 ' + (i + 1) + '/' + spine.length);
            if (i % 8 === 0) await nextTick();                          // 让出主线程，进度条能动

            let str = null;
            try { str = await zip.textOf(item.path); } catch (e) { str = null; }
            if (str === null) continue;

            const doc = parseXML(str, true);
            const root = doc ? (doc.body || doc.documentElement) : null;
            if (!root) continue;

            const r = htmlToText(root, fragsByPath[item.path] || Object.create(null), offset);
            let piece = r.text;
            if (piece && piece.charAt(piece.length - 1) !== '\n') piece += '\n';

            docs.push({
                path: item.path,
                offset,
                length: piece.length,
                anchors: r.anchors,
                heading: r.heading
            });
            pieces.push(piece);
            offset += piece.length;
        }

        const text = pieces.join('');
        if (!text.trim()) throw new Error('EPUB 正文为空，可能带 DRM 加密');

        report(0.90, '构建目录');
        const chapters = buildChapters(text, docs, toc);

        // 7) 封面
        report(0.95, '提取封面');
        let cover = '';
        try {
            let coverItem = null;
            Object.keys(manifest).forEach(k => {
                if (!coverItem && /cover-image/.test(manifest[k].props)) coverItem = manifest[k];
            });
            if (!coverItem) {
                const metas = localTags(metaEl, 'meta');
                for (let i = 0; i < metas.length; i++) {
                    if ((metas[i].getAttribute('name') || '') === 'cover') {
                        const c = metas[i].getAttribute('content');
                        if (c && manifest[c]) coverItem = manifest[c];
                        break;
                    }
                }
            }
            if (!coverItem) {
                Object.keys(manifest).forEach(k => {
                    const m = manifest[k];
                    if (!coverItem && m.type.indexOf('image') === 0 && /cover/i.test(m.path)) coverItem = m;
                });
            }
            if (coverItem) {
                const bytes = await zip.bytes(coverItem.path);
                if (bytes && bytes.length && bytes.length < 12 * 1024 * 1024) {
                    const raw = await bytesToDataURL(bytes, coverItem.type || guessMime(coverItem.path));
                    cover = await downscaleCover(raw);
                }
            }
        } catch (e) { cover = ''; }

        report(1, '完成');
        return {
            text,
            chapters,
            title: (title || '').trim(),
            author: (author || '').trim(),
            cover
        };
    }

    global.EpubKit = { isEpub, parse, splitLongBlocks, MAX_BLOCK };

})(window);