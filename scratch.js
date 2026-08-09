const fs = require('fs');
const path = require('path');
// Emulate localStorage reading
// We don't have access to browser localStorage from node, but where is it saved?
// The app runs on a local server. Does it save to a file?
