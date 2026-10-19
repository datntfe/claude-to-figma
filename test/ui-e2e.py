# Full chain: MCP stdio -> server -> WebSocket -> figma-plugin/ui.html (real Chromium)
# -> simulated plugin main thread. Two plugin windows (two Figma files) stay connected
# together, user activity in one of them makes it the file Claude reads from, and the UI
# shows "disconnected" when the server stops and reconnects on its own when a new one starts.
#
# Run: pip install playwright && python -m playwright install chromium
#      python3 test/ui-e2e.py
#
# Uses its own port (default 3997) so it never touches a bridge you have running on 3055.
import json, os, subprocess, sys, tempfile, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SERVER = os.path.join(ROOT, "server", "index.js")
PORT = os.environ.get("TEST_PORT_UI", "3997")
ENV = dict(os.environ, FIGMA_BRIDGE_PORT=PORT)


def start_server():
    return subprocess.Popen(["node", SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, bufsize=1, env=ENV)


srv = start_server()
rid = 0


def rpc(method, params=None):
    global rid
    rid += 1
    srv.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}) + "\n")
    srv.stdin.flush()
    return json.loads(srv.stdout.readline())


def tool(name, args=None):
    return rpc("tools/call", {"name": name, "arguments": args or {}})["result"]["content"][0]["text"]


time.sleep(0.5)
print("init:", rpc("initialize", {"protocolVersion": "2024-11-05"})["result"]["serverInfo"])

# Point a copy of ui.html at the test port.
with open(os.path.join(ROOT, "figma-plugin", "ui.html"), encoding="utf-8") as f:
    html = f.read().replace('value="3055"', 'value="%s"' % PORT)
tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
tmp.write(html)
tmp.close()

# Stands in for figma-plugin/code.js: answers ui-ready with hello and echoes commands with its file name.
SIM = """
window.__file = %s;
function post(x) { window.postMessage({ pluginMessage: x }, '*'); }
function finish(m, ok, result, summary) {
  post(ok ? { type: 'result', id: m.id, ok: true, result: result } : { type: 'result', id: m.id, ok: false, error: result });
  post({ type: 'done', rid: m.id, command: m.command, ok: ok, ms: 1500, write: true, summary: summary, touched: [], preview: '' });
}
window.addEventListener('message', function (ev) {
  var m = ev.data && ev.data.pluginMessage; if (!m) return;
  if (m.type === 'ui-ready') { post({ type: 'hello', info: { file: window.__file, page: 'Page 1', editorType: 'figma', version: '1.5.0', session: window.__file } }); post({ type: 'prefs', mode: 'allow', follow: false }); }
  /* Ask first: build waits for the OK in the panel */
  if (m.type === 'command' && m.command === 'build') {
    window.__asked = m;
    post({ type: 'progress', rid: m.id, state: 'asking' });
    post({ type: 'ask', rid: m.id, command: 'build', text: 'Create 3 layers: “Checkout”', detail: 'spec: …', targets: ['1:2'], until: Date.now() + 125000 });
    return;
  }
  if (m.type === 'decide') { (window.__panel = window.__panel || []).push(m); post({ type: 'asked', rid: m.rid, ok: m.ok }); finish(window.__asked, m.ok, m.ok ? { created: 3 } : 'The user declined this change in Figma.', 'Created 3 layers'); return; }
  /* a long run_code reports progress and can be cancelled */
  if (m.type === 'command' && m.command === 'run_code' && m.params.code === 'progress') {
    window.__long = m;
    post({ type: 'progress', rid: m.id, state: 'running', done: 3, total: 10, text: 'Cards' });
    return;
  }
  if (m.type === 'cancel') { (window.__panel = window.__panel || []).push(m); post({ type: 'progress', rid: m.rid, state: 'stopping' }); setTimeout(function () { finish(window.__long, false, 'Stopped part way through (cancelled).', ''); }, 50); return; }
  if (m.type === 'command') {
    var result = m.command === 'run_code' ? { value: 'ran ' + m.params.code.length + ' chars in ' + window.__file, logs: [] }
      : m.command === 'ping' ? { file: window.__file, page: 'Page 1', editorType: 'figma', selection: 0, version: '1.5.0' }
      : { echo: m.command, file: window.__file };
    setTimeout(function () {
      window.postMessage({ pluginMessage: { type: 'result', id: m.id, ok: true, result: result } }, '*');
      window.postMessage({ pluginMessage: { type: 'done', rid: m.id, command: m.command, ok: true, ms: 12, write: m.command === 'run_code',
        summary: m.command === 'run_code' ? 'Ran code' : 'Read', touched: m.command === 'run_code' ? ['12:34'] : [], preview: JSON.stringify(result) } }, '*');
    }, 10);
  }
  if (m.type === 'ui-focus' || m.type === 'mode' || m.type === 'follow' || m.type === 'ui-save-version') (window.__panel = window.__panel || []).push(m);
});
"""
ok = True
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.add_init_script(SIM % json.dumps("Browser test file"))
        pg.goto("file://" + tmp.name)
        pg.wait_for_function("document.getElementById('dot').className.includes('on')", timeout=8000)
        time.sleep(0.3)
        print("UI status:", pg.inner_text("#status"))
        ok &= "Browser test file" in pg.inner_text("#status")
        text = tool("status")
        print("status tool:", text.replace("\n", " "))
        ok &= "Browser test file" in text
        rc = tool("run_code", {"code": "return 1+1"})
        print("run_code via browser UI:", rc.replace("\n", " "))
        ok &= "ran 10 chars" in rc
        # the panel shows a timeline row with the summary, the undo badge and a Show button
        pg.wait_for_function("document.getElementById('log').innerText.includes('Ran code')", timeout=4000)
        row = pg.inner_text("#log")
        print("timeline:", row.replace("\n", " | "))
        ok &= "↶ 1 undo" in row and "Show" in row
        pg.click("text=Show")
        pg.select_option("#mode", "off")
        pg.check("#follow")
        time.sleep(0.2)
        panel = pg.evaluate("window.__panel || []")
        print("panel messages:", panel)
        ok &= any(m.get("type") == "ui-focus" and m.get("ids") == ["12:34"] for m in panel)
        ok &= any(m.get("type") == "mode" and m.get("mode") == "off" for m in panel)
        ok &= any(m.get("type") == "follow" and m.get("on") is True for m in panel)
        ok &= "Look only" in pg.inner_text("#status")
        pg.select_option("#mode", "ask")
        ok &= "Ask first" in pg.inner_text("#status")

        # Ask first: the change waits on a card; Allow lets it through
        out = {}
        th = threading.Thread(target=lambda: out.update(build=tool("build", {"spec": {"type": "FRAME", "name": "Checkout"}})))
        th.start()
        pg.wait_for_selector("#asks .ask", timeout=4000)
        card = pg.inner_text("#asks")
        print("ask card:", card.replace("\n", " | "))
        ok &= "Claude wants to:" in card and "Create 3 layers" in card and "Allow for 10 min" in card and "left" in card
        ok &= "Waiting for your OK" in pg.inner_text("#log")
        pg.click("#asks .ask button.primary")
        th.join(10)
        print("build after OK:", out.get("build", "").replace("\n", " ")[:120])
        ok &= '"created":3' in out.get("build", "") and pg.query_selector("#asks .ask") is None
        ok &= any(m.get("type") == "decide" and m.get("ok") is True for m in pg.evaluate("window.__panel"))

        # progress bar and Cancel on a long change
        th = threading.Thread(target=lambda: out.update(long=tool("run_code", {"code": "progress"})))
        th.start()
        pg.wait_for_function("document.getElementById('log').innerText.includes('3 of 10')", timeout=4000)
        bar = pg.evaluate("getComputedStyle(document.querySelector('.pending .bar')).display + ' ' + document.querySelector('.pending .bar > i').style.width")
        print("progress:", bar)
        ok &= bar == "block 30%"
        pg.click(".pending button.cancel")
        th.join(10)
        print("cancelled:", out.get("long", "").replace("\n", " ")[:120])
        ok &= "Stopped part way" in out.get("long", "")
        ok &= any(m.get("type") == "cancel" for m in pg.evaluate("window.__panel"))
        pg.select_option("#mode", "allow")

        # A second Figma file opens the plugin too: both stay connected.
        pg2 = b.new_page()
        pg2.add_init_script(SIM % json.dumps("Second file"))
        pg2.goto("file://" + tmp.name)
        pg2.wait_for_function("document.getElementById('dot').className.includes('on')", timeout=8000)
        time.sleep(1.0)
        st = json.loads(tool("status"))
        print("files:", [f["file"] for f in st.get("files", [])])
        ok &= len(st.get("files", [])) == 2
        ok &= '"Second file"' in tool("get_context")
        # The user does something in the first file (the main thread reports activity) -> Claude reads from it.
        pg.evaluate("window.postMessage({ pluginMessage: { type: 'activity', what: 'select' } }, '*')")
        time.sleep(0.3)
        ctx = tool("get_context")
        print("after activity in the first file:", ctx.replace("\n", " ")[:120])
        ok &= '"Browser test file"' in ctx
        both_on = pg.evaluate("document.getElementById('dot').className") + " " + pg2.evaluate("document.getElementById('dot').className")
        ok &= both_on.count("on") == 2
        print("UI log:", pg.inner_text("#log").replace("\n", " | ")[:300])
        pg2.close()

        # Server goes away -> UI shows disconnected, then reconnects to a new server by itself.
        srv.stdin.close()
        srv.wait(timeout=5)
        pg.wait_for_function("document.getElementById('dot').className.includes('off')", timeout=8000)
        print("after server stop:", pg.inner_text("#status"))
        srv2 = start_server()
        pg.wait_for_function("document.getElementById('dot').className.includes('on')", timeout=10000)
        print("auto-reconnected:", pg.inner_text("#status"))
        srv2.stdin.close()
        srv2.wait(timeout=5)
        b.close()
finally:
    os.unlink(tmp.name)

print("ALL UI E2E TESTS PASSED" if ok else "UI E2E FAILED")
sys.exit(0 if ok else 1)
