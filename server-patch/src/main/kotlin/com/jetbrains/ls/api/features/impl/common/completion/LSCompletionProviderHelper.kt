// Copyright 2000-2026 JetBrains s.r.o. and contributors. Apache 2.0. Modified in 2026 by the Kotlin Continuous IntelliSense project.
package com.jetbrains.ls.api.features.impl.common.completion

import com.intellij.codeInsight.completion.impl.CamelHumpMatcher
import com.intellij.codeInsight.completion.PrefixMatcher
import com.intellij.codeInsight.lookup.LookupElement
import com.intellij.codeInsight.lookup.LookupElementPresentation
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.lang.Language
import com.intellij.openapi.application.edtWriteAction
import com.intellij.openapi.application.invokeAndWaitIfNeeded
import com.intellij.openapi.application.readAction
import com.intellij.openapi.application.runWriteAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.vfs.findDocument
import com.intellij.openapi.vfs.findPsiFile
import com.intellij.psi.PsiFile
import com.intellij.psi.search.GlobalSearchScope
import com.jetbrains.analyzer.codeServer.createCompletionProcess
import com.jetbrains.analyzer.codeServer.insertCompletion
import com.jetbrains.analyzer.codeServer.performCompletion
import com.jetbrains.ls.api.core.LSAnalysisContext
import com.jetbrains.ls.api.core.LSServer
import com.jetbrains.ls.api.core.project
import com.jetbrains.ls.api.core.util.findVirtualFile
import com.jetbrains.ls.api.core.util.offsetByPosition
import com.jetbrains.ls.api.core.util.positionByOffset
import com.jetbrains.ls.api.core.withAnalysisContextAndFileSettings
import com.jetbrains.ls.api.features.commands.LSCommandDescriptor
import com.jetbrains.ls.api.features.completion.LSCompletionCandidate
import com.jetbrains.ls.api.features.completion.LSCompletionItemKindProvider
import com.jetbrains.ls.api.features.configuration.LSUniqueConfigurationEntry
import com.jetbrains.ls.api.features.impl.common.hover.LSHoverProviderBase.LSMarkdownDocProvider.Companion.getMarkdownDoc
import com.jetbrains.ls.api.features.language.LSLanguage
import com.jetbrains.ls.api.features.resolve.ResolveDataWithConfigurationEntryId
import com.jetbrains.ls.api.features.textEdits.TextEditsComputer
import com.jetbrains.ls.api.features.utils.isSource
import com.jetbrains.ls.snapshot.api.impl.core.CompletionItemId
import com.jetbrains.ls.snapshot.api.impl.core.CompletionItemWithObject
import com.jetbrains.lsp.implementation.lspClient
import com.jetbrains.lsp.protocol.ApplyEditRequests
import com.jetbrains.lsp.protocol.ApplyWorkspaceEditParams
import com.jetbrains.lsp.protocol.Command
import com.jetbrains.lsp.protocol.CompletionItem
import com.jetbrains.lsp.protocol.CompletionItemKind
import com.jetbrains.lsp.protocol.CompletionItemLabelDetails
import com.jetbrains.lsp.protocol.CompletionList
import com.jetbrains.lsp.protocol.CompletionParams
import com.jetbrains.lsp.protocol.CompletionTriggerKind
import com.jetbrains.lsp.protocol.InsertReplaceEdit
import com.jetbrains.lsp.protocol.LSP
import com.jetbrains.lsp.protocol.MarkupContent
import com.jetbrains.lsp.protocol.MarkupKindType
import com.jetbrains.lsp.protocol.MessageType
import com.jetbrains.lsp.protocol.Position
import com.jetbrains.lsp.protocol.Range
import com.jetbrains.lsp.protocol.ShowDocument
import com.jetbrains.lsp.protocol.ShowDocumentParams
import com.jetbrains.lsp.protocol.ShowMessageNotificationType
import com.jetbrains.lsp.protocol.ShowMessageParams
import com.jetbrains.lsp.protocol.StringOrMarkupContent
import com.jetbrains.lsp.protocol.TextEdit
import com.jetbrains.lsp.protocol.URI
import com.jetbrains.lsp.protocol.WorkspaceEdit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.lang.reflect.Method
import java.util.concurrent.atomic.AtomicLong

class LSCompletionProviderHelper(
    private val language: LSLanguage,
    private val uniqueId: LSUniqueConfigurationEntry.UniqueId,
    private val applyCompletionCommandKey: String,
    private val completionDataKey: String,
) {
    private val completionCacheLock = Any()
    private var cachedCompletion: ComputedCompletion? = null
    private var inFlightCompletion: InFlightCompletion? = null
    private val completionRequestSequence = AtomicLong()
    private val completionItemIdSequence = AtomicLong()
    private val publicationMutex = Mutex()
    private var latestPublishedSequence = 0L
    @Volatile
    private var latestCompletionObjects: Map<CompletionItemId, Any> = emptyMap()

    interface FileForModificationProvider {
        context(analysisContext: LSAnalysisContext)
        fun <T> withFileForModification(physicalPsiFile: PsiFile, action: (fileForModification: PsiFile) -> T): T
    }

    fun createCommandDescriptors(fileForModificationProvider: FileForModificationProvider): List<LSCommandDescriptor> = listOf(
            LSCommandDescriptor(
                title = "Apply Completion Item",
                name = applyCompletionCommandKey,
                executor = { arguments ->
                    val server = contextOf<LSServer>()
                    require(arguments.size == 1) { "Expected 1 argument, got: ${arguments.size}" }
                    val id = arguments[0]
                    when (val completion = latestCompletionObjects[CompletionItemId.fromJson(id)] as LSCompletion?) {
                        null -> {
                            lspClient.notify(
                                notificationType = ShowMessageNotificationType,
                                params = ShowMessageParams(MessageType.Error, "Your completion session has expired, please try again"),
                            )
                        }

                        else -> {
                            server.withAnalysisContextAndFileSettings(completion.params.textDocument.uri.uri) {
                                val insertionResult = applyCompletion(completion, fileForModificationProvider)
                                lspClient.request(
                                    ApplyEditRequests.ApplyEdit,
                                    ApplyWorkspaceEditParams(
                                        label = null,
                                        edit = WorkspaceEdit(
                                            changes = mapOf(completion.params.textDocument.uri to insertionResult.edits)
                                        )
                                    )
                                )
                                lspClient.request(
                                    ShowDocument,
                                    ShowDocumentParams(
                                        uri = completion.params.textDocument.uri.uri,
                                        external = false,
                                        takeFocus = true,
                                        selection = Range(insertionResult.caretPosition, insertionResult.caretPosition)
                                    )
                                )
                            }
                        }
                    }

                    JsonPrimitive(true)
                }
            )
        )

    context(server: LSServer)
    suspend fun provideCompletion(params: CompletionParams): CompletionList {
        if (!params.textDocument.isSource()) return CompletionList.EMPTY

        val requestSequence = completionRequestSequence.incrementAndGet()
        val input = server.withAnalysisContextAndFileSettings(params.textDocument.uri.uri) {
            readAction {
                params.textDocument.findVirtualFile()?.let { file ->
                    file.findPsiFile(project) ?: return@let null
                    val document = file.findDocument() ?: return@let null
                    val offset = document.offsetByPosition(params.position)
                    createCompletionInput(params, document, offset)
                }
            }
        } ?: return CompletionList.EMPTY

        val fastAnnotationItems = server.withAnalysisContextAndFileSettings(params.textDocument.uri.uri) {
            readAction {
                val file = params.textDocument.findVirtualFile() ?: return@readAction emptyList()
                val document = file.findDocument() ?: return@readAction emptyList()
                val psiFile = file.findPsiFile(project) ?: return@readAction emptyList()
                buildFastAnnotationCompletionItems(
                    params = params,
                    document = document,
                    input = input,
                    scope = psiFile.resolveScope,
                )
            }
        }
        if (fastAnnotationItems.isNotEmpty()) {
            if (!publishCompletion(requestSequence, emptyList())) {
                return CompletionList(isIncomplete = true, items = emptyList())
            }
            return CompletionList(isIncomplete = true, items = fastAnnotationItems)
        }

        val computed = if (input.prefix.length >= REUSABLE_COMPLETION_MIN_PREFIX_LENGTH) {
            getOrComputeReusableCompletion(input, params)
        } else {
            server.withAnalysisContextAndFileSettings(params.textDocument.uri.uri) {
                computeCompletion(input, params)
            }
        }

        val itemsWithObjects = server.withAnalysisContextAndFileSettings(params.textDocument.uri.uri) {
            readAction {
                buildCompletionItems(params, input.prefix, computed)
            }
        }

        if (!publishCompletion(requestSequence, itemsWithObjects)) {
            return CompletionList(isIncomplete = true, items = emptyList())
        }
        return CompletionList(isIncomplete = true, items = itemsWithObjects.map { it.item })
    }

    private fun createCompletionInput(
        params: CompletionParams,
        document: Document,
        offset: Int,
    ): CompletionInput {
        val text = document.text
        var prefixStart = offset
        while (prefixStart > 0 && isKotlinIdentifierPart(text[prefixStart - 1])) {
            prefixStart--
        }
        return CompletionInput(
            prefix = text.substring(prefixStart, offset),
            cacheKey = CompletionCacheKey(
                uri = params.textDocument.uri.uri,
                prefixStart = prefixStart,
                textBeforePrefix = text.substring(0, prefixStart),
                textAfterCursor = text.substring(offset),
            ),
        )
    }

    context(analysisContext: LSAnalysisContext)
    private fun buildFastAnnotationCompletionItems(
        params: CompletionParams,
        document: Document,
        input: CompletionInput,
        scope: GlobalSearchScope,
    ): List<CompletionItem> {
        val prefix = input.prefix
        val prefixStart = input.cacheKey.prefixStart
        if (
            prefix.length < FAST_ANNOTATION_MIN_PREFIX_LENGTH ||
            prefixStart == 0 ||
            document.charsSequence[prefixStart - 1] != '@'
        ) {
            return emptyList()
        }

        val reflection = fastAnnotationReflection
            ?: FastAnnotationReflection.create()?.also { fastAnnotationReflection = it }
            ?: return emptyList()
        val shortClassNameIndex = reflection.invoke(reflection.getInstance, null)
            ?: return emptyList()
        val allClassNames = reflection.invoke(reflection.getAllKeys, shortClassNameIndex, project) as? Collection<*>
            ?: return emptyList()
        val matchingShortNames = allClassNames
            .asSequence()
            .mapNotNull { it as? String }
            .filter { it.startsWith(prefix, ignoreCase = true) }
            .sortedWith(
                compareBy<String>(
                    { !it.startsWith(prefix) },
                    { it.length },
                    { it },
                )
            )
            .take(FAST_ANNOTATION_SHORT_NAME_LIMIT)
            .toList()

        val importContext = FastImportContext.create(document)
        val seenQualifiedNames = HashSet<String>()
        val candidates = ArrayList<FastAnnotationCandidate>()
        for (shortName in matchingShortNames) {
            val classes = reflection.invoke(
                reflection.getClasses,
                shortClassNameIndex,
                shortName,
                project,
                scope,
            ) as? Collection<*> ?: continue
            for (psiClass in classes) {
                psiClass ?: continue
                if (reflection.invoke(reflection.isAnnotationType, psiClass) != true) continue
                val simpleName = reflection.invoke(reflection.getName, psiClass) as? String ?: continue
                val qualifiedName = reflection.invoke(reflection.getQualifiedName, psiClass) as? String ?: continue
                if (!seenQualifiedNames.add(qualifiedName)) continue
                val importEdits = importContext.createImportEdits(qualifiedName, simpleName) ?: continue
                candidates += FastAnnotationCandidate(simpleName, qualifiedName, importEdits)
                if (candidates.size >= FAST_ANNOTATION_ITEM_LIMIT) break
            }
            if (candidates.size >= FAST_ANNOTATION_ITEM_LIMIT) break
        }

        val prefixEnd = prefixStart + prefix.length
        val replacementRange = Range(
            document.positionByOffset(prefixStart),
            document.positionByOffset(prefixEnd),
        )
        return candidates.mapIndexed { index, candidate ->
            CompletionItem(
                label = candidate.simpleName,
                sortText = getSortedFieldByIndex(index),
                filterText = candidate.simpleName,
                labelDetails = CompletionItemLabelDetails(
                    description = candidate.qualifiedName.substringBeforeLast('.', ""),
                ),
                kind = CompletionItemKind.Class,
                textEdit = CompletionItem.Edit.InsertReplace(
                    InsertReplaceEdit(
                        newText = candidate.simpleName,
                        insert = replacementRange,
                        replace = replacementRange,
                    )
                ),
                additionalTextEdits = candidate.importEdits,
            )
        }
    }

    context(server: LSServer)
    private suspend fun getOrComputeReusableCompletion(
        input: CompletionInput,
        params: CompletionParams,
    ): ComputedCompletion {
        val work = synchronized(completionCacheLock) {
            cachedCompletion
                ?.takeIf { it.canServe(input) }
                ?.let { return it }

            inFlightCompletion
                ?.takeIf { it.canServe(input) }
                ?.let { return@synchronized CompletionWork(it.result, isOwner = false) }

            val result = CompletableDeferred<ComputedCompletion>()
            inFlightCompletion = InFlightCompletion(
                cacheKey = input.cacheKey,
                basePrefix = input.prefix,
                result = result,
            )
            CompletionWork(result, isOwner = true)
        }

        if (!work.isOwner) return work.result.await()

        val supervisor = SupervisorJob(server.handlersContext[Job])
        CoroutineScope(server.handlersContext.minusKey(Job) + supervisor).launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                // VS Code cancels the previous request on every keystroke. Do not inherit its Job
                // or IntelliJ progress indicator: the next, longer prefix reuses this calculation.
                val computed = server.withAnalysisContextAndFileSettings(params.textDocument.uri.uri) {
                    computeCompletion(input, params)
                }
                synchronized(completionCacheLock) {
                    if (inFlightCompletion?.result === work.result) {
                        cachedCompletion = computed
                        inFlightCompletion = null
                    }
                }
                work.result.complete(computed)
            } catch (error: Throwable) {
                synchronized(completionCacheLock) {
                    if (inFlightCompletion?.result === work.result) {
                        inFlightCompletion = null
                    }
                }
                work.result.completeExceptionally(error)
            } finally {
                supervisor.complete()
            }
        }
        return work.result.await()
    }

    context(analysisContext: LSAnalysisContext)
    private suspend fun computeCompletion(
        input: CompletionInput,
        params: CompletionParams,
    ): ComputedCompletion {
        val prepared = edtWriteAction {
            // didChange can advance the document while this request waits for the EDT. Build the
            // process at the newest end of the same identifier instead of its stale LSP offset.
            val file = requireNotNull(params.textDocument.findVirtualFile()) {
                "virtual file not found for ${params.textDocument}"
            }
            val psiFile = requireNotNull(file.findPsiFile(project)) {
                "psi file not found for $file"
            }
            val document = requireNotNull(file.findDocument()) {
                "document not found for $file"
            }
            val text = document.text
            var currentOffset = input.cacheKey.prefixStart
            while (currentOffset < text.length && isKotlinIdentifierPart(text[currentOffset])) {
                currentOffset++
            }
            val currentInput = createCompletionInput(params, document, currentOffset)
            val process = createCompletionProcess(
                project = project,
                file = psiFile,
                offset = currentOffset,
                invocationCount = computeInvocationCount(params.context?.triggerKind)
            )
            currentInput to process
        }
        val candidates = readAction {
            performCompletion(prepared.second).map { lookup ->
                ComputedCandidate(
                    lookup = lookup,
                    matcher = prepared.second.arranger.itemMatcher(lookup),
                )
            }
        }
        return ComputedCompletion(
            cacheKey = prepared.first.cacheKey,
            basePrefix = prepared.first.prefix,
            candidates = candidates,
        )
    }

    context(server: LSServer)
    private fun buildCompletionItems(
        params: CompletionParams,
        prefix: String,
        computed: ComputedCompletion,
    ): List<CompletionItemWithObject<*>> {
        return computed.candidates
            .mapNotNull { candidate ->
                val matcher = candidate.matcher.cloneWithPrefix(prefix)
                candidate.takeIf { matcher.prefixMatches(candidate.lookup) }?.let { it to matcher }
            }
            .mapIndexed { index, (candidate, matcher) ->
                val lookup = candidate.lookup
                val lookupPresentation = LookupElementPresentation().also {
                    lookup.renderElement(it)
                }
                val obj = LSCompletion(params, lookup, matcher)
                val key = CompletionItemId.fromJson(JsonPrimitive(completionItemIdSequence.incrementAndGet()))
                CompletionItemWithObject(
                    item = CompletionItem(
                        label = lookupPresentation.itemText ?: lookup.lookupString,
                        sortText = getSortedFieldByIndex(index),
                        labelDetails = CompletionItemLabelDetails(
                            detail = lookupPresentation.tailText,
                            description = lookupPresentation.typeText,
                        ),
                        kind = LSCompletionItemKindProvider.getKind(CompletionCandidate(lookup, language)),
                        textEdit = CompletionItem.Edit.emptyAtPosition(params.position),
                        command = Command(
                            "Apply Completion",
                            command = applyCompletionCommandKey,
                            arguments = listOf(key.toJson())
                        ),
                        data = JsonObject(
                            mapOf(
                                completionDataKey to key.toJson(),
                                ResolveDataWithConfigurationEntryId::configurationEntryId.name to LSP.json.encodeToJsonElement(
                                    uniqueId
                                )
                            )
                        ),
                    ),
                    key = key,
                    obj = obj
                )
            }
    }

    context(server: LSServer)
    private suspend fun publishCompletion(
        requestSequence: Long,
        itemsWithObjects: List<CompletionItemWithObject<*>>,
    ): Boolean {
        publicationMutex.lock()
        return try {
            if (requestSequence < latestPublishedSequence) {
                false
            } else {
                latestPublishedSequence = requestSequence
                latestCompletionObjects = itemsWithObjects.associate { itemWithObject ->
                    itemWithObject.key to itemWithObject.obj
                }
                true
            }
        } finally {
            publicationMutex.unlock()
        }
    }

    context(server: LSServer)
    suspend fun resolveCompletion(completionItem: CompletionItem, fileForModificationProvider: FileForModificationProvider): CompletionItem? {
        val completionDataValue = completionItem.data?.jsonObject?.get(completionDataKey) ?: return completionItem

        return (latestCompletionObjects[CompletionItemId.fromJson(completionDataValue)] as LSCompletion?)?.let { completionData ->
            server.withAnalysisContextAndFileSettings(completionData.params.textDocument.uri.uri) {
                val completionItem = completionItem.copy(
                    documentation = readAction { computeDocumentation(completionData.lookup) },
                )
                // https://youtrack.jetbrains.com/issue/LSP-319/Fix-completion-in-Air
                val isAir = server.initializeParams.clientInfo?.name == "JetBrains Air"
                if (isAir) {
                    val insRes = applyCompletion(completionData, fileForModificationProvider)
                    completionItem.copy(
                        additionalTextEdits = insRes.edits,
                        command = Command(
                            title = "Move cursor",
                            command = "cursorMove",
                            arguments = listOf(
                                buildJsonObject {
                                    put("to", "offset")
                                    put("value", insRes.caretOffset)
                                }
                            )
                        )
                    )
                } else {
                    completionItem
                }
            }
        }
    }

    private fun computeDocumentation(lookup: LookupElement): StringOrMarkupContent? {
        return lookup.psiElement
            ?.let { getMarkdownDoc(it) }
            ?.let { StringOrMarkupContent(MarkupContent(MarkupKindType.Markdown, it)) }
    }

    context(analysisContext: LSAnalysisContext)
    private fun applyCompletion(completion: LSCompletion, fileForModificationProvider: FileForModificationProvider): CompletionInsertionResult =
        invokeAndWaitIfNeeded {
            runWriteAction {
                val physicalVirtualFile = requireNotNull(completion.params.textDocument.findVirtualFile()) {
                    "virtual file not found for ${completion.params.textDocument}"
                }
                val physicalPsiFile = requireNotNull(physicalVirtualFile.findPsiFile(project)) {
                    "psi file not found for $physicalVirtualFile"
                }
                val initialText = physicalPsiFile.text

                fileForModificationProvider.withFileForModification(
                    physicalPsiFile,
                ) { fileForModification ->
                    val document = fileForModification.fileDocument
                    val caretBefore = document.offsetByPosition(completion.params.position)
                    val completionProcess = createCompletionProcess(project, fileForModification, caretBefore)
                    completionProcess.arranger.registerMatcher(
                        completion.lookup,
                        CamelHumpMatcher(completion.itemMatcher.prefix)
                    )
                    insertCompletion(project, fileForModification, completion.lookup, completionProcess.parameters!!)
                    val edits = TextEditsComputer.computeTextEdits(initialText, fileForModification.text)
                    val caretAfter = completionProcess.caret.offset
                    CompletionInsertionResult(edits, document.positionByOffset(caretAfter), caretAfter)
                }
            }
        }

    private fun computeInvocationCount(triggerKind: CompletionTriggerKind?): Int {
        return when (triggerKind) {
            CompletionTriggerKind.TriggerCharacter,
            CompletionTriggerKind.TriggerForIncompleteCompletions -> 0

            else -> 1
        }
    }

    private fun isKotlinIdentifierPart(character: Char): Boolean =
        Character.isJavaIdentifierPart(character) || character == '`'

    private fun ComputedCompletion.canServe(input: CompletionInput): Boolean =
        cacheKey == input.cacheKey && input.prefix.startsWith(basePrefix)

    private fun InFlightCompletion.canServe(input: CompletionInput): Boolean =
        cacheKey == input.cacheKey && input.prefix.startsWith(basePrefix)

    private data class CompletionCandidate(private val lookup: LookupElement, private val lsLanguage: LSLanguage) : LSCompletionCandidate {
        override val language: Language = lsLanguage.intellijLanguage
        override val result: Any = lookup.psiElement ?: lookup.`object`
    }

    private data class CompletionCacheKey(
        val uri: URI,
        val prefixStart: Int,
        val textBeforePrefix: String,
        val textAfterCursor: String,
    )

    private data class CompletionInput(
        val prefix: String,
        val cacheKey: CompletionCacheKey,
    )

    private data class ComputedCandidate(
        val lookup: LookupElement,
        val matcher: PrefixMatcher,
    )

    private data class ComputedCompletion(
        val cacheKey: CompletionCacheKey,
        val basePrefix: String,
        val candidates: List<ComputedCandidate>,
    )

    private data class InFlightCompletion(
        val cacheKey: CompletionCacheKey,
        val basePrefix: String,
        val result: CompletableDeferred<ComputedCompletion>,
    )

    private data class CompletionWork(
        val result: CompletableDeferred<ComputedCompletion>,
        val isOwner: Boolean,
    )

    private data class FastAnnotationCandidate(
        val simpleName: String,
        val qualifiedName: String,
        val importEdits: List<TextEdit>,
    )

    private data class FastAnnotationReflection(
        val getInstance: Method,
        val getAllKeys: Method,
        val getClasses: Method,
        val isAnnotationType: Method,
        val getName: Method,
        val getQualifiedName: Method,
    ) {
        fun invoke(method: Method, receiver: Any?, vararg arguments: Any?): Any? = try {
            method.invoke(receiver, *arguments)
        } catch (_: ReflectiveOperationException) {
            null
        } catch (_: LinkageError) {
            null
        }

        companion object {
            fun create(): FastAnnotationReflection? {
                val classLoaders = LinkedHashSet<ClassLoader>()
                findClassOwnerClassLoader()?.let(classLoaders::add)
                collectEnabledModuleClassLoaders(classLoaders)
                runCatching {
                    PluginManagerCore.getPlugin(PluginId.getId(JAVA_PLUGIN_ID))
                        ?.pluginClassLoader
                        ?.let(classLoaders::add)
                }
                Thread.currentThread().contextClassLoader?.let(classLoaders::add)
                LSCompletionProviderHelper::class.java.classLoader?.let(classLoaders::add)

                return classLoaders.firstNotNullOfOrNull(::load)
            }

            private fun findClassOwnerClassLoader(): ClassLoader? = try {
                val findDescriptor = PluginManagerCore::class.java.findMethod(
                    "getPluginDescriptorOrPlatformByClassName",
                    1,
                ) ?: return null
                val descriptor = findDescriptor.invoke(null, JAVA_SHORT_CLASS_NAME_INDEX_CLASS_NAME)
                    ?: return null
                descriptor.javaClass.findMethod("getPluginClassLoader", 0)
                    ?.invoke(descriptor) as? ClassLoader
            } catch (_: ReflectiveOperationException) {
                null
            } catch (_: LinkageError) {
                null
            }

            private fun collectEnabledModuleClassLoaders(destination: MutableSet<ClassLoader>) {
                try {
                    val pluginSet = PluginManagerCore.getPluginSet()
                    val modules = pluginSet.javaClass.findMethod("getEnabledModules", 0)
                        ?.invoke(pluginSet) as? Iterable<*> ?: return
                    for (module in modules) {
                        module ?: continue
                        try {
                            val classLoader = module.javaClass.findMethod("getPluginClassLoader", 0)
                                ?.invoke(module) as? ClassLoader ?: continue
                            destination += classLoader
                        } catch (_: ReflectiveOperationException) {
                            continue
                        } catch (_: LinkageError) {
                            continue
                        }
                    }
                } catch (_: ReflectiveOperationException) {
                    return
                } catch (_: LinkageError) {
                    return
                }
            }

            private fun load(classLoader: ClassLoader): FastAnnotationReflection? = try {
                val cacheClass = Class.forName(JAVA_SHORT_CLASS_NAME_INDEX_CLASS_NAME, false, classLoader)
                val psiClass = Class.forName(PSI_CLASS_CLASS_NAME, false, classLoader)
                FastAnnotationReflection(
                    getInstance = cacheClass.findMethod("getInstance", 0) ?: return null,
                    getAllKeys = cacheClass.findMethod("getAllKeys", 1) ?: return null,
                    getClasses = cacheClass.findMethod("getClasses", 3) ?: return null,
                    isAnnotationType = psiClass.findMethod("isAnnotationType", 0) ?: return null,
                    getName = psiClass.findMethod("getName", 0) ?: return null,
                    getQualifiedName = psiClass.findMethod("getQualifiedName", 0) ?: return null,
                )
            } catch (_: ReflectiveOperationException) {
                null
            } catch (_: LinkageError) {
                null
            }

            private fun Class<*>.findMethod(name: String, parameterCount: Int): Method? =
                methods.firstOrNull { it.name == name && it.parameterCount == parameterCount }
        }
    }

    private data class FastImportDirective(
        val path: String,
        val alias: String?,
    )

    private data class FastImportContext(
        val document: Document,
        val packageName: String?,
        val imports: List<FastImportDirective>,
        val insertionOffset: Int,
        val insertionPrefix: String,
        val insertionSuffix: String,
    ) {
        fun createImportEdits(qualifiedName: String, simpleName: String): List<TextEdit>? {
            val targetPackage = qualifiedName.substringBeforeLast('.', "")
            if (
                targetPackage == packageName ||
                imports.any { directive ->
                    directive.alias == null &&
                        (directive.path == qualifiedName || directive.path == "$targetPackage.*")
                }
            ) {
                return emptyList()
            }

            val hasConflictingImport = imports.any { directive ->
                when {
                    directive.alias == simpleName -> directive.path != qualifiedName
                    directive.alias == null -> directive.path.substringAfterLast('.') == simpleName &&
                        directive.path != qualifiedName
                    else -> false
                }
            }
            if (hasConflictingImport) return null

            val position = document.positionByOffset(insertionOffset)
            return listOf(
                TextEdit(
                    range = Range(position, position),
                    newText = "$insertionPrefix$qualifiedName$insertionSuffix",
                )
            )
        }

        companion object {
            fun create(document: Document): FastImportContext {
                val text = document.text
                val newline = if ("\r\n" in text) "\r\n" else "\n"
                val packageMatch = PACKAGE_DIRECTIVE_REGEX.find(text)
                val importMatches = IMPORT_DIRECTIVE_REGEX.findAll(text).toList()
                val imports = importMatches.map { match ->
                    val rawDirective = match.groupValues[1].trim().removeSuffix(";").trim()
                    val path = rawDirective.substringBefore(" as ").trim()
                    val alias = rawDirective.substringAfter(" as ", "").trim().ifEmpty { null }
                    FastImportDirective(path, alias)
                }

                val insertionOffset: Int
                val insertionPrefix: String
                val insertionSuffix: String
                when {
                    importMatches.isNotEmpty() -> {
                        insertionOffset = importMatches.last().range.last + 1
                        insertionPrefix = "${newline}import "
                        insertionSuffix = ""
                    }

                    packageMatch != null -> {
                        insertionOffset = packageMatch.range.last + 1
                        insertionPrefix = "$newline${newline}import "
                        insertionSuffix = ""
                    }

                    else -> {
                        insertionOffset = 0
                        insertionPrefix = "import "
                        insertionSuffix = "$newline$newline"
                    }
                }

                return FastImportContext(
                    document = document,
                    packageName = packageMatch?.groupValues?.get(1),
                    imports = imports,
                    insertionOffset = insertionOffset,
                    insertionPrefix = insertionPrefix,
                    insertionSuffix = insertionSuffix,
                )
            }
        }
    }

    private data class CompletionInsertionResult(val edits: List<TextEdit>, val caretPosition: Position, val caretOffset: Int)

    private companion object {
        const val REUSABLE_COMPLETION_MIN_PREFIX_LENGTH = 1
        const val FAST_ANNOTATION_MIN_PREFIX_LENGTH = 3
        const val FAST_ANNOTATION_SHORT_NAME_LIMIT = 256
        const val FAST_ANNOTATION_ITEM_LIMIT = 50
        const val JAVA_PLUGIN_ID = "org.jetbrains.ls.plugin.java"
        const val JAVA_SHORT_CLASS_NAME_INDEX_CLASS_NAME =
            "com.intellij.psi.impl.java.stubs.index.JavaShortClassNameIndex"
        const val PSI_CLASS_CLASS_NAME = "com.intellij.psi.PsiClass"
        @Volatile
        var fastAnnotationReflection: FastAnnotationReflection? = null
        val PACKAGE_DIRECTIVE_REGEX = Regex(
            """(?m)^[\t ]*package[\t ]+([A-Za-z_][A-Za-z0-9_.]*)[\t ]*;?[\t ]*$"""
        )
        val IMPORT_DIRECTIVE_REGEX = Regex(
            """(?m)^[\t ]*import[\t ]+([^\r\n]+?)[\t ]*$"""
        )
    }
}
