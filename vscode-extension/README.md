# Kotlin Continuous IntelliSense

Companion Cursor/VS Code extension for the Kotlin LSP continuous-completion
patch.

It triggers the native suggestion widget while a Kotlin identifier is still
being typed. The default three-character threshold uses a 10 ms leading-edge
interval, not an idle debounce. It also performs one background completion
request after a Kotlin editor becomes active to warm the official completion
engine.

The extension contains no Spring-specific symbol list. All candidates and
imports come from the installed Kotlin language server.

Requires `jetbrains.kotlin-server`.
