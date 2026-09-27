package dev.darshit.daak.qrscanner

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the DaakQrScanner TurboModule. Autolinking only finds the module
 * if this class exists; without it nothing puts "DaakQrScanner" in the
 * TurboModule registry and TurboModuleRegistry.getEnforcing throws at import
 * time. The plan omits this file, and Task 4 and Task 8 each shipped the
 * identical omission as a Critical; pinned by
 * apps/mobile/src/__tests__/qrScanner.test.ts.
 */
class DaakQrScannerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == DaakQrScannerModule.NAME) DaakQrScannerModule(reactContext) else null

  override fun getReactModuleInfoProvider() =
      ReactModuleInfoProvider {
        mapOf(
            DaakQrScannerModule.NAME to
                ReactModuleInfo(
                    /* name = */ DaakQrScannerModule.NAME,
                    /* className = */ DaakQrScannerModule.NAME,
                    /* canOverrideExistingModule = */ false,
                    /* needsEagerInit = */ false,
                    /* isCxxModule = */ false,
                    /* isTurboModule = */ true,
                ),
        )
      }
}
