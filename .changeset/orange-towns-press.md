---
'gitignore-reader-x': patch
---

`isIgnored` and `check` now treat a `file:` URL ending with `/` as a directory, like a path ending with a separator
