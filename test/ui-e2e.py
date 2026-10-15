# Full chain: MCP stdio -> server -> WebSocket -> figma-plugin/ui.html (real Chromium)
# -> simulated plugin main thread. Also checks that the UI shows "disconnected" when the
# server stops and reconnects on its own when a new server starts.
#
# Run: pip install playwright && python -m playwright install chromium
#      python3 test/ui-e2e.py
#
# Uses its own port (default 3997) so it never touches a bridge you have running on 3055.
import json, os, subprocess, sys, tempfile, time
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


time.sleep(0.5)
print("init:", rpc("initialize", {"protocolVersion": "2024-11-05"})["result"]["serverInfo"])

# Point a copy of ui.html at the test port.
with open(os.path.join(ROOT, "figma-plugin", "ui.html"), encoding="utf-8") as f:
    html = f.read().replace('value="3055"', 'value="%s"' % PORT)
tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
tmp.write(html)
tmp.close()

# Stands in for figma-plugin/code.js: answers ui-ready with hello and echoes commands.
SIM = """
window.addEventListener('message', function (ev) {
  var m = ev.data && ev.data.pluginMessage; if (!m) return;
  if (m.type === 'ui-ready') window.postMessage({ pluginMessage: { type: 'hello', info: { file: 'Browser test file', page: 'Page 1', editorType: 'figma' } } }, '*');
  if (m.type === 'command') {
    var result = m.command === 'run_code' ? { value: 'ran ' + m.params.code.length + ' chars', logs: [] } : { echo: m.command };
    setTimeout(function () { window.postMessage({ pluginMessage: { type: 'result', id: m.id, ok: true, result: result } }, '*'); }, 10);
  }
});
"""
ok = True
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.add_init_script(SIM)
        pg.goto("file://" + tmp.name)
        pg.wait_for_function("document.getElementById('dot').className.includes('on')", timeout=8000)
        print("UI status:", pg.inner_text("#status"))
        time.sleep(0.3)
        st = rpc("tools/call", {"name": "status", "arguments": {}})
        text = st["result"]["content"][0]["text"]
        print("status tool:", text.replace("\n", " "))
        ok &= "Browser test file" in text
        rc = rpc("tools/call", {"name": "run_code", "arguments": {"code": "return 1+1"}})
        print("run_code via browser UI:", rc["result"]["content"][0]["text"].replace("\n", " "))
        ok &= "ran 10 chars" in rc["result"]["content"][0]["text"]
        gt = rpc("tools/call", {"name": "get_tree", "arguments": {}})
        ok &= "get_tree" in gt["result"]["content"][0]["text"]
        print("UI log:", pg.inner_text("#log").replace("\n", " | "))
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
