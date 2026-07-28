# Kotlin Continuous IntelliSense

Unofficial continuous Kotlin completion for Cursor and VS Code, built on top of
the official **Kotlin by JetBrains** extension.

The project fixes the case where completion work is repeatedly cancelled while
the user is still typing. It also adds a fast indexed path for annotation
classes, including automatic imports from the Gradle-imported project classpath.

> [!IMPORTANT]
> This is a version-locked experimental patch. The first release supports only
> `jetbrains.kotlin-server@0.0.6` with `LS-262.9593.0`.

## Architecture

The project has two parts:

1. `vscode-extension/` triggers the native suggestion widget from a
   three-character Kotlin identifier using a 10 ms leading-edge interval. It
   does not wait for typing to become idle.
2. `server-patch/` changes the official language server completion helper:
   - in-flight semantic completion survives cancellation and can be reused by
     a longer prefix;
   - `@` followed by at least three characters uses the IntelliJ project class
     index to return annotation classes and LSP import edits directly.

There are no hard-coded Spring symbols. `RestController`, `RequestMapping`,
`GetMapping`, `Service`, and other annotations are discovered from the indexed
project and library classes.

## What is not included

This repository does **not** include the official JetBrains VSIX, a complete
language-server JAR, JetBrains Runtime, or proprietary JetBrains components.
Install the official `jetbrains.kotlin-server` extension first.

## Build the patch payload

Requirements:

- the official Kotlin extension `0.0.6`;
- JDK 24 or a compatible Gradle toolchain;
- network access for the first Gradle dependency resolution.

Locate the extension's `server` directory and run:

```bash
cd server-patch
./gradlew \
  -PkotlinLspServerHome="$HOME/.cursor/extensions/jetbrains.kotlin-server-0.0.6/server" \
  clean jar
```

The payload is created at:

```text
server-patch/build/libs/language-server-completion-patch.jar
```

You can also set `KOTLIN_LSP_SERVER_HOME` instead of the Gradle property.

## Install locally

The current installer uses zsh and supports standard Cursor and VS Code
extension directories on macOS. It verifies the exact upstream hash, creates a
backup, and refuses unknown versions.

```bash
./scripts/install-kotlin-lsp-completion-patch.sh
```

If both Cursor and VS Code installations are present, select one explicitly:

```bash
KOTLIN_LSP_EXTENSION_ROOT="$HOME/.cursor/extensions" \
  ./scripts/install-kotlin-lsp-completion-patch.sh
```

Build and install the companion extension:

```bash
cd vscode-extension
npx --yes @vscode/vsce package --allow-missing-repository \
  --out ../dist/kotlin-continuous-intellisense-0.5.0.vsix
cursor --install-extension ../dist/kotlin-continuous-intellisense-0.5.0.vsix --force
```

Reload the editor or run `Kotlin: Restart LSP server`.

## Restore the official server

```bash
./scripts/restore-kotlin-lsp-completion-patch.sh
```

The restore command verifies both the backup and the currently installed patch
before replacing anything.

## Verification

The LSP harness sends a new completion request every 30 ms and cancels the
previous request, matching the behavior that exposed the original problem.

```bash
KOTLIN_LSP_SERVER=/absolute/path/to/server/bin/intellij-server \
  node tests/benchmark-kotlin-lsp.mjs \
  --annotation \
  --rapid-prefix=RestCont \
  --keystroke-ms=30
```

The assertion requires a `RestController` completion item and
`import smoke.RestController` without writing to the fixture source file.

General semantic completion can be checked with:

```bash
KOTLIN_LSP_SERVER=/absolute/path/to/server/bin/intellij-server \
  node tests/benchmark-kotlin-lsp.mjs \
  --warmup \
  --rapid-prefix=BigDec \
  --keystroke-ms=30
```

This verifies completion item resolution, the official
`jetbrains.kotlin.completion.apply` command, and the `java.math.BigDecimal`
import edit.

## Known limitations

- The annotation fast path currently searches the whole indexed project scope.
  A future release should use the current file's resolve scope so that
  dependencies from unrelated modules or test-only source sets cannot leak into
  main-source suggestions.
- The binary patch is tied to an exact language-server build and may be
  overwritten by an official extension update.
- The repository currently provides a macOS/zsh installer. The Kotlin and
  JavaScript sources are platform-independent, but Windows and Linux installers
  still need to be added.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The modified Kotlin source retains the upstream JetBrains copyright header and
is distributed under the same Apache-2.0 terms. This project is unofficial and
is not affiliated with JetBrains.
