#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "src", "mcp-server.js");
const SAMPLE_BOOK_PATH = path.join(PROJECT_ROOT, "examples", "sample-book.txt");
const STATE_DIR = path.join(PROJECT_ROOT, ".tmp", "smoke-state");
const STATE_DIR_ARG = ".tmp/smoke-state";
const EXPECTED_TOOL_NAMES = [
  "reading_find_weread_context",
  "reading_import_book",
  "reading_list_books",
  "reading_get_manifest",
  "reading_search",
  "reading_search_exact",
  "reading_get_chunk",
  "reading_get_progress",
  "reading_build_index",
  "reading_update_progress",
  "reading_update_note",
  "reading_read_note",
  "reading_resume_book",
  "reading_link_weread_book",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function resetStateDir() {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(STATE_DIR), { recursive: true });
}

function extractToolPayload(result) {
  if (result && result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }

  const textItem = Array.isArray(result?.content)
    ? result.content.find((item) => item?.type === "text" && typeof item.text === "string")
    : null;

  if (!textItem) {
    return null;
  }

  try {
    return JSON.parse(textItem.text);
  } catch {
    return textItem.text;
  }
}

function formatErrorDetails(details) {
  if (!details) {
    return "";
  }

  if (typeof details === "string") {
    return details;
  }

  return JSON.stringify(details, null, 2);
}

async function verifyToolInventory(client) {
  const result = await client.listTools();
  const toolNames = Array.isArray(result?.tools)
    ? result.tools.map((tool) => tool.name).sort()
    : [];
  const expected = [...EXPECTED_TOOL_NAMES].sort();

  assert(
    toolNames.length === expected.length,
    `Expected ${expected.length} tools, received ${toolNames.length}`
  );

  for (let index = 0; index < expected.length; index += 1) {
    assert(
      toolNames[index] === expected[index],
      `Tool inventory mismatch: expected ${expected[index]}, received ${toolNames[index]}`
    );
  }

  const exactSearch = result.tools.find((tool) => tool.name === "reading_search_exact");
  const required = exactSearch?.inputSchema?.required || [];
  assert(required.includes("query"), "reading_search_exact schema must require query");
  assert(!required.includes("bookId"), "reading_search_exact schema must not require bookId");
  assert(!required.includes("all"), "reading_search_exact schema must not require all");
  assert(
    exactSearch?.description?.includes("Omit bookId and all to search all books"),
    "reading_search_exact help must describe the default all-books scope"
  );
  assert(
    exactSearch?.inputSchema?.properties?.query?.minLength === 1,
    "reading_search_exact schema must reject an empty query"
  );
}

async function callTool(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args,
  });

  const payload = extractToolPayload(result);
  if (result?.isError) {
    const error = new Error(`Tool returned error: ${name}`);
    error.toolPayload = payload;
    throw error;
  }

  return payload;
}

async function runStep(name, action) {
  try {
    const value = await action();
    console.log(`✓ ${name}`);
    return value;
  } catch (error) {
    const details = error?.toolPayload || error?.message || error;
    console.error(`Smoke test failed at: ${name}`);
    console.error(formatErrorDetails(details));
    process.exit(1);
  }
}

async function main() {
  assert(fs.existsSync(SERVER_PATH), `Server file does not exist: ${SERVER_PATH}`);
  assert(fs.existsSync(SAMPLE_BOOK_PATH), `Sample book does not exist: ${SAMPLE_BOOK_PATH}`);

  resetStateDir();

  const client = new Client({
    name: "co-reading-kit-smoke-test",
    version: "0.1.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      READING_STATE_DIR: STATE_DIR,
    },
    stderr: "pipe",
  });

  const serverStderr = [];
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      serverStderr.push(String(chunk));
    });
  }

  try {
    await client.connect(transport);
    await verifyToolInventory(client);

    const importResult = await runStep("import book", async () => {
      const payload = await callTool(client, "reading_import_book", {
        input: "examples/sample-book.txt",
        bookId: "sample-book",
        title: "Sample Book",
        stateDir: STATE_DIR_ARG,
        maxChars: 1000,
        minChars: 200,
        buildIndex: true,
      });

      assert(payload?.ok === true, "reading_import_book did not return ok=true");
      assert(payload.bookId === "sample-book", `Unexpected bookId: ${payload.bookId}`);
      assert(Number(payload.chunkCount) > 0, "Import chunkCount must be greater than 0");
      return payload;
    });

    await runStep("link weread book", async () => {
      const payload = await callTool(client, "reading_link_weread_book", {
        wereadTitle: "示例书",
        localBookId: "sample-book",
        confirm: true,
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_link_weread_book did not return ok=true");
      assert(payload.result?.action === "linked", "reading_link_weread_book should link sample-book");
      return payload;
    });

    await runStep("build index", async () => {
      const payload = await callTool(client, "reading_build_index", {
        bookId: "sample-book",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_build_index did not return ok=true");
      const stdout = String(payload.stdout || "");
      assert(!/error:/iu.test(stdout), "reading_build_index stdout contains a fatal error");
      return payload;
    });

    await runStep("list books", async () => {
      const payload = await callTool(client, "reading_list_books", {
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_list_books did not return ok=true");
      assert(Array.isArray(payload.books), "reading_list_books.books must be an array");
      const sampleBook = payload.books.find((book) => book.bookId === "sample-book");
      assert(sampleBook, "sample-book was not found in reading_list_books");
      return payload;
    });

    const manifestResult = await runStep("get manifest", async () => {
      const payload = await callTool(client, "reading_get_manifest", {
        bookId: "sample-book",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_get_manifest did not return ok=true");
      assert(Number(payload.chunkCount) > 0, "Manifest chunkCount must be greater than 0");
      return payload;
    });

    await runStep("search", async () => {
      const payload = await callTool(client, "reading_search", {
        bookId: "sample-book",
        query: "雾",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_search did not return ok=true");
      assert(Array.isArray(payload.results), "reading_search.results must be an array");
      assert(payload.results.length > 0, "reading_search must return at least one result");
      return payload;
    });

    await runStep("search exact", async () => {
      const payload = await callTool(client, "reading_search_exact", {
        bookId: "sample-book",
        query: "清晨的城里有一层很薄的雾",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_search_exact did not return ok=true");
      assert(Array.isArray(payload.results), "reading_search_exact.results must be an array");
      assert(payload.results.length > 0, "reading_search_exact must return at least one result");
      return payload;
    });

    await runStep("search exact defaults to all books", async () => {
      const payload = await callTool(client, "reading_search_exact", {
        query: "清晨的城里有一层很薄的雾",
        limit: 10,
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_search_exact without scope did not return ok=true");
      assert(Array.isArray(payload.results), "reading_search_exact without scope must return results");
      assert(payload.results.length > 0, "reading_search_exact without scope must search all books");
      return payload;
    });

    await runStep("search exact accepts the reported query-limit shape", async () => {
      const payload = await callTool(client, "reading_search_exact", {
        query: "耳洞早晨 第四章",
        limit: 10,
      });

      assert(payload?.ok === true, "reported reading_search_exact shape did not return ok=true");
      assert(Array.isArray(payload.results), "reported reading_search_exact shape must return results");
      assert(payload.results.length === 0, "reported query should produce a valid empty result in smoke state");
      return payload;
    });

    await runStep("search exact rejects conflicting scope as invalid params", async () => {
      const result = await client.callTool({
        name: "reading_search_exact",
        arguments: {
          bookId: "sample-book",
          all: true,
          query: "雾",
          stateDir: STATE_DIR_ARG,
        },
      });
      const payload = extractToolPayload(result);
      assert(result?.isError === true, "reading_search_exact accepted conflicting bookId/all scope");
      assert(payload?.code === "invalid_args", `Expected invalid_args, received ${payload?.code}`);
      return payload;
    });

    await runStep("search exact rejects all false without a book", async () => {
      const result = await client.callTool({
        name: "reading_search_exact",
        arguments: {
          all: false,
          query: "雾",
          stateDir: STATE_DIR_ARG,
        },
      });
      const payload = extractToolPayload(result);
      assert(result?.isError === true, "reading_search_exact accepted all=false without bookId");
      assert(payload?.code === "invalid_args", `Expected invalid_args, received ${payload?.code}`);
      return payload;
    });

    await runStep("find weread context", async () => {
      const payload = await callTool(client, "reading_find_weread_context", {
        wereadTitle: "示例书",
        markText: "清晨的城里有一层很薄的雾",
        includeChunk: true,
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_find_weread_context did not return ok=true");
      assert(payload.localBookId === "sample-book", "reading_find_weread_context should resolve sample-book");
      assert(Number(payload.search?.resultCount) > 0, "reading_find_weread_context must return at least one result");
      assert(payload.chunk?.chunkId === "ch000", "reading_find_weread_context should return ch000");
      return payload;
    });

    await runStep("get chunk", async () => {
      const payload = await callTool(client, "reading_get_chunk", {
        bookId: "sample-book",
        chunkId: "ch000",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_get_chunk did not return ok=true");
      assert(typeof payload.text === "string" && payload.text.length > 0, "reading_get_chunk must return text");
      return payload;
    });

    await runStep("update note", async () => {
      const payload = await callTool(client, "reading_update_note", {
        bookId: "sample-book",
        title: "Sample Book",
        appendSection: "段落共读记录",
        appendHeading: "smoke test",
        appendContent: "这是一条用于本地验收的测试记录。",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_update_note did not return ok=true");
      return payload;
    });

    await runStep("update progress", async () => {
      const payload = await callTool(client, "reading_update_progress", {
        bookId: "sample-book",
        title: "Sample Book",
        lastChunkId: "ch000",
        nextChunkId: "ch000",
        lastPath: "chunks/ch000.md",
        nextPath: "chunks/ch000.md",
        status: "reading",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_update_progress did not return ok=true");
      assert(payload.progress?.lastChunkId === "ch000", "Progress lastChunkId must be ch000");
      return payload;
    });

    await runStep("get progress", async () => {
      const payload = await callTool(client, "reading_get_progress", {
        bookId: "sample-book",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_get_progress did not return ok=true");
      assert(payload.progress?.lastChunkId === "ch000", "reading_get_progress must return sample-book progress");
      return payload;
    });

    await runStep("read note", async () => {
      const payload = await callTool(client, "reading_read_note", {
        bookId: "sample-book",
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_read_note did not return ok=true");
      assert(payload.exists === true, "reading_read_note must report exists=true");
      assert(typeof payload.sections?.["阅读恢复区"] === "string", "Missing 阅读恢复区 section");
      assert(typeof payload.sections?.["当前理解"] === "string", "Missing 当前理解 section");
      assert(typeof payload.sections?.["下次入口"] === "string", "Missing 下次入口 section");
      return payload;
    });

    await runStep("resume book", async () => {
      const payload = await callTool(client, "reading_resume_book", {
        bookId: "sample-book",
        readChunk: true,
        stateDir: STATE_DIR_ARG,
      });

      assert(payload?.ok === true, "reading_resume_book did not return ok=true");
      assert(payload.progress?.lastChunkId === "ch000", "Resume progress lastChunkId must be ch000");
      assert(payload.note?.sections?.["阅读恢复区"] !== undefined, "Resume note must include 阅读恢复区");
      assert(payload.chunk?.chunkId === "ch000", "Resume chunkId must be ch000");
      assert(typeof payload.chunk?.text === "string" && payload.chunk.text.length > 0, "Resume chunk must include text");
      return payload;
    });

    assert(importResult.bookId === manifestResult.bookId, "Import result and manifest bookId should match");
    console.log("");
    console.log("Smoke test passed.");
  } catch (error) {
    console.error("Smoke test failed before completing the workflow.");
    console.error(formatErrorDetails(error?.toolPayload || error?.message || error));
    const stderrText = serverStderr.join("").trim();
    if (stderrText) {
      console.error(stderrText);
    }
    process.exit(1);
  } finally {
    await transport.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Smoke test failed before startup.");
  console.error(formatErrorDetails(error?.message || error));
  process.exit(1);
});
