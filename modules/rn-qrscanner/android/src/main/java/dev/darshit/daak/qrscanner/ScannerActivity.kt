package dev.darshit.daak.qrscanner

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * CameraX + zxing scan screen. Returns the first decoded QR payload via
 * EXTRA_RESULT and finishes; a denied CAMERA permission (or any other failure)
 * is reported via EXTRA_ERROR so DaakQrScannerModule can tell it from a plain
 * dismissal. R92: a manifest declaration is not a runtime grant -- without the
 * request below the preview opens black on a real device (API 23+) and the
 * scan Promise never settles.
 */
class ScannerActivity : ComponentActivity() {

  companion object {
    const val EXTRA_RESULT = "result"
    const val EXTRA_ERROR = "error"
  }

  private val previewView by lazy { PreviewView(this) }
  private val reader = QRCodeReader()

  private val permissionLauncher =
      registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else fail("camera permission denied")
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(previewView)
    if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
      startCamera()
    } else {
      permissionLauncher.launch(Manifest.permission.CAMERA)
    }
  }

  private fun startCamera() {
    val future = ProcessCameraProvider.getInstance(this)
    future.addListener(
        {
          try {
            val provider = future.get()
            val preview = Preview.Builder().build().also {
              it.surfaceProvider = previewView.surfaceProvider
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysis.setAnalyzer(ContextCompat.getMainExecutor(this), QrAnalyzer(::onDecoded))
            provider.unbindAll()
            provider.bindToLifecycle(
                this,
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                analysis)
          } catch (_: Throwable) {
            fail("camera unavailable")
          }
        },
        ContextCompat.getMainExecutor(this))
  }

  private fun onDecoded(text: String) {
    setResult(android.app.Activity.RESULT_OK, Intent().putExtra(EXTRA_RESULT, text))
    finish()
  }

  private fun fail(message: String) {
    setResult(android.app.Activity.RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, message))
    finish()
  }

  private inner class QrAnalyzer(private val onFound: (String) -> Unit) :
      ImageAnalysis.Analyzer {

    override fun analyze(imageProxy: ImageProxy) {
      try {
        val plane = imageProxy.planes[0]
        val width = imageProxy.width
        val height = imageProxy.height
        val data = ByteArray(width * height)
        // PlanarYUVLuminanceSource expects tightly packed luma, but YUV_420_888
        // may pad rows (rowStride > width) or interleave (pixelStride > 1). The
        // packed fast path covers most devices; the stride-aware copy covers
        // the rest. Without it the scan decodes garbage or nothing on those.
        if (plane.rowStride == width && plane.pixelStride == 1) {
          plane.buffer.get(data)
        } else {
          val row = ByteArray(plane.rowStride)
          var offset = 0
          for (y in 0 until height) {
            plane.buffer.position(y * plane.rowStride)
            plane.buffer.get(row, 0, plane.rowStride)
            var x = 0
            var i = 0
            while (x < width) {
              data[offset + x] = row[i]
              x += 1
              i += plane.pixelStride
            }
            offset += width
          }
        }
        val source = PlanarYUVLuminanceSource(
            data, width, height, 0, 0, width, height, false)
        val result = reader.decode(BinaryBitmap(HybridBinarizer(source)))
        if (result.text.isNotBlank()) onFound(result.text)
      } catch (_: ReaderException) {
        // No QR in this frame; keep scanning. Throwing out of analyze would
        // kill the analysis loop and freeze the preview.
      } finally {
        imageProxy.close()
      }
    }
  }
}
