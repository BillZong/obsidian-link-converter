/**
 * 回归测试：直接跑 src/ 编译出的真实实现，而不是逻辑副本。
 *
 * 背景：Wiki 与 Markdown 的路径解析基准不同，混用必然产生断链。
 *   Wikilink  从库根解析，惯例不带 .md
 *   Markdown  从**源文件所在目录**解析
 *
 * 之前 createLink 对两种目标使用同一套路径，于是：
 *   wiki→markdown       产出库根路径  → 断链
 *   markdown→wiki       保留 ../../ 与 .md → 断链
 *
 * 运行：npm test
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), 'lc-regression-build');

/* ---------- 编译 TypeScript ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
try {
    execFileSync(
        'npx',
        ['tsc', 'src/converter.ts', 'src/settings.ts', 'src/utils.ts', 'src/main.ts',
            '--outDir', OUT, '--module', 'commonjs', '--target', 'es2020',
            '--skipLibCheck', '--esModuleInterop'],
        { cwd: ROOT, stdio: 'pipe' }
    );
} catch (e) {
    // tsc 会因 'main'/'modals' 缺少 baseUrl 报 TS2307，JS 产物仍会生成。
    const out = (e.stdout || '').toString() + (e.stderr || '').toString();
    if (!out.includes('TS2307')) {
        console.error('TypeScript 编译失败:\n' + out);
        process.exit(1);
    }
}

// converter / utils 里的 `import ... from 'main'` 是类型导入，编译后仍保留 require，
// 这里给它们一个空壳，避免解析失败。
fs.writeFileSync(
    path.join(OUT, 'main.js'),
    'class LinkConverterPlugin {}\nmodule.exports = { default: LinkConverterPlugin };\n'
);

const obsidianStub = path.join(OUT, 'obsidian-stub.js');
fs.writeFileSync(
    obsidianStub,
    `class TFile { constructor(p){ this.path=p; this.extension=p.split('.').pop();
       this.name=p.split('/').pop(); this.basename=p.split('/').pop().replace(/\\.\\w+$/,''); } }
     class TFolder {}
     class Notice { setMessage(){} hide(){} }
     class MarkdownView {}
     const normalizePath = p => p;
     module.exports = { TFile, TFolder, Notice, MarkdownView, normalizePath };\n`
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'main') return path.join(OUT, 'main.js');
    if (request === 'obsidian') return obsidianStub;
    return origResolve.call(this, request, ...rest);
};

const { convertWikiLinksToMarkdown, convertLinksAndSaveInSingleFile, convertLinksInFileToPreferredFormat } =
    require(path.join(OUT, 'converter.js'));

/* ---------- 假 Vault ---------- */
const SRC = '30_Outcomes/微信公众号/一局斗地主之后.md';

function makePlugin(filePaths, inputText, format, capture) {
    const fileMap = new Map(
        filePaths.map(p => [
            p,
            {
                path: p,
                extension: p.split('.').pop(),
                name: p.split('/').pop(),
                basename: p.split('/').pop().replace(/\.\w+$/, ''),
            },
        ])
    );

    // 模拟 Obsidian 的 metadataCache：先按库根找，再按源文件目录找。
    function resolve(linkpath, srcPath) {
        const p = decodeURI(linkpath).split('#')[0];
        if (fileMap.has(p)) return fileMap.get(p);
        const base = path.posix.dirname(srcPath);
        const cand = path.posix.normalize(path.posix.join(base, p));
        if (fileMap.has(cand)) return fileMap.get(cand);
        const withExt = cand.endsWith('.md') ? cand : cand + '.md';
        if (fileMap.has(withExt)) return fileMap.get(withExt);
        const withMd = p.endsWith('.md') ? p : p + '.md';
        if (fileMap.has(withMd)) return fileMap.get(withMd);
        return null;
    }

    return {
        settings: { finalLinkFormat: format, keepMtime: false },
        app: {
            metadataCache: { getFirstLinkpathDest: resolve, getCache: () => ({ frontmatter: {} }) },
            vault: {
                getFiles: () => [...fileMap.values()],
                read: async () => inputText,
                modify: async (_f, txt) => { capture.txt = txt; },
            },
        },
    };
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) { passed++; console.log('  ✓ ' + name); }
    else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

/* ================= 用例 1：wiki → markdown ================= */
(async () => {
    console.log('\n[1] wiki → markdown：必须产出相对源文件目录的路径');
    const files = [
        '30_Outcomes/微信公众号/一局斗地主之后.md',
        '00_Inbox/随想/教育应深入到生活的每一个角落.md',
        'attachments/outcomes/cover-parenting.jpg',
        '10_References/local/AI/某书.md',
    ];
    const input = [
        "source_note: '[[00_Inbox/随想/教育应深入到生活的每一个角落]]'",
        '![[attachments/outcomes/cover-parenting.jpg]]',
        '参考 [[10_References/local/AI/某书]] 与 [[一局斗地主之后]]。',
    ].join('\n');
    const plugin = makePlugin(files, input, 'not-change', {});
    const out = await convertWikiLinksToMarkdown(input, { path: SRC }, plugin);

    check('随想链接带 ../../ 且不含 ../.. 之外的层级',
        /\[教育应深入到生活的每一个角落\]\(\.\.\/\.\.\/00_Inbox\/随想\/教育应深入到生活的每一个角落\.md\)/.test(out),
        out);
    check('图片链接带 ../../',
        /!\[[^\]]*\]\(\.\.\/\.\.\/attachments\/outcomes\/cover-parenting\.jpg\)/.test(out),
        out);
    check('本地书链接带 ../../',
        /\[某书\]\(\.\.\/\.\.\/10_References\/local\/AI\/某书\.md\)/.test(out),
        out);
    check('同目录链接不带 ../',
        /\[一局斗地主之后\]\(一局斗地主之后\.md\)/.test(out),
        out);
    check('不出现双扩展名 .md.md', !/\.md\.md/.test(out), out);
    check('不出现仓库根相对路径（误用）', !/\]\(00_Inbox\//.test(out), out);

    /* ================= 用例 2：markdown → wiki ================= */
    console.log('\n[2] markdown → wiki：必须产出库根路径，不带 ../ 与 .md');
    const files2 = [
        '30_Outcomes/微信公众号/稿.md',
        '00_Inbox/随想/随想.md',
        'attachments/outcomes/c.jpg',
    ];
    const input2 = [
        "source_note: '[随想](../../00_Inbox/随想/随想.md)'",
        '![封面](../../attachments/outcomes/c.jpg)',
        '同目录 [自己](稿.md)。',
    ].join('\n');
    const cap = {};
    await convertLinksAndSaveInSingleFile({ path: '30_Outcomes/微信公众号/稿.md' },
        makePlugin(files2, input2, 'not-change', cap), 'wiki');
    const out2 = String(cap.txt);

    check('不再残留 ../ 前缀', !/\.\.\//.test(out2), out2);
    check('随想链接为库根路径',
        /\[\[00_Inbox\/随想\/随想(\|[^\]]*)?\]\]/.test(out2), out2);
    check('图片链接为库根路径',
        /!\[\[attachments\/outcomes\/c\.jpg(\|[^\]]*)?\]\]/.test(out2), out2);
    check('同目录链接可解析（库根路径或文件名）',
        /\[\[(?:30_Outcomes\/微信公众号\/)?稿(\|[^\]]*)?\]\]/.test(out2), out2);

    /* ================= 用例 3：relative-path 设置对 wiki 也必须可解析 ================= */
    console.log('\n[3] finalLinkFormat=relative-path 时，wiki 目标仍须可解析');
    const cap3 = {};
    await convertLinksAndSaveInSingleFile({ path: '30_Outcomes/微信公众号/稿.md' },
        makePlugin(files2, input2, 'relative-path', cap3), 'wiki');
    const out3 = String(cap3.txt);
    check('relative-path 不会产出带 ../ 的 wikilink', !/\[\[[^\]]*\.\.\//.test(out3), out3);

    /* ================= 用例 4：markdown 目标不受 shortest-path 影响 ================= */
    console.log('\n[4] finalLinkFormat=shortest-path 时，markdown 仍须相对源文件目录');
    const plugin4 = makePlugin(files, input, 'shortest-path', {});
    const out4 = await convertWikiLinksToMarkdown(input, { path: SRC }, plugin4);
    check('shortest-path 下图片链接仍带 ../../',
        /\]\(\.\.\/\.\.\/attachments\/outcomes\/cover-parenting\.jpg\)/.test(out4), out4);

    /* ================= 用例 5：不可解析的链接不得被改写 ================= */
    console.log('\n[5] 无法解析的链接保持原样，不应被猜改');
    const input5 = '![x](不存在的图片.png) 与 [[根本不存在的笔记]]';
    const out5 = await convertWikiLinksToMarkdown(input5, { path: SRC },
        makePlugin(files, input5, 'not-change', {}));
    check('未命中的链接原样保留', /!\[[^\]]*\]\(不存在的图片\.png\)/.test(out5), out5);

    /* ================= 用例 6：路径格式转换命令（另一个入口） ================= */
    console.log('\n[6] convertLinksInFileToPreferredFormat：格式转换后仍须可解析');
    // 这个入口先把路径按设置改写，再交给 createLink。
    // 若 createLink 对改写后的路径二次解析失败，就会跳过归一、写出半成品链接。
    const files6 = [
        '30_Outcomes/微信公众号/稿.md',
        '00_Inbox/随想/随想.md',
        'attachments/outcomes/c.jpg',
    ];
    const src6 = '30_Outcomes/微信公众号/稿.md';
    const wikiIn = '随想 [[00_Inbox/随想/随想]] 与图 ![[attachments/outcomes/c.jpg]]';
    const mdIn = '随想 [随想](../../00_Inbox/随想/随想.md) 与图 ![c](../../attachments/outcomes/c.jpg)';

    const cases6 = [
        // [format, 输入语法, 期望正则]
        ['relative-path', 'md', /\]\(\.\.\/\.\.\/00_Inbox\/随想\/随想\.md\)/],
        ['relative-path', 'md', /\]\(\.\.\/\.\.\/attachments\/outcomes\/c\.jpg\)/],
        ['absolute-path', 'md', /\]\(\.\.\/\.\.\/00_Inbox\/随想\/随想\.md\)/],
        // shortest-path 对 Markdown 仍必须相对源文件目录：
        // 裸文件名只在同目录时可解析，跨目录必然断链。
        ['shortest-path', 'md', /\]\(\.\.\/\.\.\/00_Inbox\/随想\/随想\.md\)/],
        ['shortest-path', 'md', /\]\(\.\.\/\.\.\/attachments\/outcomes\/c\.jpg\)/],
        // Wikilink 侧：从库根解析，不允许出现 ./
        ['relative-path', 'wiki', /\[\[00_Inbox\/随想\/随想(\|[^\]]*)?\]\]/],
        ['absolute-path', 'wiki', /\[\[00_Inbox\/随想\/随想(\|[^\]]*)?\]\]/],
        ['shortest-path', 'wiki', /\[\[随想(\.md)?(\|[^\]]*)?\]\]/],
    ];
    for (const [fmt, syntax, re] of cases6) {
        const cap6 = {};
        await convertLinksInFileToPreferredFormat(
            { path: src6 },
            makePlugin(files6, syntax === 'md' ? mdIn : wikiIn, fmt, cap6),
            fmt
        );
        const out6 = String(cap6.txt);
        check(`${fmt} + ${syntax} 产出可解析路径`, re.test(out6), out6);
        check(`${fmt} + ${syntax} 无 ../.. 与 .md.md`, !/\.\.\/\.\.\/\.\./.test(out6) && !/\.md\.md/.test(out6), out6);
    }

    /* ================= 用例 7：自愈已被写坏的链接 ================= */
    console.log('\n[7] 自愈：旧版本写坏的链接（多一层 .md）应能被修复');
    // 库里可能已经存在 [[../../00_Inbox/随想/X.md.md]] 这类坏链接。
    // 按原样解析不到目标 → 无法进入归一分支 → 坏链接被原样保留、越转越坏。
    // 所以解析失败时要退一步去掉一层 .md 重试。
    const files7 = [
        '30_Outcomes/微信公众号/一局斗地主之后.md',
        '00_Inbox/随想/教育应深入到生活的每一个角落.md',
    ];
    const src7 = '30_Outcomes/微信公众号/一局斗地主之后.md';
    const broken7 = "source_note: '[[../../00_Inbox/随想/教育应深入到生活的每一个角落.md.md|教育应深入到生活的每一个角落]]'";

    const cap7 = {};
    await convertLinksAndSaveInSingleFile({ path: src7 },
        makePlugin(files7, broken7, 'not-change', cap7), 'wiki');
    // 说明：broken7 本身就是 wikilink，wiki→wiki 本就是空操作（正确行为），
    // 自愈只在格式真正发生转换时生效，因此 wiki 侧改用「已损坏的 markdown 链接」来测。
    check('wikilink 输入给 wiki 转换时保持不变（空操作）',
        String(cap7.txt) === broken7, String(cap7.txt));

    const out7 = await convertWikiLinksToMarkdown(broken7, { path: src7 },
        makePlugin(files7, broken7, 'not-change', {}));
    check('.md.md 坏链接 → markdown 被修复为正确相对路径',
        /\]\(\.\.\/\.\.\/00_Inbox\/随想\/教育应深入到生活的每一个角落\.md\)/.test(out7),
        out7);
    check('修复后不再出现 .md.md', !/\.md\.md/.test(out7), out7);

    // md→wiki 侧：已损坏的 markdown 链接（多一层 .md）应能被修复
    const brokenMd = '[教育应深入到生活的每一个角落](../../00_Inbox/随想/教育应深入到生活的每一个角落.md.md)';
    const cap9 = {};
    await convertLinksAndSaveInSingleFile({ path: src7 },
        makePlugin(files7, brokenMd, 'not-change', cap9), 'wiki');
    check('.md.md 坏链接 → md→wiki 修复为库根路径且不带 .md',
        /\[\[00_Inbox\/随想\/教育应深入到生活的每一个角落(\|[^\]]*)?\]\]/.test(String(cap9.txt)),
        String(cap9.txt));
    check('md→wiki 修复后不含 .md.md', !/\.md\.md/.test(String(cap9.txt)), String(cap9.txt));

    // Wikilink 带 .md 的情况：转成 markdown 时应保留单层 .md 且路径可解析
    const withExt = '[[00_Inbox/随想/教育应深入到生活的每一个角落.md]]';
    const out10 = await convertWikiLinksToMarkdown(withExt, { path: src7 },
        makePlugin(files7, withExt, 'not-change', {}));
    check('带 .md 的 wikilink → markdown 路径可解析',
        /\]\(\.\.\/\.\.\/00_Inbox\/随想\/教育应深入到生活的每一个角落\.md\)/.test(out10),
        out10);

    /* ================= 用例 8：真实 Vault 结构上的端到端回归 ================= */
    console.log('\n[8] 真实 Vault 结构：Typora / VSCode 场景');
    // 上面 7 组用的是人造路径。这里用一个与真实库同构的文件集复现用户遇到的情况：
    // 三篇文章在 30_Outcomes/微信公众号/，图在 attachments/outcomes/，
    // 目标笔记分别在 00_Inbox/随想/ 与 20_Throughput/。
    const files8 = [
        '30_Outcomes/微信公众号/一局斗地主之后.md',
        '00_Inbox/随想/教育应深入到生活的每一个角落.md',
        '20_Throughput/Theme-学习方法.md',
        'attachments/outcomes/cover-parenting.jpg',
        'attachments/outcomes/fig-relation-cost.jpg',
    ];
    const src8 = '30_Outcomes/微信公众号/一局斗地主之后.md';
    const real8 =
        "source_note: '[[00_Inbox/随想/教育应深入到生活的每一个角落|教育应深入到生活的每一个角落]]'\n" +
        '![[attachments/outcomes/cover-parenting.jpg]]\n' +
        '参考 [[20_Throughput/Theme-学习方法]] 与 ![[attachments/outcomes/fig-relation-cost.jpg]]。';
    const out8 = await convertWikiLinksToMarkdown(real8, { path: src8 },
        makePlugin(files8, real8, 'not-change', {}));

    check('笔记链接为 ../../ 相对路径',
        /\]\(\.\.\/\.\.\/00_Inbox\/随想\/教育应深入到生活的每一个角落\.md\)/.test(out8), out8);
    check('图片链接为 ../../ 相对路径（Typora 可渲染）',
        /!\[[^\]]*\]\(\.\.\/\.\.\/attachments\/outcomes\/cover-parenting\.jpg\)/.test(out8), out8);
    check('第二张图片同样带 ../../',
        /!\[[^\]]*\]\(\.\.\/\.\.\/attachments\/outcomes\/fig-relation-cost\.jpg\)/.test(out8), out8);
    check('主题笔记链接带 ../../ 且单层 .md',
        /\]\(\.\.\/\.\.\/20_Throughput\/Theme-学习方法\.md\)/.test(out8), out8);
    check('图片 alt 取文件名而非 undefined',
        /!\[cover-parenting\]/.test(out8) && !/undefined/.test(out8), out8);
    check('无 .md.md', !/\.md\.md/.test(out8), out8);

    console.log(`\n通过 ${passed} / 失败 ${failed}`);
    process.exit(failed ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
