#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakClipboard, NSObject)
RCT_EXTERN_METHOD(setString:(NSString *)text
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getString:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
