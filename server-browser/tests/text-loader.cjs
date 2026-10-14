// Match Paseo's raw text asset imports when tsx executes the server entry in Node.
const { readFileSync } = require('node:fs');
require.extensions['.txt'] = (module, filename) => { module.exports = readFileSync(filename, 'utf8'); };
