// Method table only. Codegen generates the DaakQrScannerSpec protocol from
// js/NativeDaakQrScanner.ts; this declares the SAME names so the Swift
// implementation is reachable from JS. NSObject parent, matching
// DaakClipboard.mm: this module has no events, so RCTEventEmitter's shape
// would be a lie.
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakQrScanner, NSObject)

RCT_EXTERN_METHOD(scan:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(generate:(NSString *)payload
                  size:(nonnull NSNumber *)size
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
