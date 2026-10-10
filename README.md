# QR Doodle

A single-page web app for designing QR codes with logos and drawings, **without guessing whether they still scan**.

**Use it here: https://mmmlinux.github.io/QR-Doodle/** · Source: https://github.com/mmmlinux/QR-Doodle

Paint modules dark or light, drop in a logo, and QR Doodle shows exactly how much of the
Reed-Solomon error-correction budget you've used, **per block**, the way a real decoder sees it.

## Features

- **Required modules highlighted**: finder, timing, alignment, format and version patterns are tinted and locked by default.
- **Real error budget**: a painted module only costs something if it differs from what the encoder wanted. Damage is counted per codeword and per RS block, against each block's true correction capacity (including the reserved misdecode-protection codewords in versions 1–3).
- **All densities**: versions 1–40, error correction L/M/Q/H, and numeric/alphanumeric/byte encoding.
- **Mask search**: picks the mask that suits your drawing best, or lets you choose one by hand.
- **Spare-capacity solver**: padding codewords after your message are re-solved (a GF(2) linear solve, like QArt codes) so painted areas become "naturally" correct. A larger version means more room for a logo.
- **Logo tools**: trace an image into modules (threshold, invert), or knock out a clear area (rectangle/ellipse with padding). Drag to move, scroll to resize. The logo is positioned relative to the code, so it carries across versions.
- **Compare densities**: a version × error-correction table showing which combination handles your design best.
- **Drawing tools**: brush (square or round, sizes 1–9), rectangle, ellipse, mirror/rotational symmetry, undo/redo.
- **Select, copy, cut, paste**: drag to select and drag inside to move. Pastes float under the cursor, can be rotated (R) or flipped (H/V), and Shift+click stamps repeated copies.
- **Real decoder test**: runs the rendered output through jsQR (bundled) and the browser's native `BarcodeDetector` where available.
- **Styling and export**: square/rounded/dot modules, finder eye styles, colours, quiet zone, PNG and SVG export. Designs save to JSON and autosave in your browser.

## Deploy on GitHub Pages

No build step. All files are static.

1. Create a repository and push these files to it (`index.html` at the root).
2. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, and pick `main` / `(root)`.
3. Your app will be live at `https://<user>.github.io/<repo>/`.

To run it locally, open `index.html` directly or serve the folder (`python3 -m http.server`).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup |
| `style.css` | Styles |
| `qrcore.js` | QR encoder with module→codeword/block mapping, damage analysis, spare-capacity solver |
| `app.js` | Editor UI, logo handling, preview/export |
| `version.js` | App version (`MAJOR.COMMIT.CHANGE`), shown next to the title and in Help |
| `RELEASE_NOTES.md` | What changed in each version, newest first |
| `vendor/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0), loaded on demand for scan tests |

## Notes

- "Scannable" means the code is decodable in theory. Real-world printing, blur and glare add errors, so keep the worst block under the safety margin (60% by default) and test with real phones.
- The encoder follows the structure of Project Nayuki's [QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) (MIT). It was verified module-for-module against the `qrcode` npm package across versions 1–40.

## Tests (optional)

`tests/` isn't needed to run the app. It holds the checks used during development:

- `core.test.js` compares the encoder module-for-module against the `qrcode` npm package for versions 1–40, decodes with jsQR, and checks that the error meter's pass/fail threshold matches a real decoder exactly (at capacity it decodes, one more damaged codeword fails).
- `export-diff.test.js` drives the app in headless Chrome and checks that the exported image matches the analyzed matrix module-for-module (including with a logo drawn on top).

```sh
cd tests && npm install
npm run test:core
python3 -m http.server 8765 --directory .. &   # then:
npm run test:export                            # CHROME_PATH / APP_URL env vars override defaults
```

## License

[MIT with the Commons Clause](LICENSE). You're free to use, copy, modify and share QR Doodle, including commercially, and the QR codes you make with it are yours. What you may **not** do is sell the software itself, or a paid product or service whose value comes substantially from it (for example, paid hosting of it). `vendor/jsQR.js` keeps its own Apache-2.0 license.
