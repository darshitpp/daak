package dev.darshit.daak

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the in-app Daak engine TurboModule. Phase 4 delivered DaakModule.kt
 * but the app has no ReactPackage for it, so nothing puts the Daak name in the
 * TurboModule registry; this is the missing half, not a second engine.
 */
class DaakPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakModule.NAME) DaakModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakModule.NAME,
                /* className = */ DaakModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}
