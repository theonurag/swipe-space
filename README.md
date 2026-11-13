# Swipe Space

An infinite canvas for drawing and for placing images, files, text, and links. The board stays in this browser.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints, usually http://127.0.0.1:5173.

## Use the canvas

- Drag on empty space to draw.
- Scroll to pan. Hold Space and drag, or drag with the middle mouse button, to pan.
- Pinch, or hold Ctrl (Command on macOS) and scroll, to zoom. The buttons at the bottom zoom too.
- Paste, or drop, an image, a file, text, or a link to place it on the canvas.
- Every item has a title and a description. Edit them on the card.
- Drag a card to move it. Click a stroke or an item and press Delete to remove it, or use the × on a card.

Drawings and items are saved in `localStorage`. Refresh the page and they are still there.

## Check

```bash
npm test
npm run build
```
