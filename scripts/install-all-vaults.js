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
 *   npm run install:all -- --reinstall   # 先卸载再安装（推荐用于换版本）
 *   npm run install:all -- --uninstall   # 只卸载，不安装
 *
 * 「先卸载再安装」而不是直接覆盖文件：
 * 直接覆盖会残留旧版本的缓存状态（Obsidian 内存里已加载的旧插件、
 * 插件目录里遗留的旧文件）。走一遍卸载能让注册状态和文件都干净重来，
 * 这也是 Obsidian 界面里「卸载 → 放入新文件 → 启用」的实际步骤。
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
const doUninstall = args.includes('--uninstall');
const doReinstall = args.includes('--reinstall');

function stamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
}

/** 从 Obsidian 配置读出已注册的 Vault 列表。 */
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

/* -------------------- 启用状态（community-plugins.json） -------------------- */

function enabledListPath(vault) {
    return path.join(vault, '.obsidian', 'community-plugins.json');
}

function readEnabled(vault) {
    const p = enabledListPath(vault);
    if (!fs.existsSync(p)) return null;
    try {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Array.isArray(v) ? v : [];
    } catch (e) {
        console.error('  ! 解析 community-plugins.json 失败：' + e.message);
        return null;
    }
}

function writeEnabled(vault, list) {
    // 保持 Obsidian 自己的格式：2 空格缩进的数组
    fs.writeFileSync(enabledListPath(vault), JSON.stringify(list, null, 2) + '\n', 'utf8');
}

function setEnabled(vault, enabled) {
    const list = readEnabled(vault);
    if (list === null) return false; // 文件不存在或坏了，不动它
    const has = list.includes(PLUGIN_ID);
    if (enabled && !has) {
        list.push(PLUGIN_ID);
        writeEnabled(vault, list);
        return true;
    }
    if (!enabled && has) {
        writeEnabled(vault, list.filter(id => id !== PLUGIN_ID));
        return true;
    }
    return false;
}

/* -------------------- 卸载 / 安装 -------------------- */

function uninstallFrom(vault) {
    const dest = path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
    const label = path.basename(vault);
    const existed = fs.existsSync(dest);

    if (dryRun) {
        console.log(`  · ${label}: 将卸载${existed ? '' : '（目录不存在，仅清理启用状态）'}`);
        return 'changed';
    }

    // 1. 从启用列表里摘掉
    const listChanged = setEnabled(vault, false);

    // 2. 插件目录移走而不是删掉，出问题能找回来
    let backupDir = null;
    if (existed) {
        backupDir = path.join(BACKUP_ROOT, PLUGIN_ID + '-uninstalled-' + stamp());
        fs.mkdirSync(backupDir, { recursive: true });
        for (const f of fs.readdirSync(dest)) {
            fs.renameSync(path.join(dest, f), path.join(backupDir, f));
        }
        fs.rmdirSync(dest);
    }

    console.log(`  ✓ ${label}: 已卸载${listChanged ? '（已从启用列表移除）' : ''}${backupDir ? `，旧文件见 ${backupDir}` : ''}`);
    return 'changed';
}

function installInto(vault, force) {
    const dest = path.join(vault, '.obsidian', 'plugins', PLUGIN_ID);
    const label = path.basename(vault);

    // 源文件缺失就不装，避免装出一个坏插件
    for (const f of FILES) {
        if (!fs.existsSync(path.join(ROOT, f))) {
            console.log(`  ✗ ${label}: 构建产物缺少 ${f}，请先 npm run build`);
            return 'missing-build';
        }
    }
    fs.mkdirSync(dest, { recursive: true });

    const alreadySame = FILES.every((f) => {
        const cur = path.join(dest, f);
        const src = path.join(ROOT, f);
        return fs.existsSync(cur) && fs.existsSync(src) && sha256(cur) === sha256(src);
    });
    // 启用状态也要一致：文件在但没启用，等于没装
    const enabledOk = (readEnabled(vault) || []).includes(PLUGIN_ID);
    if (alreadySame && enabledOk && !force) return 'same';

    if (dryRun) {
        console.log(`  · ${label}: 将安装${alreadySame ? '' : '（文件有变化）'}${enabledOk ? '' : '（并注册为启用）'}`);
        return 'changed';
    }

    // 备份旧版本，便于回滚
    const currentMain = path.join(dest, 'main.js');
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
    const reEnabled = setEnabled(vault, true);
    console.log(`  ✓ ${label}: 已安装${backupDir ? `（旧文件备份见 ${backupDir}）` : ''}${reEnabled ? '，已注册为启用' : ''}`);
    return 'changed';
}

/* -------------------- 主流程 -------------------- */

const vaults = onlyVault ? [onlyVault] : registeredVaults();
if (vaults.length === 0) {
    console.log('未找到任何 Vault，可用 --vault <路径> 指定。');
    process.exit(0);
}

const mode = doUninstall ? '卸载' : doReinstall ? '重装（先卸载后安装）' : '安装';
console.log(`\n${dryRun ? '[试运行] ' : ''}${mode} ${vaults.length} 个 Vault：`);

const summary = { same: 0, changed: 0, skipped: 0 };
for (const v of vaults) {
    let r;
    if (doUninstall) {
        r = uninstallFrom(v);
    } else if (doReinstall) {
        uninstallFrom(v);
        r = installInto(v, true);
    } else {
        r = installInto(v);
    }
    if (r === 'same') { summary.same++; console.log(`  · ${path.basename(v)}: 已是最新，无需改动`); }
    else if (r === 'changed') summary.changed++;
    else summary.skipped++;
}
console.log(`\n更新 ${summary.changed} · 已是最新 ${summary.same} · 跳过 ${summary.skipped}`);
if (summary.changed > 0 && !dryRun) {
    console.log('\n注意：Obsidian 需要重新加载插件才能生效。');
    console.log('在 Obsidian 里：设置 → 第三方插件 → Link Converter → 关闭再开启（或重启 Obsidian）。');
}
