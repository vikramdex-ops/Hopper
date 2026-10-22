# Shipping checklist

Use this before every release. CI mirrors most of it, but the local checks catch
platform problems earlier.

## 1. Version bump

1. Update `version` in `package.json`.
2. Move the `CHANGELOG.md` "Unreleased" notes under the new version with today's date.
3. Commit as `release: vX.Y.Z` and tag:

   ```bash
   git tag -a v1.1.0 -m "Xplorer² Modern 1.1.0"
   git push origin main --tags
   ```

The `v*` tag triggers `.github/workflows/build.yml`, which builds every platform and
attaches the artifacts to a GitHub Release.

## 2. Static checks

```bash
npm ci
npm run check          # syntax (ESM + CJS), icon names, no emoji, asset refs
npm run smoke          # boots the real app over CDP; fails on console errors
```

`npm run smoke` writes `screenshots/smoke-*.png`. Inspect at least:

- `smoke-boot_*` — both panes populated, drive chips rendered
- `smoke-preview_*` — preview pane and metadata card
- `smoke-command_palette_*` — grouped palette rows
- `smoke-right_click_*` — grouped context menu with hints/keys
- `smoke-icons_*` — ribbon/chrome icons

## 3. Icon and assets

```bash
npm run icons
```

Commit the regenerated `assets/icon.png`, `build/icon.png`, `build/icon.ico` if the
mark changed. The icon generator has no dependencies and is deterministic.

## 4. Local packaging

```bash
npm run pack           # unpacked app in release/<platform>-unpacked, quick launch test
npm run dist:win       # NSIS installer + portable zip
npm run dist:mac       # dmg + zip (x64 + arm64)
npm run dist:linux     # AppImage + deb
```

Smoke-test the **installed** app, not only the dev run:

- installer creates Start-menu and desktop shortcuts and respects a custom path
- app launches from a clean profile (`%APPDATA%\xplorer2-modern` removed)
- panes restore the last folders and Back/Forward still work after a restart
- preview pane renders an image and a PDF
- “Archive selection…” produces a ZIP that opens in Explorer/Finder
- drag & drop between panes copies; with Shift it moves
- portable `x2m-portable.flag` keeps settings next to the executable

## 5. Signing (optional but recommended)

Unsigned builds show SmartScreen/Gatekeeper warnings.

- **Windows**: set `CSC_LINK` (base64 or path to `.pfx`) and `CSC_KEY_PASSWORD`.
  electron-builder signs the installer and the app automatically.
- **macOS**: set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
  and `APPLE_TEAM_ID` for notarisation. Without them the workflow sets
  `CSC_IDENTITY_AUTO_DISCOVERY=false` and produces unsigned artifacts.
- Keep secrets in GitHub → Settings → Secrets, never in the repo.

## 6. Release notes

- Title: `Xplorer² Modern vX.Y.Z`
- Include the changelog section and the three artifact families.
- Note any platform prerequisites (e.g. Linux `libfuse2` for AppImage).
- Verify the release page downloads and that checksums match (`sha256sum release/*`).

## 7. Post-release

- [ ] Install from the published artifacts on a clean machine/VM
- [ ] Open a folder with >10,000 entries and confirm scrolling stays smooth
- [ ] Confirm `Help → Keyboard shortcuts` matches the bindings in `app.js`
- [ ] Close the milestone / open issues for follow-ups

## Known limitations

- Windows-only features: NTFS junctions, file attributes (`attrib`), recycled-bin
  integration. They degrade to no-ops on other platforms.
- Archive listing/extraction uses 7-Zip/Tar binaries when present; creation uses the
  built-in ZIP writer only.
- macOS/Linux builds are not notarised/signed by default.
- Cloud status columns appear only when a provider exposes them to Windows.
