#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER = process.env.KOTLIN_LSP_SERVER ?? '';
const DEFAULT_WORKSPACE = path.join(SCRIPT_DIRECTORY, 'fixture');
const DEFAULT_FILE = path.join(DEFAULT_WORKSPACE, 'src/main/kotlin/LspBenchmark.kt');

function parseArgs(argv) {
  const options = {
    server: DEFAULT_SERVER,
    workspace: DEFAULT_WORKSPACE,
    file: DEFAULT_FILE,
    runs: 5,
    timeoutMs: 120_000,
    systemPath: path.join(SCRIPT_DIRECTORY, '.benchmark-system'),
    warmup: false,
    rapidPrefix: null,
    keystrokeMs: 30,
    annotation: false,
  };

  for (const arg of argv) {
    const [key, value] = arg.split('=', 2);
    switch (key) {
      case '--server':
        options.server = value;
        break;
      case '--workspace':
        options.workspace = path.resolve(value);
        break;
      case '--file':
        options.file = path.resolve(value);
        break;
      case '--runs':
        options.runs = Number(value);
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(value);
        break;
      case '--system-path':
        options.systemPath = path.resolve(value);
        break;
      case '--warmup':
        options.warmup = true;
        break;
      case '--rapid-prefix':
        options.rapidPrefix = value;
        break;
      case '--keystroke-ms':
        options.keystrokeMs = Number(value);
        break;
      case '--annotation':
        options.annotation = true;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`--runs must be a positive integer, got ${options.runs}`);
  }
  if (!options.server) {
    throw new Error(
      'Set KOTLIN_LSP_SERVER=/path/to/intellij-server or pass --server=/path/to/intellij-server',
    );
  }
  return options;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

class JsonRpcConnection {
  constructor(socket, debug = false) {
    this.socket = socket;
    this.debug = debug;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.applyEdits = [];
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => {
      this.log(`socket error: ${error.stack ?? error}`);
      this.rejectAll(error);
    });
    socket.on('end', () => this.log('socket ended by server'));
    socket.on('close', (hadError) => {
      this.log(`socket closed (hadError=${hadError})`);
      this.rejectAll(new Error('LSP socket closed'));
    });
  }

  log(message) {
    if (this.debug) process.stderr.write(`[rpc] ${message}\n`);
  }

  send(message) {
    this.log(
      `--> ${
        message.method
          ? `${message.id === undefined ? 'notification' : 'request'} ${message.method}${message.id === undefined ? '' : ` #${message.id}`}`
          : `response #${message.id}`
      }`,
    );
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf8');
    this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.socket.write(body);
  }

  request(method, params, timeoutMs = 30_000) {
    return this.requestWithId(method, params, timeoutMs).promise;
  }

  requestWithId(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
    return { id, promise };
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  cancelRequest(id) {
    this.notify('$/cancelRequest', { id });
  }

  waitForNotification(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((item) => item !== waiter);
        reject(new Error(`Notification wait timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.notificationWaiters.push(waiter);
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) throw new Error(`Missing Content-Length header: ${header}`);
      const contentLength = Number(lengthMatch[1]);
      const messageEnd = headerEnd + 4 + contentLength;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString('utf8');
      this.buffer = this.buffer.subarray(messageEnd);
      this.onMessage(JSON.parse(body));
    }
  }

  onMessage(message) {
    this.log(
      `<-- ${
        message.method
          ? `${message.id === undefined ? 'notification' : 'request'} ${message.method}${message.id === undefined ? '' : ` #${message.id}`}`
          : `response #${message.id}${message.error ? ' (error)' : ''}`
      }`,
    );
    if ('method' in message && 'id' in message) {
      void this.onServerRequest(message);
      return;
    }
    if ('method' in message) {
      this.onNotification(message.method, message.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      this.log(`response error: ${JSON.stringify(message.error)}`);
      pending.reject(
        new Error(`${message.error.message} (code ${message.error.code})`, {
          cause: message.error,
        }),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  async onServerRequest(message) {
    let result = null;
    if (message.method === 'workspace/applyEdit') {
      this.applyEdits.push(message.params);
      result = { applied: true };
    } else if (message.method === 'window/showDocument') {
      result = { success: true };
    } else if (message.method === 'workspace/configuration') {
      result = (message.params?.items ?? []).map(() => null);
    } else {
      this.log(`unhandled server request params: ${JSON.stringify(message.params)}`);
    }
    this.send({ jsonrpc: '2.0', id: message.id, result });
  }

  onNotification(method, params) {
    if (method === 'window/logMessage' || method === 'window/showMessage') {
      const level = params?.type ?? '?';
      process.stderr.write(`[server message ${level}] ${params?.message ?? ''}\n`);
    }
    if (method === 'intellij/importLog' || method === 'intellij/ready-for-test') {
      this.log(`${method} params: ${JSON.stringify(params)}`);
    }
    for (const waiter of [...this.notificationWaiters]) {
      if (!waiter.predicate(method, params)) continue;
      clearTimeout(waiter.timer);
      this.notificationWaiters = this.notificationWaiters.filter((item) => item !== waiter);
      waiter.resolve({ method, params });
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters = [];
  }
}

async function startServer(options) {
  await mkdir(options.systemPath, { recursive: true });
  const child = spawn(
    options.server,
    ['--socket', '0', '--system-path', options.systemPath],
    {
      env: {
        ...process.env,
        INTELLIJ_DATA_SHARING: undefined,
        IJ_JAVA_OPTIONS: '-Xmx4g -Xms512m',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.on('exit', (code, signal) => {
    process.stderr.write(`[server] exited: code=${code}, signal=${signal}\n`);
  });
  const lines = readline.createInterface({ input: child.stdout, terminal: false });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server did not announce a port in ${options.timeoutMs} ms`)),
      options.timeoutMs,
    );
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before startup: code=${code}, signal=${signal}`));
    };
    child.once('exit', onExit);
    lines.on('line', (line) => {
      const match = /Server is listening on .*:(\d+)\s*$/.exec(line);
      if (!match) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(Number(match[1]));
    });
  });
  lines.close();
  child.stdout.resume();

  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  return { child, connection: new JsonRpcConnection(socket, true), port };
}

async function initialize(connection, options) {
  const workspaceUri = pathToFileURL(options.workspace).toString();
  const startedAt = performance.now();
  const result = await connection.request(
    'initialize',
    {
      processId: process.pid,
      clientInfo: { name: 'kotlin-lsp-benchmark', version: '0.1.0' },
      locale: 'en',
      rootPath: options.workspace,
      rootUri: workspaceUri,
      initializationOptions: { buildTools: {} },
      capabilities: {
        workspace: {
          applyEdit: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ['create', 'rename', 'delete'],
            failureHandling: 'textOnlyTransactional',
          },
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
          symbol: { dynamicRegistration: true },
          workspaceFolders: true,
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            willSave: true,
            willSaveWaitUntil: true,
            didSave: true,
          },
          completion: {
            dynamicRegistration: true,
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              preselectSupport: true,
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              resolveSupport: {
                properties: [
                  'documentation',
                  'detail',
                  'additionalTextEdits',
                  'textEdit',
                  'command',
                ],
              },
            },
            completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'insertTextMode'] },
          },
          codeAction: {
            dynamicRegistration: true,
            codeActionLiteralSupport: {
              codeActionKind: { valueSet: ['', 'quickfix', 'source', 'source.organizeImports'] },
            },
          },
          hover: { dynamicRegistration: true, contentFormat: ['markdown', 'plaintext'] },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
            codeDescriptionSupport: true,
            dataSupport: true,
          },
        },
        window: {
          workDoneProgress: true,
          showDocument: { support: true },
        },
        general: {
          staleRequestSupport: { cancel: true, retryOnContentModified: [] },
          positionEncodings: ['utf-16'],
        },
      },
      trace: 'off',
      workspaceFolders: [{ uri: workspaceUri, name: path.basename(options.workspace) }],
    },
    options.timeoutMs,
  );
  connection.notify('initialized', {});
  return { result, elapsedMs: performance.now() - startedAt };
}

async function runBenchmark(options) {
  const originalText = await readFile(options.file, 'utf8');
  const fileUri = pathToFileURL(options.file).toString();
  const marker = '__kotlinLspBenchmark';
  const initialPrefix =
    options.rapidPrefix === null ? (options.annotation ? 'RestCont' : 'BigDec') : '';
  const snippet = options.annotation
    ? ['', `@${initialPrefix}`, `private class ${marker}`, ''].join('\n')
    : [
        '',
        `private fun ${marker}() {`,
        '    val warmupType = Str',
        `    val importedType = ${initialPrefix}`,
        '}',
        '',
      ].join('\n');
  const text = `${originalText.replace(/\s*$/, '')}\n${snippet}`;
  const lines = text.split('\n');
  const benchmarkLine = lines.findIndex((line) =>
    options.annotation ? line.startsWith('@') : line.includes('val importedType = '),
  );
  const prefixStartCharacter = options.annotation
    ? lines[benchmarkLine].indexOf('@') + 1
    : lines[benchmarkLine].length - initialPrefix.length;
  const character = prefixStartCharacter + initialPrefix.length;
  const warmupLine = lines.findIndex((line) => line.includes('Str'));
  const warmupCharacter = lines[warmupLine].indexOf('Str') + 'Str'.length;

  const { child, connection, port } = await startServer(options);
  let shutdownComplete = false;
  try {
    const workspaceReady = connection.waitForNotification(
      (method, params) =>
        method === 'intellij/ready-for-test' ||
        (method === 'intellij/importLog' &&
          (params?.succeeded === true || params?.failed === true)),
      options.timeoutMs,
    );
    const initialized = await initialize(connection, options);
    const readyResult = await workspaceReady;
    if (readyResult.params?.failed) {
      throw new Error(`Workspace import failed: ${readyResult.params?.message ?? 'unknown error'}`);
    }

    connection.notify('textDocument/didOpen', {
      textDocument: {
        uri: fileUri,
        languageId: 'kotlin',
        version: 1,
        text,
      },
    });

    if (options.annotation) {
      let version = 1;
      let currentPrefix = initialPrefix;
      let finalCompletion;
      let finalElapsedMs;
      const requestResults = [];
      const pendingResults = [];
      let previousHandle = null;
      const prefixes =
        options.rapidPrefix === null
          ? [initialPrefix]
          : [...options.rapidPrefix].map((_, index) => options.rapidPrefix.slice(0, index + 1));

      for (const prefix of prefixes) {
        if (previousHandle !== null) connection.cancelRequest(previousHandle.id);
        currentPrefix = prefix;
        if (options.rapidPrefix !== null) {
          version += 1;
          const changedLines = [...lines];
          changedLines[benchmarkLine] =
            `${changedLines[benchmarkLine].slice(0, prefixStartCharacter)}${prefix}`;
          connection.notify('textDocument/didChange', {
            textDocument: { uri: fileUri, version },
            contentChanges: [{ text: changedLines.join('\n') }],
          });
        }

        const startedAt = performance.now();
        const handle = connection.requestWithId(
          'textDocument/completion',
          {
            textDocument: { uri: fileUri },
            position: {
              line: benchmarkLine,
              character: prefixStartCharacter + prefix.length,
            },
            context: { triggerKind: prefix.length === 1 ? 1 : 3 },
          },
          options.timeoutMs,
        );
        const resultPromise = handle.promise.then(
          (completion) => {
            const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
            const elapsedMs = Number((performance.now() - startedAt).toFixed(1));
            const result = {
              prefix,
              elapsedMs,
              status: 'completed',
              resultCount: items.length,
              foundTarget: items.some((item) => item.label === 'RestController'),
            };
            if (prefix === prefixes.at(-1)) {
              finalCompletion = completion;
              finalElapsedMs = elapsedMs;
            }
            requestResults.push(result);
            return result;
          },
          (error) => {
            const result = {
              prefix,
              elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
              status: 'cancelled',
              error: error.message,
            };
            requestResults.push(result);
            return result;
          },
        );
        pendingResults.push(resultPromise);
        previousHandle = handle;
        if (prefix !== prefixes.at(-1)) {
          await new Promise((resolve) => setTimeout(resolve, options.keystrokeMs));
        }
      }

      await previousHandle.promise;
      await Promise.all(pendingResults);
      const finalItems = Array.isArray(finalCompletion)
        ? finalCompletion
        : (finalCompletion?.items ?? []);
      const targetItem = finalItems.find((item) => item.label === 'RestController');
      if (!targetItem) {
        throw new Error(
          `RestController was not suggested for @${currentPrefix}. Results: ${JSON.stringify(
            finalItems.slice(0, 20).map((item) => item.label),
          )}`,
        );
      }
      const importEdit = targetItem.additionalTextEdits?.find((edit) =>
        edit.newText.includes('import smoke.RestController'),
      );
      if (!importEdit) {
        throw new Error(
          `RestController completion had no smoke.RestController import: ${JSON.stringify(targetItem)}`,
        );
      }

      connection.notify('textDocument/didClose', { textDocument: { uri: fileUri } });
      await connection.request('shutdown', null, 15_000);
      connection.notify('exit');
      shutdownComplete = true;
      return {
        serverPort: port,
        serverVersion: initialized.result?.serverInfo?.version ?? null,
        initializeMs: Number(initialized.elapsedMs.toFixed(1)),
        readinessNotification: readyResult.method,
        annotationCompletion: {
          prefix: currentPrefix,
          keystrokeMs: options.keystrokeMs,
          requests: requestResults.sort((a, b) => a.prefix.length - b.prefix.length),
          finalRequestMs: finalElapsedMs,
          resultCount: finalItems.length,
          selectedItem: targetItem,
          autoImportVerified: true,
        },
        writesToSourceFiles: false,
      };
    }

    let warmup = null;
    if (options.warmup) {
      const warmupStartedAt = performance.now();
      const warmupCompletion = await connection.request(
        'textDocument/completion',
        {
          textDocument: { uri: fileUri },
          position: { line: warmupLine, character: warmupCharacter },
          context: { triggerKind: 1 },
        },
        options.timeoutMs,
      );
      const warmupItems = Array.isArray(warmupCompletion)
        ? warmupCompletion
        : (warmupCompletion?.items ?? []);
      warmup = {
        elapsedMs: Number((performance.now() - warmupStartedAt).toFixed(1)),
        resultCount: warmupItems.length,
        foundString: warmupItems.some((item) => item.label === 'String'),
      };
    }

    let rapidTyping = null;
    if (options.rapidPrefix !== null) {
      let prefix = '';
      let version = 1;
      let previousHandle = null;
      const requestResults = [];
      const pendingResults = [];
      let finalCompletion = null;
      let finalStartedAt = null;
      let finalRequestElapsedMs = null;

      for (const characterToType of options.rapidPrefix) {
        if (previousHandle !== null) connection.cancelRequest(previousHandle.id);
        prefix += characterToType;
        const requestPrefix = prefix;
        version += 1;
        const changedLines = [...lines];
        changedLines[benchmarkLine] =
          `${changedLines[benchmarkLine].slice(0, prefixStartCharacter)}${prefix}`;
        connection.notify('textDocument/didChange', {
          textDocument: { uri: fileUri, version },
          contentChanges: [{ text: changedLines.join('\n') }],
        });

        const startedAt = performance.now();
        const handle = connection.requestWithId(
          'textDocument/completion',
          {
            textDocument: { uri: fileUri },
            position: {
              line: benchmarkLine,
              character: prefixStartCharacter + prefix.length,
            },
            context: {
              triggerKind: prefix.length === 1 ? 1 : 3,
            },
          },
          options.timeoutMs,
        );
        const resultPromise = handle.promise.then(
          (completion) => {
            const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
            const result = {
              prefix: requestPrefix,
              elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
              status: 'completed',
              resultCount: items.length,
              foundBigDecimal: items.some((item) => item.label === 'BigDecimal'),
            };
            requestResults.push(result);
            if (requestPrefix === options.rapidPrefix) {
              finalCompletion = completion;
              finalRequestElapsedMs = result.elapsedMs;
            }
            return result;
          },
          (error) => {
            const result = {
              prefix: requestPrefix,
              elapsedMs: Number((performance.now() - startedAt).toFixed(1)),
              status: 'cancelled',
              error: error.message,
            };
            requestResults.push(result);
            return result;
          },
        );
        pendingResults.push(resultPromise);
        previousHandle = handle;
        if (prefix === options.rapidPrefix) finalStartedAt = startedAt;
        if (prefix !== options.rapidPrefix) {
          await new Promise((resolve) => setTimeout(resolve, options.keystrokeMs));
        }
      }

      await previousHandle.promise;
      await Promise.race([
        Promise.all(pendingResults),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      const finalItems = Array.isArray(finalCompletion)
        ? finalCompletion
        : (finalCompletion?.items ?? []);
      const finalRequestMs =
        finalRequestElapsedMs ?? Number((performance.now() - finalStartedAt).toFixed(1));
      const targetItem =
        finalItems.find(
          (item) =>
            item.label === 'BigDecimal' &&
            (item.labelDetails?.detail?.includes('java.math') ||
              item.labelDetails?.description?.includes('java.math')),
        ) ?? finalItems.find((item) => item.label === 'BigDecimal');
      if (!targetItem) {
        throw new Error(
          `BigDecimal was not suggested after rapid typing. Results: ${JSON.stringify(
            finalItems.slice(0, 20).map((item) => item.label),
          )}`,
        );
      }
      const resolveStartedAt = performance.now();
      const resolvedItem = await connection.request(
        'completionItem/resolve',
        targetItem,
        options.timeoutMs,
      );
      const resolveMs = Number((performance.now() - resolveStartedAt).toFixed(1));
      const command = resolvedItem?.command ?? targetItem.command;
      if (!command) throw new Error('BigDecimal completion item has no apply command');
      const applyStartedAt = performance.now();
      await connection.request(
        'workspace/executeCommand',
        { command: command.command, arguments: command.arguments ?? [] },
        options.timeoutMs,
      );
      const applyMs = Number((performance.now() - applyStartedAt).toFixed(1));
      const capturedEdits = connection.applyEdits.flatMap(
        (entry) => Object.values(entry?.edit?.changes ?? {}).flat(),
      );
      rapidTyping = {
        prefix: options.rapidPrefix,
        keystrokeMs: options.keystrokeMs,
        requests: requestResults.sort((a, b) => a.prefix.length - b.prefix.length),
        finalRequestMs,
        finalResultCount: finalItems.length,
        foundBigDecimal: finalItems.some((item) => item.label === 'BigDecimal'),
        resolveMs,
        applyMs,
        command: command.command,
        capturedEdits,
      };

      connection.notify('textDocument/didClose', { textDocument: { uri: fileUri } });
      await connection.request('shutdown', null, 15_000);
      connection.notify('exit');
      shutdownComplete = true;
      return {
        serverPort: port,
        serverVersion: initialized.result?.serverInfo?.version ?? null,
        initializeMs: Number(initialized.elapsedMs.toFixed(1)),
        readinessNotification: readyResult.method,
        warmup,
        rapidTyping,
        writesToSourceFiles: false,
      };
    }

    const durations = [];
    let targetItem;
    let resultCount = 0;
    let isIncomplete = null;
    for (let run = 0; run < options.runs; run += 1) {
      const startedAt = performance.now();
      const completion = await connection.request(
        'textDocument/completion',
        {
          textDocument: { uri: fileUri },
          position: { line: benchmarkLine, character },
          context: {
            triggerKind: run === 0 ? 1 : 3,
          },
        },
        options.timeoutMs,
      );
      durations.push(performance.now() - startedAt);
      const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
      isIncomplete = Array.isArray(completion) ? false : (completion?.isIncomplete ?? null);
      resultCount = items.length;
      targetItem =
        items.find(
          (item) =>
            item.label === 'BigDecimal' &&
            (item.labelDetails?.detail?.includes('java.math') ||
              item.labelDetails?.description?.includes('java.math')),
        ) ?? items.find((item) => item.label === 'BigDecimal');
      if (!targetItem) {
        const labels = items.slice(0, 20).map((item) => ({
          label: item.label,
          detail: item.labelDetails?.detail,
          description: item.labelDetails?.description,
        }));
        throw new Error(`BigDecimal was not suggested. First results: ${JSON.stringify(labels)}`);
      }
    }

    const resolveStartedAt = performance.now();
    const resolvedItem = await connection.request(
      'completionItem/resolve',
      targetItem,
      options.timeoutMs,
    );
    const resolveMs = performance.now() - resolveStartedAt;

    const command = resolvedItem?.command ?? targetItem.command;
    if (!command) throw new Error('BigDecimal completion item has no apply command');
    const applyStartedAt = performance.now();
    await connection.request(
      'workspace/executeCommand',
      { command: command.command, arguments: command.arguments ?? [] },
      options.timeoutMs,
    );
    const applyMs = performance.now() - applyStartedAt;
    const capturedEdits = connection.applyEdits.flatMap(
      (entry) => Object.values(entry?.edit?.changes ?? {}).flat(),
    );

    connection.notify('textDocument/didClose', { textDocument: { uri: fileUri } });
    await connection.request('shutdown', null, 15_000);
    connection.notify('exit');
    shutdownComplete = true;

    return {
      serverPort: port,
      serverVersion: initialized.result?.serverInfo?.version ?? null,
      initializeMs: Number(initialized.elapsedMs.toFixed(1)),
      readinessNotification: readyResult.method,
      importMessage: readyResult.params?.message ?? null,
      warmup,
      completion: {
        runs: durations.map((value) => Number(value.toFixed(1))),
        p50Ms: Number(percentile(durations, 0.5).toFixed(1)),
        p95Ms: Number(percentile(durations, 0.95).toFixed(1)),
        resultCount,
        isIncomplete,
      },
      selectedItem: {
        label: targetItem.label,
        detail: targetItem.labelDetails?.detail ?? null,
        description: targetItem.labelDetails?.description ?? null,
        originalTextEdit: targetItem.textEdit ?? null,
        resolvedTextEdit: resolvedItem?.textEdit ?? null,
        additionalTextEdits: resolvedItem?.additionalTextEdits ?? null,
        command: command.command,
      },
      resolveMs: Number(resolveMs.toFixed(1)),
      applyMs: Number(applyMs.toFixed(1)),
      capturedEdits,
      writesToSourceFiles: false,
    };
  } finally {
    connection.socket.destroy();
    if (!shutdownComplete && child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const result = await runBenchmark(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
