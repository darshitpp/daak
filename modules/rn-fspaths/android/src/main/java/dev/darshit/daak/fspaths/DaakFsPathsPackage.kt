package dev.darshit.daak.fspaths

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakFsPaths TurboModule. Without this nothing puts
 * "DaakFsPaths" in the TurboModule registry and TurboModuleRegistry
 * .getEnforcing throws at app boot, since packages/platform/src/index.ts is
 * imported at module scope.
 */
class DaakFsPathsPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakFsPathsModule.NAME) DaakFsPathsModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakFsPathsModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakFsPathsModule.NAME,
                /* className = */ DaakFsPathsModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}
