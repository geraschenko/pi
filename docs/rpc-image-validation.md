# RPC image preprocessing

The fork's `processRpcImages` wrapper in `packages/coding-agent/src/modes/rpc/rpc-command-handler.ts` sends images from `prompt`, `steer`, and `follow_up` through upstream's shared `processImage` helper. The helper's conversion and resizing behavior is preserved; RPC does not implement independent image validation.

## Purpose

Invalid or oversized images can cause provider requests to fail repeatedly because session history includes them on later turns. Preprocessing applies the shared conversion and optional resizing before images are queued or persisted, and makes processing failures visible in the user message.

## Behavior

1. Decode the supplied base64 with `Buffer.from(data, "base64")`.
2. Call `processImage(bytes, mimeType, { autoResizeImages })` using the session's auto-resize setting.
3. Attach successful images. Rewrite conversion and dimension hints from `Image` to `Image N` and append them to the message.
4. Drop images when the helper reports failure and append an indexed omission note. A preprocessing failure does not reject the RPC command.

The upstream helper trusts supported MIME types (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) after normalization, including the `image/jpg` alias. It does not sniff the bytes to correct a supported but incorrect client-supplied MIME type. Other MIME types trigger attempted conversion to PNG.

With auto-resize enabled, undecodable images and images that cannot be reduced below the inline size limit produce a resize-failure note. Images that are resized also receive a dimension hint for coordinate mapping.

With auto-resize disabled, bytes labeled with a supported MIME type pass through without decoding or validation. Conversion is still attempted for other MIME types. Clients remain responsible for supplying valid image bytes and the correct MIME type; preprocessing is not a guarantee that a provider will accept the image.

CLI file arguments and the `read` tool classify file types before calling the shared helper. RPC instead supplies the client's MIME type, so sharing the helper does not imply identical MIME detection across these entry points.

## Tests

`packages/coding-agent/test/rpc-image-validation.test.ts` covers supported MIME preservation, empty image lists, resize failures, indexed omission and dimension notes, mixed successful/failed images, and pass-through with auto-resize disabled.
