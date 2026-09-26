package dev.darshit.daak

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

// Implemented on the JNI side (daak-ffi) so Rust can push engine events; the
// body is the JSON encoding of the UDL FfiEvent union (crates/daak-ffi).
interface DaakEventSink { fun onEvent(eventJson: String) }

@ReactModule(name = DaakModule.NAME)
class DaakModule(reactContext: ReactApplicationContext) :
    NativeDaakSpec(reactContext), DaakEventSink {

    companion object { const val NAME = "Daak" }

    // 0 means "not started": the other methods must fail rather than call into
    // a null engine. Written on start()'s thread, read on every other one.
    @Volatile private var engine: Long = 0L

    override fun getName() = NAME

    @ReactMethod
    override fun start(dataDir: String, displayName: String, listenPort: Double, promise: Promise) {
        Thread {
            try {
                engine = nativeStart(dataDir, displayName, listenPort.toInt(), this)
                promise.resolve(null)
            } catch (t: Throwable) {
                promise.reject("E_ENGINE", t)
            }
        }.start()
    }

    @ReactMethod
    override fun pairingBundle(promise: Promise) = resolve(promise) { nativePairingBundle(handle()) }

    @ReactMethod
    override fun pairWith(addr: String, bundleCbor: ReadableArray, promise: Promise) {
        val bytes = ByteArray(bundleCbor.size()) { bundleCbor.getInt(it).toByte() }
        resolve(promise) { nativePairWith(handle(), addr, bytes) }
    }

    @ReactMethod
    override fun acceptPairing(promise: Promise) = resolve(promise) { nativeAcceptPairing(handle()) }

    @ReactMethod
    override fun sendText(peerId: String, text: String, promise: Promise) =
        resolve(promise) { nativeSendText(handle(), peerId, text) }

    @ReactMethod
    override fun sendFiles(peerId: String, paths: ReadableArray, promise: Promise) {
        val list = Array(paths.size()) { paths.getString(it)!! }
        resolve(promise) { nativeSendFiles(handle(), peerId, list) }
    }

    @ReactMethod
    override fun listDevices(promise: Promise) = resolve(promise) { nativeListDevices(handle()) }

    @ReactMethod
    override fun cancel(transferId: String, promise: Promise) =
        resolve(promise) { nativeCancel(handle(), transferId) }

    @ReactMethod
    override fun retry(transferId: String, promise: Promise) =
        resolve(promise) { nativeRetry(handle(), transferId) }

    @ReactMethod
    override fun localPort(promise: Promise) = resolve(promise) { nativeLocalPort(handle()).toDouble() }

    @ReactMethod
    override fun shutdown(promise: Promise) =
        resolve(promise) { val h = handle(); engine = 0L; nativeShutdown(h) }

    // Every engine call blocks (it runs a tokio runtime / the whole send), so
    // none of it runs on the JS or main thread.
    private inline fun <T> resolve(promise: Promise, block: () -> T) {
        Thread {
            try { promise.resolve(block()) }
            catch (t: Throwable) { promise.reject("E_DAAK", t) }
        }.start()
    }

    private fun handle(): Long {
        val h = engine
        if (h == 0L) throw IllegalStateException("engine not started; call start() first")
        return h
    }

    // UniFFI EventSink callback, invoked on a Rust thread.
    override fun onEvent(eventJson: String) {
        val map = Arguments.createMap()
        map.putString("event", eventJson)
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("DaakEvent", map)
    }

    private external fun nativeStart(dataDir: String, displayName: String, port: Int, sink: DaakEventSink): Long
    private external fun nativePairingBundle(handle: Long): String
    private external fun nativePairWith(handle: Long, addr: String, cbor: ByteArray): String
    private external fun nativeAcceptPairing(handle: Long): String
    private external fun nativeSendText(handle: Long, peerId: String, text: String): String
    private external fun nativeSendFiles(handle: Long, peerId: String, paths: Array<String>): String
    private external fun nativeListDevices(handle: Long): String
    private external fun nativeCancel(handle: Long, transferId: String)
    private external fun nativeRetry(handle: Long, transferId: String)
    private external fun nativeLocalPort(handle: Long): Int
    private external fun nativeShutdown(handle: Long)

    init { System.loadLibrary("daak_ffi") }
}
