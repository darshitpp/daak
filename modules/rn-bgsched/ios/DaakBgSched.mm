// Method table only. Codegen generates the DaakBgSchedSpec protocol from
// js/NativeDaakBgSched.ts; this declares the SAME names so the Swift
// implementation is reachable from JS. RCTEventEmitter is the parent for the
// same reason as DaakNotify.mm: the class shape is fixed there and this module
// has the same one, so the two cannot drift in how JS reaches them.
//
// NOTE: there is NO event here, and that is deliberate. See the class comment
// in DaakBgSched.swift.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(DaakBgSched, RCTEventEmitter)

RCT_EXTERN_METHOD(configure:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(scheduleAppRefresh:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(scheduleProcessing:(nonnull NSNumber *)earliestSeconds
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startForegroundSync:(NSString *)label
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stopForegroundSync:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(enqueueDrain:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestBatteryExemption:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end
