package dev.darshit.daak.clipboard

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakClipboard TurboModule. Without this nothing puts
 * "DaakClipboard" in the TurboModule registry and
 * TurboModuleRegistry.getEnforcing throws at app boot, since
 * packages/platform/src/index.ts is imported at module scope.
 */
class DaakClipboardPackage : BaseReactPackage() {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakClipboardModule.NAME) DaakClipboardModule(reactContext) else null

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
        DaakClipboardModule.NAME to
            ReactModuleInfo(
                /* name = */ DaakClipboardModule.NAME,
                /* className = */ DaakClipboardModule.NAME,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit = */ false,
                /* isCxxModule = */ false,
                /* isTurboModule = */ true,
            ),
    )
  }
}
