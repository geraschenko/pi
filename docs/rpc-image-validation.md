# Gap: RPC-supplied images bypass pi's image validation and resizing

> **Status (2026-06-12): implemented** on this branch (`processRpcImages` in `src/modes/rpc/rpc-command-handler.ts`, tests in `test/rpc-image-validation.test.ts`). This doc contains the motivation (usable nearly verbatim for the upstream issue and PR description) and the implemented design. File paths are relative to `packages/coding-agent` unless noted.

## The problem

pi has three paths by which an image can enter a conversation, and they do not behave the same way:

1. **CLI file arguments** (`pi "look at this" image.png`): `processFileArguments` (`src/cli/file-processor.ts`, called from `src/main.ts`) sniffs the mime type from file *content* (`detectSupportedImageMimeTypeFromFile`) and decodes + resizes the image to the inline limits via `resizeImage` (`src/utils/image-resize.ts`, Photon in a worker thread).
2. **The `read` tool** — which is also how interactively pasted images reach the model: the TUI's clipboard paste handler (`handleClipboardImagePaste` in `src/modes/interactive/interactive-mode.ts`) writes a temp file and inserts its *path* as text, and the model then reads it. `read` sniffs the mime type and resizes (`src/core/tools/read.ts`, the `resizeImage` call in the image branch).
3. **RPC commands** `prompt`, `steer`, and `follow_up` with an `images: ImageContent[]` field: the handler (`src/modes/rpc/rpc-command-handler.ts`) passes `command.images` to `session.prompt` / `session.steer` / `session.followUp` **completely untouched** — no decode, no mime check, no resize, no size limit. Whatever base64 the client sent is persisted into the session and shipped to the model API.

Path 3 is the only one that takes bytes raw, and the consequences are severe because of how model APIs treat invalid images:

**A single bad image poisons the session permanently.** Providers validate *every* image in the request, not just new ones, and the full conversation history is sent on every turn. So one undecodable image (corrupt file, wrong mime type, or one that simply exceeds the provider's size limits because nothing resized it) does not just fail one turn — **every subsequent inference in that session fails** with errors like:

- anthropic: `400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}`
- openai-codex: `{"type":"invalid_request_error","code":"invalid_value","message":"The image data you provided does not represent a valid image."}`

(both observed live, 2026-06-12). Recovery requires history surgery: locating the offending entry via `get_entries` and using `navigate_tree` to move the leaf before it. Worse, the failure is silent at send time — the `prompt` RPC succeeds, the turn errors later, and nothing tells the client which image was bad or that the session is now wedged.

This was discovered building pi-ctl (an external RPC client), but it affects every RPC client: any program attaching images over RPC must currently reimplement pi's mime sniffing, decode validation, and resize pipeline itself to be safe — duplicating `IMAGE_MIME_TYPES`-style tables and resize limits that pi already owns.

## The fix

Run RPC-supplied images through the same pipeline CLI file arguments use, *before* the message reaches the session. The guiding principle (this supersedes an earlier draft that rejected the command on a bad image): **RPC behaves like `processFileArguments`, the only other path that attaches an `ImageContent` to a user message.** (Interactive paste is *not* a peer: it writes the clipboard image to a temp file and inserts the *path* as text, so the image only enters the conversation later via the `read` tool — it never attaches an image to the user message directly.) `processFileArguments` never rejects input — a bad image becomes a text note embedded in the user message, and an unvalidated image never reaches the session. RPC now does the same: the command succeeds, the bad image is dropped, and a note appears in the persisted user message where the client (and the model) can see it.

The sniff + resize + attach + note-generation logic is factored into one shared function, `prepareImageAttachment(bytes, { autoResize, label?, mimeType? })` in `src/utils/image-attachment.ts`, used by all three `ImageContent`-producing paths — `processFileArguments`, `processRpcImages`, and the `read` tool — so the rules and their user-facing message text live in exactly one place. It returns a discriminated result, each variant carrying the human-readable `note` text:

- `{ status: "ok"; image; mimeType; note? }` — `note` is the dimension note, present only when the image was downscaled.
- `{ status: "tooLarge"; mimeType; note }` — `note` is the omitted-because-unshrinkable message.
- `{ status: "unsupported"; note }` — `note` is the not-a-supported-format message.

The `label` option (default `"Image"`) drives every message string — RPC passes `"Image N"` so notes read `[Image 2 omitted: …]`, file args and `read` use the default. Each caller maps the statuses to its own surface: file args wrap `note` in `<file>` tags (and treat `unsupported` as "read this as a text file"); `read` prefixes `Read image file [mimeType]` and appends `note`; RPC appends `note` to the message with the image index. Steps per image:

1. **Sniff the real mime type from the decoded bytes** with `detectSupportedImageMimeType` (`src/utils/mime.ts`). The client/extension-supplied `mimeType` is advisory — the sniffed type wins, which also frees clients from guessing mime types from file extensions. If the sniff returns `null` → `unsupported`; RPC drops the image and appends the note. (Invalid base64 needs no separate check: `Buffer.from(data, "base64")` yields garbage bytes that fail the sniff.) The `read` tool is the exception: it classifies image-vs-text through its **pluggable, path-based** `ReadOperations.detectImageMimeType` (a published extension point for remote/SSH backends), so it passes the already-known type via the `mimeType` option to skip the byte sniff and preserve that contract.
2. **Resizing honors the user's auto-resize setting** (`settingsManager.getImageAutoResize()`, on by default), exactly as file args and `read` do — passed into `processRpcImages` from each handler case. When **on**, `resizeImage` runs; it returns `null` both for images that cannot be brought under the inline size limit and for sniff-passing bytes Photon cannot decode (it catches decode failures) → `tooLarge`. When the image is scaled down, the dimension note is included so coordinate references stay meaningful. When auto-resize is **off**, the original bytes are attached verbatim with the sniffed mime type (matching file args) — no resize, no note.
3. Processing happens **before** the message is queued/persisted — the invariant is *a session never contains an image that did not pass the pipeline*. For `prompt` it runs before `session.prompt` is called (so before `preflightResult` fires); `steer`/`follow_up` are plain awaits. The `RpcCommand` types are unchanged; all substitution is visible in the dialogue history (user messages).

Notes:

- `resizeImage` already runs Photon in a worker thread, so decoding large images won't block the RPC loop; the handler paths are async.
- `detectSupportedImageMimeType` already encodes provider quirks (rejects animated PNG, JPEG variants providers refuse) — that's precisely the knowledge RPC clients should not have to duplicate.
- `blockImages` is *not* a per-path concern: it is enforced centrally at the `convertToLlm` layer (`src/core/sdk.ts`), so every ingestion path is covered regardless.
- Tests: `test/rpc-image-validation.test.ts` covers pass-through with mime override, unsupported bytes, a corrupt-body PNG (valid signature + IHDR, undecodable body — signature checks alone don't catch it), empty message, oversize-resize with indexed dimension note, mixed good/bad images, and the auto-resize-off path (original bytes attached, unsupported still rejected). `test/image-resize-callers.test.ts`, `test/block-images.test.ts`, and `test/tools.test.ts` continue to cover `processFileArguments` and the `read` tool.

## Issue / PR framing

- **Issue title**: RPC-supplied images bypass validation and resizing; one bad image permanently poisons the session
- **Motivation**: "The problem" section above.
- **PR summary**: RPC `prompt`/`steer`/`follow_up` images now go through the same sniff + resize pipeline as CLI file arguments — factored into a shared `prepareImageAttachment` helper that also owns the `read` tool and all user-facing note text. Invalid or unshrinkable images are dropped and replaced by a visible note in the user message instead of poisoning the session; resizing honors the user's auto-resize setting; the sniffed mime type overrides the client-supplied one.
