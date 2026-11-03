#import <React/RCTEventEmitter.h>

NS_ASSUME_NONNULL_BEGIN

@interface RNShare : RCTEventEmitter <RCTBridgeModule>

// Replaces the stored file paths with the paths from the Finder Services entry. Safe to call before the
// React bridge exists. Posts the notification DaakServiceFilesPending.
+ (void)addPendingFiles:(NSArray<NSString *> *)paths;

// Clears the stored paths. Posts the notification DaakServiceFilesDismissed.
+ (void)dismissPendingFiles;
@end

NS_ASSUME_NONNULL_END
