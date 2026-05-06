"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function setupHermeticHome(prefix = "equip-home-") {
  const originalHome = os.homedir;
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const root = path.parse(homeDir).root;
  const originalEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    CODEX_HOME: process.env.CODEX_HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
  };

  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.APPDATA = path.join(homeDir, "AppData", "Roaming");
  process.env.LOCALAPPDATA = path.join(homeDir, "AppData", "Local");
  process.env.CODEX_HOME = path.join(homeDir, ".codex");
  process.env.HOMEDRIVE = root.replace(/[\\\/]+$/, "");
  process.env.HOMEPATH = homeDir.slice(root.length - 1);
  os.homedir = () => homeDir;

  return {
    homeDir,
    restore() {
      os.homedir = originalHome;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  setupHermeticHome,
};
