#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakSecureStore, NSObject)
RCT_EXTERN_METHOD(get:(NSString *)key
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(set:(NSString *)key value:(NSString *)value
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(delete:(NSString *)key
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
