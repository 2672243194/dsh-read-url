# Third-Party Notices

dsh-read-url 核心**零运行时依赖**（仅使用 Node.js 20+ 内置能力）。

以下库为**可选增强依赖**：仅在 DSH profile 目录手动执行 `npm i @mozilla/readability happy-dom` 后自动启用；未安装时插件回退到内置启发式提取器，功能不受影响。

| 库 | 许可 | 用途 | 获取 |
|---|---|---|---|
| @mozilla/readability | MPL-2.0 | 可选正文提取增强（Firefox Reader Mode 同款算法），引用不改写 | https://github.com/mozilla/readability |
| happy-dom | MIT | 可选：为 readability 提供 Node 环境 DOM 实现 | https://github.com/capricorn86/happy-dom |

MPL-2.0 许可证全文：https://www.mozilla.org/en-US/MPL/2.0/
MIT 许可证全文见各库仓库 LICENSE 文件。
