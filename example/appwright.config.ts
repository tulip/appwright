import { defineConfig, Platform } from "appwright";
import path from "path";

export default defineConfig({
  // Number of parallel workers. Each worker drives its own device, so this may be raised
  // up to the number of entries in the project's `device.devices` list.
  workers: 1,
  projects: [
    {
      name: "ios",
      use: {
        platform: Platform.IOS,
        device: {
          provider: "emulator",
          name: "iPhone 14 Pro",
        },
        buildPath: path.join("builds", "Wikipedia.app"),
      },
    },
    {
      name: "android",
      use: {
        platform: Platform.ANDROID,
        device: {
          provider: "emulator",
          // One entry per worker. Replace the AVD name with one from
          // `$ANDROID_HOME/emulator/emulator -list-avds`; appwright boots it on
          // `emulator-5554` if it is not already running.
          devices: [{ udid: "emulator-5554", avd: "Pixel_7_API_34" }],
        },
        buildPath: path.join("builds", "wikipedia.apk"),
      },
    },
  ],
});
