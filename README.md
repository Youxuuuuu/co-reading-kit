# Co Reading Kit｜轻便的人机共读 MCP

Co Reading Kit 是一个低 token 的人机共读 MCP 工具包。它会把本地 EPUB/TXT/Markdown 导入成 chunks，让 AI 只读取需要讨论的片段，并把共读结果写入长期阅读笔记和进度文件。

## 功能特性

- 导入本地 EPUB/TXT/Markdown 书籍
- 构建轻量搜索索引
- 支持关键词搜索
- 支持原文/划线精确搜索
- 默认一次只读取一个 chunk
- 写入长期阅读笔记
- 保存阅读进度
- 根据进度恢复阅读
- 列出本地书库
- 查看本地 manifest / chunk 切片地图
- 不需要数据库
- 不需要向量数据库
- 本地优先，数据默认保存在用户自己的 `stateDir`

## 安装

```powershell
git clone https://github.com/Youxuuuuu/co-reading-kit.git
cd co-reading-kit
npm install
npm run check
```

## 本地验收

```powershell
npm run check
npm run test:smoke
```

说明：

- `npm run check` 只做语法检查。
- `npm run test:smoke` 会使用 `examples/sample-book.txt` 和 `.tmp/smoke-state` 跑通完整 MCP 工具链。
- `.tmp/` 不会被提交。

## 本地打包检查

```powershell
npm run test
npm run pack:dry
```

说明：

- `npm run test` 会执行语法检查和 smoke test。
- `npm run pack:dry` 会检查 npm 包里会包含哪些文件。
- 包里不应该包含 `.tmp/`、`node_modules/`、用户书库、`reading/` 或 `.cyberboss/`。

## stateDir 说明

`stateDir` 是 Co Reading Kit 保存书籍、笔记和进度的本地状态目录。

解析顺序如下：

```text
工具入参 stateDir
READING_STATE_DIR
CYBERBOSS_STATE_DIR
项目上级目录的 .cyberboss
```

默认目录结构：

```text
<stateDir>/
  reading/
    books/
    notes/
    progress.json
```

其中：

- `books/` 存放导入后的书、manifest、chunk 文件和搜索索引。
- `notes/` 存放长期阅读笔记。
- `progress.json` 存放阅读进度。

## MCP 客户端配置示例

发布到 npm 后可用：

```json
{
  "mcpServers": {
    "co-reading-kit": {
      "command": "co-reading-kit",
      "args": [],
      "env": {
        "READING_STATE_DIR": "D:/study/.cyberboss"
      }
    }
  }
}
```

本地开发路径配置示例：

```json
{
  "mcpServers": {
    "co-reading-kit": {
      "command": "node",
      "args": ["D:/study/co-reading-kit/src/mcp-server.js"],
      "env": {
        "READING_STATE_DIR": "D:/study/.cyberboss"
      }
    }
  }
}
```

不同 MCP 客户端的配置文件位置可能不同。  
在 Windows 上，路径建议统一使用正斜杠。

## 快速开始

```text
1. 导入一本书 reading_import_book
2. 自动或手动建索引 reading_build_index
3. 列出书库 reading_list_books
4. 查看切片结构 reading_get_manifest
5. 搜索关键词 reading_search
6. 精确查原文 reading_search_exact
7. 读取 chunk reading_get_chunk
8. 讨论后写笔记 reading_update_note
9. 更新进度 reading_update_progress
10. 下次继续 reading_resume_book
```

## 工具总览

当前提供 14 个 MCP 工具。

| 工具 | 用途 | 读取 original.md？ | 读取 chunk 正文？ | 写入文件？ |
| --- | --- | --- | --- | --- |
| `reading_import_book` | 导入本地书并切片 | 否 | 否 | 是 |
| `reading_list_books` | 列出本地书库 | 否 | 否 | 否 |
| `reading_get_manifest` | 查看书籍结构和 chunk 地图 | 否 | 否 | 否 |
| `reading_search` | 关键词搜索 | 否 | 仅在索引未命中时 fallback 扫描 | 否 |
| `reading_search_exact` | 精确原文搜索 | 否 | 是，用于精确扫描 chunks | 否 |
| `reading_get_chunk` | 读取一个 chunk 正文 | 否 | 是，只读取一个 chunk | 否 |
| `reading_get_progress` | 查看阅读进度 | 否 | 否 | 否 |
| `reading_build_index` | 为书建立搜索索引 | 否 | 是，会读取 chunk 文件生成索引 | 是 |
| `reading_update_progress` | 写入进度文件 | 否 | 否 | 是 |
| `reading_update_note` | 写入阅读笔记 | 否 | 否 | 是 |
| `reading_read_note` | 读取笔记固定区块 | 否 | 否 | 否 |
| `reading_resume_book` | 按进度恢复阅读 | 否 | 可选，只读取一个 chunk | 否 |
| `reading_link_weread_book` | 链接微信读书书籍和本地书 | 否 | 否 | 是 |
| `reading_find_weread_context` | 根据微信读书划线定位本地 chunk 上下文 | 否 | 可选，只读取一个 chunk | 否 |

## 工具示例

### `reading_import_book`

```json
{
  "input": "D:/study/books/薄雾.epub",
  "bookId": "薄雾",
  "title": "薄雾",
  "maxChars": 4000,
  "minChars": 1200,
  "buildIndex": true
}
```

说明：

- 导入结果保存到 `<stateDir>/reading/books/<bookId>/`。
- 默认不会把整本书读进上下文。
- 导入后可使用 `reading_build_index` 或 `buildIndex=true` 建索引。
- 后续可配合 `reading_search`、`reading_get_manifest`、`reading_get_chunk` 共读。

### `reading_list_books`

```json
{
  "includeProgress": true,
  "includeIndexStatus": true,
  "includeStats": true
}
```

说明：

- 用于查看当前本地书库有哪些书。
- 不读取原文。
- 不读取 chunks。
- 只读取 manifest、progress 和索引状态。

### `reading_get_manifest`

```json
{
  "bookId": "薄雾",
  "includeChunks": true,
  "includeChunkPreview": true,
  "maxChunks": 50
}
```

说明：

- 用于查看一本书的结构和 chunk 列表。
- 不读取 `original.md`。
- 不读取 chunk 正文。
- 只读取 manifest。
- 如果要读具体正文，使用 `reading_get_chunk`。

### `reading_search`

```json
{
  "bookId": "薄雾",
  "query": "孤独"
}
```

### `reading_search_exact`

```json
{
  "bookId": "薄雾",
  "query": "一种深刻的孤独"
}
```

省略 `bookId` 和 `all` 时，`reading_search` 与 `reading_search_exact` 默认搜索整个书库；指定 `bookId` 时只搜索该书。`bookId` 与 `all: true` 不能同时使用。

### `reading_get_chunk`

```json
{
  "bookId": "薄雾",
  "chunkId": "ch000"
}
```

### `reading_update_note`

```json
{
  "bookId": "薄雾",
  "title": "薄雾",
  "appendSection": "段落共读记录",
  "appendHeading": "2026-06-08 · ch022 · 第六章",
  "appendContent": "这段主要讨论了雾如何变成一种连接失效的象征。"
}
```

### `reading_update_progress`

```json
{
  "bookId": "薄雾",
  "title": "薄雾",
  "lastChunkId": "ch022",
  "nextChunkId": "ch023",
  "lastPath": "chunks/ch022.md",
  "nextPath": "chunks/ch023.md",
  "lastSectionTitle": "第六章",
  "currentThemes": ["孤独", "雾", "连接失效"],
  "status": "reading"
}
```

### `reading_resume_book`

```json
{
  "bookId": "薄雾",
  "readChunk": true
}
```

## 微信读书联动

如果你通过微信读书 Skill 拿到了书名、bookId 或划线 `markText`，可以先把微信读书里的书和本地书链接起来：

`reading_link_weread_book`

链接后，使用 `reading_find_weread_context` 可以根据划线原文定位本地 chunk，并返回上下文。

示例：

```json
{
  "wereadTitle": "薄雾[无限]",
  "localBookId": "薄雾",
  "confirm": true
}
```

再查划线上下文：

```json
{
  "wereadTitle": "薄雾[无限]",
  "markText": "一种深刻的孤独",
  "includeChunk": true
}
```

涉及微信读书划线、用户明确引用的原文，或 `reading_find_weread_context` 返回的定位结果时，讨论内容应写入 `摘录与想法`，不要写进 `交叉关联`。如果只是搜索还没有展开讨论，则不要写入 notes；同时不要把整段 chunk 原文完整抄进笔记。

## 隐私和版权说明

- 本工具是 local-first。
- 书籍文件、索引、笔记和进度默认都保存在用户自己的本地 `stateDir`。
- 本项目不提供任何书籍内容。
- 用户应只导入自己有权使用的电子书。
- 不建议把 `books/original.md` 或任何受版权保护的书籍内容提交到公开仓库。

## 目录结构

```text
co-reading-kit/
  docs/
  examples/
  scripts/
  skill/
  src/
  templates/
  README.md
  LICENSE
  package.json
```

更多说明可以看：

- [工具参考](docs/TOOL_REFERENCE.md)
- [共读流程](docs/WORKFLOW.md)
- [MCP 配置示例](examples/mcp-config.example.json)
