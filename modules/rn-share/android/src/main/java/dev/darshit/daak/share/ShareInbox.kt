package dev.darshit.daak.share

import android.content.Context
import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID

/** Filesystem handshake dir `filesDir/share-inbox`. Staging only, never crypto. */
object ShareInbox {
  private const val DIR = "share-inbox"

  fun dir(ctx: Context): File = File(ctx.filesDir, DIR).apply { mkdirs() }

  /** Batch metadata only, scanned non-recursively. See [appendItem]. */
  private fun batchesDir(ctx: Context): File = File(dir(ctx), "batches").apply { mkdirs() }

  /**
   * Intent-send items get their OWN subdir, a sibling of [batchesDir] (R25).
   * Direct Share / Siri name a destination up front, so these are the only
   * staged items that can be acted on today. Sharing `batches/` would make the
   * send path reachable only through drainToJson, which is all-or-nothing:
   * draining it to send one Direct Share would delete the metadata naming every
   * unrelated text/file batch, and nothing routes those until Task 11. That is
   * silent data loss on the inbound path.
   */
  private fun intentSendsDir(ctx: Context): File = File(dir(ctx), "intent-sends").apply { mkdirs() }

  fun copyToCache(ctx: Context, uri: Uri): File {
    // Another app picks this uri (the share target is exported), and the read
    // runs in this process. A file:// uri, or a uri on a provider of this app,
    // would copy a private Daak file into the share inbox.
    if (uri.scheme != ContentResolver.SCHEME_CONTENT ||
      uri.authority?.startsWith(ctx.packageName) == true
    ) {
      throw SecurityException("refused uri: $uri")
    }
    // R42m: the name used to come from `uri.lastPathSegment`, which for a
    // content URI is `image:1000196782`. No extension travelled with it, so the
    // receiving device stored an unopenable file. The provider knows the real
    // display name; ask it, and fall back only when there is no provider answer.
    val name = displayNameOf(ctx, uri) ?: uri.lastPathSegment?.substringAfterLast('/') ?: "payload"
    // The UUID stays but moves to a DIRECTORY. It was prefixed to the file name,
    // and that prefixed name is what the manifest carried, so every received
    // file arrived as `<uuid>-<name>`. A directory keeps the uniqueness and
    // leaves the file's own name alone.
    val home = File(dir(ctx), UUID.randomUUID().toString()).apply { mkdirs() }
    val out = File(home, safeLeaf(name))
    // A content:// read can fail: the granting app revoked the URI, the
    // provider is dead, or openInputStream returns null. The old non-null
    // assertion turned every one of those into a NullPointerException that
    // killed the caller, and a mid-copy failure left a truncated file that
    // drainToJson would happily stage as a payload. Fail loudly, clean up.
    val input = ctx.contentResolver.openInputStream(uri)
      ?: throw IOException("cannot open $uri")
    try {
      input.use { i -> out.outputStream().use { o -> i.copyTo(o) } }
    } catch (t: Throwable) {
      out.delete()
      throw t
    }
    return out
  }

  /**
   * The provider's own name for a picked document, extension included. Null for
   * a `file://` URI, which already carries a real name in its path, and null
   * when the provider refuses the query -- the caller falls back rather than
   * failing the pick.
   */
  private fun displayNameOf(ctx: Context, uri: Uri): String? {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
    return try {
      ctx.contentResolver
        .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null }
    } catch (t: Throwable) {
      null
    }
  }

  /**
   * One path component. A provider-supplied name is untrusted input that is
   * about to become a file name on THIS device and on the peer, so separators
   * and traversal are removed here rather than at the far end.
   */
  private fun safeLeaf(name: String): String {
    val leaf = name.substringAfterLast('/').substringAfterLast('\\')
    val cleaned = leaf.replace(Regex("[\\u0000-\\u001f/:*?\"<>|]"), "_").trim()
    return if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "payload" else cleaned
  }

  fun stageText(ctx: Context, text: String) =
    appendItem(ctx, JSONObject().put("kind", "text").put("text", text))

  fun stageFile(ctx: Context, file: File, mime: String?) =
    appendItem(ctx, JSONObject().put("kind", "file").put("path", file.absolutePath)
      .put("name", file.name).put("mime", mime ?: "*/*"))

  fun stageIntentSend(ctx: Context, deviceId: String, text: String?) =
    append(JSONObject().put("kind", "intent-send").put("deviceId", deviceId)
      .apply { if (!text.isNullOrEmpty()) put("text", text) }, intentSendsDir(ctx))

  private fun appendItem(ctx: Context, item: JSONObject) = append(item, batchesDir(ctx))

  private fun append(item: JSONObject, dir: File) {
    // Batches live in their own subdir, never beside the staged payload files.
    // A suffix filter is not enough: a shared file called "report.batch" is
    // staged as "<uuid>-report.batch" and would still be read as a batch. A
    // directory cannot collide, and the drain lists this dir NON-recursively,
    // so a shared file is never mistaken for metadata.
    val final = File(dir, UUID.randomUUID().toString() + ".json")
    // Write-then-rename: a process killed mid-write leaves a .tmp that
    // drainToJson ignores, never a truncated .json that looks valid.
    val tmp = File(final.path + ".tmp")
    tmp.writeText(JSONArray().put(item).toString())
    check(tmp.renameTo(final)) { "staging rename failed: ${final.name}" }
  }

  fun drainToJson(ctx: Context): String {
    return drainDir(batchesDir(ctx)).toString()
  }

  /**
   * Drains ONLY the intent-send subdir. It cannot touch a text/file batch: the
   * directory is a sibling, and the listing is non-recursive, so nothing under
   * `batches/` is even visible here, let alone deleted.
   */
  fun drainIntentSendsToJson(ctx: Context): String = drainDir(intentSendsDir(ctx)).toString()

  private fun drainDir(dir: File): JSONArray {
    val merged = JSONArray()
    // The extension filter is load-bearing, not tidiness. A process killed
    // mid-write leaves "<uuid>.json.tmp" in this dir; a bare listFiles() would
    // read it as a batch, and a complete one would be merged AND deleted (the
    // same item delivered twice), while a truncated one would be re-read and
    // re-fail on every drain forever. Only the rename target is a batch.
    dir.listFiles { f -> f.extension == "json" }?.forEach { batch ->
      val parsed = runCatching {
        val arr = JSONArray(batch.readText())
        arr
      }
      // Delete only after a successful parse, so a corrupt file is retried
      // rather than dropped on the floor. Draining is idempotent: a re-read
      // only happens if the drain itself dies before the next copy loop.
      parsed.getOrNull()?.let { arr ->
        for (i in 0 until arr.length()) merged.put(arr.getJSONObject(i))
        batch.delete()
      }
    }
    return merged
  }
}
