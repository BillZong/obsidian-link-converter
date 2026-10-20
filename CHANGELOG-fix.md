# 修复：Wiki 与 Markdown 链接路径混用导致断链

## 问题

Wikilink 与 Markdown 的路径解析基准不同：

| 格式 | 解析基准 | 有效形式 |
|---|---|---|
| `[[wikilink]]` | **库根** | `a/b/note`，惯例不带 `.md` |
| `![](markdown)` | **源文件所在目录** | `../../a/b/note.md` |

原 `createLink` 对两种目标使用同一套 `getFileLinkInFormat` 结果，于是两个方向都会产出断链：

* **wiki → markdown**：产出库根相对路径 `(00_Inbox/随想/X.md)`，Markdown 从源文件目录解析 → 断链
* **markdown → wiki**：保留 `../../` 与 `.md`，Wikilink 从库根解析 → 断链

## 改动

`src/converter.ts`

1. **按目标格式分别归一**。markdown 目标一律走 `getRelativeLink`（源文件相对路径），
   wiki 目标走新增的 `toWikiPath`（库根路径）。无论 `finalLinkFormat` 设成什么，
   markdown 都不会再产出库根路径——那在 Markdown 里无解。
2. **新增 `toWikiPath`**。设置里的 `relative-path` 对 Wikilink 本就无效（那是 Markdown
   的概念），现在映射到库根相对路径，而不是产出一个必然断链的结果。
3. **`not-change` 也归一**。之前原样透传，来源是 Markdown 相对路径时会带着 `../../`
   和 `.md` 直接塞进 Wikilink。
4. **消除 `convertLinksInFileToPreferredFormat` 的重复解析**。该入口先把路径改写、
   再交给 `createLink` 二次解析；改写后的路径解析失败就会跳过归一、写出半成品链接。
   现在把已解析出的 `TFile` 通过新增的 `knownFile` 参数直接传入。
   这条修复了 `shortest-path` + markdown 产出裸文件名（仅同目录可解析）的问题。
5. **修 `.md.md` 双扩展名**。markdown 路径去掉 `.md` 后由 `fileExtension` 补回。
6. **修自链接算出空路径**。`getRelativeLink(x, x)` 原返回空串，会产出 `](.md)`。
7. **自愈历史损坏的链接**。旧版本可能已写出 `[[../../a/b/X.md.md]]`（多一层扩展名）
   或 `[[a/b/X.md]]`（Wikilink 不该带扩展名）。这类链接按原样解析不到目标，
   进不了归一分支，于是会被原样保留、越转越坏。现在解析失败时退一步去掉一层
   `.md` 重试，让插件能修复已损坏的链接，而不只是不再制造新的。
8. **新增多 Vault 安装脚本** `scripts/install-all-vaults.js`（`npm run install:all`）。
   一台机器常同时开着多个 Vault、插件目录各有一份；只改一个会在其他 Vault
   里继续得到旧行为且不易察觉。脚本从 `obsidian.json` 读取已注册 Vault，
   逐个比对 sha256、只更新落后的，安装前自动备份，支持 `--dry-run` 与
   `--vault <路径>`。

## 测试

分两层，共 47 条断言（`npm run test:all`）：

1. **源码层** `test/run-tests.js`（`npm test`，41 条）——直接编译 `src/` 跑真实实现，
   不是逻辑副本，改坏真代码会失败。覆盖两个转换入口 × 三种 `finalLinkFormat` ×
   wiki/markdown × 普通链接/图片/同目录/自链接/未命中；
   另含「已损坏链接的自愈」与「真实 Vault 结构上的 Typora/VSCode 场景」两组。
2. **产物层** `test/bundle.test.js`（`npm run test:bundle`，6 条）——加载真实 `main.js`
   走完整命令路径，验证 terser 压缩未破坏语义、命令确实写回文件。

反向验证：同一套源码测试跑修复前的代码 → **19 条失败**；跑修复后的代码 → **41 条全过**。

## 实测输出（真实 Vault 结构）

```
source_note: '[[00_Inbox/随想/教育应深入到生活的每一个角落|…]]'
  → [教育应深入到生活的每一个角落](../../00_Inbox/随想/教育应深入到生活的每一个角落.md)

![[attachments/outcomes/cover-parenting.jpg]]
  → ![cover-parenting](../../attachments/outcomes/cover-parenting.jpg)
```

`../../` 是相对**当前文件所在目录**的两级回退，从
`30_Outcomes/微信公众号/` 出发正好落在库根，Typora / VSCode / Obsidian 都能解析。

## 未覆盖

* 需要 Obsidian 运行时才能验的：`metadataCache` 的真实解析行为、
  wikilink 的跨库解析、设置项 UI。本地测试用桩替代 Obsidian API。
* `data.json` 里的 `finalLinkFormat` 若为 `not-change`，行为已按上面第 3 点修正。
