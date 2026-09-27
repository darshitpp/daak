package dev.darshit.daak.securestore

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakSecureStore TurboModule. Without this nothing puts
 * "DaakSecureStore" in the TurboModule registry and TurboModuleRegistry
 * .getEnforcing throws at app boot, since packages/platform/src/index.ts is
 * imported at module scope.
 */
class DaakSecureStorePackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakSecureStoreModule.NAME) DaakSecureStoreModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakSecureStoreModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakSecureStoreModule.NAME,
                /* className = */ DaakSecureStoreModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}
