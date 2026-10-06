// Method table only, identical to ios/DaakQrScanner.mm: codegen builds the
// DaakQrScannerSpec protocol from js/NativeDaakQrScanner.ts, and this declares
// the SAME names so the Swift implementation is reachable from JS. NSObject as
// the parent, matching DaakSecureStore.mm -- this module has no events, so
// RCTEventEmitter's shape would be a lie.
//
// The scan method is deliberately ABSENT: the desktop is the side that SHOWS a
// code. See the header comment in DaakQrScanner.swift.
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakQrScanner, NSObject)

RCT_EXTERN_METHOD(generate:(NSString *)payload
                  size:(nonnull NSNumber *)size
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
