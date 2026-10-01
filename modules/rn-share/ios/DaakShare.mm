#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakShare, NSObject)
RCT_EXTERN_METHOD(present:(NSString *)text urls:(NSArray<NSString *> *)urls mime:(NSString *)mime
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pickDocuments:(BOOL)multiple
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(consumePendingInbox:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(consumeIntentSends:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(updateShortcutTargets:(NSString *)devicesJson
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
@end
