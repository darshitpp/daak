#import <React/RCTEventEmitter.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNShare : RCTEventEmitter <RCTBridgeModule>

// Stores file paths from the Finder Services entry. Safe to call before the
// React bridge exists. Posts the notification DaakServiceFilesPending.
+ (void)addPendingFiles:(NSArray<NSString *> *)paths;
@end

NS_ASSUME_NONNULL_END
