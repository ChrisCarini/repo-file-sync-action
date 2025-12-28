const eslintConfig = require('@betahuhn/config').eslint;

eslintConfig.parserOptions = {
  ...eslintConfig.parserOptions,
  ecmaVersion: 'latest',
};
eslintConfig.rules = {
  ...eslintConfig.rules,
  'comma-dangle': 0,
  'brace-style': 0,
};

module.exports = eslintConfig;
