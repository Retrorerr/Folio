# Folio Linux 0.1.13 release recovery

This record preserves the provenance of the Fedora/GNOME/Wayland Linux release artifacts produced on 2026-08-10.

## Release artifacts

- `Folio_0.1.13_amd64.AppImage`
  - SHA-256: `001e5247aa4e314189dba7e61ee463d483a104ff3a1477669c087c7d20fc3580`
  - Size: 169,904,632 bytes
- `Folio-0.1.13-1.x86_64.rpm`
  - SHA-256: `77ba1841a2e9212529078d53cafa011c1305a8d28b165f23101a88aa3230a8c2`
  - Size: 103,687,621 bytes

The exact machine-readable manifest is stored at `dist/linux/release/linux-build-manifest.json`.

## Build provenance

- Intended source commit: `fe82e3771a4e9f84517986e2a48ff5494c885c7d`
- Release version: `0.1.13`
- Build tree was reported clean.
- The artifacts passed the recorded frontend, backend, Rust, package-structure, MIME/desktop-entry, RPM payload/digest, AppImage, and authenticated sidecar smoke checks.

## Recovery status

The original local Linux release branch was not pushed before its temporary workspace disappeared, and GitHub does not contain the intended source commit. This recovery commit preserves the exact artifact manifest and provenance without pretending to recreate the missing Linux source diff. The current `main` branch remains unchanged.
