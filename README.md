# WorkLens

WorkLens 是一个本地优先的每日工作整理器。你可以随手记录当天进展，也可以一次上传多份会议纪要、文档和截图；WorkLens 会按工作日自动合并、去重，生成第二个工作日早会上可以直接照着念的汇报逐字稿。

## 当前能力

- 粘贴文本，或导入 TXT、Markdown、PDF、DOCX、PNG、JPEG、WebP、TIFF。
- 本地 SQLite、内容寻址附件目录、FTS5 全文搜索与离线 OCR。
- 默认调用用户自行安装并登录的官方 Cursor Agent CLI，无需 API Key。
- 桌面端实时读取当前 Cursor 账号可用模型，也可切换到 Cursor SDK 或 OpenAI-compatible API。
- “每日记录”用于为选定工作日快速写入内容，同一天的新记录会自动重新合并为一份日报。
- “批量上传”使用一个统一入口：可拖入或点击选择最多 200 份不同工作日、不同格式的资料，也可直接按 ⌘V 粘贴复制的工作文字；系统识别正文日期后分别归入时间线，并按日期触发日报整理。
- 批量导入会显示逐文件进度，支持中途取消；单份失败不会拖累整批，失败原件保留在本机并可重新解析。
- 内容相同的文件会安全跳过，不会重复入库；自动日期不准确时可直接改归档日期，并重整新旧工作日的日报。
- 自动提取已完成、进行中、风险与协助、下一步，并生成自然口语化的早会逐字稿。
- 周五工作会自动生成下周一使用的早会稿，跳过周末。
- 工作看板、按日时间线和合并后的工作事项视图。
- “问工作资料”会先在 SQLite 中按日期和关键词检索，再由本机 Cursor 回答过往工作问题，并提供可回看的原始记录、日报或事项引用。
- 导出包含早会稿的 Markdown、PDF、日报 CSV，以及带 JSON、数据库和附件的 ZIP 备份。

## 环境

- macOS 作为首发平台。
- Node.js 22.13 或更高；推荐使用 `.nvmrc` 中的当前 LTS。
- 默认模式需要官方 Cursor Agent CLI：

```bash
curl https://cursor.com/install -fsS | bash
~/.local/bin/agent login
```

WorkLens 只启动官方 CLI，不读取、复制或打包其登录凭据。API Key 仅用于可选的 SDK/API Provider。

## 开发

```bash
npm install
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

`npm run package` 生成未签名的 macOS 目录包；`npm run dist:mac` 生成 DMG/ZIP。正式分发前仍需配置 Apple Developer 签名和公证凭据。

## 数据与隐私

- 工作区默认位于 Electron `userData/workspace`，原始附件按 SHA-256 保存。
- 单份文件上限为 25 MB；批次取消时已成功完成的资料会保留，未开始的资料不会生成失败记录。
- 可选 API Provider 的 Key 通过 Electron `safeStorage` 加密；macOS 上使用 Keychain。密钥不进入业务数据库、日志和导出文件。
- Cursor CLI 登录令牌由官方 CLI 自行保存在系统安全存储中，WorkLens 只读取“已登录/未登录”状态。
- AI 在独立 Electron Utility Process 中运行。CLI 使用 `ask` 只读模式、显式 sandbox，并只信任 WorkLens 自己创建的隔离临时目录。
- AI 生成的日报不会覆盖原始记录；同一天重新生成时，只替换该日的合并日报和自动生成工作事项。
- 历史工作问答不会把整个数据库发送给模型，只发送本机检索命中的有限片段；Cursor 返回的逐字引用会在主进程中再次校验。
- “本机 Cursor”不等于本地推理：分析内容仍会发送给 Cursor 及所选模型提供商。
- Renderer 关闭 Node integration、启用 context isolation 和 Chromium sandbox；所有 IPC 输入均经过 Zod 校验。

## MVP 限制

- 扫描 PDF 会逐页本地 OCR；为控制内存和耗时，单份扫描 PDF 最多处理 30 页，文本型 PDF 最多 100 页。
- 图片 OCR 使用简体中文模型，可同时识别常见英文，但复杂版面需要人工校对。
- 视觉模型发送开关暂为能力预留，当前只发送本地提取出的文字。
- 无账号、云同步、协作、移动端、音视频转写、知识图谱和自动任务执行。
- WorkLens 不再分发 Cursor CLI 二进制；用户需通过 Cursor 官方安装器独立安装，以遵守官方分发与账号边界。
- Cursor SDK 仍处于 public beta，项目锁定在 `package-lock.json` 的已验证版本，升级后应重新运行契约与打包测试。

## 已知上游依赖风险

当前最新版 `@cursor/sdk@1.0.23` 通过 `@connectrpc/connect-node` 间接依赖存在公开公告的旧版 `undici`，`npm audit` 报告 2 个 moderate 和 1 个 high，且上游暂未提供兼容修复。WorkLens 将全部模型网络调用放在可终止的独立 AI Utility Process 中以缩小影响面，但这不是漏洞修复；Cursor SDK 发布修复版本后应优先升级并重新执行打包测试。
