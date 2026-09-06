from __future__ import annotations

import json
import subprocess
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).parents[1]
VERSION = "0.7.3"
XPI = ROOT / "dist" / f"Hermes-Reading-Assistant-Zotero9-{VERSION}.xpi"
LEDGER = XPI.with_suffix(".release.json")
EXPECTED_ID = "hermes-reading-assistant-z9@altail.local"


class TestZotero9Package(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            [sys.executable, "build.py"], cwd=ROOT, capture_output=True, text=True
        )
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)

    def test_build_produces_valid_zotero9_package_and_release_ledger(self):
        self.assertTrue(XPI.exists())
        self.assertTrue(LEDGER.exists())

        with zipfile.ZipFile(XPI) as bundle:
            self.assertIsNone(bundle.testzip())
            names = bundle.namelist()
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual(manifest["manifest_version"], 2)
            self.assertEqual(manifest["version"], VERSION)
            self.assertEqual(manifest["applications"]["zotero"]["id"], EXPECTED_ID)
            self.assertEqual(manifest["applications"]["zotero"]["strict_min_version"], "9.0")
            self.assertEqual(manifest["applications"]["zotero"]["strict_max_version"], "9.0.*")
            self.assertTrue(manifest["applications"]["zotero"]["update_url"].startswith("https://"))
            for required in [
                "bootstrap.js",
                "content/scripts/core.js",
                "content/scripts/main.js",
                "content/hermes-reader.css",
                "content/prefs.xhtml",
                "content/vendor/katex.min.js",
                "content/vendor/katex.LICENSE",
                "content/icons/hermes-reader.svg",
                "locale/en-US/hermes-reading-assistant.ftl",
                "locale/zh-CN/hermes-reading-assistant.ftl",
            ]:
                self.assertIn(required, names)
            self.assertFalse(any(name.startswith("Hermes-Reading-Assistant") for name in names))
            self.assertFalse(any(".DS_Store" in name or "__pycache__" in name for name in names))

        ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
        self.assertEqual(ledger["addon_id"], EXPECTED_ID)
        self.assertEqual(ledger["version"], VERSION)
        self.assertEqual(ledger["xpi"], XPI.name)
        self.assertEqual(len(ledger["sha256"]), 64)
        self.assertGreater(ledger["size"], 0)

    def test_bootstrap_loads_core_before_main_and_follows_lifecycle(self):
        bootstrap = (ROOT / "bootstrap.js").read_text(encoding="utf-8")
        self.assertLess(bootstrap.index("content/scripts/core.js"), bootstrap.index("content/scripts/main.js"))
        for required in [
            "async function startup({ id, version, rootURI })",
            "registerChrome",
            "async function onMainWindowLoad({ window })",
            "function shutdown(data, reason)",
            "chromeHandle.destruct()",
            "Ci: Components.interfaces",
        ]:
            self.assertIn(required, bootstrap)

    def test_sidebar_gateway_and_reader_use_supported_contracts(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        for required in [
            "Zotero.ItemPaneManager.registerSection",
            "paneID: \"hermes-reading-assistant-z9-pane\"",
            "pluginID: config.addonID",
            "l10nID: \"hermes-reading-assistant-section-header\"",
            "Zotero.Reader.registerEventListener(\"renderTextSelectionPopup\"",
            "Zotero.Reader.registerEventListener(\"createAnnotationContextMenu\"",
            "spawn-ledger.json",
            "event.payload || {}",
            "stored_session_id",
            "session.resume",
            "gateway.ping",
            "window.ZoteroContextPane.collapsed = false",
            "Zotero.PreferencePanes.register",
            "Zotero.PreferencePanes.unregister",
            "Zotero.Utilities.Internal.openPreferences",
            "attachment.getFilePath()",
        ]:
            self.assertIn(required, main)

    def test_settings_live_in_zotero_preferences_not_the_item_pane(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        # The in-panel settings form is gone; the item pane only links out to it.
        for gone in ["settingsPanel", "hermes-reader-z9-settings-input", "saveConnectionSettings"]:
            self.assertNotIn(gone, main)

        pane = (ROOT / "content/prefs.xhtml").read_text(encoding="utf-8")
        self.assertIn('onload="Zotero.HermesReadingAssistantZ9.initPrefPane(this)"', pane)
        for control in ["endpoint", "token", "status", "save", "clear"]:
            self.assertIn(f'id="hermes-reading-assistant-z9-{control}"', pane)

        # The inline onload is evaluated in the prefs window global, so the
        # module has to be reachable from `Zotero` there.
        bootstrap = (ROOT / "bootstrap.js").read_text(encoding="utf-8")
        self.assertIn("Zotero.HermesReadingAssistantZ9 = HermesReadingAssistantZ9", bootstrap)
        self.assertIn("delete Zotero.HermesReadingAssistantZ9", bootstrap)

    def test_pane_cannot_widen_the_item_pane(self):
        css = (ROOT / "content/hermes-reader.css").read_text(encoding="utf-8")
        root_rule = css.split(".hermes-reader-z9 {", 1)[1].split("}", 1)[0]
        self.assertIn("contain: inline-size", root_rule)
        self.assertIn("max-width: 100%", root_rule)

    def test_composer_has_no_button_competing_for_width(self):
        css = (ROOT / "content/hermes-reader.css").read_text(encoding="utf-8")
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")

        def rule(selector):
            return css.split(selector + " {", 1)[1].split("}", 1)[0]

        self.assertIn("display: flex", rule(".hermes-reader-z9-composer"))
        # Enter sends, so the send button is gone from both CSS and JS.
        self.assertNotIn("hermes-reader-z9-send", css)
        self.assertNotIn("this.send", main)
        # A fixed width on the textarea overflows the panel.
        self.assertNotIn("width: 100%", rule(".hermes-reader-z9-input"))

    def test_enter_sends_and_shift_enter_keeps_a_newline(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        self.assertIn("event.shiftKey || event.isComposing", main)
        # A CJK IME commits with keyCode 229; sending then would eat the word.
        self.assertIn("event.keyCode === 229", main)

    def test_panel_is_clamped_to_the_sidenav_boundary(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        self.assertIn("observePanelWidth", main)
        self.assertIn("item-pane-sidenav", main)
        # Observing the panel itself would loop against its own clamp.
        self.assertIn(".zotero-view-item", main)

    def test_math_renders_as_mathml_without_shipping_fonts(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        css = (ROOT / "content/hermes-reader.css").read_text(encoding="utf-8")
        bootstrap = (ROOT / "bootstrap.js").read_text(encoding="utf-8")

        # MathML output is what keeps this dependency to one JS file: Gecko
        # draws it with system math fonts, so no KaTeX CSS/webfont is bundled.
        self.assertIn('output: "mathml"', main)
        self.assertNotIn("katex.min.css", css)
        self.assertNotIn("KaTeX_", css)

        # KaTeX must load before main.js so `katex` is a global there.
        self.assertLess(
            bootstrap.index("content/vendor/katex.min.js"),
            bootstrap.index("content/scripts/main.js"),
        )

        # Model LaTeX must not reach the DOM as markup.
        self.assertIn("DOMParser", main)
        self.assertIn("importNode", main)
        self.assertNotIn("innerHTML", main)

    def test_inline_math_wins_over_emphasis(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        pattern_line = next(l for l in main.splitlines() if "const tokenPattern" in l)
        # `^`/`_`/`*` inside LaTeX would otherwise be eaten by the emphasis rules.
        self.assertLess(pattern_line.index("\\\\("), pattern_line.index("`+"))

    def test_conversations_are_listed_from_the_server(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        # Zotero prefs are per-profile, so the list must come from session.list
        # for both machines to see the same conversations.
        self.assertIn('gateway.request("session.list"', main)
        self.assertIn("sessionBelongsToPaper", main)
        self.assertIn("switchSession", main)
        # The five preset-prompt buttons are gone; Obsidian keeps its own entry
        # because it needs mode "obsidian-draft", not just a canned question.
        self.assertNotIn("hermes-reader-z9-action\"", main)
        self.assertIn('mode: "obsidian-draft"', main)

    def test_messages_are_selectable_and_copyable(self):
        css = (ROOT / "content/hermes-reader.css").read_text(encoding="utf-8")
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")

        def rule(selector):
            return css.split("\n" + selector + " {", 1)[1].split("}", 1)[0]

        # Gecko walks the ancestor chain when a drag-selection starts, so the
        # panel root has to opt in — marking only leaf nodes is not enough.
        root = rule(".hermes-reader-z9")
        self.assertIn("-moz-user-select: text", root)
        self.assertIn("user-select: text", root)
        # Chrome documents draw no selection highlight by default.
        self.assertIn("::selection", css)
        # Controls opt back out so dragging does not grab their labels.
        self.assertIn("-moz-user-select: none", css)

        # Copy hands back the source, not MathML-rendered glyphs.
        self.assertIn("dataset.rawText", main)
        self.assertIn("copyTextToClipboard", main)
        self.assertIn("answer.article.dataset.rawText = answer.content.dataset.rawMarkdown", main)

    def test_message_controls_are_icons_below_the_bubble(self):
        main = (ROOT / "content/scripts/main.js").read_text(encoding="utf-8")
        css = (ROOT / "content/hermes-reader.css").read_text(encoding="utf-8")
        # Inline SVG, so the icon never depends on a system glyph.
        self.assertIn("iconButton", main)
        self.assertIn("http://www.w3.org/2000/svg", main)
        # Tools are a sibling of the bubble inside a block wrapper, not a child.
        self.assertIn("block.append(article, this.buildMessageTools(article, role))", main)
        self.assertIn("hermes-reader-z9-message-block", css)
        # Removing a failed turn must take its controls with it.
        self.assertIn("answer.block.remove()", main)
        self.assertNotIn("answer.article.remove()", main)

    def test_ftl_messages_have_no_value(self):
        # A Fluent message value replaces the host element's textContent, which
        # deletes collapsible-section's head and its <div data-type="body"> and
        # paints label text over the sidenav icon. Attributes only.
        for locale in ["en-US", "zh-CN"]:
            path = ROOT / "locale" / locale / "hermes-reading-assistant.ftl"
            messages = []
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("#") or not line.strip():
                    continue
                if not line[0].isspace():
                    identifier, _, value = line.partition("=")
                    messages.append(identifier.strip())
                    self.assertEqual(
                        value.strip(),
                        "",
                        f"{locale} message {identifier.strip()} must not define a value",
                    )
                else:
                    self.assertTrue(
                        line.strip().startswith("."),
                        f"{locale} continuation line is not an attribute: {line!r}",
                    )
            self.assertEqual(
                messages,
                ["hermes-reading-assistant-section-header", "hermes-reading-assistant-sidenav"],
            )

    def test_core_protocol_helpers(self):
        result = subprocess.run(
            ["node", "tests/test_core.js"], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
