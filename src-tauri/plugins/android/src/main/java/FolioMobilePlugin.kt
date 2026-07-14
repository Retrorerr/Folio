package com.folio.reader.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.view.HapticFeedbackConstants
import androidx.activity.result.ActivityResult
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import app.tauri.annotation.ActivityCallback
import org.json.JSONObject
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray

@InvokeArg
class PickEpubArgs {
    var initialUri: String? = null
}

@InvokeArg
class PickFolderArgs {
    var initialUri: String? = null
}

@InvokeArg
class ScanDocumentTreeArgs {
    var treeUri: String? = null
    var recursive: Boolean? = null
}

@InvokeArg
class OpenDocumentReadArgs {
    var uri: String? = null
}

@InvokeArg
class ReadDocumentChunkArgs {
    var handle: String? = null
    var maxBytes: Int? = null
}

@InvokeArg
class CloseDocumentReadArgs {
    var handle: String? = null
}

@InvokeArg
class SynthesizeArgs {
    var text: String? = null
    var voice: String? = null
    var speed: Double? = null
    var engine: String? = null
}

@InvokeArg
class InstallModelPackArgs {
    var engine: String? = null
    var download: Boolean? = null
    var cancel: Boolean? = null
}

@InvokeArg
class SystemBarsArgs {
    var darkBackground: Boolean? = null
    var backgroundColor: String? = null
}

@InvokeArg
class HapticArgs {
    var kind: String? = null
}

@InvokeArg
class PlayAudioArgs {
    var audioBase64: String? = null
    var title: String? = null
    var artist: String? = null
    var album: String? = null
    var positionMs: Long? = null
    var mode: String? = null
}

@InvokeArg
class ControlAudioArgs {
    var action: String? = null
    var positionMs: Long? = null
}

private data class DocumentTreeNode(
    val documentId: String,
    val depth: Int,
    val path: String,
)

private data class DocumentMetadata(
    val displayName: String,
    val mimeType: String,
    val size: Long,
    val lastModified: Long,
)

private data class DocumentReadSession(
    val input: InputStream,
    val maxBytes: Long,
    val declaredSize: Long,
    var bytesRead: Long = 0L,
    var lastTouchedAt: Long = System.currentTimeMillis(),
)

private fun bridgeJsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSObject().apply {
        value.forEach { (key, nested) ->
            require(key is String) { "Bridge JSON object keys must be strings" }
            put(key, bridgeJsonValue(nested))
        }
    }
    is Iterable<*> -> JSONArray().apply { value.forEach { put(bridgeJsonValue(it)) } }
    is Array<*> -> JSONArray().apply { value.forEach { put(bridgeJsonValue(it)) } }
    is Boolean, is Number, is String, is JSONObject, is JSONArray -> value
    else -> value.toString()
}

internal fun statusJsonObject(values: Map<String, Any?>): JSObject =
    bridgeJsonValue(values) as JSObject

@TauriPlugin
class FolioMobilePlugin(private val activity: Activity) : Plugin(activity) {
    private companion object {
        const val PICKER_CALLBACK = "onPickerResult"
        const val READ_SESSION_MAX_IDLE_MS = 5L * 60L * 1000L
        const val STATUS_CACHE_TTL_MS = 750L
    }

    private val modelManager = OnDeviceModelManager(activity)
    private val supertonicRuntime = SupertonicRuntime(modelManager)
    private val kokoroRuntime = KokoroRuntime(modelManager)
    private val pickerLock = Any()
    private var pendingPickerKind: String? = null
    private val workerIds = AtomicInteger(0)
    private val synthesisExecutor = boundedExecutor("folio-local-tts", workers = 2, queueSize = 4)
    private val statusExecutor = boundedExecutor("folio-native-status", workers = 1, queueSize = 1)
    private val modelImportExecutor = boundedExecutor("folio-model-import", workers = 1, queueSize = 1)
    private val modelDownloadExecutor = boundedExecutor("folio-model-download", workers = 1, queueSize = 1)
    private val documentExecutor = boundedExecutor("folio-documents", workers = 1, queueSize = 12)
    private val playbackExecutor = boundedExecutor("folio-playback-bridge", workers = 1, queueSize = 8)
    private val documentReads = mutableMapOf<String, DocumentReadSession>()
    private val statusLock = Any()
    private val statusWaiters = ArrayDeque<Invoke>()
    private var statusRefreshRunning = false
    private var statusSnapshot: JSObject? = null
    private var statusSnapshotAt = 0L
    private val modelDownloader = AndroidModelDownloader(modelManager)

    override fun onStop() {
        // ONNX sessions are hundreds of MB and the current playback service
        // consumes already-generated WAVs. Release inference memory once the
        // WebView is no longer visible; a later request reloads lazily.
        modelManager.unloadAllAsync()
        super.onStop()
    }

    override fun onDestroy() {
        synchronized(pickerLock) { pendingPickerKind = null }
        synthesisExecutor.shutdownNow()
        statusExecutor.shutdownNow()
        modelImportExecutor.shutdownNow()
        modelDownloadExecutor.shutdownNow()
        documentExecutor.shutdownNow()
        playbackExecutor.shutdownNow()
        synchronized(documentReads) {
            documentReads.values.forEach { runCatching { it.input.close() } }
            documentReads.clear()
        }
        val pendingStatus = synchronized(statusLock) {
            statusRefreshRunning = false
            buildList { while (statusWaiters.isNotEmpty()) add(statusWaiters.removeFirst()) }
        }
        pendingStatus.forEach { it.reject("Android native runtime status stopped") }
        modelManager.unloadAllAsync()
        super.onDestroy()
    }

    private fun boundedExecutor(prefix: String, workers: Int, queueSize: Int): ThreadPoolExecutor =
        ThreadPoolExecutor(
            workers,
            workers,
            30L,
            TimeUnit.SECONDS,
            ArrayBlockingQueue(queueSize),
            { task -> Thread(task, "$prefix-${workerIds.incrementAndGet()}").apply { isDaemon = true } },
            ThreadPoolExecutor.AbortPolicy(),
        ).apply { allowCoreThreadTimeOut(true) }

    @Command
    fun pickEpub(invoke: Invoke) {
        val args = invoke.parseArgs(PickEpubArgs::class.java)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            type = "application/epub+zip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/epub+zip", "application/octet-stream"))
            args.initialUri?.let { putExtra("android.provider.extra.INITIAL_URI", it.toUri()) }
        }
        launchPicker(invoke, "epub", intent)
    }

    @Command
    fun pickFolder(invoke: Invoke) {
        val args = invoke.parseArgs(PickFolderArgs::class.java)
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            args.initialUri?.let { putExtra("android.provider.extra.INITIAL_URI", it.toUri()) }
        }
        launchPicker(invoke, "folder", intent)
    }

    @Command
    fun installModelPack(invoke: Invoke) {
        val args = invoke.parseArgs(InstallModelPackArgs::class.java)
        val engine = args.engine?.trim().orEmpty()
        if (engine != "kokoro" && engine != "supertonic") {
            invoke.reject("Unknown model engine")
            return
        }
        if (args.cancel == true) {
            val requested = modelDownloader.cancel(engine)
            invoke.resolve(JSObject().apply {
                put("engine", engine)
                put("cancelRequested", requested)
                put("state", modelManager.downloadState(engine)["state"] ?: "not_installed")
            })
            return
        }
        if (args.download == true) {
            try {
                modelDownloadExecutor.execute {
                    invoke.resolve(modelDownloader.download(engine))
                }
            } catch (_: RejectedExecutionException) {
                invoke.reject("Another Android model download is already running")
            }
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            type = "application/zip"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/octet-stream"))
        }
        launchPicker(invoke, "model:$engine", intent)
    }

    private fun launchPicker(invoke: Invoke, kind: String, intent: Intent) {
        synchronized(pickerLock) {
            if (pendingPickerKind != null) {
                invoke.reject("Another Android file picker is already open")
                return
            }
            pendingPickerKind = kind
        }
        try {
            startActivityForResult(invoke, intent, PICKER_CALLBACK)
        } catch (error: Throwable) {
            synchronized(pickerLock) {
                if (pendingPickerKind == kind) pendingPickerKind = null
            }
            invoke.reject(error.message ?: "Android file picker could not be opened")
        }
    }

    @ActivityCallback
    fun onPickerResult(invoke: Invoke, activityResult: ActivityResult) {
        val data = activityResult.data
        // Document providers return a new Intent and are not required to echo
        // caller extras. Preserve request state in the plugin instead.
        val kind = synchronized(pickerLock) {
            pendingPickerKind.also { pendingPickerKind = null }
        }
        if (kind == null) {
            invoke.reject("Android file picker result did not match a pending request")
            return
        }
        if (activityResult.resultCode != Activity.RESULT_OK || data?.data == null) {
            invoke.resolve(JSObject())
            return
        }
        val uri = data.data!!
        if (kind.startsWith("model:")) {
            val engine = kind.removePrefix("model:")
            try {
                modelImportExecutor.execute {
                    val result = installModelPackFromUri(uri, engine)
                    invoke.resolve(result)
                }
            } catch (_: RejectedExecutionException) {
                invoke.reject("Another model-pack import is already running")
            }
            return
        }
        var persisted = false
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
            persisted = runCatching {
                activity.contentResolver.persistedUriPermissions.any { it.isReadPermission && it.uri == uri }
            }.getOrDefault(false)
        } catch (_: Throwable) {
            // The caller receives persisted=false. Single-file imports can
            // still copy their transient stream; folder scans require persistence.
        }
        val result = JSObject()
        result.put("uri", uri.toString())
        result.put("displayName", queryDisplayName(uri) ?: if (kind == "folder") "Folder" else "book.epub")
        result.put("persisted", persisted)
        invoke.resolve(result)
    }

    @Command
    fun scanDocumentTree(invoke: Invoke) {
        val args = invoke.parseArgs(ScanDocumentTreeArgs::class.java)
        val rawTreeUri = args.treeUri?.trim().orEmpty()
        try {
            documentExecutor.execute {
                val result = runCatching { scanTree(rawTreeUri, args.recursive != false) }
                    .getOrElse { scanFailure(rawTreeUri, it.message ?: "The selected folder could not be scanned") }
                invoke.resolve(result)
            }
        } catch (_: RejectedExecutionException) {
            invoke.reject("The Android document queue is busy")
        }
    }

    @Command
    fun openDocumentRead(invoke: Invoke) {
        val args = invoke.parseArgs(OpenDocumentReadArgs::class.java)
        try {
            documentExecutor.execute {
                try {
                    val uri = requireContentUri(args.uri)
                    val metadata = queryDocumentMetadata(uri)
                    val kind = SafDocumentPolicy.classify(metadata.displayName, metadata.mimeType)
                        ?: throw IllegalArgumentException("Only EPUB and PDF documents can be imported")
                    if (metadata.size > kind.maxBytes) throw IllegalArgumentException("${metadata.displayName} is too large to import safely")
                    pruneDocumentReads()
                    synchronized(documentReads) {
                        if (documentReads.size >= SafDocumentPolicy.MAX_ACTIVE_READS) {
                            throw IllegalStateException("Too many Android documents are open")
                        }
                    }
                    val input = BufferedInputStream(
                        activity.contentResolver.openInputStream(uri)
                            ?: throw IllegalStateException("The document provider returned no readable stream"),
                        64 * 1024,
                    )
                    val handle = UUID.randomUUID().toString()
                    synchronized(documentReads) {
                        documentReads[handle] = DocumentReadSession(input, kind.maxBytes, metadata.size)
                    }
                    invoke.resolve(JSObject().apply {
                        put("handle", handle)
                        put("displayName", metadata.displayName)
                        put("mimeType", metadata.mimeType)
                        put("size", metadata.size)
                    })
                } catch (error: Throwable) {
                    invoke.reject(error.message ?: "The Android document could not be opened")
                }
            }
        } catch (_: RejectedExecutionException) {
            invoke.reject("The Android document queue is busy")
        }
    }

    @Command
    fun readDocumentChunk(invoke: Invoke) {
        val args = invoke.parseArgs(ReadDocumentChunkArgs::class.java)
        try {
            documentExecutor.execute {
                try {
                    pruneDocumentReads()
                    val handle = args.handle?.trim().orEmpty()
                    val session = synchronized(documentReads) { documentReads[handle] }
                        ?: throw IllegalArgumentException("The Android document read has expired")
                    val requested = (args.maxBytes ?: SafDocumentPolicy.MAX_READ_CHUNK_BYTES)
                        .coerceIn(1, SafDocumentPolicy.MAX_READ_CHUNK_BYTES)
                    val remaining = (session.maxBytes - session.bytesRead).coerceAtLeast(0L)
                    if (remaining <= 0L) throw IllegalArgumentException("The document exceeds its safe import limit")
                    val buffer = ByteArray(minOf(requested.toLong(), remaining).toInt())
                    var count = session.input.read(buffer)
                    while (count == 0) count = session.input.read(buffer)
                    val eof = count < 0 || (session.declaredSize >= 0L && session.bytesRead + count.coerceAtLeast(0) >= session.declaredSize)
                    if (count > 0) session.bytesRead = Math.addExact(session.bytesRead, count.toLong())
                    if (session.bytesRead > session.maxBytes) throw IllegalArgumentException("The document exceeds its safe import limit")
                    session.lastTouchedAt = System.currentTimeMillis()
                    if (eof) closeDocumentReadHandle(handle)
                    invoke.resolve(JSObject().apply {
                        put("dataBase64", if (count > 0) Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP) else "")
                        put("bytesRead", session.bytesRead)
                        put("eof", eof)
                    })
                } catch (error: Throwable) {
                    invoke.reject(error.message ?: "The Android document could not be read")
                }
            }
        } catch (_: RejectedExecutionException) {
            invoke.reject("The Android document queue is busy")
        }
    }

    @Command
    fun closeDocumentRead(invoke: Invoke) {
        val args = invoke.parseArgs(CloseDocumentReadArgs::class.java)
        try {
            documentExecutor.execute {
                closeDocumentReadHandle(args.handle?.trim().orEmpty())
                invoke.resolve(JSObject().apply { put("closed", true) })
            }
        } catch (_: RejectedExecutionException) {
            closeDocumentReadHandle(args.handle?.trim().orEmpty())
            invoke.resolve(JSObject().apply { put("closed", true) })
        }
    }

    private fun scanTree(rawTreeUri: String, recursive: Boolean): JSObject {
        val treeUri = requireContentUri(rawTreeUri)
        if (!DocumentsContract.isTreeUri(treeUri)) throw IllegalArgumentException("The saved location is not an Android document tree")
        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        if (rootId.isBlank() || rootId.length > SafDocumentPolicy.MAX_URI_CHARS) {
            throw IllegalArgumentException("The document provider returned an invalid tree identifier")
        }
        val documents = JSONArray()
        val failures = JSONArray()
        val queue = ArrayDeque<DocumentTreeNode>()
        val seenDirectories = mutableSetOf<String>()
        queue.add(DocumentTreeNode(rootId, 0, ""))
        var visited = 0
        var unknownSizes = 0
        var declaredBytes = 0L
        var truncated = false
        var permissionGranted = false
        var stop = false

        fun failure(path: String, message: String) {
            if (failures.length() >= SafDocumentPolicy.MAX_FAILURES) return
            failures.put(JSObject().apply {
                put("filepath", path.take(500))
                put("error", message.replace(Regex("\\s+"), " ").trim().take(300))
            })
        }

        while (queue.isNotEmpty() && !stop) {
            val directory = queue.removeFirst()
            if (!seenDirectories.add(directory.documentId)) continue
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, directory.documentId)
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            )
            try {
                activity.contentResolver.query(childrenUri, projection, null, null, null)?.use { cursor ->
                    permissionGranted = true
                    val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                    val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                    val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
                    val sizeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_SIZE)
                    val modifiedIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    while (cursor.moveToNext()) {
                        visited += 1
                        if (visited > SafDocumentPolicy.MAX_VISITED_DOCUMENTS) {
                            truncated = true
                            stop = true
                            break
                        }
                        val documentId = if (idIndex >= 0 && !cursor.isNull(idIndex)) cursor.getString(idIndex) else ""
                        val displayName = SafDocumentPolicy.safeDisplayName(
                            if (nameIndex >= 0 && !cursor.isNull(nameIndex)) cursor.getString(nameIndex) else null,
                        )
                        val mimeType = if (mimeIndex >= 0 && !cursor.isNull(mimeIndex)) cursor.getString(mimeIndex).orEmpty() else ""
                        val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex).coerceAtLeast(-1L) else -1L
                        val modified = if (modifiedIndex >= 0 && !cursor.isNull(modifiedIndex)) cursor.getLong(modifiedIndex).coerceAtLeast(0L) else 0L
                        val path = listOf(directory.path, displayName).filter { it.isNotBlank() }.joinToString("/").take(500)
                        if (documentId.isBlank() || documentId.length > SafDocumentPolicy.MAX_URI_CHARS) {
                            failure(path, "The provider returned an invalid document identifier")
                            continue
                        }
                        if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
                            if (recursive && directory.depth < SafDocumentPolicy.MAX_DEPTH) {
                                queue.add(DocumentTreeNode(documentId, directory.depth + 1, path))
                            } else if (recursive) {
                                truncated = true
                                failure(path, "The folder depth limit was reached")
                            }
                            continue
                        }
                        val kind = SafDocumentPolicy.classify(displayName, mimeType) ?: continue
                        if (size > kind.maxBytes) {
                            failure(path, "This ${kind.name} exceeds the safe per-file size limit")
                            continue
                        }
                        if (documents.length() >= SafDocumentPolicy.MAX_BOOK_DOCUMENTS) {
                            truncated = true
                            stop = true
                            break
                        }
                        if (size < 0L) {
                            unknownSizes += 1
                            if (unknownSizes > SafDocumentPolicy.MAX_UNKNOWN_SIZE_DOCUMENTS) {
                                truncated = true
                                failure(path, "Too many documents have unknown sizes")
                                stop = true
                                break
                            }
                        } else {
                            if (declaredBytes > SafDocumentPolicy.MAX_DECLARED_BOOK_BYTES - size) {
                                truncated = true
                                failure(path, "The folder reached the safe total import-size limit")
                                stop = true
                                break
                            }
                            declaredBytes += size
                        }
                        val documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId).toString()
                        if (documentUri.length > SafDocumentPolicy.MAX_URI_CHARS) {
                            failure(path, "The provider returned a document URI that is too long")
                            continue
                        }
                        documents.put(JSObject().apply {
                            put("uri", documentUri)
                            put("displayName", displayName)
                            put("mimeType", mimeType)
                            put("size", size)
                            put("lastModified", modified)
                            put("kind", kind.name.lowercase())
                        })
                    }
                } ?: failure(directory.path.ifBlank { "Folder" }, "The provider returned no folder listing")
            } catch (error: SecurityException) {
                permissionGranted = false
                failure(directory.path.ifBlank { "Folder" }, "Read permission for this folder is no longer available")
                stop = true
            } catch (error: Throwable) {
                failure(directory.path.ifBlank { "Folder" }, error.message ?: "The provider could not list this folder")
            }
        }
        val persistedPermission = runCatching {
            activity.contentResolver.persistedUriPermissions.any { it.isReadPermission && it.uri == treeUri }
        }.getOrDefault(false)
        return JSObject().apply {
            put("treeUri", treeUri.toString())
            put("displayName", queryDisplayName(treeUri) ?: "Folder")
            put("recursive", recursive)
            put("permissionGranted", permissionGranted)
            put("persistedPermission", persistedPermission)
            put("visited", visited)
            put("truncated", truncated)
            put("documents", documents)
            put("failures", failures)
        }
    }

    private fun scanFailure(treeUri: String, message: String): JSObject = JSObject().apply {
        put("treeUri", treeUri.take(SafDocumentPolicy.MAX_URI_CHARS))
        put("displayName", "Folder")
        put("recursive", true)
        put("permissionGranted", false)
        put("persistedPermission", false)
        put("visited", 0)
        put("truncated", false)
        put("documents", JSONArray())
        put("failures", JSONArray().put(JSObject().apply {
            put("filepath", "Folder")
            put("error", message.replace(Regex("\\s+"), " ").trim().take(300))
        }))
    }

    private fun requireContentUri(value: String?): Uri {
        val raw = value?.trim().orEmpty()
        if (raw.isBlank() || raw.length > SafDocumentPolicy.MAX_URI_CHARS) throw IllegalArgumentException("The Android document URI is invalid")
        val uri = Uri.parse(raw)
        if (uri.scheme != "content" || uri.authority.isNullOrBlank()) throw IllegalArgumentException("Only Android content-provider documents can be opened")
        return uri
    }

    private fun queryDocumentMetadata(uri: Uri): DocumentMetadata {
        var displayName: String? = null
        var size = -1L
        var lastModified = 0L
        val projection = arrayOf(
            OpenableColumns.DISPLAY_NAME,
            OpenableColumns.SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        activity.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !cursor.isNull(it) }?.let { displayName = cursor.getString(it) }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { size = cursor.getLong(it).coerceAtLeast(-1L) }
                cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !cursor.isNull(it) }?.let { lastModified = cursor.getLong(it).coerceAtLeast(0L) }
            }
        }
        return DocumentMetadata(
            displayName = SafDocumentPolicy.safeDisplayName(displayName ?: uri.lastPathSegment?.substringAfterLast('/')),
            mimeType = activity.contentResolver.getType(uri).orEmpty(),
            size = size,
            lastModified = lastModified,
        )
    }

    private fun pruneDocumentReads() {
        val cutoff = System.currentTimeMillis() - READ_SESSION_MAX_IDLE_MS
        val expired = synchronized(documentReads) {
            documentReads.filterValues { it.lastTouchedAt < cutoff }.keys.toList()
        }
        expired.forEach(::closeDocumentReadHandle)
    }

    private fun closeDocumentReadHandle(handle: String) {
        val session = synchronized(documentReads) { documentReads.remove(handle) }
        runCatching { session?.input?.close() }
    }

    private fun installModelPackFromUri(uri: Uri, engine: String): JSObject {
        val result = JSObject()
        result.put("engine", engine)
        val targetRoot = File(activity.filesDir, "models/$engine")
        val modelParent = targetRoot.parentFile ?: throw IllegalStateException("Model directory is unavailable")
        val staging = File(modelParent, ".$engine.import-${UUID.randomUUID()}")
        try {
            if (!modelParent.isDirectory && !modelParent.mkdirs()) {
                throw IllegalStateException("Could not create the model directory")
            }
            if (!staging.mkdirs()) throw IllegalStateException("Could not create model-pack staging")
            val input = activity.contentResolver.openInputStream(uri)
                ?: throw IllegalStateException("The selected model pack could not be opened")
            input.use { ModelPackSupport.extractArchive(it, staging, engine) }
            modelManager.installPack(engine, staging)
            result.put("installed", true)
            result.put("path", targetRoot.absolutePath)
        } catch (error: Throwable) {
            result.put("installed", false)
            result.put("path", targetRoot.absolutePath)
            result.put("error", error.message ?: "Model pack import failed")
        } finally {
            staging.deleteRecursively()
        }
        return result
    }

    @Command
    fun platformStatus(invoke: Invoke) {
        var immediate: JSObject? = null
        var schedule = false
        synchronized(statusLock) {
            val now = System.currentTimeMillis()
            if (statusSnapshot != null && now - statusSnapshotAt < STATUS_CACHE_TTL_MS) {
                immediate = statusSnapshot
            } else {
                statusWaiters.addLast(invoke)
                if (!statusRefreshRunning) {
                    statusRefreshRunning = true
                    schedule = true
                }
            }
        }
        immediate?.let {
            invoke.resolve(it)
            return
        }
        if (!schedule) return
        try {
            statusExecutor.execute {
                try {
                    completePlatformStatus(buildPlatformStatus(), null)
                } catch (error: Throwable) {
                    completePlatformStatus(null, error)
                }
            }
        } catch (error: RejectedExecutionException) {
            completePlatformStatus(null, error)
        }
    }

    private fun buildPlatformStatus(): JSObject {
        val runtime = modelManager.nativeRuntimeReadiness()
        val supertonic = modelManager.status("supertonic")
        val kokoro = modelManager.status("kokoro")
        val models = JSObject()
        models.put("supertonic", statusJsonObject(supertonic))
        models.put("kokoro", statusJsonObject(kokoro))
        val density = activity.resources.displayMetrics.density.coerceAtLeast(1f)
        val decorView = activity.window.decorView
        val rootInsets = ViewCompat.getRootWindowInsets(decorView)
        val systemInsets = rootInsets?.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        )
        val imeInsets = rootInsets?.getInsets(WindowInsetsCompat.Type.ime())
        val insets = JSObject().apply {
            put("top", (systemInsets?.top ?: 0) / density)
            put("right", (systemInsets?.right ?: 0) / density)
            put("bottom", (systemInsets?.bottom ?: 0) / density)
            put("left", (systemInsets?.left ?: 0) / density)
            put("imeBottom", if (rootInsets?.isVisible(WindowInsetsCompat.Type.ime()) == true) (imeInsets?.bottom ?: 0) / density else 0f)
        }
        @Suppress("DEPRECATION")
        val refreshRate = activity.display?.refreshRate ?: activity.windowManager.defaultDisplay.refreshRate
        return JSObject().apply {
            put("platform", "android")
            put("nativeTtsAvailable", runtime.ready)
            put("nativeTtsError", runtime.error ?: JSONObject.NULL)
            put("nativeRuntimeVersion", runtime.version ?: JSONObject.NULL)
            put("nativeRuntimeProviders", JSONArray(runtime.providers))
            put("fallbackPhonemizerReady", kokoro["fallbackPhonemizerReady"] ?: JSONObject.NULL)
            put("fallbackPhonemizerError", kokoro["fallbackPhonemizerError"] ?: JSONObject.NULL)
            put("modelRoot", File(activity.filesDir, "models").absolutePath)
            put("modelAssets", models)
            put("windowInsets", insets)
            put("density", density)
            put("refreshRate", refreshRate)
        }
    }

    @Command
    fun setSystemBars(invoke: Invoke) {
        val args = invoke.parseArgs(SystemBarsArgs::class.java)
        val darkBackground = args.darkBackground != false
        val backgroundColor = runCatching {
            Color.parseColor(args.backgroundColor ?: if (darkBackground) "#030303" else "#ede0c4")
        }.getOrDefault(if (darkBackground) Color.rgb(3, 3, 3) else Color.rgb(237, 224, 196))
        activity.getSharedPreferences("folio_native_ui", android.content.Context.MODE_PRIVATE)
            .edit()
            .putInt("boot_background", backgroundColor)
            .putBoolean("boot_dark", darkBackground)
            .apply()
        activity.runOnUiThread {
            val window = activity.window
            val decorView = window.decorView
            window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(backgroundColor))
            decorView.setBackgroundColor(backgroundColor)
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isStatusBarContrastEnforced = false
                window.isNavigationBarContrastEnforced = false
            }
            WindowInsetsControllerCompat(window, decorView).apply {
                isAppearanceLightStatusBars = !darkBackground
                isAppearanceLightNavigationBars = !darkBackground
            }
            invoke.resolve(JSObject().apply {
                put("darkBackground", darkBackground)
                put("backgroundColor", args.backgroundColor ?: JSONObject.NULL)
            })
        }
    }

    @Command
    fun performHaptic(invoke: Invoke) {
        val args = invoke.parseArgs(HapticArgs::class.java)
        activity.runOnUiThread {
            val feedback = if (args.kind == "confirm") {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM
                else HapticFeedbackConstants.LONG_PRESS
            } else {
                HapticFeedbackConstants.CLOCK_TICK
            }
            val performed = activity.window.decorView.performHapticFeedback(feedback)
            invoke.resolve(JSObject().apply { put("performed", performed) })
        }
    }

    private fun completePlatformStatus(snapshot: JSObject?, error: Throwable?) {
        val pending = synchronized(statusLock) {
            if (snapshot != null) {
                statusSnapshot = snapshot
                statusSnapshotAt = System.currentTimeMillis()
            }
            val fallback = snapshot ?: statusSnapshot
            statusRefreshRunning = false
            buildList { while (statusWaiters.isNotEmpty()) add(statusWaiters.removeFirst()) }
                .map { it to fallback }
        }
        pending.forEach { (pendingInvoke, fallback) ->
            if (fallback != null) pendingInvoke.resolve(fallback)
            else pendingInvoke.reject(error?.message ?: "Android native runtime status failed")
        }
    }

    @Command
    fun synthesize(invoke: Invoke) {
        val args = invoke.parseArgs(SynthesizeArgs::class.java)
        val text = args.text?.trim().orEmpty()
        if (text.isEmpty()) {
            invoke.reject("Text is required")
            return
        }
        if (text.length > SafDocumentPolicy.MAX_SYNTH_TEXT_CHARS) {
            invoke.reject("Text is too long for one on-device narration request")
            return
        }
        try {
            synthesisExecutor.execute {
                try {
                    val engine = args.engine?.trim()?.lowercase().orEmpty().ifEmpty { "supertonic" }
                    val speed = (args.speed ?: 1.0).toFloat()
                    val result = when (engine) {
                        "supertonic" -> supertonicRuntime.synthesize(text, args.voice ?: "M1", speed).let {
                            modelAudioToWav(it.samples, it.sampleRate, engine)
                        }
                        "kokoro" -> kokoroRuntime.synthesize(text, args.voice ?: "af_heart", speed).let {
                            modelAudioToWav(it.samples, it.sampleRate, engine)
                        }
                        else -> throw IllegalArgumentException("Unknown local TTS engine: $engine")
                    }
                    invoke.resolve(result)
                } catch (error: Throwable) {
                    val detail = generateSequence(error) { it.cause }.mapNotNull { it.message }.firstOrNull()
                    invoke.reject(detail ?: "Android local-model synthesis failed")
                }
            }
        } catch (_: RejectedExecutionException) {
            invoke.reject("Android local-model synthesis queue is busy")
        }
    }

    @Command
    fun playAudio(invoke: Invoke) {
        val args = invoke.parseArgs(PlayAudioArgs::class.java)
        val mode = args.mode?.trim()?.lowercase().orEmpty().ifEmpty { "replace" }
        if (mode !in setOf("replace", "append")) {
            invoke.reject("Audio queue mode must be replace or append")
            return
        }
        val encoded = args.audioBase64?.trim().orEmpty()
        if (encoded.isEmpty()) {
            invoke.reject("Audio data is required")
            return
        }
        if (encoded.length > 120 * 1024 * 1024) {
            invoke.reject("Audio chunk is too large")
            return
        }
        try {
            playbackExecutor.execute {
            var output: File? = null
            try {
                val bytes = Base64.decode(encoded, Base64.DEFAULT)
                if (bytes.isEmpty()) throw IllegalStateException("Audio data is empty")
                val audioFile = File.createTempFile("folio-audio-", ".wav", activity.cacheDir)
                output = audioFile
                FileOutputStream(audioFile).use { it.write(bytes) }
                val status = FolioPlaybackService.enqueue(
                    activity.applicationContext,
                    audioFile.absolutePath,
                    args.title,
                    args.artist,
                    args.album,
                    args.positionMs ?: 0L,
                    appendToActiveQueue = mode == "append",
                )
                invoke.resolve(playbackStatusObject(status))
            } catch (error: Throwable) {
                output?.delete()
                invoke.reject(error.message ?: "Android playback could not start")
            }
            }
        } catch (_: RejectedExecutionException) {
            invoke.reject("The Android playback queue is busy")
        }
    }

    @Command
    fun controlAudio(invoke: Invoke) {
        val args = invoke.parseArgs(ControlAudioArgs::class.java)
        val action = args.action?.trim().orEmpty()
        if (action !in setOf("pause", "resume", "stop", "seek")) {
            invoke.reject("Unknown playback action")
            return
        }
        FolioPlaybackService.control(activity.applicationContext, action, args.positionMs)
        invoke.resolve(playbackStatusObject(FolioPlaybackService.snapshot()))
    }

    @Command
    fun audioStatus(invoke: Invoke) {
        invoke.resolve(playbackStatusObject(FolioPlaybackService.snapshot()))
    }

    private fun playbackStatusObject(status: FolioPlaybackService.Companion.PlaybackSnapshot): JSObject {
        val result = JSObject()
        result.put("state", status.state)
        result.put("positionMs", status.positionMs)
        result.put("durationMs", status.durationMs)
        result.put("sessionId", status.sessionId)
        result.put("enqueuedSessionId", status.enqueuedSessionId)
        result.put("queueSessionIds", JSONArray(status.queueSessionIds))
        result.put("currentIndex", status.currentIndex)
        result.put("queueSize", status.queueSessionIds.size)
        result.put("error", status.error ?: JSONObject.NULL)
        return result
    }

    private fun modelAudioToWav(samples: FloatArray, sampleRate: Int, engine: String): JSObject {
        val bytes = wavBytes(samples, sampleRate)
        val result = JSObject()
        result.put("audioBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        result.put("durationMs", wavDurationMs(bytes))
        result.put("sampleRate", sampleRate)
        result.put("engine", engine)
        return result
    }

    private fun wavBytes(samples: FloatArray, sampleRate: Int): ByteArray {
        val dataSize = samples.size * 2
        val bytes = ByteArray(44 + dataSize)
        fun ascii(offset: Int, value: String) { value.toByteArray(Charsets.US_ASCII).copyInto(bytes, offset) }
        fun leShort(offset: Int, value: Int) { bytes[offset] = value.toByte(); bytes[offset + 1] = (value shr 8).toByte() }
        fun leInt(offset: Int, value: Int) {
            bytes[offset] = value.toByte(); bytes[offset + 1] = (value shr 8).toByte()
            bytes[offset + 2] = (value shr 16).toByte(); bytes[offset + 3] = (value shr 24).toByte()
        }
        ascii(0, "RIFF"); leInt(4, 36 + dataSize); ascii(8, "WAVE"); ascii(12, "fmt ")
        leInt(16, 16); leShort(20, 1); leShort(22, 1); leInt(24, sampleRate); leInt(28, sampleRate * 2)
        leShort(32, 2); leShort(34, 16); ascii(36, "data"); leInt(40, dataSize)
        samples.forEachIndexed { index, sample ->
            val value = (sample.coerceIn(-1f, 1f) * 32767f).toInt()
            leShort(44 + index * 2, value)
        }
        return bytes
    }

    private fun queryDisplayName(uri: Uri): String? {
        runCatching {
            activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) return SafDocumentPolicy.safeDisplayName(cursor.getString(0))
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')
    }

    private fun wavSampleRate(bytes: ByteArray): Int {
        if (bytes.size < 28) return 22050
        return (bytes[24].toInt() and 0xff) or
            ((bytes[25].toInt() and 0xff) shl 8) or
            ((bytes[26].toInt() and 0xff) shl 16) or
            ((bytes[27].toInt() and 0xff) shl 24)
    }

    private fun wavDurationMs(bytes: ByteArray): Long {
        if (bytes.size < 44) return (bytes.size / 44L).coerceAtLeast(1L)
        val rate = wavSampleRate(bytes).coerceAtLeast(1)
        val channels = (bytes[22].toInt() and 0xff).coerceAtLeast(1)
        val bits = (bytes[34].toInt() and 0xff).coerceAtLeast(8)
        val dataSize = bytes.size - 44
        return (dataSize * 1000L / (rate.toLong() * channels * (bits / 8).coerceAtLeast(1))).coerceAtLeast(1L)
    }
}
