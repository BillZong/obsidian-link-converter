#!/usr/bin/env node
/**
 * 把构建产物安装到本机所有 Obsidian Vault 的插件目录。
 *
 * 为什么需要它：
 * 1. 一台机器常同时开着多个 Vault，插件目录各有一份。只改一个，
 *    在另一个 Vault 里转换链接仍会得到旧行为，而且很难察觉。
 * 2. iCloud Drive 会同步 .obsidian，换机器或同步冲突后可能被旧版本覆盖。
 *    这个脚本可重复执行，随时把各处拉回同一版本。
 *
 * 用法：
 *   npm run build && npm run install:all
 *   npm run install:all -- --dry-run     # 只看会改哪些，不落盘
 *   npm run install:all -- --vault <路径> # 只装指定 Vault
 *
 * 安装前会自动备份被替换的旧版本到 ~/.local/state/wrok/plugin-backups/。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PLUGIN_ID = 'obsidian-link-converter';
const FILES = ['main.js', 'manifest.json', 'styles.css'];
const BACKUP_ROOT = path.join(os.homedir(), '.local', 'state', 'wrok', 'plugin-backups');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyVault = args.includes('--vault') ? args[args.indexOf('--vault') + 1] : null;

function stamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

/** 从 ~/.config/obsidian/obsidian.json 读出已注册的 Vault 列表。 */
function registeredVaults() {
    const cfg = path.join(os.homedir(), 'Library/Application Support/obsidian/obsidian.json');
    if (!fs.existsSync(cfg)) {
        console.error('  ! 找不到 Obsidian 配置，跳过自动发现：' + cfg);
        return [];
    }
    try {
        const vaults = JSON.parse(fs.readFileSync(cfg, 'utf8')).vaults || {};
        return Object.values(vaults).map(v => v.path).filter(Boolean);
    } catch (e) {
        console.error('  ! 解析 Obsidian 配置失败：' + e.message);
        return [];
    }
}

function sha256(file) {
    return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function installInto(vault) {
    const dest = path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
    const label = path.basename(vault);

    // 源文件缺失就不装，避免装出一个坏插件
    for (const f of FILES) {
        if (!fs.existsSync(path.join(ROOT, f))) {
            console.log(`  ✗ ${label}: 构建产物缺少 ${f}，请先 npm run build`);
            return 'missing-build';
        }
    }
    if (!fs.existsSync(path.dirname(dest))) return 'no-plugin-dir';

    const currentMain = path.join(dest, 'main.js');
    // 必须比对全部产物文件。只比 main.js 的话，只改 manifest.json（比如升版本号）
    // 会被误判为「已是最新」，Vault 里留着旧 manifest 却显示最新代码。
    const alreadySame = FILES.every((f) => {
        const cur = path.join(dest, f);
        const src = path.join(ROOT, f);
        return fs.existsSync(cur) && fs.existsSync(src) && sha256(cur) === sha256(src);
    });
    if (alreadySame) return 'same';

    if (dryRun) {
        const cur = fs.existsSync(currentMain) ? fs.statSync(currentMain).size : 0;
        console.log(`  · ${label}: 需要更新（当前 main.js ${cur} 字节 → ${fs.statSync(path.join(ROOT, 'main.js')).size} 字节）`);
        return 'changed';
    }

    // 备份旧版本，便于回滚
    let backupDir = null;
    if (fs.existsSync(currentMain)) {
        backupDir = path.join(BACKUP_ROOT, PLUGIN_ID + '-' + stamp());
        fs.mkdirSync(backupDir, { recursive: true });
        for (const f of fs.existsSync(path.join(dest, 'styles.css')) ? FILES : ['main.js', 'manifest.json']) {
            const src = path.join(dest, f);
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
        }
    }

    for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
    console.log(`  ✓ ${label}: 已更新${backupDir ? `（备份见 ${backupDir}）` : ''}`);
    return 'changed';
}

const vaults = onlyVault ? [onlyVault] : registeredVaults();
if (vaults.length === 0) {
    console.log('未找到任何 Vault，可用 --vault <路径> 指定。');
    process.exit(0);
}

console.log(`\n${dryRun ? '[试运行] ' : ''}安装到 ${vaults.length} 个 Vault：`);
const summary = { same: 0, changed: 0, skipped: 0 };
for (const v of vaults) {
    const r = installInto(v);
    if (r === 'same') { summary.same++; console.log(`  · ${path.basename(v)}: 已是最新，无需改动`); }
    else if (r === 'changed') summary.changed++;
    else summary.skipped++;
}
console.log(`\n更新 ${summary.changed} · 已是最新 ${summary.same} · 跳过 ${summary.skipped}`);
if (summary.changed > 0 && !dryRun) {
    console.log('\n注意：Obsidian 需要重新加载插件才能生效。');
    console.log('在 Obsidian 里：设置 → 第三方插件 → Link Converter → 关闭再开启（或重启 Obsidian）。');
}
