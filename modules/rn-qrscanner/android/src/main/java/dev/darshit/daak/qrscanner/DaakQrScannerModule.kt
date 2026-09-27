package dev.darshit.daak.qrscanner

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.io.ByteArrayOutputStream

/**
 * The QR half of pairing. scan() presents ScannerActivity and resolves with
 * the decoded payload string; generate() renders a payload to a PNG data URI.
 * Neither half reaches the transport: pairing is engine.pair over the FFI and
 * the outbox owns every Daak-to-Daak transfer. This module turns bytes into
 * pixels and pixels back into a string, nothing else.
 */
@ReactModule(name = DaakQrScannerModule.NAME)
class DaakQrScannerModule(reactContext: ReactApplicationContext) :
    NativeDaakQrScannerSpec(reactContext), ActivityEventListener {

  companion object {
    const val NAME = "DaakQrScanner"
    private const val SCAN_REQUEST = 5201
  }

  private var pending: Promise? = null

  init {
    reactContext.addActivityEventListener(this)
  }

  override fun getName() = NAME

  @ReactMethod
  override fun scan(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "no foreground activity")
      return
    }
    if (pending != null) {
      promise.reject("E_BUSY", "a scan is already in progress")
      return
    }
    pending = promise
    activity.startActivityForResult(
        Intent(activity, ScannerActivity::class.java), SCAN_REQUEST)
  }

  override fun onActivityResult(
      activity: Activity, requestCode: Int, resultCode: Int, data: Intent?
  ) {
    if (requestCode != SCAN_REQUEST) return
    val p = pending ?: return
    pending = null
    if (resultCode == Activity.RESULT_OK && data != null) {
      val value = data.getStringExtra(ScannerActivity.EXTRA_RESULT)
      if (value != null) {
        p.resolve(value)
        return
      }
    }
    // A denied CAMERA permission is an ordinary answer, not a cancellation:
    // ScannerActivity reports it via EXTRA_ERROR so the caller can tell the
    // two apart. Anything else is a dismissal.
    val error = data?.getStringExtra(ScannerActivity.EXTRA_ERROR)
    if (error != null) p.reject("E_CAMERA", error)
    else p.reject("E_SCAN_CANCELLED", "scan cancelled")
  }

  override fun onNewIntent(intent: Intent) = Unit

  @ReactMethod
  override fun generate(payload: String, size: Double, promise: Promise) {
    val px = size.toInt().coerceAtLeast(64)
    try {
      val matrix = QRCodeWriter().encode(
          payload, BarcodeFormat.QR_CODE, px, px,
          mapOf(
              // Must match iOS CIQRCodeGenerator's level ("M"): the EC level
              // is half of the shared capacity ceiling the pair flow pins
              // (PAIRING_BUNDLE_BYTE_CEILING in packages/platform/src/qr.ts).
              // zxing's DEFAULT is L, so this line is what keeps both
              // platforms at one ceiling.
              EncodeHintType.MARGIN to 1,
              EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
      val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
      for (x in 0 until px) for (y in 0 until px) {
        bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
      }
      val out = ByteArrayOutputStream()
      bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
      promise.resolve(
          "data:image/png;base64," +
              Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
    } catch (t: Throwable) {
      promise.reject("E_ENCODE", "qr encode failed", t)
    }
  }

  override fun addListener(eventName: String) = Unit
  override fun removeListeners(count: Double) = Unit
}
