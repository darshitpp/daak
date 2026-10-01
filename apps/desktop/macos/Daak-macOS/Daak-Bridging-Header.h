// Bridging header for Daak.swift: it subclasses RCTEventEmitter and uses
// RCTPromiseResolveBlock/RCTPromiseRejectBlock, and Daak.swift is byte-locked
// to Phase 4, so the React ObjC surface is exposed here instead.
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
