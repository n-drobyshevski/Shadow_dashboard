# node-domexception stand-in (vendored)

`node-domexception@1.0.0` is deprecated ("Use your platform's native DOMException instead"); npm prints
a warning for it on every install. It reaches the project through the deploy toolchain only
(`@google/clasp` → `google-auth-library` → `gaxios` → `node-fetch` → `fetch-blob`), and all it did was
return `globalThis.DOMException`, polyfilled on Node < 17. The project needs Node ≥ 20, where that
global always exists, so this stand-in exports it directly.

The root `package.json` installs it in place of `node-domexception` (`"node-domexception":
"file:vendor/node-domexception"` + `"overrides": {"node-domexception": "$node-domexception"}`). Remove
this folder, the dev dependency and the override once `fetch-blob` stops depending on
`node-domexception`. See docs/SECURITY.md.
