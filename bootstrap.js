var HermesReadingAssistantZ9;
var chromeHandle;

function log(message) {
  Zotero.debug(`[Hermes Reading Assistant Z9] ${message}`);
}

function install() {
  log("installed");
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "hermes-reading-assistant-z9", rootURI + "content/"]]
  );

  const scope = {
    rootURI,
    Zotero,
    Services,
    IOUtils,
    PathUtils,
    Ci: Components.interfaces,
  };
  scope._globalThis = scope;
  // KaTeX is a UMD bundle; with no `exports`/`define`/`self` in this scope it
  // assigns `katex` onto the scope object, so main.js sees it as a global.
  Services.scriptloader.loadSubScript(
    rootURI + "content/vendor/katex.min.js",
    scope
  );
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/core.js",
    scope
  );
  Services.scriptloader.loadSubScript(
    rootURI + "content/scripts/main.js",
    scope
  );
  HermesReadingAssistantZ9 = scope.HermesReadingAssistantZ9;
  // The settings pane's inline `onload` is evaluated in the preferences
  // window's global, where only `Zotero` is reachable.
  Zotero.HermesReadingAssistantZ9 = HermesReadingAssistantZ9;
  await HermesReadingAssistantZ9.start({ id, version, rootURI });
  for (const window of Zotero.getMainWindows()) {
    HermesReadingAssistantZ9.onMainWindowLoad(window);
  }
}

async function onMainWindowLoad({ window }) {
  await HermesReadingAssistantZ9?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  HermesReadingAssistantZ9?.onMainWindowUnload(window);
}

function shutdown(data, reason) {
  HermesReadingAssistantZ9?.shutdown();
  HermesReadingAssistantZ9 = undefined;
  delete Zotero.HermesReadingAssistantZ9;
  if (reason !== APP_SHUTDOWN && chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {
  log("uninstalled");
}
