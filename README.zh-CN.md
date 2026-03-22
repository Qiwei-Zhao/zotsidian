# Zotsidian

[English](./README.md) | [简体中文](./README.zh-CN.md)

Zotsidian 是一个整合Zotero 8 工作流的的 Obsidian 插件。支持流畅的写作体验、文献来源信息、PDF注释预览插入，和Discourse Graph工作流。

它起初来自一个引用文献插入的工作流想法，受到了 [zotero-roam](https://github.com/alixlahuec/zotero-roam) 和 [obsidian-deepsit](https://github.com/bassio/obsidian-deepsit) 的启发；现在已经发展成一个更完整的 Zotero-to-Obsidian 工作流，并支持 [discourse-graphs](https://github.com/DiscourseGraphs/discourse-graph)，整个项目由 AI 辅助开发。当前版本还处于测试阶段，如果你有任何问题和建议，欢迎随时反馈。

![Zotsidian cover](./gifs/cover.png)

## Highlights

Zotsidian 当前围绕 5 个实用能力构建：

1. Citation 引用工作流
   - 在编辑器中用行内 `引用
   - 使用独立的 Zotero 搜索面板检索文献
   - 用悬浮卡片快速查看引用的对应文献信息
2. References 文献侧边栏
   - 在不离开当前页面的情况下查看本页所有引用文献
   - 写作时可以排序、聚焦和回跳引用的文中位置
3. Source page 文献页面工作区
   - 将 `@citekey` note 作为 paper dashboard 使用
   - 在同一侧边栏中查看元数据、附件、外部链接、注释、引用和相关文献
4. Zotero 图文标注
   - 过滤、复制、打开并一键插入zotero高亮注释或图片
5. Discourse graph canvas 支持
   - 与 `discourse-graphs` canvas画布支持
   - 识别文献节点、文本格式的文献引用和其他 discourse graph节点。  
   - 根据 canvas 画布选择高亮侧边栏条目
   - 从侧边栏引用数字按钮反向跳回 canvas对应位置

## 核心功能

### 1. 文献引用插入和悬浮卡片

Zotsidian 支持两种引用输入方式：

- 编辑器中的行内 `@` 自动补全
- 独立的 Zotero 搜索面板

悬浮卡片可以让你不离开当前上下文就快速查看引用。对于轻量写作工作流来说，这尤其有用，因为你可以不创建文献页面，也完成检索和插入。

插入的 citation 格式可配置为：

- `[@citekey]`
- `@citekey`
- `[[@citekey]]`

这三种格式都会被插件视为正式的文献引用。

![Citation search and hover workflow](./gifs/search_citaiton_card.png)

### 2. 文献侧边栏

对于普通笔记，右侧边栏会显示当前页面使用到的 references。

这支持一种“写作优先”的工作流：你可以一边在主编辑器中写作，一边并行查看 references、调整排序，并通过侧边栏跳回 citekey 出现的位置。

References 侧边栏支持：

- 普通 Obsidian notes
- Obsidian Base
- discourse-graphs canvas
- 原生 Obsidian canvas

排序方式：

- insertion order
- year, newest first
- author + year

还支持在侧边栏中高亮当前输入行对应的引用。点击侧边栏中的数字按钮，可以跳回引用所在位置。Discourse graph nodes 也支持类似联动。

![References sidebar](./gifs/sidebar_reference.png)

### 3. 文献页面工作区

文献页面是一个命名为 `@citekey` 的 note。

当前笔记是一个文献页面时，侧边栏会切换成一个文献工作区，可以显示：

- Zotero 元数据
- 附件链接
- 外部链接，例如 Zotero、Semantic Scholar、Google Scholar 和 Connected Papers
- 过滤后的 Zotero 注释
- 一键插入 / 复制 / 打开注释
- 当前文献的引用
- 当前文献的引用
- 已存在于你的 Obsidian / Zotero 工作流中的相关文献
- 在笔记正文中检测到的 discourse graph nodes

![Source page workspace](./gifs/siderbar_source.png)

### 4. discourse-graphs canvas画布支持

Zotsidian 对 [discourse-graphs](https://github.com/DiscourseGraphs/discourse-graph) Obsidian 插件提供了专门支持。

在 discourse canvas 页面中，侧边栏可以识别：

- 像 `@citekey` 这样的 source nodes
- claim / evidence / question / source 等 discourse 节点
- citation text shapes

支持的能力包括：

- 根据 canvas 选择高亮侧边栏
- 从侧边栏引用数字按钮反向跳回 canvas对应位置
- 在侧边栏中按节点类型过滤 discourse nodes

这是目前插件里最强的一条图谱工作流，也是 Zotsidian 最突出的差异点之一。

![Discourse graph canvas support](./gifs/sidebar_discourse_graph_canvas.png)

## Lightweight Native Base and Canvas Support

Zotsidian 也为原生 Obsidian Base 和原生 Canvas 提供了轻量支持。

这意味着：

- 这些页面中的引用提取仍然可用
- 在轻量工作流里引用悬浮卡片仍然有帮助

不过，这部分支持是有意保持轻量的。完整的双向 graph 工作流是为 discourse-graphs canvas 设计的，不是为原生 Canvas 设计的。

## Related Papers and External Providers

对于带 DOI 或可用标题的 source page，Zotsidian 可以获取：

- references参考文献
- citations引用
- 已经存在于你的 Zotero 笔记库中的相关文献

Provider 模式：

- `Auto (Recommended)`
- `Semantic Scholar only`
- `OpenAlex only`

推荐模式会先尝试 Semantic Scholar，在其限流或结果不完整时回退到 OpenAlex。

## Do You Need Better BibTeX?

### Better BibTeX 插件

实际使用中，通常是需要的。

Zotsidian 依赖可用的 citation keys 来支持：

- `@` citation 插入
- 名为 `@citekey` 的 source pages
- citation hover cards
- reference 和 source 的解析

Zotero 8 虽然提供了原生 `Citation Key` 字段，但它本身并不能稳定地为你生成和维护 citation keys。对大多数用户来说，最实际的方案仍然是安装 **Better BibTeX**，由它来生成和维护 Zotero 中的 citation keys。

如果你已经通过其他方式维护了稳定可用的 citation keys，Zotsidian 同样可以工作。但对于大多数真实工作流来说，Better BibTeX 仍然应该被视为一个实际上的必要组件。

## Defaults on a Fresh Install

Zotsidian 的默认设置是偏保守的：

- Citation insert format: `[@citekey]`
- Create source page on citation select: off
- Load attachment links in source panel: on
- Source pages folder: `source`
- Source page template path: empty
- Related papers provider: `Auto (Recommended)`
- Search panel hotkey: `Cmd+Shift+U` / `Ctrl+Shift+U`

这些默认值更偏向直接写作，而不是强制用户一开始就使用 source-page 工作流。

## Requirements

### Required

- Obsidian `>= 1.10.6`
- macOS、Windows 或 Linux 上的 Obsidian desktop
- 安装在同一台电脑上的 Zotero Desktop 8
- 你打算引用的 Zotero items 需要有可用的 citation keys

### Required for the full local workflow

Zotsidian 的完整工作流建立在对本地 Zotero Desktop 的实时解析之上。要让 citation lookup、hover cards、打开 PDF、打开 Zotero item、source-page enrichment 和 annotation 工作流稳定工作，需要：

- 在使用 Obsidian 时保持 Zotero Desktop 运行
- 你引用的条目真实存在于本地 Zotero library 中
- 当前电脑上可以访问 Zotero local API
- 在 Zotero 中打开 `Settings / Preferences -> Advanced`，并启用 `Allow other applications on this computer to communicate with Zotero`

对大多数用户来说，这通常还意味着：

- 安装 Better BibTeX，让 citation keys 稳定生成并持续维护

如果 Zotero Desktop 关闭，以下本地功能会降级或停止工作，尤其包括：

- 实时 citation 解析
- 打开本地 PDF
- 打开 Zotero item
- source sidebar 中的 attachment 发现
- annotation refresh 和 insert 工作流

### Optional but recommended

- 如果你希望 `Open PDF` 可用，建议在 Zotero 中保存 PDF attachments
- 如果你希望 related references / citations 解析得更好，建议 source item 具有 DOI 或至少有可用标题
- 如果你希望使用这些外部服务，需要联网：
  - Semantic Scholar / OpenAlex related-paper lookup
  - Connected Papers
  - Google Scholar

### Optional integration

- 如果你想使用 discourse canvas 支持，则需要安装 `discourse-graphs` Obsidian 插件

### Optional advanced fallback

- Better BibTeX JSON export 文件，仅当你需要在 live Zotero lookup 不完整时使用 fallback index source 时才需要

总之，你通常确实需要 citation keys，而 Better BibTeX 仍然是最常见、最可靠的方案。

但你并不需要 Better BibTeX JSON export 才能使用 Zotero 8 的主工作流。

## Installation

### Install from GitHub Release

在 Zotsidian 尚未进入 Obsidian community plugin browser 之前，这是推荐的安装方式。

1. 打开 Zotsidian 最新的 GitHub Release
2. 下载以下 release assets：
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. 在你的 vault 中创建文件夹：
   - `.obsidian/plugins/zotsidian`
4. 将这三个文件复制进去
5. 在 Obsidian community plugins 中启用 **Zotsidian**

重要：

- 在 Zotero 中打开 `Settings / Preferences -> Advanced`，确保启用了 `Allow other applications on this computer to communicate with Zotero`
- 如果这个选项没有打开，Zotsidian 可能无法加载 citation indexes、attachments、hover data 和 annotation 内容

### Manual installation from source

如果你希望修改插件或直接测试源代码，可以使用这种方式。

1. Clone 仓库
2. 安装依赖：

```bash
npm install
```

3. 构建插件：

```bash
npm run build
```

4. 在 vault 中创建插件文件夹：
   - `.obsidian/plugins/zotsidian`
5. 将仓库根目录中的这些文件复制进去：
   - `main.js`
   - `manifest.json`
   - `styles.css`
6. 在 Obsidian community plugins 中启用 **Zotsidian**

## Development

如果你要在本地开发或调试插件：

```bash
npm install
npm run dev
```

这样会自动监听源代码变化并重建 `main.js`。

你仍然需要把构建产物复制到 vault plugin 文件夹中，或者把项目 symlink 到 `.obsidian/plugins/zotsidian` 来使用开发环境。

## Quick Start

1. 启动 Zotero Desktop
2. 在 Zotero 中打开 `Settings / Preferences -> Advanced`，启用 `Allow other applications on this computer to communicate with Zotero`
3. 在 Obsidian 中启用 Zotsidian
4. 确保你要引用的 Zotero 条目已经有可用的 citation keys
   - 对大多数用户来说，这意味着 Better BibTeX 正在运行并生成引用键
5. 检查这些设置：
   - `Default Zotero scope`
   - `Citation insert format`
   - `Create source page on citation select`
   - `Source pages folder`
6. 在 note 中输入 `@` 并插入引用
7. 悬浮引用以查看元数据，或打开 PDF / Zotero 条目
8. 使用 References 侧边栏查看当前 note 中引用的文献
9. 如果需要更深入整理，打开或创建一个 `@citekey` source page
10. 如果你使用 discourse-graphs，则打开一个 discourse canvas，让侧边栏跟踪 source 节点和 discourse 节点

## License

MIT. See [LICENSE](./LICENSE).
