# Zotsidian 0.2.1

Fixes Discourse Canvas discovery in custom folders. Explorer and Canvas
pickers now recognize the persisted `tldr-dg` / `tldraw-dg` frontmatter marker,
so a Canvas remains listed after its tab is closed.

修复自定义目录中的 Discourse Canvas 识别：关闭标签页后，Canvas 仍会显示在
Explorer 和 Canvas 选择列表中，无需改名或移动文件。

Validation: production build, lint, stylesheet checks, JavaScript syntax,
Canvas catalog regressions, and live Obsidian verification with a closed
Canvas. No Canvas content migration is required.

Install the three runtime files (`main.js`, `manifest.json`, `styles.css`)
from the ZIP into your Vault's `.obsidian/plugins/zotsidian` folder, then
reload Zotsidian.
