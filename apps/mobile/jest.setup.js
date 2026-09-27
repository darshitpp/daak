jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => {
  return class NativeEventEmitter { addListener() { return { remove() {} }; } };
});
