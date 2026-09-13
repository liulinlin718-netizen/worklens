# WorkLens

WorkLens 是一个本地优先的每日工作整理器。你可以随手记录当天进展，也可以一次上传多份会议纪要、文档和截图；WorkLens 会按工作日自动合并、去重，生成第二个工作日早会上可以直接照着念的汇报逐字稿。

## 当前能力

- 粘贴文本，或导入 TXT、Markdown、PDF、DOCX、PNG、JPEG、WebP、TIFF。
- 本地 SQLite、内容寻址附件目录、FTS5 全文搜索与离线 OCR。
- 默认调用用户自行安装并登录的官方 Cursor Agent CLI，也可连接 OpenAI Codex CLI；两种本机 CLI 模式均无需在 WorkLens 中保存 API Key。
- 桌面端实时读取当前 Cursor 或 Codex 账号状态与可用模型，也可切换到 OpenAI-compatible API。
- “每日记录”用于为选定工作日快速写入内容，同一天的新记录会自动重新合并为一份日报。
- 每日记录会自动暂存草稿，先确认原文保存，再在后台整理；批量队列、进度和结果在切换页面后保留。未连接 AI 时可以先保存，连接后继续处理已有资料。
- “批量上传”使用一个统一入口：可拖入或点击选择最多 200 份不同工作日、不同格式的资料，也可直接使用粘贴快捷键（macOS ⌘V / Windows Ctrl+V）加入复制的工作文字；系统识别正文日期后分别归入时间线，并按日期触发日报整理。
- 批量导入会显示逐文件进度，支持中途取消；单份失败不会拖累整批，失败原件保留在本机并可重新解析。
- 内容相同的文件会安全跳过，不会重复入库；自动日期不准确时可直接改归档日期，并重整新旧工作日的日报。
- 自动提取已完成、进行中、风险与协助、下一步，并生成自然口语化的早会逐字稿。
- 周五工作会自动生成下周一使用的早会稿，跳过周末。
- 工作看板、按日时间线和合并后的工作事项视图。
- 早会稿提供阅读和编辑模式，文字与粘贴图片按日期暂存。人工保存的稿件不会被自动整理直接覆盖，新的 AI 稿可以比较、采用；版本记录支持恢复正文和图片。
- 工作资料库有独立入口，搜索和问答中的事项引用会定位并展开对应事项。工作事项支持人工修改标题、分类和合并；疑似碎片可在“待核对”中查看，原始资料和证据仍保留。
- “问工作资料”会先在 SQLite 中按日期和关键词检索，再由当前选择的本机 AI 回答过往工作问题，并提供可回看的原始记录、日报或事项引用。
- 导出包含早会稿的 Markdown、PDF、日报 CSV，以及带 JSON、数据库和附件的 ZIP 备份。

## 环境

- macOS 13+（Apple Silicon）或 Windows 10/11 x64。
- Node.js 22.13 或更高；推荐使用 `.nvmrc` 中的当前 LTS。
- 本机 CLI 模式至少需要安装并登录一个受支持的官方 CLI。Cursor Agent CLI：

```bash
curl https://cursor.com/install -fsS | bash
~/.local/bin/agent login
```

OpenAI Codex CLI（macOS/Linux；Windows 安装方式请参考[官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli)）：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

首次运行 `codex` 时按提示使用 ChatGPT 登录。WorkLens 只启动用户已安装的官方 CLI，不读取、复制或打包其登录凭据。API Key 仅用于可选的外部 API Provider。

## 开发

```bash
npm ci
npm run dev
```

常用检查：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run package
```

`npm run package` 生成当前系统的未签名目录包；`npm run dist:mac` 生成 DMG/ZIP，`npm run dist:win` 生成 Windows x64 NSIS 安装程序。版本标签推送到 GitHub 后，Windows 工作流会在原生 Windows 环境运行类型检查、单元测试、打包后启动测试和静默安装测试，再把安装包与 SHA-256 校验文件发布到对应 Release。

Windows 版会使用系统原生标题栏、Segoe UI 字体和 Ctrl 快捷键。Cursor/Codex CLI 连接只解析原生 `.exe`，不会通过 `.cmd`/`.bat` 命令壳传递工作资料；可把官方 CLI 加入 `PATH`，或分别通过 `WORKLENS_CURSOR_AGENT_PATH`、`WORKLENS_CODEX_PATH` 指向原生可执行文件。

## 数据与隐私

- 工作区默认位于 Electron `userData/workspace`，原始附件按 SHA-256 保存。
- 单份文件上限为 25 MB；批次取消时已成功完成的资料会保留，未开始的资料不会生成失败记录。
- 可选 API Provider 的 Key 通过 Electron `safeStorage` 加密；macOS 上使用 Keychain，Windows 上使用系统 DPAPI。密钥不进入业务数据库、日志和导出文件。
- Cursor/Codex CLI 登录令牌由各自的官方 CLI 保存，WorkLens 只读取连接状态，不复制或导出令牌。
- AI 在独立 Electron Utility Process 中运行。CLI 使用 `ask` 只读模式、显式 sandbox，并只信任 WorkLens 自己创建的隔离临时目录。
- AI 生成的日报不会覆盖原始记录；同一天重新生成时会更新自动生成内容。人工保存的早会稿保持不变，AI 新稿作为待采用版本保存；人工校正的事项标题、分类和合并关系会在可匹配的原文证据下保留。
- 历史工作问答不会把整个数据库发送给模型，只发送本机检索命中的有限片段；本机 AI 返回的逐字引用会在主进程中再次校验。
- “本机 CLI”不等于本地推理：分析内容仍会发送给 Cursor、OpenAI 或用户所选的模型提供商。
- Renderer 关闭 Node integration、启用 context isolation 和 Chromium sandbox；所有 IPC 输入均经过 Zod 校验。

## MVP 限制

- 扫描 PDF 会逐页本地 OCR；为控制内存和耗时，单份扫描 PDF 最多处理 30 页，文本型 PDF 最多 100 页。
- 图片 OCR 使用简体中文模型，可同时识别常见英文，但复杂版面需要人工校对。
- 视觉模型发送开关暂为能力预留，当前只发送本地提取出的文字。
- 无账号、云同步、协作、移动端、音视频转写、知识图谱和自动任务执行。
- WorkLens 不再分发 Cursor CLI 二进制；用户需通过 Cursor 官方安装器独立安装，以遵守官方分发与账号边界。
- 为避免把代理凭据泄露给子进程，WorkLens 当前不会向 Cursor/Codex CLI 转发 `HTTP_PROXY`、`HTTPS_PROXY` 等环境变量；必须依赖此类变量联网的企业代理环境暂不支持。

## 安全与许可

- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露漏洞细节或真实工作资料。
- 本项目以 [MIT License](LICENSE) 开源。
