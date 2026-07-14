package com.folio.reader.mobile

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.app.Activity
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.ZipInputStream
import kotlin.concurrent.withLock

internal data class TrustedModelAsset(val size: Long, val sha256: String)

internal data class ModelPackExtraction(
    val files: Int,
    val directories: Int,
    val bytes: Long,
)

internal data class NativeRuntimeReadiness(
    val ready: Boolean,
    val version: String? = null,
    val providers: List<String> = emptyList(),
    val error: String? = null,
)

internal object ModelPackSupport {
    private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")

    const val MAX_EXTRACTED_BYTES = 650L * 1024L * 1024L
    const val MAX_ARCHIVE_FILES = 256
    const val MAX_ARCHIVE_DIRECTORIES = 256
    const val MAX_ARCHIVE_ENTRIES = MAX_ARCHIVE_FILES + MAX_ARCHIVE_DIRECTORIES
    const val MAX_MANIFEST_BYTES = 1024 * 1024
    private const val MAX_RELATIVE_PATH_CHARS = 512
    private const val MAX_PATH_SEGMENTS = 16

    fun normalizeRelativePath(rawPath: String): String {
        val value = rawPath.replace('\\', '/').trim()
        if (
            value.isEmpty() || value.length > MAX_RELATIVE_PATH_CHARS || value.startsWith('/') ||
            value.contains(':') || value.any { it.code < 0x20 }
        ) {
            throw IllegalArgumentException("Model pack contains an unsafe path: $rawPath")
        }
        val parts = value.split('/')
        if (
            parts.size > MAX_PATH_SEGMENTS ||
            parts.any { it.isEmpty() || it == "." || it == ".." || it.length > 255 }
        ) {
            throw IllegalArgumentException("Model pack contains an unsafe path: $rawPath")
        }
        return parts.joinToString("/")
    }

    /**
     * Extracts a model pack into an already-created staging directory. Archive
     * entry budgets are charged before any path is created or file body is
     * written, so a ZIP containing thousands of empty directory records cannot
     * grow the filesystem or hold the importer indefinitely.
     */
    fun extractArchive(input: InputStream, staging: File, engine: String): ModelPackExtraction {
        if (!staging.isDirectory) throw IllegalStateException("Model-pack staging is unavailable")
        val canonicalRoot = staging.canonicalFile
        var entryCount = 0
        var fileCount = 0
        var directoryCount = 0
        var totalBytes = 0L
        val extractedPaths = mutableSetOf<String>()

        ZipInputStream(BufferedInputStream(input, 128 * 1024)).use { zip ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val entry = zip.nextEntry ?: break
                entryCount = Math.addExact(entryCount, 1)
                if (entryCount > MAX_ARCHIVE_ENTRIES) {
                    throw IllegalStateException("Model pack contains too many archive entries")
                }
                if (entry.isDirectory) {
                    directoryCount = Math.addExact(directoryCount, 1)
                    if (directoryCount > MAX_ARCHIVE_DIRECTORIES) {
                        throw IllegalStateException("Model pack contains too many directories")
                    }
                } else {
                    fileCount = Math.addExact(fileCount, 1)
                    if (fileCount > MAX_ARCHIVE_FILES) {
                        throw IllegalStateException("Model pack contains too many files")
                    }
                }

                val entryPath = if (entry.isDirectory) entry.name.trimEnd('/', '\\') else entry.name
                val normalized = normalizeRelativePath(entryPath)
                val rawParts = normalized.split('/')
                val parts = if (rawParts.first() == engine) rawParts.drop(1) else rawParts
                if (parts.isEmpty()) {
                    if (entry.isDirectory) {
                        zip.closeEntry()
                        continue
                    }
                    throw IllegalStateException("Model pack contains an invalid root entry")
                }
                val relative = parts.joinToString("/")
                if (!extractedPaths.add(relative)) {
                    throw IllegalStateException("Model pack contains duplicate path $relative")
                }
                val destination = File(staging, relative)
                if (!destination.canonicalFile.path.startsWith(canonicalRoot.path + File.separator)) {
                    throw IllegalStateException("Model pack contains an unsafe path")
                }

                if (entry.isDirectory) {
                    if (!destination.isDirectory && !destination.mkdirs()) {
                        throw IllegalStateException("Could not create model-pack directory $relative")
                    }
                    zip.closeEntry()
                    continue
                }

                val entryLimit = if (relative == "manifest.json") MAX_MANIFEST_BYTES.toLong() else MAX_EXTRACTED_BYTES
                if (entry.size > entryLimit) {
                    throw IllegalStateException("Model pack file $relative is too large")
                }
                destination.parentFile?.let { parent ->
                    if (!parent.isDirectory && !parent.mkdirs()) {
                        throw IllegalStateException("Could not create model-pack directory")
                    }
                }
                var entryBytes = 0L
                FileOutputStream(destination).use { output ->
                    while (true) {
                        val count = zip.read(buffer)
                        if (count < 0) break
                        if (count == 0) continue
                        entryBytes = Math.addExact(entryBytes, count.toLong())
                        totalBytes = Math.addExact(totalBytes, count.toLong())
                        if (entryBytes > entryLimit) {
                            throw IllegalStateException("Model pack file $relative is too large")
                        }
                        if (totalBytes > MAX_EXTRACTED_BYTES) {
                            throw IllegalStateException("Model pack is too large")
                        }
                        output.write(buffer, 0, count)
                    }
                }
                if (entry.size >= 0L && entryBytes != entry.size) {
                    throw IllegalStateException("Model pack file $relative is truncated")
                }
                zip.closeEntry()
            }
        }
        if (fileCount == 0) throw IllegalStateException("Model pack is empty")
        return ModelPackExtraction(fileCount, directoryCount, totalBytes)
    }

    fun normalizeSha256(value: String): String {
        val digest = value.trim().lowercase(Locale.ROOT)
        if (!SHA256_PATTERN.matches(digest)) {
            throw IllegalArgumentException("Model pack contains an invalid SHA-256 digest")
        }
        return digest
    }

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        BufferedInputStream(FileInputStream(file), 128 * 1024).use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(Locale.ROOT, it.toInt() and 0xff) }
    }
}

/**
 * Owns Android ONNX sessions and model-pack publication. Every engine has a
 * single execution lock: inference, unload, validation, and pack replacement
 * can never observe or close one another's sessions halfway through a run.
 */
class OnDeviceModelManager(private val activity: Activity) {
    private data class SessionSchema(val inputs: Set<String>, val outputs: Set<String>)
    private data class ManifestRecord(val path: String, val size: Long, val sha256: String)
    private data class EngineDefinition(
        val assets: Map<String, TrustedModelAsset>,
        val sessionPaths: List<String>,
        val schemas: List<SessionSchema>,
    )

    private class EngineState {
        val lock = ReentrantLock()

        @Volatile
        var sessions: List<OrtSession>? = null

        @Volatile
        var generation: Long = 0

        @Volatile
        var lastError: String? = null
    }

    private data class DownloadState(
        var state: String = "not_installed",
        var active: Boolean = false,
        var downloadedBytes: Long = 0L,
        var totalBytes: Long = 0L,
        var error: String? = null,
    )

    private val environment = OrtEnvironment.getEnvironment()
    private val states = DEFINITIONS.keys.associateWith { EngineState() }
    private val downloadStates = DEFINITIONS.keys.associateWith { DownloadState() }.toMutableMap()
    private val downloadStateLock = Any()
    private val cleanupRunning = AtomicBoolean(false)
    val phonemizer = EspeakPhonemizer(activity.applicationContext)
    internal val kokoroG2p = MisakiEnglishG2p(activity.applicationContext, phonemizer)

    init {
        DEFINITIONS.keys.forEach(::recoverInterruptedSwap)
    }

    fun modelRoot(engine: String): File = File(activity.filesDir, "models/${definition(engine).let { engine }}")

    fun requiredFiles(engine: String): List<String> = definition(engine).assets.keys.toList()

    internal fun expectedAssets(engine: String): Map<String, TrustedModelAsset> = definition(engine).assets.toMap()

    internal fun beginDownload(engine: String, totalBytes: Long): Boolean = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: throw IllegalArgumentException("Unknown local model engine: $engine")
        if (state.active) return@synchronized false
        state.state = "download_queued"
        state.active = true
        state.downloadedBytes = 0L
        state.totalBytes = totalBytes
        state.error = null
        true
    }

    internal fun updateDownload(engine: String, downloadedBytes: Long, totalBytes: Long) = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: return@synchronized
        state.state = "downloading"
        state.active = true
        state.downloadedBytes = downloadedBytes.coerceAtLeast(0L)
        state.totalBytes = totalBytes.coerceAtLeast(0L)
        state.error = null
    }

    internal fun markDownloadVerifying(engine: String, downloadedBytes: Long, totalBytes: Long) = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: return@synchronized
        state.state = "verifying"
        state.active = true
        state.downloadedBytes = downloadedBytes.coerceAtLeast(0L)
        state.totalBytes = totalBytes.coerceAtLeast(0L)
        state.error = null
    }

    internal fun finishDownload(engine: String) = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: return@synchronized
        state.state = "ready"
        state.active = false
        state.downloadedBytes = state.totalBytes
        state.error = null
    }

    internal fun failDownload(engine: String, error: String) = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: return@synchronized
        state.state = "failed"
        state.active = false
        state.error = error.take(300)
    }

    internal fun cancelDownload(engine: String, installed: Boolean) = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: return@synchronized
        state.state = if (installed) "ready" else "not_installed"
        state.active = false
        state.downloadedBytes = if (installed) state.totalBytes else 0L
        state.error = null
    }

    internal fun downloadState(engine: String): Map<String, Any?> = synchronized(downloadStateLock) {
        val state = downloadStates[engine] ?: throw IllegalArgumentException("Unknown local model engine: $engine")
        val approxBytes = definition(engine).assets.values.sumOf { it.size }
        val totalBytes = state.totalBytes.takeIf { it > 0L } ?: approxBytes
        mapOf(
            "state" to state.state,
            "download_active" to state.active,
            "downloaded_bytes" to state.downloadedBytes,
            "total_bytes" to totalBytes,
            "progress" to if (totalBytes > 0) state.downloadedBytes.toDouble() / totalBytes else 0.0,
            "download_label" to "${if (engine == "kokoro") "Kokoro" else "Supertonic 3"} model assets",
            "download_error" to state.error,
            "approx_download_bytes" to approxBytes,
        )
    }

    internal fun writeManifest(root: File, engine: String) {
        val files = org.json.JSONArray()
        expectedAssets(engine).forEach { (path, asset) ->
            files.put(JSONObject().apply {
                put("path", path)
                put("size", asset.size)
                put("sha256", asset.sha256)
            })
        }
        val manifest = JSONObject().apply {
            put("schemaVersion", MANIFEST_SCHEMA_VERSION)
            put("engine", engine)
            put("files", files)
        }
        File(root, "manifest.json").writeText(manifest.toString())
    }

    fun installed(engine: String): Boolean {
        val state = state(engine)
        return state.lock.withLock {
            runCatching { validateManifest(modelRoot(engine), engine, verifyHashes = false) }.isSuccess
        }
    }

    fun loaded(engine: String): Boolean = state(engine).sessions != null

    /** Runs [operation] while the engine sessions are guaranteed to stay open. */
    internal fun <T> withSessions(
        engine: String,
        operation: (sessions: List<OrtSession>, root: File, generation: Long) -> T,
    ): T {
        val state = state(engine)
        return state.lock.withLock {
            val root = modelRoot(engine)
            val sessions = try {
                validateManifest(root, engine, verifyHashes = false)
                state.sessions ?: openSessions(engine, root).also {
                    state.sessions = it
                }
            } catch (error: Throwable) {
                state.lastError = actionableMessage(engine, error)
                throw IllegalStateException(state.lastError, error)
            }
            state.lastError = null
            try {
                operation(sessions, root, state.generation)
            } catch (error: Throwable) {
                // Bad request text, an unavailable optional OOD fallback, or an
                // inference failure must be returned to that request without
                // poisoning the installed model's persistent readiness state.
                throw IllegalStateException(actionableMessage(engine, error), error)
            }
        }
    }

    /**
     * Fully validates [staging] and publishes it without deleting the current
     * pack first. A failed validation or rename restores the previous pack.
     */
    fun installPack(engine: String, staging: File) {
        val state = state(engine)
        state.lock.withLock {
            closeSessionsLocked(state)
            state.generation += 1
            try {
                validateManifest(staging, engine, verifyHashes = true)
                when (engine) {
                    "supertonic" -> SupertonicModelAssets.validate(staging)
                    "kokoro" -> KokoroModelAssets.validate(staging)
                }
                validateSessionContracts(engine, staging)
                publishPackLocked(engine, staging)
                state.lastError = null
            } catch (error: Throwable) {
                val detail = actionableMessage(engine, error)
                val existingPackIsValid = runCatching {
                    validateManifest(modelRoot(engine), engine, verifyHashes = false)
                }.isSuccess
                state.lastError = detail.takeUnless { existingPackIsValid }
                throw IllegalStateException(detail, error)
            }
        }
    }

    fun unload(engine: String): Boolean {
        val state = state(engine)
        return state.lock.withLock {
            val hadSessions = state.sessions != null
            closeSessionsLocked(state)
            state.generation += 1
            hadSessions
        }
    }

    fun unloadAll() {
        DEFINITIONS.keys.forEach(::unload)
    }

    fun unloadAllAsync() {
        if (!cleanupRunning.compareAndSet(false, true)) return
        Thread({
            try {
                unloadAll()
            } finally {
                cleanupRunning.set(false)
            }
        }, "folio-model-cleanup").apply {
            isDaemon = true
            start()
        }
    }

    internal fun nativeRuntimeReadiness(): NativeRuntimeReadiness = try {
        val version = environment.version?.trim().orEmpty()
        val providers = OrtEnvironment.getAvailableProviders().map { it.name }.sorted()
        if (version.isEmpty() || "CPU" !in providers) {
            throw IllegalStateException("ONNX Runtime Android has no CPU execution provider")
        }
        NativeRuntimeReadiness(true, version, providers)
    } catch (error: Throwable) {
        NativeRuntimeReadiness(
            ready = false,
            error = error.message?.take(240) ?: "ONNX Runtime Android could not initialize",
        )
    }

    fun status(engine: String): Map<String, Any?> {
        val state = state(engine)
        val installCheck = runCatching { installed(engine) }
        val isInstalled = installCheck.getOrDefault(false)
        val native = nativeRuntimeReadiness()
        val g2p = kokoroG2p.telemetry()
        val primaryG2p = if (engine == "kokoro" && isInstalled) kokoroG2p.readiness() else null
        val fallback = if (engine == "kokoro" && isInstalled) phonemizer.readiness() else null
        val readinessError = when {
            !native.ready -> native.error
            primaryG2p?.ready == false -> primaryG2p.error
            else -> null
        }
        val download = downloadState(engine)
        val resolvedState = if (isInstalled) "ready" else (download["state"] ?: "not_installed")
        val downloadError = download["download_error"] as? String
        val totalBytes = download["total_bytes"] as? Long ?: 0L
        return mapOf(
            "state" to resolvedState,
            "installed" to isInstalled,
            "loaded" to loaded(engine),
            "synthesisReady" to when (engine) {
                "kokoro" -> isInstalled && native.ready && primaryG2p?.ready == true
                "supertonic" -> isInstalled && native.ready
                else -> false
            },
            "path" to modelRoot(engine).absolutePath,
            "runner" to "onnxruntime-android",
            "runtimeVersion" to native.version,
            "runtimeProviders" to native.providers,
            "phonemizer" to if (engine == "kokoro") g2p.strategy else "none",
            "primaryG2pReady" to if (engine == "kokoro") primaryG2p?.ready else null,
            "fallbackPhonemizerReady" to if (engine == "kokoro") fallback?.ready else null,
            "fallbackPhonemizerError" to if (engine == "kokoro") fallback?.error else null,
            "g2pDialect" to if (engine == "kokoro") g2p.dialect else null,
            "g2pFallbackCount" to if (engine == "kokoro") g2p.fallbackCount else 0,
            "g2pFallbackWords" to if (engine == "kokoro") g2p.fallbackWords else emptyList<String>(),
            "error" to (state.lastError ?: installCheck.exceptionOrNull()?.message ?: readinessError
                ?: if (!isInstalled) downloadError else null),
            "download_active" to download["download_active"],
            "downloaded_bytes" to if (isInstalled) totalBytes else download["downloaded_bytes"],
            "total_bytes" to totalBytes,
            "progress" to if (isInstalled) 1.0 else download["progress"],
            "download_label" to download["download_label"],
            "download_error" to download["download_error"],
            "approx_download_bytes" to download["approx_download_bytes"],
        )
    }

    private fun validateManifest(root: File, engine: String, verifyHashes: Boolean) {
        val definition = definition(engine)
        val manifestFile = File(root, "manifest.json")
        if (!manifestFile.isFile) throw IllegalStateException("Model pack is missing manifest.json")
        if (manifestFile.length() !in 1..ModelPackSupport.MAX_MANIFEST_BYTES.toLong()) {
            throw IllegalStateException("Model pack manifest has an invalid size")
        }
        val manifest = JSONObject(manifestFile.readText())
        if (manifest.optInt("schemaVersion", -1) != MANIFEST_SCHEMA_VERSION) {
            throw IllegalStateException("Model pack uses an unsupported manifest schema")
        }
        if (manifest.optString("engine") != engine) {
            throw IllegalStateException("Model pack engine does not match $engine")
        }
        val files = manifest.optJSONArray("files")
            ?: throw IllegalStateException("Model pack manifest is missing its files array")
        if (files.length() == 0 || files.length() > MAX_MANIFEST_FILES) {
            throw IllegalStateException("Model pack manifest has an invalid file count")
        }

        val records = linkedMapOf<String, ManifestRecord>()
        var declaredTotal = 0L
        for (index in 0 until files.length()) {
            val item = files.optJSONObject(index)
                ?: throw IllegalStateException("Model pack file record $index is invalid")
            val path = ModelPackSupport.normalizeRelativePath(item.optString("path"))
            val size = if (item.has("size")) item.optLong("size", -1) else item.optLong("sizeBytes", -1)
            if (size <= 0 || size > MAX_PACK_BYTES) {
                throw IllegalStateException("Model pack file $path has an invalid size")
            }
            val sha256 = ModelPackSupport.normalizeSha256(item.optString("sha256"))
            if (records.put(path, ManifestRecord(path, size, sha256)) != null) {
                throw IllegalStateException("Model pack manifest contains duplicate path $path")
            }
            declaredTotal = Math.addExact(declaredTotal, size)
            if (declaredTotal > MAX_PACK_BYTES) throw IllegalStateException("Model pack is too large")
        }

        val missingAssets = definition.assets.keys - records.keys
        val unexpectedAssets = records.keys - definition.assets.keys
        if (missingAssets.isNotEmpty() || unexpectedAssets.isNotEmpty()) {
            throw IllegalStateException("Model pack manifest does not match Folio's pinned asset set")
        }

        definition.assets.forEach { (path, trusted) ->
            val record = records[path]
                ?: throw IllegalStateException("Model pack manifest is missing required $path")
            if (record.size != trusted.size || record.sha256 != trusted.sha256) {
                throw IllegalStateException("Model pack $path does not match Folio's trusted model revision")
            }
        }

        records.values.forEach { record ->
            val file = File(root, record.path)
            if (!file.isFile || file.length() != record.size) {
                throw IllegalStateException("Model pack file ${record.path} is missing or has the wrong size")
            }
            if (verifyHashes && ModelPackSupport.sha256(file) != record.sha256) {
                throw IllegalStateException("Model pack file ${record.path} failed SHA-256 verification")
            }
        }

        val filesOnDisk = root.walkTopDown()
            .filter(File::isFile)
            .map { it.relativeTo(root).invariantSeparatorsPath }
            .filter { it != "manifest.json" }
            .toSet()
        val undeclared = filesOnDisk - records.keys
        val missing = records.keys - filesOnDisk
        if (undeclared.isNotEmpty() || missing.isNotEmpty()) {
            throw IllegalStateException("Model pack contents do not match its manifest")
        }
    }

    private fun openSessions(engine: String, root: File): List<OrtSession> {
        val definition = definition(engine)
        val created = mutableListOf<OrtSession>()
        val options = sessionOptions()
        try {
            definition.sessionPaths.forEachIndexed { index, path ->
                val session = environment.createSession(File(root, path).absolutePath, options)
                created += session
                validateSessionSchema(path, session, definition.schemas[index])
            }
            return created.toList()
        } catch (error: Throwable) {
            created.asReversed().forEach(::closeQuietly)
            throw error
        } finally {
            options.close()
        }
    }

    private fun validateSessionContracts(engine: String, root: File) {
        val definition = definition(engine)
        val options = sessionOptions()
        try {
            definition.sessionPaths.forEachIndexed { index, path ->
                environment.createSession(File(root, path).absolutePath, options).use { session ->
                    validateSessionSchema(path, session, definition.schemas[index])
                }
            }
        } finally {
            options.close()
        }
    }

    private fun sessionOptions(): OrtSession.SessionOptions = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(2)
        setInterOpNumThreads(1)
    }

    private fun validateSessionSchema(path: String, session: OrtSession, schema: SessionSchema) {
        val inputs = session.inputInfo.keys.toSet()
        val outputs = session.outputInfo.keys.toSet()
        if (inputs != schema.inputs || outputs != schema.outputs) {
            throw IllegalStateException(
                "ONNX graph $path has an incompatible input/output contract " +
                    "(inputs=$inputs, outputs=$outputs)",
            )
        }
    }

    private fun publishPackLocked(engine: String, staging: File) {
        val target = modelRoot(engine)
        val parent = target.parentFile ?: throw IllegalStateException("Model directory is unavailable")
        if (!parent.isDirectory && !parent.mkdirs()) {
            throw IllegalStateException("Could not create the model directory")
        }
        if (staging.parentFile?.canonicalFile != parent.canonicalFile) {
            throw IllegalStateException("Model staging directory is not on the model filesystem")
        }

        val backup = File(parent, ".$engine.previous-${UUID.randomUUID()}")
        var preservedExisting = false
        try {
            if (target.exists()) {
                if (!target.renameTo(backup)) {
                    throw IllegalStateException("Could not preserve the existing $engine model pack")
                }
                preservedExisting = true
            }
            if (!staging.renameTo(target)) {
                if (preservedExisting && !backup.renameTo(target)) {
                    throw IllegalStateException("Could not publish or restore the $engine model pack")
                }
                throw IllegalStateException("Could not publish the $engine model pack")
            }
            backup.deleteRecursively()
        } catch (error: Throwable) {
            if (!target.exists() && backup.exists()) backup.renameTo(target)
            throw error
        } finally {
            if (target.exists()) backup.deleteRecursively()
        }
    }

    private fun closeSessionsLocked(state: EngineState) {
        val sessions = state.sessions
        state.sessions = null
        sessions?.asReversed()?.forEach(::closeQuietly)
    }

    private fun closeQuietly(session: OrtSession) {
        runCatching { session.close() }
    }

    private fun recoverInterruptedSwap(engine: String) {
        val target = modelRoot(engine)
        val parent = target.parentFile ?: return
        if (!parent.isDirectory) return
        val backups = parent.listFiles { file -> file.name.startsWith(".$engine.previous-") }
            .orEmpty()
            .sortedByDescending(File::lastModified)
        if (!target.exists()) backups.firstOrNull()?.renameTo(target)
        backups.filter { it.exists() && it != target }.forEach { it.deleteRecursively() }
        parent.listFiles { file -> file.name.startsWith(".$engine.import-") }
            .orEmpty()
            .forEach { it.deleteRecursively() }
        parent.listFiles { file -> file.name.startsWith(".$engine.download-") }
            .orEmpty()
            .forEach { it.deleteRecursively() }
    }

    private fun actionableMessage(engine: String, error: Throwable): String {
        val detail = generateSequence(error) { it.cause }.mapNotNull { it.message }.firstOrNull()
            ?: error.javaClass.simpleName
        return "$engine local model error: $detail"
    }

    private fun definition(engine: String): EngineDefinition = DEFINITIONS[engine]
        ?: throw IllegalArgumentException("Unknown local model engine: $engine")

    private fun state(engine: String): EngineState = states[engine]
        ?: throw IllegalArgumentException("Unknown local model engine: $engine")

    private companion object {
        const val MANIFEST_SCHEMA_VERSION = 1
        const val MAX_MANIFEST_FILES = 256
        const val MAX_PACK_BYTES = ModelPackSupport.MAX_EXTRACTED_BYTES

        fun asset(size: Long, sha256: String) = TrustedModelAsset(size, sha256)
        fun schema(inputs: Set<String>, outputs: Set<String>) = SessionSchema(inputs, outputs)

        val DEFINITIONS = mapOf(
            "kokoro" to EngineDefinition(
                assets = linkedMapOf(
                    "kokoro-v1.0.onnx" to asset(325_532_387, "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"),
                    "voices-v1.0.bin" to asset(28_214_398, "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"),
                ),
                sessionPaths = listOf("kokoro-v1.0.onnx"),
                schemas = listOf(schema(setOf("tokens", "style", "speed"), setOf("audio"))),
            ),
            "supertonic" to EngineDefinition(
                assets = linkedMapOf(
                    "onnx/duration_predictor.onnx" to asset(3_700_147, "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db"),
                    "onnx/text_encoder.onnx" to asset(36_416_150, "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff"),
                    "onnx/vector_estimator.onnx" to asset(256_534_781, "883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c"),
                    "onnx/vocoder.onnx" to asset(101_424_195, "085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba"),
                    "onnx/tts.json" to asset(8_253, "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09"),
                    "onnx/unicode_indexer.json" to asset(277_676, "9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f"),
                    "voice_styles/F1.json" to asset(292_046, "bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2"),
                    "voice_styles/F2.json" to asset(292_423, "7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6"),
                    "voice_styles/F3.json" to asset(290_794, "12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab"),
                    "voice_styles/F4.json" to asset(291_808, "c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b"),
                    "voice_styles/F5.json" to asset(291_479, "45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d"),
                    "voice_styles/M1.json" to asset(291_748, "e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b"),
                    "voice_styles/M2.json" to asset(292_055, "b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50"),
                    "voice_styles/M3.json" to asset(290_198, "ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b"),
                    "voice_styles/M4.json" to asset(291_522, "ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303"),
                    "voice_styles/M5.json" to asset(291_469, "dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2"),
                ),
                sessionPaths = listOf(
                    "onnx/duration_predictor.onnx",
                    "onnx/text_encoder.onnx",
                    "onnx/vector_estimator.onnx",
                    "onnx/vocoder.onnx",
                ),
                schemas = listOf(
                    schema(setOf("text_ids", "style_dp", "text_mask"), setOf("duration")),
                    schema(setOf("text_ids", "style_ttl", "text_mask"), setOf("text_emb")),
                    schema(
                        setOf("noisy_latent", "text_emb", "style_ttl", "text_mask", "latent_mask", "current_step", "total_step"),
                        setOf("denoised_latent"),
                    ),
                    schema(setOf("latent"), setOf("wav_tts")),
                ),
            ),
        )
    }
}
