# Shipping checklist

1. **Version**: bump `version` in `package.json`, add the section to `CHANGELOG.md` (the release
   workflow uses it as the release notes).
2. **Checks**: `npm ci`, `npm run build`, `npm test`, `npm run e2e` (and `node tests/e2e/lan.mjs`
   for sharing). Inspect the screenshots the suites write.
3. **Screenshots** (if the UI changed): `npm run shots`, copy the PNGs from the output folder to
   `docs/screenshots/` and `site/assets/shots/`.
4. **Tag**: commit as `release: vX.Y.Z`, then `git tag vX.Y.Z && git push origin main --tags`.
   `.github/workflows/release.yml` builds the NSIS installer and portable zip on Windows and
   uploads them with `latest.yml` (auto-update) and `SHA256SUMS.txt`.
5. **Smoke the installed build** on a clean PC: install, open a network folder, copy a folder,
   zip, share to a colleague, check the update channel.

Signing: set `CSC_LINK` / `CSC_KEY_PASSWORD` secrets to sign the installer; unsigned builds show
a SmartScreen prompt.

Local builds on a network drive: keep `TEMP`, npm, Electron and electron-builder caches off C:
(see the commands in this repo's history), and run test instances with `--no-sandbox` — the
Chromium sandbox can't start child processes from an executable on a network share.
