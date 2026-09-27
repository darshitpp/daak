// Method table only. Codegen generates the DaakNotifySpec protocol from
// js/NativeDaakNotify.ts; this declares the SAME names so the Swift
// implementation is reachable from JS. RCTEventEmitter is the parent because
// the event surface is sendEvent(withName:body:) -- the same shape as the
// working Daak.swift / DaakModule.mm precedent in apps/mobile/ios.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(DaakNotify, RCTEventEmitter)

RCT_EXTERN_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(registerCategories:(NSString *)categoriesJson
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(post:(NSString *)id
                  title:(NSString *)title
                  body:(NSString *)body
                  category:(NSString *)category
                  payloadJson:(NSString *)payloadJson
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancel:(NSString *)id
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(consumePendingAction:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)

@end

