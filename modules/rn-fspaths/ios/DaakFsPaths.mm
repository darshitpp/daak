#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(DaakFsPaths, NSObject)
RCT_EXTERN_METHOD(documentsDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadsDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(appGroupDir:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(reveal:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(openFile:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(exists:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
// R42p: declared because the JS Spec has them and the source pin compares this
// table to that spec. The iOS BODIES are no-ops until slice 3 for iOS lands, so
// the iOS host does not render the row yet and nothing calls them.
RCT_EXTERN_METHOD(chooseDownloadFolder:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(downloadFolderName:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearDownloadFolder:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(moveReceivedFiles:(NSArray<NSString *> *)paths
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
@end
