# Claude to Figma (Claude Bridge)

[English](README.md) · **Tiếng Việt**

Cầu nối cho Claude làm việc trực tiếp trong file Figma bạn đang mở. Claude có thể vẽ màn hình, sửa layer, chạy mọi đoạn code Figma Plugin API, và chụp màn hình để tự kiểm tra kết quả.

```
Claude ──(MCP, stdio)──► server/index.js ──(WebSocket, chỉ trong máy)──► plugin "Claude Bridge" trong Figma desktop
```

- **Không cần cài thư viện.** Server chỉ là một file Node.js (Node 18 trở lên), plugin viết bằng JavaScript thuần. Không phải chạy `npm install`.
- **Dùng được toàn bộ Plugin API.** Plugin Figma làm được gì thì Claude làm được nấy qua `run_code`: tạo layer, đổi style, đổi tên, auto layout, component, nối prototype…
- **Claude tự nhìn được kết quả.** `screenshot` xuất layer bất kỳ ra PNG rồi trả về cho Claude dưới dạng ảnh.
- **Chỉ chạy trong máy.** Server chỉ nghe trên `127.0.0.1` / `::1`. Dữ liệu chỉ đi giữa Claude và Figma trên chính máy bạn.
- **Mở nhiều cửa sổ Claude cùng lúc vẫn chạy.** Bản server khởi động đầu tiên giữ cổng, các bản sau chuyển lệnh qua nó. Nhờ vậy Claude desktop, Cowork và Claude Code dùng chung được một kết nối Figma.

---

## Mục lục

1. [Cần có gì](#cần-có-gì)
2. [Cài nhanh (macOS + Claude desktop)](#cài-nhanh-macos--claude-desktop)
3. [Cài đặt chi tiết](#cài-đặt-chi-tiết)
4. [Sử dụng hằng ngày](#sử-dụng-hằng-ngày)
5. [Danh sách công cụ](#danh-sách-công-cụ)
6. [Viết `run_code` cho tốt](#viết-run_code-cho-tốt)
7. [Cách hoạt động](#cách-hoạt-động)
8. [Xử lý lỗi](#xử-lý-lỗi)
9. [An toàn](#an-toàn)
10. [Gỡ cài đặt](#gỡ-cài-đặt)
11. [Phát triển](#phát-triển)

---

## Cần có gì

| Thứ cần | Ghi chú |
|---|---|
| **Figma desktop** | Plugin dạng development chỉ import và chạy được trong app desktop (macOS hoặc Windows), không chạy trên trình duyệt. Dùng cho file Figma Design. Chưa hỗ trợ FigJam, Slides và Dev Mode. |
| **Node.js 18 trở lên** | Kiểm tra bằng lệnh `node -v` trong Terminal. Tải bản LTS tại <https://nodejs.org>. |
| **Một MCP client** | Claude desktop (chat và Cowork), Claude Code, hoặc client bất kỳ chạy được MCP server qua stdio. |

---

## Cài nhanh (macOS + Claude desktop)

```bash
git clone https://github.com/datntfe/claude-to-figma.git
cd claude-to-figma
bash install-mac.sh
```

Script cài đặt sẽ:

- chép bridge vào `~/claude-figma-bridge`.
- thêm mục `figma-bridge` vào `~/Library/Application Support/Claude/claude_desktop_config.json`. Script sao lưu file cũ (có gắn ngày giờ) trước khi ghi, giữ nguyên các MCP server bạn đang có, và dừng lại không ghi gì nếu file hiện tại không phải JSON hợp lệ.

Sau đó:

1. **Thoát hẳn Claude** (Cmd+Q, không chỉ đóng cửa sổ) rồi mở lại.
2. Trong **Figma desktop**, mở một file design và chọn **Plugins → Development → Import plugin from manifest…**. Chọn file `~/claude-figma-bridge/figma-plugin/manifest.json`.
3. Chạy **Plugins → Development → Claude Bridge**. Thấy chấm xanh là đã kết nối.
4. Nhắn Claude: *"Kiểm tra trạng thái Figma bridge."*

---

## Cài đặt chi tiết

### 1. Lấy code về

Chọn một trong hai cách:

- `git clone https://github.com/datntfe/claude-to-figma.git`
- Trên GitHub bấm **Code → Download ZIP** rồi giải nén.

Đặt thư mục ở chỗ cố định. Mỗi lần mở, Claude sẽ chạy server từ đường dẫn này.

### 2. Khai báo MCP server

Làm theo mục ứng với client bạn dùng. Client nào cũng cần hai thứ: **đường dẫn tuyệt đối tới `node`** và **đường dẫn tuyệt đối tới `server/index.js`**.

Tìm đường dẫn `node`:

- macOS / Linux: `which node`, ví dụ `/usr/local/bin/node` hoặc `/opt/homebrew/bin/node`
- Windows: `where node`, ví dụ `C:\Program Files\nodejs\node.exe`

#### A. Claude desktop trên macOS (dùng script)

Chạy `bash install-mac.sh` như phần cài nhanh. Mỗi lần kéo bản mới về thì chạy lại script này. Script sẽ ghi đè `~/claude-figma-bridge` và cập nhật mục cấu hình.

#### B. Claude desktop, sửa cấu hình bằng tay (macOS hoặc Windows)

Mở file cấu hình. Trong Claude desktop, bạn cũng có thể vào **Settings → Developer → Edit Config**.

| Hệ điều hành | File cấu hình |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Thêm `figma-bridge` vào trong `mcpServers` và giữ nguyên các server đang có.

macOS:

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/ban/claude-to-figma/server/index.js"]
    }
  }
}
```

Windows (dấu `\` phải viết thành `\\`):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\ban\\claude-to-figma\\server\\index.js"]
    }
  }
}
```

Lưu file, thoát hẳn Claude rồi mở lại.

#### C. Claude Code

```bash
claude mcp add --scope user figma-bridge -- node /duong/dan/tuyet/doi/claude-to-figma/server/index.js
claude mcp list        # phải thấy figma-bridge
```

`--scope user` giúp mọi project đều dùng được. Bỏ cờ này thì server chỉ thêm cho project hiện tại. Trong phiên làm việc, gõ `/mcp` để xem server đã kết nối chưa.

#### D. MCP client khác

Đây là MCP server chuẩn chạy qua stdio:

- command: `node`
- args: `["/duong/dan/tuyet/doi/server/index.js"]`
- env (không bắt buộc): `FIGMA_BRIDGE_PORT`

#### Đổi cổng (không bắt buộc)

Cổng mặc định là **3055**. Muốn đổi thì phải sửa cả 3 chỗ:

1. **Server:** đặt `FIGMA_BRIDGE_PORT` trong cấu hình client, ví dụ thêm `"env": { "FIGMA_BRIDGE_PORT": "3056" }` cạnh `command`/`args`. Với Claude Code thì dùng `claude mcp add -e FIGMA_BRIDGE_PORT=3056 …`.
2. **Manifest của plugin:** Figma chỉ cho plugin mở những địa chỉ khai báo trong `figma-plugin/manifest.json`. Sửa cả hai dòng trong `devAllowedDomains` sang cổng mới.
3. **Cửa sổ plugin:** nhập cổng mới vào ô **Port** rồi bấm **Reconnect**. Sau khi sửa manifest thì đóng plugin và chạy lại.

### 3. Import plugin vào Figma (mỗi máy làm một lần)

1. Mở **Figma desktop** và một file design bất kỳ.
2. Vào **Plugins → Development → Import plugin from manifest…**. Cũng có thể bấm Cmd+/ (Ctrl+/) rồi gõ "Import plugin from manifest".
3. Chọn `figma-plugin/manifest.json`. Nếu cài bằng script thì file nằm ở `~/claude-figma-bridge/figma-plugin/manifest.json`.

Import **đúng file manifest của repo này**. Đừng tạo plugin mới bằng "New plugin…" của Figma, vì cách đó sinh ra template TypeScript cần build, không phải plugin này.

### 4. Kiểm tra mọi thứ đã chạy

1. Khi Claude đang mở, vào <http://localhost:3055> trên trình duyệt. Phải thấy dòng `Claude Figma bridge 1.1.0 is running. Plugin connected: no`.
2. Trong Figma, chạy **Plugins → Development → Claude Bridge**. Chấm chuyển **xanh**, kèm dòng "Connected. Claude can now work in this file."
3. Tải lại trang trình duyệt. Lúc này phải thấy `Plugin connected: yes`.
4. Nhắn Claude *"Kiểm tra trạng thái Figma bridge."* Claude sẽ trả lời kèm tên file và page bạn đang mở.

---

## Sử dụng hằng ngày

1. Mở file Figma bạn muốn Claude làm việc. Nên dùng file làm việc riêng hoặc một page nhân bản.
2. Chạy **Plugins → Development → Claude Bridge**. Những lần sau có thể mở lại từ **Plugins → Development**, danh sách plugin gần đây, hoặc phím tắt Cmd+Option+P (Ctrl+Alt+P).
3. **Để cửa sổ plugin mở** trong suốt lúc Claude làm. Đóng cửa sổ là Claude mất kết nối. Bạn có thể kéo hoặc thu nhỏ cửa sổ này.
4. Nhắn Claude việc cần làm bằng lời bình thường.

Cửa sổ plugin hiển thị:

| Thành phần | Ý nghĩa |
|---|---|
| 🟢 chấm xanh | Đã kết nối với bridge |
| 🟠 chấm cam | Đang kết nối |
| 🔴 chấm đỏ | Chưa kết nối. Plugin tự thử lại mỗi 2 giây. |
| Log | Từng lệnh Claude gửi (`run_code`, `screenshot`…) và lỗi nếu có |
| Port / Reconnect | Đổi cổng, hoặc buộc kết nối lại |

### Ví dụ yêu cầu

- *"Kiểm tra trạng thái Figma bridge và liệt kê các page."*
- *"Tạo page mới tên 'Explorations', vẽ màn đăng nhập mobile 390×844 dùng font Inter, chụp lại rồi tự sửa chỗ nào chưa ổn."*
- *"Xem layer mình đang chọn, chỉ ra text nào không theo type scale 12/14/16/20/24/32."*
- *"Đổi tên mọi frame cấp cao nhất trên page này thành 'Screen / <tên hiện tại>'."*
- *"Nhân bản frame đang chọn và làm bản dark mode đặt cạnh nó."*
- *"Chuyển group đang chọn thành auto layout, padding 16, gap 12."*
- *"Nối nút 'Continue' ở màn Login sang frame Home với hiệu ứng Smart Animate."*

Thường Claude sẽ gọi `status` trước, dùng `run_code` để vẽ, rồi `screenshot` để kiểm tra. Làm xong, Claude dùng `focus` để đưa màn hình của bạn tới chỗ vừa sửa.

### Mẹo

- **Lưu version trước.** Trước khi sửa lớn, chọn **File → Save to version history** để luôn quay lại được.
- **Chỉ cho Claude layer cần sửa.** Chọn layer trong Figma rồi nói "layer đang chọn", hoặc dán link layer. Claude đọc được `node-id` trong URL Figma.
- **Chỉ một cửa sổ Figma chạy plugin.** Nếu chạy plugin ở hai file, file mở plugin sau sẽ giành kết nối.

---

## Danh sách công cụ

Đây là các công cụ Claude nhìn thấy. Ở vài client, tên có thêm tiền tố tên server, ví dụ `figma-bridge__run_code`.

| Công cụ | Tham số | Việc |
|---|---|---|
| `status` | — | Plugin đã kết nối chưa. Trả về `connected`, `role` (hub/relay), `port`, `version`, `file`, `page`, `editorType`, `selection` (số layer đang chọn). |
| `run_code` | `code` (chuỗi, bắt buộc), `timeout_ms` (mặc định 60000) | Chạy JavaScript trong plugin với toàn bộ Figma Plugin API. Trả về `{ value, logs }`. |
| `screenshot` | `node_id`, `scale` (mặc định 1), `max_size` (mặc định 1600) | Xuất PNG của một node (hoặc layer đang chọn đầu tiên) và trả về dạng ảnh. Cạnh dài nhất không vượt quá `max_size`. |
| `get_selection` | `depth` (mặc định 2) | Mô tả vùng đang chọn: id, tên, loại, vị trí, kích thước, nội dung text, layer con. |
| `get_tree` | `node_id`, `depth` (mặc định 2) | Cây layer của một node, hoặc của page hiện tại. |
| `list_pages` | — | Danh sách page và page hiện tại. |
| `set_page` | `page_id` hoặc `name`, `create` | Chuyển page. Có `create: true` thì tạo page nếu chưa có. |
| `build` | `spec` (object hoặc mảng), `parent_id` | Tạo layer từ mô tả JSON, không cần viết code. |
| `delete_nodes` | `ids` | Xoá layer. Không bao giờ xoá page hay cả document. |
| `focus` | `ids` | Chuyển tới đúng page, chọn layer và zoom màn hình tới đó. |

### Chi tiết `run_code`

`code` là **phần thân của một async function**, trong đó có sẵn:

| Tên | Là gì |
|---|---|
| `figma` | Figma Plugin API |
| `log(...args)` | Ghi dòng debug. Các dòng này trả về trong `logs`. |
| `h.solid('#RRGGBB', opacity?)` | Trả về mảng paint màu đặc cho `fills` / `strokes` |
| `h.hex('#RRGGBB')` | Trả về `{ r, g, b }` theo thang 0–1 |
| `await h.font(family, style?)` | Load font và trả về `FontName` |
| `h.svg(markup, width?)` | Tạo node từ SVG, có thể scale theo `width` |
| `h.paints(v)` | `'#RRGGBB'`, `'#RRGGBB@0.5'`, một Paint hoặc mảng các loại đó → Paint[] |
| `h.summary(node, depth?)` | Trả về mô tả JSON ngắn gọn của node |

Giá trị trả về được đổi sang JSON:

- Node thành `{ id, name, type, x, y, width, height, … }`.
- `undefined` thành `null`, function thành `"[function]"`.
- Độ sâu tối đa 4 cấp, mảng tối đa 500 phần tử, object tối đa 200 key.

Ví dụ:

```js
await figma.loadFontAsync({ family: "Inter", style: "Bold" });
const card = figma.createFrame();
card.name = "Card";
card.resize(358, 200);
card.cornerRadius = 20;
card.fills = h.solid("#15121F");
card.layoutMode = "VERTICAL";
card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 16;

const t = figma.createText();
t.fontName = { family: "Inter", style: "Bold" };
t.characters = "Daily Lucky Bonus";
t.fontSize = 20;
t.fills = h.solid("#F5F3FF");
card.appendChild(t);

figma.currentPage.appendChild(card);
figma.viewport.scrollAndZoomIntoView([card]);
log("created", card.id);
return card;
```

### Cấu trúc `build`

Cách nhanh để tạo layer mà không viết code. Mỗi phần tử có dạng:

```jsonc
{
  "type": "FRAME",              // FRAME | TEXT | RECTANGLE | ELLIPSE | SVG | SECTION | LINE
  "name": "Screen",
  "x": 0, "y": 0,
  "size": [390, 844],
  "fill": "#0A0912",            // '#RRGGBB', '#RRGGBB@0.5', một Paint hoặc Paint[]
  "stroke": "#FFFFFF@0.1",
  "radius": 16,
  "layout": {                   // chỉ cho FRAME: bật auto layout
    "mode": "VERTICAL",         // hoặc HORIZONTAL
    "gap": 12,
    "padding": [16, 16],        // số | [dọc, ngang] | [trên, phải, dưới, trái]
    "align": "MIN",             // trục phụ: MIN | CENTER | MAX
    "justify": "MIN",           // trục chính: MIN | CENTER | MAX | SPACE_BETWEEN
    "w": 390,                   // HUG | FILL | số
    "h": "HUG"
  },
  "text": "Hello",              // chỉ cho TEXT
  "font": { "family": "Inter", "style": "Bold" },
  "fontSize": 20,
  "color": "#F5F3FF",
  "svg": "<svg …>…</svg>",      // chỉ cho SVG
  "fillWidth": true,            // giãn theo chiều ngang của parent (parent có auto layout)
  "props": { "opacity": 0.9 },  // mọi thuộc tính node khác
  "children": [ /* các spec con */ ]
}
```

`build` trả về id của các node gốc và số layer đã tạo. Frame mới mặc định trong suốt nếu không có `fill`.

---

## Viết `run_code` cho tốt

Phần này dành cho người và agent viết code cho bridge. Phần lớn là những "tật" của Figma đã gặp khi làm trên file thật.

- **Page được load khi cần.** Plugin dùng `documentAccess: "dynamic-page"`, nên:
  - Dùng `await figma.getNodeByIdAsync(id)` thay cho `getNodeById`.
  - Gọi `await page.loadAsync()` trước khi đọc layer con của page khác.
  - Chuyển page bằng `await figma.setCurrentPageAsync(page)`.
- **Load font trước khi đụng vào text:** `await figma.loadFontAsync({ family, style })`. Tên style mỗi font mỗi khác ("SemiBold" hay "Semi Bold"). Kiểm tra bằng `await figma.listAvailableFontsAsync()`.
- **Không bao giờ gọi `figma.closePlugin()`.** Lệnh này đóng luôn bridge, người dùng phải chạy lại plugin.
- **Frame auto layout rỗng không tự co lại.** Frame mới tạo có kích thước 100×100. Nếu frame để auto layout kiểu hug mà **không có layer con** (ví dụ frame spacer), Figma giữ nguyên 100×100. Hãy resize trước (`f.resize(0.01, 0.01)`) hoặc đặt kích thước cố định.
- **`globalThis` được giữ lại khi plugin còn mở.** Lưu thư viện helper một lần (`globalThis.lib = { … }`) rồi dùng lại ở các lần gọi sau, khỏi gửi lại đoạn code lớn.
- **Việc chạy lâu:** timeout mặc định là 60 giây (tăng bằng `timeout_ms`). Một số client còn có giới hạn riêng, ví dụ kết nối từ Cowork tới máy bạn ngắt sau khoảng 60 giây. Với việc dựng lớn, cho chạy nền rồi hỏi kết quả sau:

  ```js
  // lần gọi 1: bắt đầu
  globalThis.jobs = globalThis.jobs || {};
  const job = (globalThis.jobs.build = { status: "running", started: Date.now() });
  (async () => {
    try { /* … việc chạy lâu … */ job.status = "done"; }
    catch (e) { job.status = "error"; job.error = String(e); }
  })();
  return "started";
  ```

  ```js
  // lần gọi 2, 3, …: kiểm tra
  return globalThis.jobs.build;
  ```
- **Gửi dữ liệu lớn vẫn được.** Đã kiểm thử code trên 300 KB và ảnh chụp trên 4 MB. Dù vậy, gửi thư viện một lần rồi dùng lại vẫn nhanh hơn.
- **Page có loại node mới:** đọc `.children` của page chứa loại node mà Plugin API chưa hỗ trợ có thể báo lỗi (ví dụ `unsupported type in createVMObject: SPEC_BLOCK`). Gặp lỗi này thì dựng trên page mới và để yên page đó.
- **Kiểm tra bằng mắt.** Vẽ xong thì gọi `screenshot` với `max_size` đủ để thấy chi tiết, soát chữ tràn hay bị cắt, rồi sửa.

---

## Cách hoạt động

```
Claude (MCP client bất kỳ)
   │  JSON-RPC qua stdio
   ▼
server/index.js  ── hub trên 127.0.0.1:3055 ◄── /relay ── các bản server khác (cửa sổ Claude khác)
   │  WebSocket, ws://localhost:3055
   ▼
figma-plugin/ui.html   (iframe giao diện plugin: phần duy nhất được phép mở kết nối)
   │  postMessage
   ▼
figma-plugin/code.js   (luồng chính của plugin: chạy lệnh bằng Figma Plugin API)
```

1. MCP client khởi động `server/index.js` và trao đổi với nó bằng JSON-RPC qua stdio.
2. Server mở HTTP + WebSocket trên `127.0.0.1:3055` (và `[::1]:3055` nếu máy hỗ trợ).
3. Giao diện plugin (`ui.html`) kết nối tới `ws://localhost:3055`. Code chính của plugin không tự mở kết nối mạng được, nên iframe giao diện đảm nhận việc đó và chuyển tin nhắn cho luồng chính (`code.js`), nơi có Plugin API.
4. Mỗi lần gọi công cụ thành `{ id, command, params }` gửi tới plugin, rồi nhận về `{ type: "result", id, ok, result | error }`.

**Nhiều tiến trình Claude.** Mỗi cửa sổ Claude, phiên Cowork hay Claude Code có thể tự chạy một bản server:

- Bản đầu tiên chiếm được cổng làm **hub**, nói chuyện trực tiếp với plugin.
- Các bản sau thấy cổng đã có người dùng thì kiểm tra đó có phải bridge tương thích không (qua `GET /`), rồi nối vào `/relay` để làm **relay**. Lệnh của chúng được chuyển qua hub.
- Nếu hub tắt, một relay sẽ giành lại cổng trong vài giây, và plugin tự kết nối lại.
- Nếu một bridge **cũ** (1.0.x) đang giữ cổng, các bản mới báo lỗi rõ ràng thay vì tranh cổng.

---

## Xử lý lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Chấm plugin vẫn **đỏ**, "Not connected" | Server chưa chạy. Đảm bảo Claude đang mở và đã **thoát hẳn rồi mở lại** (Cmd+Q) sau khi cài. Mở <http://localhost:3055> để kiểm tra. Nếu trang không lên thì cấu hình MCP sai: kiểm tra đường dẫn, và trên Windows kiểm tra dấu `\\`. |
| <http://localhost:3055> chạy nhưng chấm vẫn đỏ | Ô **Port** trong plugin có đúng 3055 (hoặc cổng bạn đã đổi) không, và `manifest.json` có cho phép cổng đó không? Bấm **Reconnect**. |
| Claude báo "The Figma plugin is not connected" | Chạy **Plugins → Development → Claude Bridge** trong đúng file cần làm và để cửa sổ plugin mở. |
| Figma báo *"This plugin template uses TypeScript…"* | Bạn đã tạo plugin mới từ template của Figma thay vì import plugin này. Xoá plugin đó, rồi **Import plugin from manifest…** và chọn `figma-plugin/manifest.json` của repo này. |
| Không thấy "Import plugin from manifest" | Bạn đang dùng Figma trên trình duyệt. Hãy dùng **app desktop**. |
| Claude báo *"could not open port 3055"* hoặc *"port 3055 is used by another program"* | Có chương trình khác đang chiếm cổng. Đổi cổng khác (xem [Đổi cổng](#đổi-cổng-không-bắt-buộc)). |
| Claude báo có *"older bridge"* đang chạy | Một bản 1.0.x vẫn chạy, thường do bạn tự chạy trong cửa sổ Terminal. Đóng cửa sổ đó (hoặc bấm Ctrl+C) rồi thử lại. |
| `run_code` bị timeout | Chia nhỏ việc hoặc dùng cách chạy nền ở mục [Viết `run_code` cho tốt](#viết-run_code-cho-tốt). Kiểm tra thêm Figma có đang hiện hộp thoại nào không. |
| Lỗi text kiểu *"unloaded font"* | Load đúng family và style trước. Dùng `figma.listAvailableFontsAsync()` để xem máy có font nào. |
| Claude không thấy công cụ | Claude desktop: vào **Settings → Developer** xem `figma-bridge` có báo lỗi không. Claude Code: chạy `claude mcp list` và `/mcp`. Thử chạy server bằng tay: `node server/index.js` (Ctrl+C để tắt). |

Chạy server bằng tay để dò lỗi:

```bash
node ~/claude-figma-bridge/server/index.js
# [figma-bridge] hub listening on ws://127.0.0.1:3055
```

Log ghi ra stderr với tiền tố `[figma-bridge]`. stdout dành riêng cho MCP. Claude desktop lưu log MCP ở `~/Library/Logs/Claude/` (macOS) hoặc `%APPDATA%\Claude\logs\` (Windows).

---

## An toàn

- Server chỉ nghe trên `127.0.0.1` và `::1`, máy khác trong mạng không truy cập được.
- Manifest của plugin chỉ cho phép kết nối tới `localhost:3055` (`devAllowedDomains`). Plugin không ra được internet.
- `run_code` cho Claude chạy **bất kỳ** code Plugin API nào trong file đang mở: đọc, sửa hay xoá layer. Chỉ dùng bridge trên file bạn yên tâm cho Claude sửa, giữ version history, và đóng plugin khi xong việc.
- Chương trình khác trên chính máy bạn, nếu truy cập được `localhost:3055`, cũng có thể gửi lệnh khi plugin đang mở. Đóng plugin khi không dùng.

---

## Gỡ cài đặt

1. Xoá mục `figma-bridge` trong cấu hình client:
   - Claude desktop: file `claude_desktop_config.json` ở trên.
   - Claude Code: `claude mcp remove figma-bridge`.
2. Xoá thư mục: `~/claude-figma-bridge` nếu đã cài bằng script, và/hoặc thư mục bạn đã clone.
3. Trong Figma: mở **Plugins → Manage plugins…**, tìm **Claude Bridge** trong nhóm plugin đang phát triển và xoá.
4. Khởi động lại Claude.

---

## Phát triển

```
claude-to-figma/
├── server/index.js          MCP server + hub/relay WebSocket (không cần thư viện ngoài)
├── figma-plugin/
│   ├── manifest.json        Manifest plugin (dynamic-page, chỉ kết nối localhost)
│   ├── code.js              Luồng chính: chạy lệnh bằng Plugin API
│   └── ui.html              Cửa sổ plugin: WebSocket client + trạng thái và log
├── install-mac.sh           Script cài cho Claude desktop trên macOS
├── test/
│   ├── plugin.test.js       Handler của code.js chạy trên mock Figma API chặt chẽ
│   ├── server.test.js       Giao thức MCP, dữ liệu lớn, gọi đồng thời, mất kết nối
│   ├── multi.test.js        Hub + relay, chuyển hub khi bản cũ tắt, phát hiện bản cũ
│   └── ui-e2e.py            Kiểm thử toàn tuyến qua ui.html trên Chromium thật (Playwright)
└── package.json
```

Chạy test:

```bash
npm test              # Node 22+ (dùng WebSocket client có sẵn của Node)
npm run test:ui       # tuỳ chọn, cần: pip install playwright && python -m playwright install chromium
```

Test dùng cổng 3997–3999 nên không đụng tới bridge đang chạy trên 3055.

**Giao thức** (server ↔ giao diện plugin, frame JSON dạng text):

```jsonc
// plugin → server, khi vừa kết nối
{ "type": "hello", "info": { "file": "…", "page": "…", "editorType": "figma" } }
// server → plugin
{ "id": 7, "command": "run_code", "params": { "code": "return 1" } }
// plugin → server
{ "type": "result", "id": 7, "ok": true, "result": { "value": 1, "logs": [] } }
{ "type": "result", "id": 7, "ok": false, "error": "message" }
```

Relay nối vào `ws://127.0.0.1:<port>/relay`, gửi `{ type: "call", id, command, params, timeout }` hoặc `{ type: "status", id }`, và nhận về `{ type: "reply", id, ok, result | error }`.

**Thêm lệnh mới:**

1. Thêm handler vào `handlers` trong `figma-plugin/code.js`.
2. Thêm tool vào `TOOLS` trong `server/index.js`, gọi `callPlugin("<command>", params)`.
3. Viết test trong `test/plugin.test.js`.

**Phát hành bản mới:** tăng `VERSION` trong `server/index.js` và `version` trong `package.json` cùng lúc. Relay dựa vào chuỗi phiên bản của hub để nhận ra bridge cũ.
