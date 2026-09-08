# AI Chat Exporter

Save browser conversations and local Codex or OpenCode sessions as readable Markdown, with available attachments. No sign-up, analytics, or exporter-hosted conversation storage.

**[Open the website](https://rc2barrington.github.io/ai-chat-exporter/)**

## Get started

### Browser chats

1. Download the Chrome extension from the website and unzip it somewhere permanent.
2. Open `chrome://extensions`, enable Developer mode, and use **Load unpacked** to select the extracted extension folder.
3. Open the extension, select chats, choose whether to include attachments, and export.

Supported sources: ChatGPT, Claude.ai, Gemini, Grok, Google AI Overviews and Google Search AI Mode on google.com. Exports run in existing tabs without moving or activating them. Updating an unpacked extension requires replacing its files and clicking Reload in Chrome.

### Codex and OpenCode

On the website, choose Codex or OpenCode and download the Mac local app. Unzip it, then double-click **Open AI Chat Exporter.command**. Requires [Node.js](https://nodejs.org/en/download) 22.13 or newer. No `npm install` is needed for the packaged app. Keep its launcher window open while exporting.

The local app automatically lists saved chats. Search, select, and export. Everything starts unselected. Conversation bodies are read only when you preview or export them.

- Codex: discovers `sessions` and `archived_sessions` under `$CODEX_HOME`, defaulting to `~/.codex`. Reads titles from the local state database or session index. Parses the rollout message stream once, excluding mirrored UI events and injected system/developer instructions.
- OpenCode: reads `$XDG_DATA_HOME/opencode/opencode.db`, defaulting to `~/.local/share/opencode/opencode.db`, in read-only transactions. Includes text, saved reasoning, file parts, tool calls and results; excludes reverted tail messages.
- Manual file import is optional: Codex `.jsonl` rollouts or OpenCode `.json` exports. Imported files stay in your browser. To copy local `file:` attachments, use automatic discovery in the local app.
- Local coding-agent support is intentionally limited to Codex and OpenCode. Claude.ai remains a supported browser source.

## Export behavior

- No attachment files saved: a plain `.md` file, no empty media folder or ZIP.
- Attachments saved: a ZIP containing `conversation.md` and `media/`.
- Multiple local chats: one ZIP with a separate folder for each conversation.
- Exact duplicate images: one saved copy per conversation. SHA-256 groups candidates, then their bytes are compared. Different encodings and similar-looking images remain separate. Every occurrence still links to the retained image.
- Batch export requires two separate confirmations of the selected chat names. The extension worker validates the confirmed selection snapshot too.
- Message text and tool output are not truncated by the current interface. The parser cannot undo truncation already present in a provider's saved records.
- Cancel stops active requests and prevents further downloads. It does not delete files already downloaded.
- Unavailable attachments are identified in the conversation and status display. No separate error-log file is generated.
- All ZIP entries, including automatically created folders, receive the current local modification time. ZIP timestamps have two-second precision. Archive filenames use the local date.

## Completeness and limits

ChatGPT text is reconstructed from the authoritative active root-to-current chain, including paginated history. If that chain cannot be established, no partial ChatGPT export is presented as complete. Markdown uses `history_status: complete` for a verified chain. An optional rendered-media recovery sweep no longer produces a misleading `root history reached: false` field in the document.

Other browser providers use the messages available through their pages. Their output is a page capture, not an independently verified server history. Website changes, virtualized histories, authentication and expired attachment links can affect results. Gemini images are labeled neutrally, not assumed to be generated merely because Gemini displayed them.

The extension transports data in acknowledged 256 Ki-character chunks instead of one giant Chrome message. There is no configured total attachment count, total transfer size, or whole-export deadline. Individual network requests still time out when stalled. Browser memory, ZIP format constraints, disk space and provider access remain real limits.

Deleted or expired files cannot be reconstructed from a filename. Local exports copy bytes only from embedded attachments or structured file references that remain accessible. Paths mentioned in ordinary chat text or tool commands are not treated as permission to read arbitrary files.

## Privacy

The local server binds only to `127.0.0.1`. Its API requires the local exporter's custom header, rejects foreign origins and hosts, and accepts session identifiers rather than arbitrary filesystem paths. Local attachment reads are limited to structured attachment records in an opened session. It does not scan authentication files or send conversations to the exporter website.

Browser attachment downloads contact the original providers or media hosts. The optional console-script fallback is subject to the page's cross-origin restrictions; the extension is preferred.

## Development

Use Node.js 22.13 or newer (Node 24 is used in CI):

```sh
npm ci
npm run build
npm run local
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite development server |
| `npm run local` | Serve the built local app and discover sessions |
| `npm test` | Parser, transport, media, selection, archive and access-control tests |
| `npm run lint` | Lint source and tests |
| `npm run build` | Build the website in `dist/` |
| `npm run package:downloads` | Build extension and local-app ZIPs after building the site |
| `npm run build:standalone` | Single-file offline import UI in `dist-standalone/` |
| `npm run deploy` | Build, package downloads and publish GitHub Pages |

CI runs tests, lint, production build and downloadable packaging. Tests include a payload larger than Chrome's 64 MiB message ceiling, byte-exact image deduplication, untruncated tool results, local file attachments, cancellation and ZIP directory timestamps. Browser-provider compatibility still requires live checks when those sites change.

Please report issues with the exporter version, provider and redacted log. Do not publish conversation contents, session tokens or private attachment links.

## 0.2.0

Rebuilt source-first interface, downloadable local app, automatic session discovery, two-stage batch confirmation, chunked extension transport, exact-image deduplication, local attachment bundles, clearer history status and corrected file/folder timestamps.
