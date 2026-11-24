# SnapSelect

Simple, fast photo culling straight from an SD card, in the browser. Pick a folder, mark photos **Keep / Maybe / Reject**, then permanently delete the rejected files from the card. Nothing is uploaded, there's no login and no server.

## Run

```bash
npm install
npm run dev            # http://localhost:3000 (localhost counts as a secure context)
npm run dev:https      # self-signed HTTPS, to test from another machine
npm run build          # static export to ./out, host on any HTTPS static host
npm test               # unit tests (pairing, undo, deletion safety, session restore)
npm run e2e            # real-Chromium end-to-end test (OPFS stands in for the SD card)
```

Requires **Chrome or Edge on desktop** (Windows/macOS/Linux) over **HTTPS** or `localhost`.

## Usage

1. Insert the SD card and click **Select Folder**. Choose the folder that holds the images, usually `DCIM\100XXXXX`. Subfolders are not read.
2. Cull with the keyboard: `1` Keep · `2` Maybe · `X` Reject · `←/→` (and `↑/↓` in the grid) to move · `Space` preview · `Esc` close · `Ctrl+Z` undo.
   In the preview: mouse wheel or `+`/`-` to zoom toward the cursor, drag to pan, `Z` or double-click for 100% (actual pixels), `0` to fit.
3. Click **Finish →** to see the summary and the list of files to be deleted. Then **Finish & Delete Rejected**, tick the checkbox, and allow write access when the browser asks.

Unrated photos are never deleted.

## Architecture

```
src/lib/types.ts     data model (PhotoFile, PhotoGroup, CullStatus)
src/lib/files.ts     top-level folder scan, extension filter, RAW+JPEG grouping
src/lib/cull.ts      pure status reducer with an undo stack
src/lib/thumbs.ts    thumbnail queue (4 at a time, LIFO, cancellable), LRU of object URLs with revoke, RAW embedded-JPEG extraction
src/lib/db.ts        IndexedDB sessions (metadata only, no file handles)
src/lib/deletion.ts  delete plan and safe execution
src/components/      Home, Workspace, VirtualGrid, Thumb, Preview, Summary
```

- **Pairing:** files that share a base name, case-insensitive (`IMG_1001.CR3` + `IMG_1001.JPG`), form one *group*. Status is stored per group, so a pair always changes together and is deleted together. The JPEG is used as the preview. A RAW-only shot uses the JPEG preview embedded in the RAW file.
- **Performance:** a windowed grid mounts only the visible rows. Thumbnails are decoded with `createImageBitmap` at 320 px. Only one full-size image (the preview) is held at a time, and its URL is revoked when you move on or close it.
- **Session:** saved to IndexedDB every time a status changes (folder name, file names, sizes, lastModified, status, timestamps). No handles are stored. To resume, pick the same folder again; that click is the new permission grant. A status is restored only if every file in the group still matches name, size and lastModified.

## Deletion safety (`src/lib/deletion.ts`)

1. The plan contains only files from groups whose status is exactly `REJECT`. The check runs again right before deleting.
2. Names must be plain top-level names. Each file is re-resolved with `dir.getFileHandle(name)`, so nothing outside the picked folder can be reached.
3. The fresh handle must pass `isSameEntry()` against the handle from the scan, and size and lastModified must be unchanged.
4. Write permission is requested, then the folder is listed to make sure the card is still connected. If either step fails, nothing is deleted.
5. Each file is deleted with `FileSystemFileHandle.remove()`, or `removeEntry()` as a fallback. It counts as deleted only after a follow-up lookup returns `NotFoundError`.
6. Deletion stops at the first error. The report lists deleted, failed (with reason) and not-attempted files.

## Browser API limitations (investigated)

- **Chromium only.** `showDirectoryPicker` exists only in Chrome and Edge on desktop; Firefox, Safari and mobile browsers don't have it. A secure context (HTTPS or localhost) is required.
- **Deleting on an SD card works.** A removable drive is an ordinary folder to the OS. Deletion is **permanent**: it skips the Recycle Bin, and the browser offers no API that moves files to the trash.
- `FileSystemFileHandle.remove()` is Chromium-only (Chrome 110+). The code falls back to `FileSystemDirectoryHandle.removeEntry()`.
- Chrome blocks picking certain locations: drive roots such as `E:\` can be refused for write access. Pick the `DCIM\…` folder, which is also the right place anyway.
- Permissions don't persist reliably between visits, so each session asks again. The app doesn't depend on stored handles.
- A card with the physical **lock switch** on fails with `NoModificationAllowedError`. The app reports this clearly and deletes nothing more.
- RAW decoding: browsers can't decode RAW, so the embedded JPEG preview is extracted. Files without a usable one show "No preview".
- If the card is removed mid-session, reads fail with `NotFoundError`. Previews show an error, and deletion aborts at the connection check or at the first failed file.
