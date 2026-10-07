# Machdoch logo variants

Open [Preview.html](Preview.html) directly in a browser. Choose an icon and text, switch theme or layout, and download the combined SVG.

- 12 icon concepts, 12 outlined wordmarks, and 12 example pairings.
- Each asset has black, white, accent, and `currentColor` versions.
- Transparent SVGs; wordmarks contain paths rather than font-dependent text.
- [Overview.svg](Overview.svg) and `Overview.png` show the complete set.
- [Research.md](Research.md) records the sources and design reasoning.

The example pairings are starting points. Every icon can be combined with every wordmark in the preview. The opening combination is Action M + Grotesk; it is not a final selection.

The existing app branding has not been replaced. Animation is deferred until an icon and wordmark are selected.

## Rebuild

```powershell
python -m pip install -r Source/requirements.txt
python Source/build.py
```

Source artwork and typography settings are in `Source/icons.json` and `Source/wordmarks.json`. Included font files, provenance, checksums, and SIL Open Font Licenses are in `Source/Fonts/`.

To regenerate the PNG overview from the SVG using the repository's existing Sharp dependency:

```powershell
node --input-type=module -e "import sharp from 'sharp'; await sharp('assets/branding/logo-variants/Overview.svg').png().toFile('assets/branding/logo-variants/Overview.png')"
```

The delivered copy is in `C:\Users\ehrha\Downloads\Machdoch Logo Variants`. Its `Reference/PurePortal Logo Variants` folder is a complete, unchanged copy of the supplied reference set, including its existing animation examples. The new Machdoch set contains static artwork only.
