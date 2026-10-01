package dev.darshit.daak

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // DaakModule lives in the app, not in an autolinked node module,
              // so PackageList cannot find it. Without this add() the
              // TurboModule registry has no "Daak" and NativeDaak throws at
              // the first engine call.
              add(DaakPackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // Must run BEFORE anything touches the uniffi bindings: findLibraryName()
    // reads this system property once, the first time it loads the library, and
    // caches the result for the life of the process.
    //
    // uniffi_bindgen 0.28.3 hardcodes "uniffi_daak_ffi" there and offers no
    // build-time way to change it -- there is no UDL keyword for it in 0.28.3
    // (library_override does not exist until later versions). "daak_ffi" is the
    // library BASENAME, which is what JNA wants: it prepends lib and appends the
    // platform suffix itself, and gen-android-ffi.sh packages the cdylib as
    // libdaak_ffi.so, so this is the one string that has to line up.
    //
    // The alternative was renaming the .so to libuniffi_daak_ffi.so instead.
    // That was not chosen because every other consumer of the crate expects the
    // daak_ffi name (the iOS staticlib, daakd), and one override here is
    // smaller than renaming the artifact everywhere. Pinned by
    // src/__tests__/androidFfiWiring.test.ts.
    System.setProperty("uniffi.component.daak_ffi.libraryOverride", "daak_ffi")
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      // If you opted-in for the New Architecture, we load the native entry point for this app.
      load()
    }
  }
}
