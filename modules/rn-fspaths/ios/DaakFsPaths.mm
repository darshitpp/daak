#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakFsPaths, NSObject)
RCT_EXTERN_METHOD(documentsDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadsDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(appGroupDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(reveal:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
