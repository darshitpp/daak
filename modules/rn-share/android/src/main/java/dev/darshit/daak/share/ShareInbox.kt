package dev.darshit.daak.share

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Filesystem handshake dir `filesDir/share-inbox`. Staging only, never crypto. */
object ShareInbox {
  private const val DIR = "share-inbox"

  fun dir(ctx: Context): File = File(ctx.filesDir, DIR).apply { mkdirs() }

  fun copyToCache(ctx: Context, uri: Uri): File {
    val name = uri.lastPathSegment?.substringAfterLast('/') ?: "payload"
    val out = File(dir(ctx), UUID.randomUUID().toString() + "-" + name)
    ctx.contentResolver.openInputStream(uri)!!.use { input -> out.outputStream().use { input.copyTo(it) } }
    return out
  }

  fun stageText(ctx: Context, text: String) =
    appendItem(ctx, JSONObject().put("kind", "text").put("text", text))

  fun stageFile(ctx: Context, file: File, mime: String?) =
    appendItem(ctx, JSONObject().put("kind", "file").put("path", file.absolutePath)
      .put("name", file.name).put("mime", mime ?: "*/*"))

  fun stageIntentSend(ctx: Context, deviceId: String, text: String?) =
    appendItem(ctx, JSONObject().put("kind", "intent-send").put("deviceId", deviceId)
      .apply { if (!text.isNullOrEmpty()) put("text", text) })

  private fun appendItem(ctx: Context, item: JSONObject) {
    val final = File(dir(ctx), UUID.randomUUID().toString() + ".json")
    // Write-then-rename: a process killed mid-write leaves a .tmp that drainToJson
    // ignores, never a truncated .json that looks valid.
    val tmp = File(final.path + ".tmp")
    tmp.writeText(JSONArray().put(item).toString())
    check(tmp.renameTo(final)) { "staging rename failed: ${final.name}" }
  }

  fun drainToJson(ctx: Context): String {
    val merged = JSONArray()
    dir(ctx).listFiles { f -> f.extension == "json" }?.forEach { batch ->
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
    return merged.toString()
  }
}
