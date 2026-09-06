// `node --check` only catches syntax errors. A helper deleted by a careless
// edit still parses, then throws ReferenceError at render time and the panel
// goes blank — which is exactly how 0.7.4 shipped without `button()`.
//
// Deliberately simple: no attempt at a general undefined-identifier scan. An
// earlier version tried that, mis-parsed regex literals containing quotes, and
// silently dropped half the file. These two checks are the ones that catch the
// failure that actually happened.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "content/scripts/main.js"), "utf8");
const core = require(path.join(root, "content/scripts/core.js"));

let failed = false;

// Every module-level helper the render path walks through. Losing any one of
// them blanks the panel.
const REQUIRED = [
  "h", "button", "iconButton", "log", "reportError", "prefString",
  "configuredGateway", "saveConfiguredGateway", "clearConfiguredGateway",
  "pdfFileFromAttachment", "paperFromItem", "paperFromReader",
  "readSessionStore", "writeSessionBinding", "deleteSessionBinding",
  "listPaperSessions", "createPaperSession", "resumePaperSession",
  "ensurePaperSession", "registerController", "unregisterController",
  "appendMarkdownInline", "appendMath", "safeMarkdownURL", "renderMarkdown",
  "openConnectionSettings", "applyGatewaySettings",
  "registerPrefPane", "clampPanelWidth", "observePanelWidth", "render",
  "installWindowResources", "notifySelectionStaged", "focusHermesPane",
  "registerReaderHandlers",
];

// Entry points: bootstrap.js and the prefs pane call these from outside, so
// they are checked against the module's return value instead of call sites.
const EXPORTED = [
  "start", "onMainWindowLoad", "onMainWindowUnload", "shutdown", "initPrefPane",
];
for (const name of REQUIRED.concat(EXPORTED)) {
  const declared = new RegExp(`\\b(?:async\\s+)?function\\s+${name}\\s*\\(`).test(source);
  if (!declared) {
    console.error(`main.js no longer declares function ${name}()`);
    failed = true;
  }
}

// Each of those must also still be reachable — a helper nobody calls is dead
// weight, and a call with no declaration is the ReferenceError we are hunting.
for (const name of REQUIRED) {
  const calls = source.match(new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, "g")) || [];
  if (calls.length < 2) {
    console.error(`main.js declares ${name}() but never calls it`);
    failed = true;
  }
}

// Entry points have to be handed back to bootstrap.js.
const returned = source.slice(source.lastIndexOf("return {"));
for (const name of EXPORTED) {
  if (!returned.includes(name)) {
    console.error(`main.js declares ${name}() but never returns it`);
    failed = true;
  }
}

// core.js must actually export everything main.js reaches for.
for (const m of source.matchAll(/HermesReaderCore\.([A-Za-z_$][\w$]*)/g)) {
  if (!(m[1] in core)) {
    console.error(`core.js does not export HermesReaderCore.${m[1]}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("main.js reference check: ok");
