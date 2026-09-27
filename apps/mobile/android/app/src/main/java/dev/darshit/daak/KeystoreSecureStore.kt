package dev.darshit.daak

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import uniffi.daak_ffi.FfiStoreException
import uniffi.daak_ffi.SecureStore
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The Daak device identity, in the AndroidKeyStore.
//
// This is the UniFFI SecureStore the Rust engine calls DIRECTLY. The
// DaakSecureStore TurboModule in modules/rn-securestore is the JS-facing face
// of the same algorithm for the app's own small secrets; the cipher code is
// NOT shared, because the engine must keep working with no JS bridge at all
// and the module is not a dependency of the app's own compilation unit.
//
// WHY THE BLOB IS LENGTH-PREFIXED rather than a bare iv followed by ciphertext:
// a 12-byte GCM IV is a JDK/Android default, not a contract the platform
// promises. Reading a fixed 12 bytes off a longer IV yields garbage that only
// fails at decrypt time -- as a keystore read error, on another device, after
// the identity is already needed. Both lengths are stored, so a future IV
// length is a read and not a permanent loss of the device identity.
//
// WHY setRandomizedEncryptionRequired stays true (the default, stated
// explicitly): it forces a fresh IV per encryption, which is the whole reason
// reusing one AES key under GCM is safe. It is not a Secure Enclave
// requirement and needs no user presence.
//
// WHY setUserAuthenticationRequired is NOT set: it would put a biometric or
// device-credential prompt in front of EVERY engine call, including the
// background accept loop that has no UI at all. Out of scope and hostile.
class KeystoreSecureStore(private val context: Context) : SecureStore {

  companion object {
    const val NAME = "KeystoreSecureStore"
    private const val KEY_ALIAS = "dev.darshit.daak.identity"
    private const val PREFS = "dev.darshit.daak.keystore"
    private const val TAG = "KeystoreSecureStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    // Far inside GCM's own limit, and it bounds what a corrupt length prefix
    // can make this read allocate.
    private const val MAX_VALUE_BYTES = 65536
  }

  // SharedPreferences is thread-safe, and the engine calls this from several
  // Rust threads. commit() rather than apply(): apply() is a fire-and-forget
  // async write, so a process death right after start() would lose a brand-new
  // identity and the next launch would re-pair the device as a new one.
  private val prefs by lazy {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  // null is "no such key" (a first launch) and is NOT a failure. Every other
  // failure is thrown as FfiStoreException.Store, so start() rejects (R40(c)).
  // A keystore failure flattened to null would mint a FRESH identity and
  // silently re-pair the device as a new one.
  //
  // The error TYPE is load-bearing. uniffi's generated
  // uniffiTraitInterfaceCallWithError only lowers a throwable that `is` the
  // declared FfiStoreException; anything else is flattened to
  // UNIFFI_CALL_UNEXPECTED_ERROR with a bare string, so the Rust side never
  // sees the fielded error. Rethrowing the raw cause is therefore NOT enough.
  override fun get(key: String): String? {
    val encoded = prefs.getString(key, null) ?: return null
    return try {
      open(key, encoded)
    } catch (t: Throwable) {
      Log.e(TAG, "keystore read failed for $key", t)
      if (t is FfiStoreException) throw t
      throw FfiStoreException.Store(
          "keystore read failed for $key: " + (t.message ?: t.toString()))
    }
  }

  override fun set(key: String, value: String) {
    try {
      val sealed = seal(value)
      check(prefs.edit().putString(key, sealed).commit()) {
        "keystore commit returned false for $key"
      }
    } catch (t: Throwable) {
      Log.e(TAG, "keystore write failed for $key", t)
      if (t is FfiStoreException) throw t
      throw FfiStoreException.Store(
          "keystore write failed for $key: " + (t.message ?: t.toString()))
    }
  }

  // Not-found is the ordinary answer for a key that was never written, and it
  // is not a failure: the Rust side treats delete as best-effort.
  override fun delete(key: String) {
    try {
      // check() the boolean like set() does two methods above. Throwing it away
      // reports a successful delete to Rust while the old secret is still on
      // disk -- and a rotate-then-relaunch would then read a key the app
      // believes it destroyed.
      check(prefs.edit().remove(key).commit()) {
        "keystore commit returned false deleting $key"
      }
    } catch (t: Throwable) {
      Log.e(TAG, "keystore delete failed for $key", t)
      if (t is FfiStoreException) throw t
      throw FfiStoreException.Store(
          "keystore delete failed for $key: " + (t.message ?: t.toString()))
    }
  }

  /** Encrypts [plain] into the self-describing blob. */
  private fun seal(plain: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val iv = cipher.iv
    val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
    val out = ByteArrayOutputStream()
    out.write(byteArrayOf((iv.size ushr 8).toByte(), iv.size.toByte()))
    out.write(byteArrayOf((ct.size ushr 8).toByte(), ct.size.toByte()))
    out.write(iv)
    out.write(ct)
    return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }

  /** The exact inverse of [seal]; throws on a blob that is not self-consistent. */
  private fun open(key: String, encoded: String): String {
    val raw = Base64.decode(encoded, Base64.NO_WRAP)
    require(raw.size >= 4) { "keystore blob for $key is truncated" }
    val ivLen = ((raw[0].toInt() and 0xFF) shl 8) or (raw[1].toInt() and 0xFF)
    val ctLen = ((raw[2].toInt() and 0xFF) shl 8) or (raw[3].toInt() and 0xFF)
    require(ivLen in 1..MAX_VALUE_BYTES && ctLen in 1..MAX_VALUE_BYTES) {
      "keystore blob for $key has implausible lengths iv=$ivLen ct=$ctLen"
    }
    require(raw.size == 4 + ivLen + ctLen) { "keystore blob for $key is inconsistent" }
    val iv = raw.copyOfRange(4, 4 + ivLen)
    val ct = raw.copyOfRange(4 + ivLen, 4 + ivLen + ctLen)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
    return String(cipher.doFinal(ct), Charsets.UTF_8)
  }

  // Reads the existing AES key or creates one. The key lives in AndroidKeyStore
  // and is never exportable, so the ciphertext in SharedPreferences is useless
  // without this device -- which is the point: a copied prefs file does not
  // copy the identity.
  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
        KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            // Stated, not assumed: this is the GCM safety property.
            .setRandomizedEncryptionRequired(true)
            // NOT setUserAuthenticationRequired -- see the header comment.
            .build())
    return generator.generateKey()
  }
}
