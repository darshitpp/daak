package dev.darshit.daak.bgsched

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakBgSched TurboModule. Autolinking only finds the module if
 * this class exists; without it nothing puts "DaakBgSched" in the TurboModule
 * registry and TurboModuleRegistry.getEnforcing throws at import time, because
 * packages/platform/src/index.ts is imported at module scope. The plan omits
 * this file, and Task 4 and Task 8 each shipped the identical omission as a
 * Critical.
 */
class DaakBgSchedPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakBgSchedModule.NAME) DaakBgSchedModule(reactContext) else null

  override fun getReactModuleInfoProvider() =
      ReactModuleInfoProvider {
        mapOf(
            DaakBgSchedModule.NAME to
                ReactModuleInfo(
                    /* name = */ DaakBgSchedModule.NAME,
                    /* className = */ DaakBgSchedModule.NAME,
                    /* canOverrideExistingModule = */ false,
                    /* needsEagerInit = */ false,
                    /* isCxxModule = */ false,
                    /* isTurboModule = */ true,
                ),
        )
      }
}
