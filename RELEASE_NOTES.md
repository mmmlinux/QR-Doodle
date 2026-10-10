# Release notes

Versions use `MAJOR.COMMIT.CHANGE`. The current version is in `version.js` and shown next to the title in the app.

## 1.0.5 — 2026-10-09
- **Design focus** now only hides the ordinary QR data. The other overlays (required, painted, costs budget, damaged codewords, free modules, RS block colours, codeword outlines) keep working while it's on.

## 1.0.4 — 2026-10-09
- **Select, copy, cut, paste**: a Select tool (S). Drag to select, drag inside the selection to move it, and use Copy/Cut/Paste/Clear in the toolbar or the usual keyboard shortcuts.
- Pastes float under the cursor until you click. R rotates, H/V flip, and Shift+click stamps repeated copies.

## 1.0.3 — 2026-10-09
- Moved the **Masks** panel to the left column, above Logo.

## 1.0.2 — 2026-10-09
- Added **Design focus** (F). It hides the ordinary QR data (faint or fully hidden) and shows required and painted modules in solid black and white so the logo stands out.

## 1.0.1 — 2026-10-09
Initial app:

- **QR codes**: versions 1–40 at error correction L/M/Q/H, with auto, numeric, alphanumeric or byte encoding.
- **Required modules**: finder, timing, alignment, format and version modules are highlighted and locked.
- **Error budget**: damage is checked per Reed-Solomon block and matches real decoders. The status shows scannable, risky or will not scan.
- **Masks**: picks the best mask for your drawing, uses the standard choice, or lets you set it by hand.
- **Spare capacity**: padding codewords are solved to match your drawing.
- **Logo tools**: trace an image into modules, or knock out an area for it. Drag to move and scroll to resize. If the logo is drawn onto the exported code, the error check accounts for what it covers.
- **Compare densities**: a table of versions × error-correction levels for your design.
- **Drawing tools**: brush, rectangle and ellipse; mirror and rotational symmetry; undo/redo.
- **Preview and export**: module and finder styles, colours, quiet zone, PNG/SVG download, and a live scan test with jsQR and the browser's barcode detector.
- **Designs**: save and load as JSON, plus autosave.
- **Version number**: shown next to the title and in the Help dialog. Saved designs record which version saved them.
- **Release notes**: this file.
- **License**: MIT with the Commons Clause. Commercial use is allowed and QR codes you make are yours, but the software itself can't be sold.
