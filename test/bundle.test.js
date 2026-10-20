/**
 * 对**打包产物**做行为验证。
 *
 * 为什么单独存在：`npm test` 跑的是 tsc 编译的 src/，
 * 而用户真正装进 Obsidian 的是 rollup + terser 的 main.js。
 * 两者之间隔着打包与压缩——单元测试全绿不代表装上去的那个是对的。
 * 这个脚本加载真实 bundle，通过它注册的命令走一遍真实转换路径。
 *
 * 运行：npm run test:bundle
 * 前置：npm run build（会在仓库根生成 main.js）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'main.js');

if (!fs.existsSync(BUNDLE)) {
    console.error('找不到 main.js，请先运行：npm run build');
    process.exit(1);
}

// ---- 桩：覆盖 bundle 在模块加载期与运行期用到的全部 Obsidian API ----
const STUB = path.join(os.tmpdir(), 'lc-bundle-stub.js');
fs.writeFileSync(
    STUB,
    `class Plugin { constructor(app, manifest){ this.app=app; this.manifest=manifest; }
       addCommand(){} addSettingTab(){} registerEvent(){} loadData(){return null;} saveData(){} }
     class PluginSettingTab { constructor(app, plugin){ this.app=app; this.plugin=plugin;
       this.containerEl={empty(){},createEl(){return {}},createDiv(){return {}}} } }
     class Modal { constructor(app){ this.app=app; this.containerEl={empty(){},createEl(){return {}}} } open(){} close(){} }
     class FuzzySuggestModal extends Modal { setPlaceholder(){} getSuggestions(){} onChooseSuggestion(){} renderSuggestion(){} }
     class Setting { setName(){return this} setDesc(){return this} addToggle(){return this}
                     addDropdown(){return this} addText(){return this} addButton(){return this} }
     class TFile { constructor(p){ this.path=p; this.name=p.split('/').pop();
       this.extension=(p.split('.').pop()||''); this.basename=this.name.replace(/\\.\\w+$/,''); } }
     class TFolder {}
     class Notice { setMessage(){} hide(){} }
     class MarkdownView {}
     const normalizePath = p => p, addIcon = ()=>{}, Menu = class Menu {};
     module.exports = { App: class App {}, Plugin, PluginSettingTab, Modal, FuzzySuggestModal,
       Setting, Menu, TFile, TFolder, Notice, MarkdownView, normalizePath, addIcon };\n`
);

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'obsidian') return STUB;
    return origResolve.call(this, request, ...rest);
};

const M = require(BUNDLE);
const PluginClass = M.default || M;

/* ---- 假 Vault ---- */
const FILES = [
    '30_Outcomes/微信公众号/稿.md',
    '00_Inbox/随想/随想.md',
    'attachments/outcomes/c.jpg',
];
const SRC = '30_Outcomes/微信公众号/稿.md';
const TEXT =
    '随想 [[00_Inbox/随想/随想]] 图 ![[attachments/outcomes/c.jpg]] ' +
    '坏的 [[../../00_Inbox/随想/随想.md.md|坏的别名]]';

const fileMap = new Map(
    FILES.map(p => [
        p,
        {
            path: p,
            name: p.split('/').pop(),
            basename: p.split('/').pop().replace(/\.\w+$/, ''),
            extension: p.split('.').pop(),
        },
    ])
);

// 贴近 Obsidian：库根 → 库根补扩展名 → 源目录相对 → 补扩展名 → 全库同名
function resolve(linkpath, srcPath) {
    const p = decodeURI(linkpath).split('#')[0];
    if (fileMap.has(p)) return fileMap.get(p);
    const withExt = p.endsWith('.md') ? p : p + '.md';
    if (fileMap.has(withExt)) return fileMap.get(withExt);
    const cand = path.posix.normalize(path.posix.join(path.posix.dirname(srcPath), p));
    if (fileMap.has(cand)) return fileMap.get(cand);
    const candExt = cand.endsWith('.md') ? cand : cand + '.md';
    if (fileMap.has(candExt)) return fileMap.get(candExt);
    const base = path.posix.basename(p).replace(/\.md$/, '');
    for (const f of fileMap.values()) if (f.basename === base) return f;
    return null;
}

let captured = null;
const app = {
    vault: {
        adapter: { stat: async () => ({}) },
        read: async () => TEXT,
        modify: async (_f, t) => { captured = t; },
        getFiles: () => [...fileMap.values()],
        getRoot: () => ({ path: '' }),
    },
    metadataCache: { getFirstLinkpathDest: resolve, getCache: () => ({ frontmatter: {} }) },
    workspace: {
        on: () => {}, off: () => {},
        getActiveFile: () => ({ path: SRC, name: '稿.md', basename: '稿', extension: 'md' }),
        getActiveViewOfType: () => null,
    },
};

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
    console.log('\n对打包产物 main.js 做行为验证');
    const plugin = new PluginClass(app, { id: 'obsidian-link-converter' });
    plugin.settings = { contextMenu: true, finalLinkFormat: 'not-change', keepMtime: false };

    const cmds = [];
    plugin.addCommand = c => cmds.push(c);
    await plugin.onload(); // async：先 await loadSettings 再注册命令

    check('bundle 可加载并注册命令', cmds.length >= 8, `仅注册 ${cmds.length} 条`);

    const conv = cmds.find(c => c.id === 'convert-wikis-to-md-in-active-file');
    if (!conv) {
        console.log('  ✗ 找不到「Active File: Links to Markdown」命令');
        process.exit(1);
    }

    await conv.callback();
    // 命令回调内部没有 await 转换，给落盘留时间
    for (let i = 0; i < 50 && captured === null; i++) {
        await new Promise(r => setTimeout(r, 20));
    }

    check('命令确实写回了文件', captured !== null);
    if (captured === null) process.exit(1);

    console.log('\n  落盘结果：\n    ' + String(captured).replace(/\n/g, '\n    '));
    console.log('');

    check('笔记链接为 ../../ 相对路径（Typora 可渲染）',
        /\]\(\.\.\/\.\.\/00_Inbox\/随想\/随想\.md\)/.test(captured), String(captured));
    check('图片链接为 ../../ 相对路径',
        /!\[[^\]]*\]\(\.\.\/\.\.\/attachments\/outcomes\/c\.jpg\)/.test(captured), String(captured));
    check('.md.md 坏链接被自愈',
        /\]\(\.\.\/\.\.\/00_Inbox\/随想\/随想\.md\)/.test(captured) && !/\.md\.md/.test(captured),
        String(captured));
    check('压缩后未破坏语义（无 undefined 泄漏）', !/undefined/.test(String(captured)), String(captured));

    console.log(`\n通过 ${pass} / 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
