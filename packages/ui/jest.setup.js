// A cold CI runner renders slowly. The default waitFor limit of 1 s fails there.
require('@testing-library/react-native').configure({ asyncUtilTimeout: 10000 });
