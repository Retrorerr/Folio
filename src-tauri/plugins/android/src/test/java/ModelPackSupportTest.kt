package com.folio.reader.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class ModelPackSupportTest {
    @Test
    fun modelPackPathsAreNormalizedWithoutTraversal() {
        assertEquals(
            "onnx/vocoder.onnx",
            ModelPackSupport.normalizeRelativePath("onnx\\vocoder.onnx"),
        )
        listOf(
            "", "/absolute", "C:/drive", "../escape", "onnx//model.onnx", "onnx/./model.onnx",
            "bad\u0000name", "a/".repeat(17) + "model.onnx", "x".repeat(513),
        )
            .forEach { path ->
                assertThrows(IllegalArgumentException::class.java) {
                    ModelPackSupport.normalizeRelativePath(path)
                }
            }
    }

    @Test
    fun sha256IsStreamingAndCanonical() {
        val directory = Files.createTempDirectory("folio-model-hash-").toFile()
        try {
            val file = File(directory, "asset.bin")
            file.writeText("folio")
            assertEquals(
                "4631f244ad4495271986f2ad47fdb560fb8d94727e723e4939fe4e2448bbb156",
                ModelPackSupport.sha256(file),
            )
            assertEquals(
                "4631f244ad4495271986f2ad47fdb560fb8d94727e723e4939fe4e2448bbb156",
                ModelPackSupport.normalizeSha256("4631F244AD4495271986F2AD47FDB560FB8D94727E723E4939FE4E2448BBB156"),
            )
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun archiveDirectoryBudgetIsChargedBeforeCreatingTheOffendingEntry() {
        val directory = Files.createTempDirectory("folio-model-dirs-").toFile()
        try {
            val archive = zipBytes(
                (0..ModelPackSupport.MAX_ARCHIVE_DIRECTORIES).map { "dir-$it/" to null },
            )

            val error = assertThrows(IllegalStateException::class.java) {
                ModelPackSupport.extractArchive(ByteArrayInputStream(archive), directory, "kokoro")
            }

            assertTrue(error.message.orEmpty().contains("too many directories"))
            assertTrue(File(directory, "dir-${ModelPackSupport.MAX_ARCHIVE_DIRECTORIES - 1}").isDirectory)
            assertFalse(File(directory, "dir-${ModelPackSupport.MAX_ARCHIVE_DIRECTORIES}").exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun archiveExtractionRejectsDuplicatePathsAndOversizedManifest() {
        val duplicateRoot = Files.createTempDirectory("folio-model-duplicate-").toFile()
        val manifestRoot = Files.createTempDirectory("folio-model-manifest-").toFile()
        try {
            assertThrows(IllegalStateException::class.java) {
                ModelPackSupport.extractArchive(
                    ByteArrayInputStream(zipBytes(listOf("onnx/" to null, "onnx" to byteArrayOf()))),
                    duplicateRoot,
                    "supertonic",
                )
            }
            val oversized = ByteArray(ModelPackSupport.MAX_MANIFEST_BYTES + 1)
            val error = assertThrows(IllegalStateException::class.java) {
                ModelPackSupport.extractArchive(
                    ByteArrayInputStream(zipBytes(listOf("manifest.json" to oversized))),
                    manifestRoot,
                    "kokoro",
                )
            }
            assertTrue(error.message.orEmpty().contains("manifest.json is too large"))
        } finally {
            duplicateRoot.deleteRecursively()
            manifestRoot.deleteRecursively()
        }
    }

    @Test
    fun validRootedArchiveExtractsWithBoundedStats() {
        val directory = Files.createTempDirectory("folio-model-valid-").toFile()
        try {
            val result = ModelPackSupport.extractArchive(
                ByteArrayInputStream(
                    zipBytes(
                        listOf(
                            "kokoro/" to null,
                            "kokoro/manifest.json" to "{}".toByteArray(),
                            "kokoro/model.onnx" to byteArrayOf(1, 2, 3),
                        ),
                    ),
                ),
                directory,
                "kokoro",
            )

            assertEquals(2, result.files)
            assertEquals(1, result.directories)
            assertEquals(5L, result.bytes)
            assertTrue(File(directory, "model.onnx").isFile)
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun zipBytes(entries: List<Pair<String, ByteArray?>>): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            entries.forEach { (name, bytes) ->
                zip.putNextEntry(ZipEntry(name))
                if (bytes != null) zip.write(bytes)
                zip.closeEntry()
            }
        }
        return output.toByteArray()
    }
}
