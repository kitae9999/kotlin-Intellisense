'use strict';

const vscode = require('vscode');

const KOTLIN_EXTENSION_ID = 'jetbrains.kotlin-server';
const CONFIG_SECTION = 'kotlinContinuousIntelliSense';
const OUTPUT_CHANNEL = 'Kotlin Continuous IntelliSense';

let output;
let scheduledTimer;
let queuedTrigger;
let lastTriggeredAt = 0;
let warmupTimer;
let warmupInFlight;
let workspaceWarmed = false;

function configuration() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get('enabled', true),
    minimumPrefixLength: config.get('minimumPrefixLength', 3),
    triggerIntervalMs: config.get('triggerIntervalMs', 10),
    warmupEnabled: config.get('warmupEnabled', true),
    warmupDelayMs: config.get('warmupDelayMs', 100),
    debugLog: config.get('debugLog', false),
  };
}

function log(message) {
  output.appendLine(`${new Date().toISOString()} ${message}`);
}

function identifierPrefixAt(document, position) {
  const textBeforeCursor = document.lineAt(position.line).text.slice(0, position.character);
  return /[A-Za-z_][A-Za-z0-9_]*$/.exec(textBeforeCursor)?.[0] ?? '';
}

function activeKotlinEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'kotlin') return undefined;
  if (editor.document.uri.scheme !== 'file') return undefined;
  return editor;
}

function warmupPosition(editor) {
  const active = editor.selection.active;
  if (!active.isEqual(new vscode.Position(0, 0))) return active;

  const lineLimit = Math.min(editor.document.lineCount, 200);
  for (let line = 0; line < lineLimit; line += 1) {
    const text = editor.document.lineAt(line).text;
    if (/^\s*(?:fun|class|interface|object|val|var)\b/.test(text)) {
      return new vscode.Position(line, text.length);
    }
  }
  return active;
}

async function activateKotlinExtension() {
  const extension = vscode.extensions.getExtension(KOTLIN_EXTENSION_ID);
  if (!extension) throw new Error(`Required extension '${KOTLIN_EXTENSION_ID}' is not installed`);
  if (!extension.isActive) await extension.activate();
}

async function executeWarmup(editor, force = false) {
  if (!force && workspaceWarmed) return undefined;
  if (warmupInFlight) return warmupInFlight;

  warmupInFlight = (async () => {
    await activateKotlinExtension();
    const position = warmupPosition(editor);
    const startedAt = performance.now();
    log(
      `warmup start ${vscode.workspace.asRelativePath(editor.document.uri)}:` +
        `${position.line + 1}:${position.character + 1}`,
    );
    const result = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      editor.document.uri,
      position,
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    const itemCount = result?.items?.length ?? 0;
    workspaceWarmed = true;
    log(`warmup finished in ${elapsedMs} ms (${itemCount} items)`);
    return { elapsedMs, itemCount };
  })()
    .catch((error) => {
      log(`warmup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return undefined;
    })
    .finally(() => {
      warmupInFlight = undefined;
    });

  return warmupInFlight;
}

function scheduleWarmup() {
  const config = configuration();
  if (!config.warmupEnabled || workspaceWarmed || warmupInFlight || warmupTimer) return;
  const editor = activeKotlinEditor();
  if (!editor) return;

  warmupTimer = setTimeout(() => {
    warmupTimer = undefined;
    void executeWarmup(editor);
  }, config.warmupDelayMs);
}

function triggerFromChange(event) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== event.document) return undefined;
  if (event.document.languageId !== 'kotlin' || event.document.uri.scheme !== 'file') {
    return undefined;
  }
  if (event.contentChanges.length !== 1) return undefined;

  const change = event.contentChanges[0];
  // VS Code-compatible hosts are allowed to omit the deprecated rangeLength
  // property. An omitted value still represents an insertion when range is
  // empty, so only reject an explicitly non-zero replacement length.
  if ((change.rangeLength ?? 0) !== 0 || !/^[A-Za-z0-9_]$/.test(change.text)) {
    return undefined;
  }

  const position = new vscode.Position(
    change.range.start.line,
    change.range.start.character + change.text.length,
  );
  const prefix = identifierPrefixAt(event.document, position);
  if (prefix.length < configuration().minimumPrefixLength) return undefined;

  return {
    documentUri: event.document.uri.toString(),
    documentVersion: event.document.version,
    position,
    prefix,
  };
}

function isStillCurrent(trigger) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== trigger.documentUri) return false;
  if (editor.document.languageId !== 'kotlin') return false;
  if (!editor.selection.active.isEqual(trigger.position)) return false;

  const prefix = identifierPrefixAt(editor.document, trigger.position);
  return prefix.length >= configuration().minimumPrefixLength;
}

function runQueuedTrigger() {
  scheduledTimer = undefined;
  const trigger = queuedTrigger;
  queuedTrigger = undefined;
  if (!trigger) return;
  if (!isStillCurrent(trigger)) {
    if (configuration().debugLog) {
      const editor = vscode.window.activeTextEditor;
      const selection = editor
        ? `${editor.selection.active.line + 1}:${editor.selection.active.character + 1}`
        : 'none';
      log(
        `drop ${trigger.prefix}: caret=${selection}, expected=` +
          `${trigger.position.line + 1}:${trigger.position.character + 1}`,
      );
    }
    return;
  }

  const config = configuration();
  if (!config.enabled) return;

  lastTriggeredAt = performance.now();
  if (config.debugLog) {
    log(
      `trigger ${trigger.prefix} at ${trigger.position.line + 1}:${trigger.position.character + 1} ` +
        `(document v${trigger.documentVersion})`,
    );
  }
  void vscode.commands.executeCommand('editor.action.triggerSuggest').catch((error) => {
    log(`trigger failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
}

function scheduleTrigger(trigger) {
  queuedTrigger = trigger;
  if (scheduledTimer) return;

  const interval = configuration().triggerIntervalMs;
  const elapsed = performance.now() - lastTriggeredAt;
  // Give the editor one event-loop turn to publish the matching caret move.
  // This is a fixed leading-edge delay, not an idle debounce: later keystrokes
  // do not reset the timer.
  const delay = Math.max(8, interval - elapsed);
  scheduledTimer = setTimeout(runQueuedTrigger, delay);
}

function activate(context) {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true });
  context.subscriptions.push(
    output,
    vscode.window.onDidChangeActiveTextEditor(() => scheduleWarmup()),
    vscode.workspace.onDidOpenTextDocument(() => scheduleWarmup()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const config = configuration();
      if (!config.enabled) return;
      if (config.debugLog) {
        const change = event.contentChanges[0];
        const editor = vscode.window.activeTextEditor;
        const selection = editor
          ? `${editor.selection.active.line + 1}:${editor.selection.active.character + 1}`
          : 'none';
        log(
          `change language=${event.document.languageId} scheme=${event.document.uri.scheme} ` +
            `active=${editor?.document === event.document} count=${event.contentChanges.length} ` +
            `text=${JSON.stringify(change?.text)} rangeLength=${String(change?.rangeLength)} ` +
            `caret=${selection}`,
        );
      }
      const trigger = triggerFromChange(event);
      if (trigger) {
        if (config.debugLog) log(`queue ${trigger.prefix}`);
        scheduleTrigger(trigger);
      } else if (config.debugLog) {
        log('ignored change');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) return;
      if (!configuration().enabled && scheduledTimer) {
        clearTimeout(scheduledTimer);
        scheduledTimer = undefined;
        queuedTrigger = undefined;
      }
      if (!configuration().warmupEnabled && warmupTimer) {
        clearTimeout(warmupTimer);
        warmupTimer = undefined;
      } else {
        scheduleWarmup();
      }
    }),
    vscode.commands.registerCommand('kotlinContinuousIntelliSense.warmupNow', async () => {
      const editor = activeKotlinEditor();
      if (!editor) {
        await vscode.window.showWarningMessage('Open a Kotlin file before warming IntelliSense.');
        return;
      }
      const result = await executeWarmup(editor, true);
      if (result) {
        await vscode.window.showInformationMessage(
          `Kotlin IntelliSense warmup: ${result.elapsedMs} ms, ${result.itemCount} items`,
        );
      }
    }),
    vscode.commands.registerCommand('kotlinContinuousIntelliSense.showLog', () => {
      output.show(true);
    }),
  );
  log('Extension activated');
  scheduleWarmup();
}

function deactivate() {
  if (scheduledTimer) clearTimeout(scheduledTimer);
  if (warmupTimer) clearTimeout(warmupTimer);
}

module.exports = {
  activate,
  deactivate,
  identifierPrefixAt,
};
