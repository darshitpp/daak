package dev.darshit.daak.notify

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakNotify TurboModule. Autolinking only finds the module if
 * this class exists; without it nothing puts "DaakNotify" in the TurboModule
 * registry and TurboModuleRegistry.getEnforcing throws at import time, because
 * packages/platform/src/index.ts is imported at module scope. The brief omits
 * this file, and Task 4 shipped the same omission as a Critical.
 */
class DaakNotifyPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakNotifyModule.NAME) DaakNotifyModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakNotifyModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakNotifyModule.NAME,
                /* className = */ DaakNotifyModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}

