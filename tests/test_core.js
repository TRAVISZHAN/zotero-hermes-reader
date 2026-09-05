const assert = require("node:assert/strict");
const core = require("../content/scripts/core.js");

assert.equal(
  core.parseInjectedToken('<script>window.__HERMES_SESSION_TOKEN__="abc-123";</script>'),
  "abc-123",
);
assert.equal(core.parseInjectedToken("no token"), "");
assert.equal(core.normalizeGatewayURL("100.100.100.100:8644/"), "http://100.100.100.100:8644");
assert.equal(core.normalizeGatewayURL("wss://reader.example.test/hermes/"), "https://reader.example.test/hermes");
assert.throws(() => core.normalizeGatewayURL("file:///tmp/hermes"), /只支持/);
assert.throws(() => core.normalizeGatewayURL("https://user:pass@example.test"), /用户名或密码/);

assert.deepEqual(
  core.servePortsFromLedger([
    { purpose: "serve", port: 41000 },
    { purpose: "dashboard", port: 9119 },
    { purpose: "serve", port: 52836 },
    { purpose: "serve", port: 41000 },
  ]),
  [52836, 41000],
);

assert.deepEqual(
  core.selectionFromParams({
    annotation: { text: "  selected text  ", position: '{"pageIndex":4}' },
  }),
  { text: "selected text", pageIndex: 4, pageLabel: "", page: "5" },
);
assert.equal(
  core.selectionFromParams({ text: "quote", pageLabel: "S3" }).page,
  "S3",
);

// A bare host:port URL parses back with pathname "/", so a naive rebuild
// produces "//api/ws" — the relay 404s that path instead of upgrading.
assert.equal(
  core.gatewayWebSocketURL("http://100.100.100.100:8644") + "/api/ws",
  "ws://100.100.100.100:8644/api/ws",
);
assert.equal(
  core.gatewayWebSocketURL("http://100.100.100.100:8644/") + "/api/ws",
  "ws://100.100.100.100:8644/api/ws",
);
assert.equal(core.gatewayWebSocketURL("https://relay.example.com"), "wss://relay.example.com");
assert.equal(core.gatewayWebSocketURL("http://h:8644/prefix/"), "ws://h:8644/prefix");
assert.equal(core.gatewayWebSocketURL("100.100.100.100:8644"), "ws://100.100.100.100:8644");

// 30-author physics papers made the panel header taller than the chat.
assert.equal(
  core.shortAuthors("M. Anders, D. Trezzi, R. Menegazzo, M. Aliotta, A. Bellini"),
  "M. Anders, D. Trezzi 等 5 人",
);
assert.equal(core.shortAuthors("A. Author, B. Author"), "A. Author, B. Author");
assert.equal(core.shortAuthors("A. Author"), "A. Author");
assert.equal(core.shortAuthors(""), "");
assert.equal(core.shortAuthors(null), "");

// Conversations are matched server-side so both machines see the same list.
// Hermes rewrites titles, so `source` + the itemKey in `preview` is the index.
const listPaper = { key: "DQAAC6MS", libraryID: 1 };
assert.ok(core.sessionBelongsToPaper(
  { source: "zotero", title: "基于Zotero论文核对实验数据",
    preview: "[ZOTERO_READER_CONTEXT] libraryID: 1 itemKey: DQAAC6MS title..." },
  listPaper,
));
assert.ok(!core.sessionBelongsToPaper(
  { source: "zotero", preview: "itemKey: A38N8G9J" }, listPaper), "another paper must not match");
assert.ok(!core.sessionBelongsToPaper(
  { source: "cli", preview: "itemKey: DQAAC6MS" }, listPaper), "non-plugin sessions must not match");
assert.ok(!core.sessionBelongsToPaper(
  { source: "zotero", preview: "itemKey: DQAAC6MSX" }, listPaper), "key prefix must not match");
assert.match(core.sessionLabel({ title: "T", message_count: 63, started_at: Date.now() / 1000 }), /T · 今天 · 63 条/);

const paper = {
  libraryID: 1,
  key: "ABCD1234",
  title: "A paper",
  authors: "A. Author",
  year: "2026",
  doi: "10.1000/test",
  pdfKeys: ["PDF12345"],
};
const prompt = core.buildPrompt({
  paper,
  question: "解释这一段",
  selection: { text: "verbatim evidence", page: "7" },
});
assert.match(prompt, /itemKey: ABCD1234/);
assert.match(prompt, /page: 7/);
assert.match(prompt, /verbatim evidence/);
assert.match(prompt, /\[USER_QUESTION\]\n解释这一段$/);
// No local file resolved -> keep the attachment-key-only line.
assert.match(prompt, /PDF attachment keys: PDF12345/);

// With a resolved file, Hermes gets the path plus the per-page read rule,
// because neither Zotero's full-text index nor document extraction carries
// page boundaries.
const withFile = core.buildPrompt({
  paper: {
    ...paper,
    pdfFiles: [{
      key: "PDF12345",
      path: "/Users/x/Zotero/storage/PDF12345/A paper.pdf",
      relativePath: "storage/PDF12345/A paper.pdf",
    }],
  },
  question: "提取实验参数",
});
assert.match(withFile, /PDF attachment key: PDF12345/);
assert.match(withFile, /PDF file: \/Users\/x\/Zotero\/storage\/PDF12345\/A paper\.pdf/);
assert.match(withFile, /PDF file \(relative to the Zotero data directory\): storage\/PDF12345\/A paper\.pdf/);
assert.match(withFile, /pdftotext -f N -l N/);
assert.ok(!withFile.includes("PDF attachment keys:"));

// Two PDFs get numbered so the paths stay unambiguous.
const twoFiles = core.buildPrompt({
  paper: {
    ...paper,
    pdfFiles: [
      { key: "AAA", path: "/tmp/a.pdf", relativePath: "storage/AAA/a.pdf" },
      { key: "BBB", path: "/tmp/b.pdf", relativePath: "storage/BBB/b.pdf" },
    ],
  },
  question: "x",
});
assert.match(twoFiles, /PDF 1 attachment key: AAA/);
assert.match(twoFiles, /PDF 2 file: \/tmp\/b\.pdf/);

// session.resume returns {role, text, timestamp, row_id}. Reading only
// `content` made every row empty, so the panel lost all history on reconnect.
const gatewayHistory = core.visibleHistory([
  { role: "user", text: "[ZOTERO_READER_CONTEXT]\nitemKey: X\n\n[USER_QUESTION]\n导读", timestamp: 1, row_id: 2199 },
  { role: "tool", name: "get_content", context: {}, args: {} },
  { role: "assistant", text: "本文研究…（PDF 第 1 页摘要）", timestamp: 2, row_id: 2200 },
]);
assert.equal(gatewayHistory.length, 2, "tool rows must not survive, user+assistant must");
assert.deepEqual(gatewayHistory[0], { role: "user", text: "导读" });
assert.equal(gatewayHistory[1].role, "assistant");
assert.match(gatewayHistory[1].text, /本文研究/);

// The older `content` shape still works.
assert.deepEqual(
  core.visibleHistory([
    { role: "user", content: "旧格式提问" },
    { role: "assistant", content: [{ text: "旧格式回答" }] },
  ]),
  [{ role: "user", text: "旧格式提问" }, { role: "assistant", text: "旧格式回答" }],
);

// Rules are re-sent every turn, so they must not read as "go fetch it again".
const rulesPrompt = core.buildPrompt({ paper, question: "第二个问题" });
assert.match(rulesPrompt, /Reuse what this conversation already contains/);
assert.match(rulesPrompt, /do not fetch it again/);
assert.match(rulesPrompt, /have not already established in this conversation/);

const draftAnswer = [
  "这是拟稿。",
  core.DRAFT_OPEN,
  JSON.stringify({
    note_title: "A paper",
    note_path: "Papers/A paper.md",
    proposed_content: "结论 [p. 7, Fig. 2]",
    evidence: [{ quote: "verbatim evidence", page: 7, locator: "Fig. 2" }],
    zotero_link: "zotero://select/library/items/ABCD1234",
  }),
  core.DRAFT_CLOSE,
].join("\n");
const parsed = core.parseObsidianDraft(draftAnswer);
assert.equal(parsed.displayText, "这是拟稿。");
assert.equal(parsed.draft.note_path, "Papers/A paper.md");
assert.equal(parsed.draft.evidence[0].page, "7");
assert.equal(parsed.draft.evidence[0].locator, "Fig. 2");

assert.deepEqual(
  core.visibleHistory([
    { role: "system", content: "hidden" },
    { role: "user", content: `${core.CONTEXT_MARKER}\ncontext\n\n${core.QUESTION_MARKER}\n用户问题` },
    { role: "assistant", content: [{ type: "text", text: "回答" }] },
  ]),
  [
    { role: "user", text: "用户问题" },
    { role: "assistant", text: "回答" },
  ],
);

console.log("core protocol helpers: ok");
