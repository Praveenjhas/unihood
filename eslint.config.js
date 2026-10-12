// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    /**
     * `dist/*` alone misses the API's compiled output, which `npm run build`
     * writes to `backend/dist` - eslint does not read .gitignore, so a lint run
     * after a build used to report errors in generated JavaScript.
     *
     * The two outbox directories are runtime state rather than source: `.otp-outbox`
     * holds live one-time codes and `.mail-outbox` holds development emails.
     */
    ignores: ['dist/*', 'backend/dist/**', 'backend/.otp-outbox/**', 'backend/.mail-outbox/**'],
  }
]);

