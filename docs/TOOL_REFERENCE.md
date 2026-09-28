# Tool Reference

本文档概览 Co Reading Kit 当前提供的 14 个 MCP 工具。

`npm run test:smoke` 会直接调用全部 14 个 MCP 工具，验证基础链路。

## `reading_import_book`

- 用途：导入本地 EPUB/TXT/Markdown 到阅读书库
- 输入参数：`input`、`title`、`author`、`bookId`、`maxChars`、`minChars`、`stateDir`、`buildIndex`
- 返回结果概要：导入后的 `bookId`、`manifestPath`、`chunkCount`、索引结果
- 是否读取正文：不直接读原文进上下文
- 是否写文件：是
- 典型使用场景：第一次把一本本地书接入共读流程

## `reading_list_books`

- 用途：列出本地书库中的已导入书籍
- 输入参数：`stateDir`、`includeProgress`、`includeIndexStatus`、`includeStats`
- 返回结果概要：书籍列表、manifest 摘要、可选 progress 和 index 状态
- 是否读取正文：否
- 是否写文件：否
- 典型使用场景：查看“我有哪些书”、确认 `bookId`

## `reading_get_manifest`

- 用途：读取某本书的 `manifest.json` 和轻量 chunk 地图
- 输入参数：`bookId`、`stateDir`、`includeChunks`、`includeChunkPreview`、`maxChunks`、`includeRaw`
- 返回结果概要：导入信息、chunk 统计、索引状态、可选 chunk 列表
- 是否读取正文：否
- 是否写文件：否
- 典型使用场景：查看这本书有多少段、从哪里开始读

## `reading_search`

- 用途：按主题词或关键词搜索
- 输入参数：`bookId` / `all`、`query`、`limit`、`maxPreview`、`includeText`、`stateDir`；省略 `bookId` 和 `all` 时默认全书库搜索
- 返回结果概要：命中 chunk、分数、预览、warnings
- 是否读取正文：通常不读；必要时会做 chunk fallback 扫描
- 是否写文件：否
- 典型使用场景：找“孤独”“雾”“连接失效”等主题段落

## `reading_search_exact`

- 用途：按完整原文或划线原文精确搜索
- 输入参数：`bookId` / `all`、`query`、`limit`、`maxPreview`、`includeText`、`stateDir`；省略 `bookId` 和 `all` 时默认全书库搜索
- 返回结果概要：命中 chunk、exact 标记、预览、warnings
- 是否读取正文：是，按需扫描 chunk 文件
- 是否写文件：否
- 典型使用场景：根据一句原文快速定位上下文

## `reading_get_chunk`

- 用途：读取一个 chunk 的正文
- 输入参数：`bookId`、`chunkId` / `path`、`stateDir`
- 返回结果概要：chunk 标题、前后关系、正文内容
- 是否读取正文：是，只读取一个 chunk
- 是否写文件：否
- 典型使用场景：开始共读某一段

## `reading_get_progress`

- 用途：读取当前阅读进度
- 输入参数：`bookId`、`stateDir`
- 返回结果概要：整份 progress 或某本书的 progress
- 是否读取正文：否
- 是否写文件：否
- 典型使用场景：查看上次读到哪里了

## `reading_build_index`

- 用途：为一本书或全部书建立轻量搜索索引
- 输入参数：`bookId` / `all`、`stateDir`
- 返回结果概要：建索引 stdout/stderr
- 是否读取正文：读取 chunk 文件，不读取 `original.md`
- 是否写文件：是
- 典型使用场景：导入后让关键词搜索更快

## `reading_update_progress`

- 用途：更新 `progress.json`
- 输入参数：`bookId`、`title`、`lastChunkId`、`nextChunkId`、`lastPath`、`nextPath`、`lastSectionTitle`、`lastReadAt`、`notePath`、`currentThemes`、`status`、`stateDir`
- 返回结果概要：写入后的当前书进度
- 是否读取正文：否
- 是否写文件：是
- 典型使用场景：讨论完后记录读到哪里

## `reading_update_note`

- 用途：更新长期阅读笔记
- 输入参数：`bookId`、`title`、`author`、`quickRecovery`、`currentUnderstanding`、`nextEntry`、`appendSection`、`appendHeading`、`appendContent`、`timestamp`、`stateDir`
- 返回结果概要：note 路径、更新区块、追加信息
- 是否读取正文：否
- 是否写文件：是
- 典型使用场景：保存理解、想法、关联和下次入口

## `reading_read_note`

- 用途：安全读取笔记固定区块
- 输入参数：`bookId`、`sections`、`includeFull`、`maxChars`、`stateDir`
- 返回结果概要：`阅读恢复区`、`当前理解`、`下次入口` 等区块
- 是否读取正文：否
- 是否写文件：否
- 典型使用场景：恢复上下文但不把整份笔记都读进来

## `reading_resume_book`

- 用途：按进度恢复一本书的共读上下文
- 输入参数：`bookId`、`readChunk`、`chunkId`、`stateDir`
- 返回结果概要：progress、note 顶部区块、可选一个 chunk
- 是否读取正文：可选读取一个 chunk
- 是否写文件：否
- 典型使用场景：继续上次阅读

## `reading_link_weread_book`

- 用途：把微信读书里的书映射到本地导入书 `localBookId`
- 输入参数：`wereadTitle`、`wereadBookId`、`wereadAuthor`、`localBookId`、`confirm`、`listPending`、`stateDir`
- 返回结果概要：`book-map.json` 路径、脚本 stdout/stderr、映射结果或待确认结果
- 是否读取正文：否，不读取 `original.md`
- 是否写文件：是，会写入 `reading/book-map.json`
- 典型使用场景：先把微信读书的书与本地书建立稳定映射

## `reading_find_weread_context`

- 用途：根据微信读书划线原文 `markText` 精确定位本地 chunk，并可选返回一个 chunk 上下文
- 输入参数：`markText`、`wereadTitle`、`wereadBookId`、`localBookId`、`includeChunk`、`limit`、`maxPreview`、`stateDir`
- 返回结果概要：WeRead 信息、解析出的 `localBookId`、映射状态、exact 搜索结果、可选一个 chunk
- 是否读取正文：最多读取一个 chunk；不读取 `original.md`
- 是否写文件：否
- 典型使用场景：从微信读书划线直接回到本地共读上下文
