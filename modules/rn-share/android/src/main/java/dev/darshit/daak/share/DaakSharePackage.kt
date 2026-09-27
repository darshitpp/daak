package dev.darshit.daak.share

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakShare TurboModule. Without this nothing puts "DaakShare" in
 * the TurboModule registry and TurboModuleRegistry.getEnforcing throws at app
 * boot, since packages/platform/src/index.ts is imported at module scope.
 */
class DaakSharePackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakShareModule.NAME) DaakShareModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakShareModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakShareModule.NAME,
                /* className = */ DaakShareModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}
