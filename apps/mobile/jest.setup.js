jest.mock('react-native/Libraries/EventEmitter/NativeEventEmitter', () => {
  return class NativeEventEmitter { addListener() { return { remove() {} }; } };
});
require('@testing-library/react-native').configure({ asyncUtilTimeout: 10000 });
